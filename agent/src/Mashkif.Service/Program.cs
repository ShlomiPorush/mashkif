using Mashkif.Common;
using Mashkif.Service;

ServiceHost.CreateBuilder(args, new FileLoggerProvider(new FileLog(AgentLogPaths.ServiceLogFile))).Build().Run();
