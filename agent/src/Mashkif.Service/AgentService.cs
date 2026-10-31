using Mashkif.Common;

namespace Mashkif.Service;

/// <summary>
/// The Mashkif Windows service. In this skeleton it only records that it
/// started and stopped.
/// </summary>
internal sealed partial class AgentService(ILogger<AgentService> logger) : BackgroundService
{
    /// <summary>Windows service name registered by the installer.</summary>
    public const string ServiceName = "Mashkif";

    private static readonly string Version = AgentInfo.VersionOf(typeof(AgentService).Assembly);

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

    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.Delay(Timeout.Infinite, stoppingToken).ContinueWith(
            static _ => { },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

    [LoggerMessage(EventId = 1, Level = LogLevel.Information, Message = "Mashkif service {Version} started (process {ProcessId})")]
    private static partial void LogStarted(ILogger logger, string version, int processId);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "Mashkif service stopped")]
    private static partial void LogStopped(ILogger logger);
}
