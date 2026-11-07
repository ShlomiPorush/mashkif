using Mashkif.Common.Pipe;
using Mashkif.Service.Agent;
using Mashkif.Service.Config;
using Mashkif.Service.Pipe;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;

namespace Mashkif.Service;

/// <summary>The installed agent: production paths, registry, HTTP, and pipe.</summary>
internal sealed partial class AgentRuntime(ILoggerFactory loggers, LifecycleRecorder recorder) : IAgentRunner
{
    public async Task RunAsync(CancellationToken stoppingToken)
    {
        var logger = loggers.CreateLogger<AgentRuntime>();
        var registry = AgentRegistry.Production();
        var origin = ServerOrigin.Parse(registry.ReadServerUrl());

        Guid bootId;
        try
        {
            bootId = BootIdentity.GetOrCreate(registry.Root, registry.ServiceKeyPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException or System.Security.SecurityException)
        {
            // Without the MSI-created key the PC is not installed correctly;
            // a fresh boot ID per start is the safe fallback.
            LogBootIdFallback(logger, exception.GetType().Name);
            bootId = Guid.NewGuid();
        }

        using var http = new HttpClient(AgentApiClient.CreateHandler()) { Timeout = Timeout.InfiniteTimeSpan };
        var store = StateStore.Production();
        using var engine = new AgentEngine(
            new AgentEngineOptions
            {
                Store = store,
                Origin = origin,
                Http = http,
                BootId = bootId,
                AgentVersion = AgentService.Version,
                OsVersion = OsVersion(),
                Queue = new Events.EventQueue(store.StateDirectory, store.Policy),
            },
            loggers.CreateLogger<AgentEngine>());
        engine.Initialize();
        recorder.Attach(engine);

        var pipe = new PipeServer(
            engine,
            PipeAcl.Create(PathPolicy.MashkifServiceSid),
            PipeProtocol.PipeName,
            loggers.CreateLogger<PipeServer>(),
            TimeProvider.System);

        try
        {
            await Task.WhenAll(engine.RunAsync(stoppingToken), pipe.RunAsync(stoppingToken)).ConfigureAwait(false);
        }
        finally
        {
            recorder.Detach();
        }
    }

    /// <summary>Windows version, for example 10.0.26100.</summary>
    internal static string OsVersion()
    {
        var version = Environment.OSVersion.Version;
        return $"{version.Major}.{version.Minor}.{version.Build}";
    }

    [LoggerMessage(EventId = 40, Level = LogLevel.Warning, Message = "The boot ID key is not available ({Error}); using a new boot ID")]
    private static partial void LogBootIdFallback(ILogger logger, string error);
}
