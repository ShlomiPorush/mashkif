using Mashkif.Common;

namespace Mashkif.Service;

/// <summary>The work the service runs between start and stop.</summary>
internal interface IAgentRunner
{
    Task RunAsync(CancellationToken stoppingToken);
}

/// <summary>
/// The Mashkif Windows service: logs start and stop and runs the agent
/// (registration, heartbeats, and the local pipe).
/// </summary>
internal sealed partial class AgentService(ILogger<AgentService> logger, IAgentRunner runner) : BackgroundService
{
    /// <summary>Windows service name registered by the installer.</summary>
    public const string ServiceName = "Mashkif";

    public static readonly string Version = AgentInfo.VersionOf(typeof(AgentService).Assembly);

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        LogStarted(logger, Version, Environment.ProcessId);
        return base.StartAsync(cancellationToken);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
        LogStopped(logger);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await runner.RunAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal stop.
        }
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Information, Message = "Mashkif service {Version} started (process {ProcessId})")]
    private static partial void LogStarted(ILogger logger, string version, int processId);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "Mashkif service stopped")]
    private static partial void LogStopped(ILogger logger);
}
