using Mashkif.Service;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mashkif.Agent.Tests;

/// <summary>The service host: its shutdown budget, the stop-path logging, and the power-event lifetime (P15).</summary>
public sealed partial class ServiceHostTests
{
    [Fact]
    public void The_host_stop_is_bounded_at_5_seconds_through_HostOptions()
    {
        using var provider = new BlockingLoggerProvider();
        using var host = ServiceHost.CreateBuilder([], provider).Build();
        Assert.Equal(TimeSpan.FromSeconds(5), host.Services.GetRequiredService<IOptions<HostOptions>>().Value.ShutdownTimeout);
    }

    [Fact]
    public async Task The_lifetime_log_line_of_a_stop_never_reaches_the_file_log()
    {
        using var provider = new BlockingLoggerProvider();
        using var host = ServiceHost.CreateBuilder([], provider).Build();
        var lifetime = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Microsoft.Hosting.Lifetime");

        // With the filter, "Application is shutting down..." is not passed to the provider at all.
        Assert.False(lifetime.IsEnabled(LogLevel.Information));
        var write = Task.Run(() => LogShuttingDown(lifetime), TestContext.Current.CancellationToken);
        await write.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal(0, provider.Writes);

        // A warning of the host still reaches the log.
        Assert.True(lifetime.IsEnabled(LogLevel.Warning));
    }

    [Fact]
    public async Task Without_the_filter_a_stuck_log_write_would_block_the_stop_before_its_bounded_wait()
    {
        // Documents the stuck-disk limitation of decision 8: the host writes this line
        // synchronously during StopApplication, before WindowsServiceLifetime waits.
        using var provider = new BlockingLoggerProvider();
        using var factory = LoggerFactory.Create(builder => builder.AddProvider(provider).AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Information));
        var lifetime = factory.CreateLogger("Microsoft.Hosting.Lifetime");
        var write = Task.Run(() => LogShuttingDown(lifetime), TestContext.Current.CancellationToken);
        Assert.NotSame(write, await Task.WhenAny(write, Task.Delay(300, TestContext.Current.CancellationToken)));
        provider.Release();
        await write.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public void The_service_lifetime_accepts_power_events_and_shutdown()
    {
        using var provider = new BlockingLoggerProvider();
        var builder = ServiceHost.CreateBuilder([], provider);
        builder.Services.AddSingleton<MashkifServiceLifetime>();
        using var host = builder.Build();
        using var lifetime = host.Services.GetRequiredService<MashkifServiceLifetime>();
        Assert.True(lifetime.CanHandlePowerEvent);
        Assert.True(lifetime.CanShutdown);
        Assert.True(lifetime.CanStop);
    }

    /// <summary>The line WindowsServiceLifetime writes in its ApplicationStopping callback.</summary>
    [LoggerMessage(Level = LogLevel.Information, Message = "Application is shutting down...")]
    private static partial void LogShuttingDown(ILogger logger);

    /// <summary>A log provider whose every write blocks until released, like a stuck disk.</summary>
    private sealed class BlockingLoggerProvider : ILoggerProvider
    {
        private readonly ManualResetEventSlim _released = new();
        private int _writes;

        public int Writes => Volatile.Read(ref _writes);

        public void Release() => _released.Set();

        public ILogger CreateLogger(string categoryName) => new BlockingLogger(this);

        public void Dispose()
        {
            _released.Set();
            _released.Dispose();
        }

        private sealed class BlockingLogger(BlockingLoggerProvider owner) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                Interlocked.Increment(ref owner._writes);
                owner._released.Wait(TimeSpan.FromSeconds(30));
            }
        }
    }
}
