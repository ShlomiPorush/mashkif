using System.Globalization;
using System.Text;

namespace Mashkif.Common;

/// <summary>
/// Appends timestamped lines to a UTF-8 log file. Safe to share between
/// threads in one process; other processes may read the file while it is open.
/// </summary>
public sealed class FileLog
{
    private readonly object _gate = new();
    private readonly TimeProvider _time;

    /// <summary>Creates a log that writes to <paramref name="path"/>.</summary>
    public FileLog(string path, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        Path = System.IO.Path.GetFullPath(path);
        _time = time ?? TimeProvider.System;
    }

    /// <summary>Full path of the log file.</summary>
    public string Path { get; }

    /// <summary>
    /// Appends one line: UTC timestamp, level, and message. Line breaks in the
    /// message are replaced so each entry stays on one line.
    /// </summary>
    public void Write(string level, string message)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(level);
        ArgumentNullException.ThrowIfNull(message);

        var line = string.Create(
            CultureInfo.InvariantCulture,
            $"{_time.GetUtcNow():yyyy-MM-ddTHH:mm:ss.fffZ} {level.ToUpperInvariant(),-5} {Flatten(message)}\n");
        var bytes = Encoding.UTF8.GetBytes(line);

        lock (_gate)
        {
            var directory = System.IO.Path.GetDirectoryName(Path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            using var stream = new FileStream(Path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            stream.Write(bytes);
        }
    }

    private static string Flatten(string message) =>
        message.Replace("\r\n", " | ", StringComparison.Ordinal)
            .Replace('\n', ' ')
            .Replace('\r', ' ');
}
