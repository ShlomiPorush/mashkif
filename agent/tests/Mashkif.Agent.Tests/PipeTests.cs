using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Mashkif.Agent.Tests.Support;
using Mashkif.Common.Pipe;
using Mashkif.Service.Pipe;
using Mashkif.Service.State;
using Mashkif.Tray;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Mashkif.Agent.Tests;

public sealed class PipeTests : IDisposable
{
    private readonly EngineFixture _f = new();
    private readonly string _pipeName = $"Mashkif.Tests.{Guid.NewGuid():N}";

    public void Dispose() => _f.Dispose();

    private static AgentState Revoked() =>
        AgentState.Empty with { InstallId = EngineFixture.InstallId, IdentityState = IdentityStates.Revoked };

    private PipeServer Server(PipeSecurity? security = null, TimeProvider? time = null)
    {
        var engine = _f.LastEngineOrNew();
        return new PipeServer(
            engine,
            security ?? PipeAcl.Create(StateFixture.CurrentUser),
            _pipeName,
            LoggerFactory.Create(b => b.AddProvider(_f.Logs)).CreateLogger<PipeServer>(),
            time ?? TimeProvider.System);
    }

    [Fact]
    public void The_pipe_DACL_denies_the_network_and_gives_interactive_users_only_the_client_rights()
    {
        var security = PipeAcl.Create(PathPolicy.MashkifServiceSid);
        Assert.True(security.AreAccessRulesProtected);
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<PipeAccessRule>()
            .Select(r => (((SecurityIdentifier)r.IdentityReference).Value, r.AccessControlType, r.PipeAccessRights))
            .ToHashSet();
        Assert.Equal(
            new HashSet<(string, AccessControlType, PipeAccessRights)>
            {
                ("S-1-5-2", AccessControlType.Deny, PipeAccessRights.FullControl),
                ("S-1-5-18", AccessControlType.Allow, PipeAccessRights.FullControl),
                ("S-1-5-32-544", AccessControlType.Allow, PipeAccessRights.FullControl),
                (PathPolicy.MashkifServiceSid.Value, AccessControlType.Allow, PipeAccessRights.FullControl),
                ("S-1-5-4", AccessControlType.Allow, PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize),
                ("S-1-3-4", AccessControlType.Allow, PipeAccessRights.ReadPermissions | PipeAccessRights.Synchronize),
            },
            rules);
        Assert.Equal(0, (int)(PipeAcl.ClientRights & PipeAccessRights.CreateNewInstance));
        Assert.Equal(0, (int)(PipeAcl.ClientRights & PipeAccessRights.WriteAttributes));
        Assert.Equal(PipeAcl.ClientRights, PipeClient.Rights);

        // The deny rule comes first in the binary DACL.
        var sddl = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        Assert.StartsWith("D:P(D;;", sddl, StringComparison.Ordinal);
    }

    [Fact]
    public void Dispatch_answers_status_and_refuses_bad_requests()
    {
        _f.Create().Initialize();
        var server = Server();
        Assert.Equal(PipeErrors.RequestInvalid, server.Dispatch(null).Error);
        Assert.Equal(PipeErrors.RequestInvalid, server.Dispatch("not json").Error);
        Assert.Equal(PipeErrors.VersionUnsupported, server.Dispatch("""{"version":2,"command":"status"}""").Error);
        Assert.Equal(PipeErrors.UnknownCommand, server.Dispatch("""{"version":1,"command":"set_area"}""").Error);
        var status = server.Dispatch("""{"version":1,"command":"status"}""");
        Assert.True(status.Ok);
        Assert.Equal(AgentStates.Unregistered, status.Status!.State);
        Assert.Equal("mashkif.test", status.Status.ServerHost);
        Assert.Equal(PipeErrors.NotRejoinable, server.Dispatch("""{"version":1,"command":"rejoin"}""").Error);
        Assert.Equal(PipeErrors.UnknownCommand, server.Dispatch("""{"version":1,"command":"register","enrollmentKey":"x"}""").Error);
    }

