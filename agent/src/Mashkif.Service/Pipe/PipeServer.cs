using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Mashkif.Common.Pipe;
using Mashkif.Service.Agent;
using Mashkif.Service.State;

namespace Mashkif.Service.Pipe;

/// <summary>The access rules of the service pipe.</summary>
internal static class PipeAcl
{
    /// <summary>NT AUTHORITY\NETWORK: every remote logon carries it.</summary>
    public static readonly SecurityIdentifier Network = new(WellKnownSidType.NetworkSid, null);

    /// <summary>NT AUTHORITY\INTERACTIVE: users signed in at the PC or over Remote Desktop.</summary>
    public static readonly SecurityIdentifier Interactive = new(WellKnownSidType.InteractiveSid, null);

    /// <summary>
    /// What an interactive client may do: read and write data, read attributes,
    /// and wait. No CreateNewInstance, no WriteAttributes (the pipe stays in byte mode).
    /// </summary>
    public const PipeAccessRights ClientRights =
        PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize;

    /// <summary>
    /// Deny NETWORK; allow SYSTEM, Administrators, and the service SID full
    /// control; allow INTERACTIVE <see cref="ClientRights"/>; restrict the
    /// owner (LocalService, shared by other services) to read control.
    /// </summary>
    public static PipeSecurity Create(SecurityIdentifier serviceSid)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(Network, PipeAccessRights.FullControl, AccessControlType.Deny));
        foreach (var sid in new[] { PathPolicy.LocalSystem, PathPolicy.Administrators, serviceSid })
        {
            security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        }

        security.AddAccessRule(new PipeAccessRule(Interactive, ClientRights, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(PathPolicy.OwnerRights, PipeAccessRights.ReadPermissions, AccessControlType.Allow));
        return security;
    }
}

/// <summary>
/// The local pipe the tray app talks to. One request line and one response
/// line per connection. The first instance is created with
/// <see cref="PipeOptions.FirstPipeInstance"/>, so a pipe that another process
/// created first is never joined.
/// </summary>
internal sealed partial class PipeServer(AgentEngine engine, PipeSecurity security, string pipeName, ILogger<PipeServer> logger, TimeProvider time)
{
    /// <summary>Most instances: one listening, the rest handling connections.</summary>
    public const int MaxInstances = 4;

    private static readonly TimeSpan SquatRetry = TimeSpan.FromSeconds(30);

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        using var handlers = new SemaphoreSlim(MaxInstances - 1, MaxInstances - 1);
        NamedPipeServerStream? listening = await CreateFirstAsync(stoppingToken).ConfigureAwait(false);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                while (listening is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), time, stoppingToken).ConfigureAwait(false);
                    listening = TryCreate(first: false);
                }

                try
                {
                    await listening.WaitForConnectionAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    // A client connected and closed before the wait completed
                    // ("the pipe is being closed"). Replace the instance and go on;
                    // the replacement is created first, so the name stays ours.
                    var replacement = TryCreate(first: false);
                    await listening.DisposeAsync().ConfigureAwait(false);
                    listening = replacement;
                    continue;
                }

                await handlers.WaitAsync(stoppingToken).ConfigureAwait(false);

                // Create the next instance before this one is handed off, so the
                // pipe name always has an instance of this process.
                var next = TryCreate(first: false);
                var connected = listening;
                listening = next;
                _ = HandleAsync(connected, handlers, stoppingToken);
            }
        }
        finally
        {
            if (listening is not null)
            {
                await listening.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private async Task<NamedPipeServerStream> CreateFirstAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            var pipe = TryCreate(first: true);
            if (pipe is not null)
            {
                return pipe;
            }

            await Task.Delay(SquatRetry, time, stoppingToken).ConfigureAwait(false);
        }
    }

    private NamedPipeServerStream? TryCreate(bool first)
    {
        try
        {
            return NamedPipeServerStreamAcl.Create(
                pipeName,
                PipeDirection.InOut,
                MaxInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None),
                PipeProtocol.MaxRequestBytes,
                PipeProtocol.MaxResponseBytes,
                security);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            if (first)
            {
                LogSquatted(logger, pipeName, exception.GetType().Name);
            }
            else
            {
                LogCreateFailed(logger, exception.GetType().Name);
            }

            return null;
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, SemaphoreSlim handlers, CancellationToken stoppingToken)
    {
        try
        {
            await using (pipe.ConfigureAwait(false))
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(PipeProtocol.RequestTimeout);
                var line = await PipeLines.ReadLineAsync(pipe, PipeProtocol.MaxRequestBytes, timeout.Token).ConfigureAwait(false);
                var response = Dispatch(line);
                await PipeLines.WriteLineAsync(pipe, response, PipeJsonContext.Default.PipeResponse, timeout.Token).ConfigureAwait(false);

                // Wait until the client has read the answer and closed its end.
                var rest = new byte[1];
                while (await pipe.ReadAsync(rest, timeout.Token).ConfigureAwait(false) > 0)
                {
                }
            }
        }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException)
        {
            // The client went away or was too slow; nothing to answer.
        }
        finally
        {
            handlers.Release();
        }
    }

    /// <summary>Answers one request line. Public for tests.</summary>
    internal PipeResponse Dispatch(string? line)
    {
        var request = PipeLines.Parse(line, PipeJsonContext.Default.PipeRequest);
        if (request is null)
        {
            return PipeResponse.Failure(PipeErrors.RequestInvalid);
        }

        if (request.Version != PipeProtocol.Version)
        {
            return PipeResponse.Failure(PipeErrors.VersionUnsupported);
        }

        switch (request.Command)
        {
            case PipeProtocol.StatusCommand:
                return PipeResponse.Success(engine.Status());
            case PipeProtocol.RejoinCommand:
                return engine.Rejoin();
            default:
                return PipeResponse.Failure(PipeErrors.UnknownCommand);
        }
    }

    [LoggerMessage(EventId = 30, Level = LogLevel.Error, Message = "The pipe {PipeName} already exists in another process ({Error}); retrying in 30 seconds")]
    private static partial void LogSquatted(ILogger logger, string pipeName, string error);

    [LoggerMessage(EventId = 31, Level = LogLevel.Warning, Message = "A new pipe instance could not be created: {Error}")]
    private static partial void LogCreateFailed(ILogger logger, string error);
}
