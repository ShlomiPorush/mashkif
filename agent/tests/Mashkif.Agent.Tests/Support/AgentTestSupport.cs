using System.Collections.Concurrent;
using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Mashkif.Service.Agent;
using Mashkif.Service.Config;
using Mashkif.Service.State;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Mashkif.Agent.Tests.Support;

/// <summary>One request the scripted handler received.</summary>
internal sealed record RecordedRequest(string Method, Uri Uri, string? Authorization, string? ProtocolVersion, string Body);

/// <summary>
/// An HTTP handler that answers from a script, records every request, and
/// can block a request until the test releases it.
/// </summary>
internal sealed class ScriptedHandler : HttpMessageHandler
{
    private readonly ConcurrentQueue<Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>> _script = new();
    private readonly ConcurrentQueue<RecordedRequest> _requests = new();
    private readonly SemaphoreSlim _arrived = new(0);

    public IReadOnlyList<RecordedRequest> Requests => [.. _requests];

    /// <summary>Runs before each answer, inside the request.</summary>
    public Action<RecordedRequest>? OnRequest { get; set; }

    public void Enqueue(Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> answer) => _script.Enqueue(answer);

    public void Enqueue(HttpStatusCode status, string json, Action<HttpResponseMessage>? configure = null) =>
        Enqueue((_, _) =>
        {
            var response = new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
            configure?.Invoke(response);
            return Task.FromResult(response);
        });

    /// <summary>A lost answer: the request went out, no response came back.</summary>
    public void EnqueueLost() => Enqueue((_, _) => throw new HttpRequestException("connection reset"));

    /// <summary>Waits until <paramref name="count"/> requests in total have arrived.</summary>
    public async Task WaitForRequestsAsync(int count, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));
        while (_requests.Count < count)
        {
            var left = deadline - DateTime.UtcNow;
            if (left <= TimeSpan.Zero)
            {
                throw new TimeoutException($"Expected {count} requests, got {_requests.Count}.");
            }

            await _arrived.WaitAsync(left).ConfigureAwait(false);
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        request.Headers.TryGetValues("Mashkif-Protocol-Version", out var versions);
        var recorded = new RecordedRequest(
            request.Method.Method,
            request.RequestUri!,
            request.Headers.Authorization?.ToString(),
            versions?.FirstOrDefault(),
            body);
        OnRequest?.Invoke(recorded);
        var answer = _script.TryDequeue(out var next)
            ? next
            : (_, _) => throw new HttpRequestException("no scripted answer");
        _requests.Enqueue(recorded);
        _arrived.Release();
        return await answer(recorded, cancellationToken).ConfigureAwait(false);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _arrived.Dispose();
        }

        base.Dispose(disposing);
    }
}

/// <summary>Collects log lines, to check that no secret reaches the log.</summary>
internal sealed class ListLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _lines = new();

    public IReadOnlyList<string> Lines => [.. _lines];

    public ILogger CreateLogger(string categoryName) => new ListLogger(_lines);

    public void Dispose()
    {
    }

    private sealed class ListLogger(ConcurrentQueue<string> lines) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            lines.Enqueue($"{logLevel}: {formatter(state, exception)} {exception}");
    }
}

/// <summary>
/// A product directory and a state directory with the production ACL shape,
/// where the current user stands in for the service SID.
/// </summary>
internal sealed class StateFixture : IDisposable
{
    public static readonly SecurityIdentifier CurrentUser = WindowsIdentity.GetCurrent().User!;

    private readonly TestScratch _scratch = new();

    public StateFixture()
    {
        ProductDirectory = _scratch.File("Mashkif");
        StateDirectory = Path.Combine(ProductDirectory, "state");
        Policy = new PathPolicy(
            CurrentUser,
            [PathPolicy.LocalSystem, PathPolicy.Administrators, CurrentUser],
            [PathPolicy.LocalSystem, PathPolicy.Administrators, CurrentUser],
            [PathPolicy.LocalSystem, PathPolicy.Administrators, PathPolicy.LocalService, CurrentUser]);
        new DirectoryInfo(ProductDirectory).Create(ProductSecurity());
        new DirectoryInfo(StateDirectory).Create(StateSecurity());
    }

    public string ProductDirectory { get; }

    public string StateDirectory { get; }

    public PathPolicy Policy { get; }

    public string StateFile => Path.Combine(StateDirectory, StateStore.FileName);

    public StateStore CreateStore() => new(ProductDirectory, StateDirectory, Policy);

    /// <summary>Like the MSI SDDL of %ProgramData%\Mashkif, with the current user as a writer.</summary>
    public static DirectorySecurity ProductSecurity(bool includeOwnerRights = true)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { PathPolicy.LocalSystem, PathPolicy.Administrators, CurrentUser })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        }

        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), PathPolicy.ReadOnlyRights, AccessControlType.Allow));
        if (includeOwnerRights)
        {
            security.AddAccessRule(new FileSystemAccessRule(PathPolicy.OwnerRights, FileSystemRights.ReadPermissions, AccessControlType.Allow));
        }

        return security;
    }

    /// <summary>Like the MSI SDDL of the state directory, with the current user as the service SID.</summary>
    public static DirectorySecurity StateSecurity(bool includeOwnerRights = true, FileSystemRights ownerRights = FileSystemRights.ReadPermissions)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { PathPolicy.LocalSystem, PathPolicy.Administrators, CurrentUser })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        }

        if (includeOwnerRights)
        {
            security.AddAccessRule(new FileSystemAccessRule(PathPolicy.OwnerRights, ownerRights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        }

        return security;
    }

    public void Dispose() => _scratch.Dispose();
}

