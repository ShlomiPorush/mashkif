using Mashkif.Common;

namespace Mashkif.Agent.Tests;

public sealed class CommonTests
{
    [Fact]
    public void FileLog_creates_the_folder_and_appends_timestamped_lines()
    {
        using var scratch = new TestScratch();
        var path = scratch.File("nested", "logs", "test.log");
        var log = new FileLog(path, new FixedTimeProvider(new DateTimeOffset(2026, 11, 1, 9, 30, 15, 250, TimeSpan.Zero)));

        log.Write("info", "first");
        log.Write("warn", "second\r\nline\nbreaks");

        var lines = File.ReadAllLines(path);
        Assert.Equal(
            [
                "2026-11-01T09:30:15.250Z INFO  first",
                "2026-11-01T09:30:15.250Z WARN  second | line breaks",
            ],
            lines);
    }

    [Fact]
    public void FileLog_allows_other_readers_while_writing()
    {
        using var scratch = new TestScratch();
        var path = scratch.File("shared.log");
        var log = new FileLog(path);
        log.Write("info", "one");

        using var reader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        log.Write("info", "two");

        Assert.Equal(2, File.ReadAllLines(path).Length);
    }

    [Fact]
    public void Log_paths_use_the_standard_Windows_data_folders()
    {
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        Assert.Equal(Path.Combine(programData, "Mashkif", "logs", "service.log"), AgentLogPaths.ServiceLogFile);
        Assert.Equal(Path.Combine(localAppData, "Mashkif", "logs", "tray.log"), AgentLogPaths.TrayLogFile);
    }
}
