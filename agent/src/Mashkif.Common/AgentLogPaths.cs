namespace Mashkif.Common;

/// <summary>
/// Standard log file locations for the agent components.
/// </summary>
public static class AgentLogPaths
{
    /// <summary>Folder name used under the Windows data folders.</summary>
    public const string ProductFolder = "Mashkif";

    /// <summary>Service log file name.</summary>
    public const string ServiceLogFileName = "service.log";

    /// <summary>Tray app log file name.</summary>
    public const string TrayLogFileName = "tray.log";

    /// <summary>
    /// Machine-wide log folder for the Windows service: %ProgramData%\Mashkif\logs.
    /// </summary>
    public static string ServiceLogDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            ProductFolder,
            "logs");

    /// <summary>
    /// Per-user log folder for the tray app: %LOCALAPPDATA%\Mashkif\logs.
    /// </summary>
    public static string TrayLogDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            ProductFolder,
            "logs");

    /// <summary>Full path of the service log file.</summary>
    public static string ServiceLogFile => Path.Combine(ServiceLogDirectory, ServiceLogFileName);

    /// <summary>Full path of the tray app log file.</summary>
    public static string TrayLogFile => Path.Combine(TrayLogDirectory, TrayLogFileName);
}
