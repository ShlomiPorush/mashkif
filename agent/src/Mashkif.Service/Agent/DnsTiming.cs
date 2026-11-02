using System.Net;
using System.Net.Sockets;
using Mashkif.Service.Protocol;

namespace Mashkif.Service.Agent;

/// <summary>
/// The <c>dnsMs</c> of a heartbeat: a separate, timed resolution of the server
/// name. The connection pool usually skips DNS, so timing HttpClient's own
/// lookup would mostly give nothing.
/// </summary>
internal static class DnsTiming
{
    /// <summary>
    /// Milliseconds that <paramref name="resolve"/> took for <paramref name="host"/>,
    /// or null for an IP literal, a failure, or a lookup longer than <paramref name="budget"/>.
    /// Cancelling <paramref name="cancellationToken"/> cancels the lookup.
    /// </summary>
    public static async Task<int?> MeasureAsync(
        Func<string, CancellationToken, Task> resolve,
        string host,
        TimeSpan budget,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(resolve);
        ArgumentNullException.ThrowIfNull(time);
        if (IPAddress.TryParse(host, out _))
        {
            return null;
        }

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(budget);
        var started = time.GetTimestamp();
        try
        {
            await resolve(host, limit.Token).ConfigureAwait(false);
        }
        catch (SocketException)
        {
            return null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }

        return (int)Math.Min(time.GetElapsedTime(started).TotalMilliseconds, ProtocolConstants.MaxLatencyMs);
    }
}