/// <summary>Builds engines over one state directory, as a service restart would.</summary>
internal sealed class EngineFixture : IDisposable
{
    public const string Origin = "https://mashkif.test";

    private readonly List<AgentEngine> _engines = [];
    private readonly List<(Task Task, CancellationTokenSource Stop)> _running = [];
    private int _credentials;

    public EngineFixture()
    {
        Http = new HttpClient(Handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public StateFixture State { get; } = new();

    public ScriptedHandler Handler { get; } = new();

    public HttpClient Http { get; }

    public FakeTimeProvider Time { get; } = new(new DateTimeOffset(2026, 11, 2, 9, 0, 0, TimeSpan.Zero));

    public ListLoggerProvider Logs { get; } = new();

    public Guid BootId { get; } = Guid.Parse("7c9e6679-7425-40de-944b-e07fc1f90ae7");

    public StateStore Store { get; private set; } = null!;

    /// <summary>The engine created last.</summary>
    public AgentEngine LastEngine => _engines[^1];

    /// <summary>The engine created last, or a new one.</summary>
    public AgentEngine LastEngineOrNew() => _engines.Count > 0 ? _engines[^1] : Create();

    /// <summary>Install IDs and tokens handed out, in order.</summary>
    public List<Credentials> IssuedCredentials { get; } = [];

    public AgentEngine Create(string? origin = Origin)
    {
        Store = State.CreateStore();
        var loggerFactory = LoggerFactory.Create(builder => builder.AddProvider(Logs).SetMinimumLevel(LogLevel.Trace));
        var engine = new AgentEngine(
            new AgentEngineOptions
            {
                Store = Store,
                Origin = origin is null ? null : ServerOrigin.Parse(origin),
                Http = Http,
                BootId = BootId,
                AgentVersion = "0.1.0",
                OsVersion = "10.0.26100",
                Time = Time,
                NewCredentials = NextCredentials,
                MeasureDns = static (_, _) => Task.FromResult<int?>(4),
            },
            loggerFactory.CreateLogger<AgentEngine>());
        _engines.Add(engine);
        return engine;
    }

    public AgentEngine Start(string? origin = Origin)
    {
        var engine = Create(origin);
        engine.Initialize();
        Run(engine);
        return engine;
    }

    public void Run(AgentEngine engine)
    {
        var stop = new CancellationTokenSource();
        _running.Add((Task.Run(() => engine.RunAsync(stop.Token)), stop));
    }

    /// <summary>Stops every running engine, like a service stop or a crash.</summary>
    public async Task StopAllAsync()
    {
        foreach (var (task, stop) in _running)
        {
            await stop.CancelAsync();
            try
            {
                await task;
            }
            catch (OperationCanceledException)
            {
            }

            stop.Dispose();
        }

        _running.Clear();
    }

    /// <summary>Saves a state directly, as an earlier run would have left it.</summary>
    public void Seed(AgentState state) => State.CreateStore().Save(state);

    /// <summary>The install ID of a seeded state.</summary>
    public static readonly Guid InstallId = Guid.Parse("11111111-1111-4111-8111-111111111111");

    /// <summary>An active identity on <paramref name="origin"/>, as an earlier run would have saved it.</summary>
    public static AgentState Registered(string origin = Origin) =>
        AgentState.Empty with { InstallId = InstallId, Identity = Identity(origin), IdentityState = IdentityStates.Active };

    /// <summary>The token of a seeded identity: random for each test run, never a fixed value.</summary>
    public static readonly string SeededToken = NewToken();

    public static AgentIdentity Identity(string origin = Origin, string? token = null) => new()
    {
        ServerOrigin = origin,
        Token = token ?? SeededToken,
        AgentId = Guid.Parse("22222222-2222-4222-8222-222222222222"),
    };

    /// <summary>32 random bytes in base64url, like a real token.</summary>
    public static string NewToken() =>
        System.Buffers.Text.Base64Url.EncodeToString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));

    private Credentials NextCredentials()
    {
        // The install IDs stay readable (an install ID is not a secret); the tokens are random.
        var n = Interlocked.Increment(ref _credentials);
        var credentials = new Credentials(
            Guid.Parse($"aaaaaaaa-aaaa-4aaa-8aaa-{n:D12}"),
            NewToken());
        IssuedCredentials.Add(credentials);
        return credentials;
    }

    public void Dispose()
    {
        StopAllAsync().GetAwaiter().GetResult();
        foreach (var engine in _engines)
        {
            engine.Dispose();
        }

        Http.Dispose();
        Handler.Dispose();
        Logs.Dispose();
        State.Dispose();
    }
}

/// <summary>Polls a condition in real time.</summary>
internal static class Eventually
{
    public static async Task TrueAsync(Func<bool> condition, string because, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail($"Timed out: {because}");
            }

            await Task.Delay(10);
        }
    }

    /// <summary>Lets background work that is ready run, without advancing the fake clock.</summary>
    public static Task SettleAsync() => Task.Delay(150);
}
