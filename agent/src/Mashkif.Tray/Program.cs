using Mashkif.Common;

namespace Mashkif.Tray;

internal static class Program
{
    // One tray instance per user session.
    private const string InstanceMutexName = @"Local\Mashkif.Tray";

    [STAThread]
    private static int Main()
    {
        var log = new FileLog(AgentLogPaths.TrayLogFile);

        using var mutex = new Mutex(initiallyOwned: true, InstanceMutexName, out var createdNew);
        if (!createdNew)
        {
            log.Write("info", "Mashkif tray is already running in this session; exiting");
            return 0;
        }

        ApplicationConfiguration.Initialize();
        log.Write(
            "info",
            $"Mashkif tray {AgentInfo.VersionOf(typeof(Program).Assembly)} started (process {Environment.ProcessId}, UI culture {Thread.CurrentThread.CurrentUICulture.Name})");

        using (var context = new TrayContext(log, PipeClient.Production()))
        {
            Application.Run(context);
        }

        log.Write("info", "Mashkif tray exited");
        return 0;
    }
}
