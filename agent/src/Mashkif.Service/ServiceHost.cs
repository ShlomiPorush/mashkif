using Microsoft.Extensions.Hosting.WindowsServices;

namespace Mashkif.Service;

/// <summary>The host of the Windows service, built in one place so tests can check its configuration.</summary>
internal static class ServiceHost
{
    /// <summary>
    /// The host stop after a shutdown or a stop: <c>HostOptions.ShutdownTimeout</c>
    /// (30 seconds by default). With the 5 seconds of the shutdown event,
    /// <c>OnShutdown</c> returns within 10 seconds on a healthy disk.
    /// </summary>
    public static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(5);

    public static HostApplicationBuilder CreateBuilder(string[] args, ILoggerProvider logProvider)
    {
        var builder = Host.CreateApplicationBuilder(args);

        builder.Services.AddWindowsService(options => options.ServiceName = AgentService.ServiceName);
        builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = ShutdownTimeout);
        builder.Services.AddSingleton<LifecycleRecorder>();

        // AddWindowsService sets WindowsServiceLifetime only when the process runs as a
        // service; the extended lifetime follows the same rule (the last IHostLifetime wins).
        if (WindowsServiceHelpers.IsWindowsService())
        {
            builder.Services.AddSingleton<IHostLifetime, MashkifServiceLifetime>();
        }

        // Only the file log: the default Event Log provider needs an event source that
        // the LocalService account cannot register.
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(logProvider);

        // Microsoft.Hosting.Lifetime falls under this rule too, so its "Application is
        // shutting down..." line, written synchronously during StopApplication before the
        // bounded wait, never reaches the file write (step 2c, P15).
        builder.Logging.AddFilter("Microsoft", LogLevel.Warning);

        // HttpClient logs request URLs and headers at Information; the agent logs its own outcomes.
        builder.Logging.AddFilter("System.Net.Http", LogLevel.Warning);

        builder.Services.AddSingleton<IAgentRunner, AgentRuntime>();
        builder.Services.AddHostedService<AgentService>();
        return builder;
    }
}
