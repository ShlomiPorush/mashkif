using Mashkif.Common;
using Mashkif.Service;
using Microsoft.Extensions.Logging;

namespace Mashkif.Agent.Tests;

public sealed class ServiceTests
{
    [Fact]
    public async Task Service_logs_start_and_stop_to_the_file_log()
    {
        using var scratch = new TestScratch();
        var path = scratch.File("service.log");
        using var provider = new FileLoggerProvider(new FileLog(path));
        using var factory = LoggerFactory.Create(builder => builder.AddProvider(provider));
        using var service = new AgentService(factory.CreateLogger<AgentService>(), new IdleRunner());

        await service.StartAsync(TestContext.Current.CancellationToken);
        await service.StopAsync(TestContext.Current.CancellationToken);

        var lines = File.ReadAllLines(path);
        Assert.Equal(2, lines.Length);
        Assert.Matches(
            @"^\S+Z INFO  \[Mashkif\.Service\.AgentService\] Mashkif service \d+\.\d+\.\d+\S* started \(process \d+\)$",
            lines[0]);
        Assert.EndsWith("INFO  [Mashkif.Service.AgentService] Mashkif service stopped", lines[1], StringComparison.Ordinal);
    }

    [Fact]
    public void Service_name_matches_the_installer()
    {
        Assert.Equal("Mashkif", AgentService.ServiceName);
    }

    private sealed class IdleRunner : IAgentRunner
    {
        public Task RunAsync(CancellationToken stoppingToken) => Task.Delay(Timeout.Infinite, stoppingToken);
    }
}
