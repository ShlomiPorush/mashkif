using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Mashkif.Agent.Tests.Support;

/// <summary>
/// A fake agent API that answers by path, for tests where the heartbeat
/// loop, the probe, and the sender run at once. Heartbeats get new sync IDs
/// (sync-1, sync-2, ...); events are accepted unless a test answers them.
/// While <see cref="Online"/> is false, every request gets no answer.
/// </summary>
internal sealed class RoutedHandler : HttpMessageHandler
{
    private readonly ConcurrentQueue<RecordedRequest> _requests = new();
    private int _syncs;

    public volatile bool Online = true;

    public IReadOnlyList<RecordedRequest> Requests => [.. _requests];

    public IReadOnlyList<RecordedRequest> Heartbeats => [.. _requests.Where(r => r.Uri.AbsolutePath.EndsWith("/heartbeat", StringComparison.Ordinal))];

    public IReadOnlyList<RecordedRequest> Events => [.. _requests.Where(r => r.Uri.AbsolutePath.EndsWith("/events", StringComparison.Ordinal))];

    public IReadOnlyList<RecordedRequest> Probes => [.. _requests.Where(r => r.Uri.AbsolutePath.EndsWith("/health", StringComparison.Ordinal))];

    /// <summary>The sync ID of the last heartbeat answer sent.</summary>
    public string LastSyncId => $"sync-{Volatile.Read(ref _syncs)}";

    /// <summary>Answers events requests; null accepts every event.</summary>
    public Func<JsonNode, CancellationToken, Task<HttpResponseMessage>>? EventsAnswer { get; set; }

    /// <summary>Answers heartbeat requests; null records them with the next sync ID.</summary>
    public Func<CancellationToken, Task<HttpResponseMessage>>? HeartbeatAnswer { get; set; }

    public static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    /// <summary>Accepts every event of a request, or gives every event <paramref name="status"/>.</summary>
    public static HttpResponseMessage Results(JsonNode body, string status = "accepted", int? retryAfterSeconds = null)
    {
        var results = new JsonArray([.. body["events"]!.AsArray().Select(e => (JsonNode)new JsonObject { ["id"] = e!["id"]!.GetValue<string>(), ["status"] = status })]);
        var response = new JsonObject { ["results"] = results };
        if (retryAfterSeconds is { } seconds)
        {
            response["retryAfterSeconds"] = seconds;
        }

        return Json(HttpStatusCode.OK, response.ToJsonString());
    }

    public RecordedRequest[] EventsSent() => [.. Events];

    public static IReadOnlyList<JsonNode> EventsOf(RecordedRequest request) =>
        [.. JsonNode.Parse(request.Body)!["events"]!.AsArray().Select(e => e!)];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        request.Headers.TryGetValues("Mashkif-Protocol-Version", out var versions);
        var recorded = new RecordedRequest(request.Method.Method, request.RequestUri!, request.Headers.Authorization?.ToString(), versions?.FirstOrDefault(), body);
        _requests.Enqueue(recorded);
        if (!Online)
        {
            throw new HttpRequestException("offline");
        }

        var path = request.RequestUri!.AbsolutePath;
        if (path.EndsWith("/register", StringComparison.Ordinal))
        {
            return Json(HttpStatusCode.Created, """{"agentId":"0b5f3c1a-9d2e-4f6a-8b7c-1d2e3f4a5b6c","heartbeatIntervalSeconds":60,"serverTime":"2026-11-02T09:00:00Z"}""");
        }

        if (path.EndsWith("/health", StringComparison.Ordinal))
        {
            return Json(HttpStatusCode.OK, """{"status":"ok","protocolVersion":1}""");
        }

        if (path.EndsWith("/heartbeat", StringComparison.Ordinal))
        {
            if (HeartbeatAnswer is { } answer)
            {
                return await answer(cancellationToken).ConfigureAwait(false);
            }

            var n = Interlocked.Increment(ref _syncs);
            return Json(HttpStatusCode.OK, $$"""{"syncId":"sync-{{n}}","serverTime":"2026-11-02T09:01:00Z","nextIntervalSeconds":60}""");
        }

        if (path.EndsWith("/events", StringComparison.Ordinal))
        {
            var json = JsonNode.Parse(body)!;
            return EventsAnswer is { } answer ? await answer(json, cancellationToken).ConfigureAwait(false) : Results(json);
        }

        return Json(HttpStatusCode.NotFound, """{"error":"internal_error"}""");
    }
}
