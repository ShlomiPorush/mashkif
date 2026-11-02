using System.Text;
using System.Text.Json;

namespace Mashkif.Common.Pipe;

/// <summary>
/// Reads and writes the one-line UTF-8 JSON messages of the pipe protocol.
/// A message is one JSON document followed by a line feed.
/// </summary>
public static class PipeLines
{
    /// <summary>
    /// Reads bytes up to the first line feed. Returns null when the stream
    /// ends first or the line is longer than <paramref name="maxBytes"/>.
    /// </summary>
    public static async Task<string?> ReadLineAsync(Stream stream, int maxBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var buffer = new byte[maxBytes];
        var length = 0;
        while (length < maxBytes)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length, maxBytes - length), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }

            var end = Array.IndexOf(buffer, (byte)'\n', length, read);
            length += read;
            if (end >= 0)
            {
                return Encoding.UTF8.GetString(buffer, 0, end);
            }
        }

        return null;
    }

    /// <summary>Writes <paramref name="message"/> as one line and flushes.</summary>
    public static async Task WriteLineAsync<T>(Stream stream, T message, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, typeInfo);
        var line = new byte[bytes.Length + 1];
        bytes.CopyTo(line, 0);
        line[^1] = (byte)'\n';
        await stream.WriteAsync(line, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Parses one line; returns null for anything that is not a valid message.</summary>
    public static T? Parse<T>(string? line, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo)
        where T : class
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(line, typeInfo);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
