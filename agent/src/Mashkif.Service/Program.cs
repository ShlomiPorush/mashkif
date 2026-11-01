using Mashkif.Common;
using Mashkif.Service;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options => options.ServiceName = AgentService.ServiceName);

// Only the file log: the default Event Log provider needs an event source that
// the LocalService account cannot register.
builder.Logging.ClearProviders();
builder.Logging.AddProvider(new FileLoggerProvider(new FileLog(AgentLogPaths.ServiceLogFile)));
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Information);

builder.Services.AddHostedService<AgentService>();

builder.Build().Run();