    [Fact]
    public async Task The_tray_client_gets_the_status_and_joins_again_over_a_real_pipe()
    {
        _f.Seed(Revoked());
        _f.Create().Initialize();
        using var stop = new CancellationTokenSource();
        var running = Server().RunAsync(stop.Token);
        var client = new PipeClient(_pipeName, static () => Environment.ProcessId);
        var ct = TestContext.Current.CancellationToken;

        var status = await client.SendAsync(new PipeRequest { Command = PipeProtocol.StatusCommand }, ct);
        Assert.Equal(PipeFailure.None, status.Failure);
        Assert.Equal(AgentStates.Revoked, status.Response!.Status!.State);
        Assert.True(status.Response.Status.CanRejoin);

        var rejoin = await client.SendAsync(new PipeRequest { Command = PipeProtocol.RejoinCommand }, ct);
        Assert.True(rejoin.Response!.Ok);
        Assert.False(rejoin.Response.Status!.CanRejoin);
        Assert.Equal(EngineFixture.Origin, _f.LastEngine.State.Pending!.ServerOrigin);
        Assert.NotEqual(EngineFixture.InstallId, _f.LastEngine.State.InstallId);

        // Several clients in a row and at once.
        var replies = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => client.SendAsync(new PipeRequest { Command = PipeProtocol.StatusCommand }, ct)));
        Assert.All(replies, r => Assert.Equal(PipeFailure.None, r.Failure));
        Assert.All(replies, r => Assert.DoesNotContain(_f.LastEngine.State.Pending!.Token, r.Response!.ToString(), StringComparison.Ordinal));

        await StopAsync(stop, running);
    }

    [Fact]
    public async Task The_client_writes_nothing_when_the_server_end_is_not_the_service()
    {
        _f.Seed(Revoked());
        _f.Create().Initialize();
        using var stop = new CancellationTokenSource();
        var running = Server().RunAsync(stop.Token);
        var ct = TestContext.Current.CancellationToken;

        foreach (var pid in new int?[] { null, Environment.ProcessId + 1 })
        {
            var client = new PipeClient(_pipeName, () => pid);
            var reply = await client.SendAsync(new PipeRequest { Command = PipeProtocol.RejoinCommand }, ct);
            Assert.Equal(PipeFailure.NotTheService, reply.Failure);
        }

        Assert.Equal(IdentityStates.Revoked, _f.LastEngine.State.IdentityState);
        Assert.Null(_f.LastEngine.State.Pending);
        await StopAsync(stop, running);
    }

    [Fact]
    public async Task Clients_that_connect_and_close_at_once_do_not_stop_the_server()
    {
        _f.Create().Initialize();
        using var stop = new CancellationTokenSource();
        var running = Server().RunAsync(stop.Token);
        var ct = TestContext.Current.CancellationToken;

        for (var i = 0; i < 30; i++)
        {
            using var pipe = new NamedPipeClientStream(".", _pipeName, PipeClient.Rights, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
            await pipe.ConnectAsync(5000, ct);
        }

        var reply = await new PipeClient(_pipeName, static () => Environment.ProcessId).SendAsync(new PipeRequest { Command = PipeProtocol.StatusCommand }, ct);
        Assert.Equal(PipeFailure.None, reply.Failure);
        Assert.False(running.IsCompleted, running.Exception?.ToString());
        await StopAsync(stop, running);
    }

    [Fact]
    public async Task A_client_with_only_the_interactive_rights_can_connect()
    {
        // The service SID here is LocalService, so this process gets access
        // only through the INTERACTIVE rule (or as an elevated administrator).
        using var server = NamedPipeServerStreamAcl.Create(
            _pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0,
            PipeAcl.Create(PathPolicy.LocalService));
        var waiting = server.WaitForConnectionAsync(TestContext.Current.CancellationToken);
        using var client = new NamedPipeClientStream(".", _pipeName, PipeClient.Rights, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
        await client.ConnectAsync(5000, TestContext.Current.CancellationToken);
        await waiting;
        Assert.True(client.IsConnected);
        Assert.Equal(Environment.ProcessId, ServiceProcessCheck.PipeServerPid(client.SafePipeHandle));
    }

    [Fact]
    public async Task A_pipe_that_another_process_created_first_is_never_joined()
    {
        _f.Create().Initialize();
        using var squatter = new NamedPipeServerStream(_pipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var time = new FakeTimeProvider();
        using var stop = new CancellationTokenSource();
        var running = Server(time: time).RunAsync(stop.Token);

        await Eventually.TrueAsync(() => _f.Logs.Lines.Any(l => l.Contains("already exists", StringComparison.Ordinal)), "squatting logged");
        await StopAsync(stop, running);
    }

    [Fact]
    public void The_service_PID_comes_from_the_service_control_manager()
    {
        Assert.True(ServiceProcessCheck.RunningServicePid("EventLog") > 0);
        Assert.Null(ServiceProcessCheck.RunningServicePid($"Mashkif.NoSuchService.{Guid.NewGuid():N}"));
    }

    [Fact]
    public async Task No_pipe_means_the_service_is_not_running()
    {
        var client = new PipeClient($"Mashkif.Tests.Absent.{Guid.NewGuid():N}", static () => Environment.ProcessId);
        var reply = await client.SendAsync(new PipeRequest { Command = PipeProtocol.StatusCommand }, TestContext.Current.CancellationToken);
        Assert.Equal(PipeFailure.ServiceUnavailable, reply.Failure);
    }

    private static async Task StopAsync(CancellationTokenSource stop, Task running)
    {
        await stop.CancelAsync();
        try
        {
            await running;
        }
        catch (OperationCanceledException)
        {
        }
    }

    [Fact]
    public async Task A_line_reader_stops_at_its_limit()
    {
        using var stream = new MemoryStream(new byte[PipeProtocol.MaxRequestBytes + 10]);
        Assert.Null(await PipeLines.ReadLineAsync(stream, PipeProtocol.MaxRequestBytes, TestContext.Current.CancellationToken));
        using var line = new MemoryStream("{\"a\":1}\nrest"u8.ToArray());
        Assert.Equal("{\"a\":1}", await PipeLines.ReadLineAsync(line, PipeProtocol.MaxRequestBytes, TestContext.Current.CancellationToken));
    }
}
