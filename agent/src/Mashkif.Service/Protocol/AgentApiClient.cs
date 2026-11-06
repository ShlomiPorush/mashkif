using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Mashkif.Service.Protocol;

/// <summary>How one HTTP attempt ended.</summary>
internal enum ApiOutcome
{
    /// <summary>2xx with a valid body.</summary>
    Success,

    /// <summary>The server answered with a status other than 2xx, or a 2xx without a valid body.</summary>
    Status,

    /// <summary>No answer: a network error or the attempt timed out.</summary>
    NoResponse,
}

/// <summary>The result of one HTTP attempt. Never contains the token.</summary>
internal sealed record ApiResult<T>
    where T : class
{
    public required ApiOutcome Outcome { get; init; }

    /// <summary>HTTP status code, or 0 without a response.</summary>
    public int StatusCode { get; init; }

    public T? Value { get; init; }

    /// <summary>The <c>error</c> code of an error body, or null.</summary>
    public string? ErrorCode { get; init; }

    /// <summary>A 2xx whose body was missing or not of the expected shape.</summary>
    public bool BadBody { get; init; }

    /// <summary>The <c>Retry-After</c> delay of a 429, or null.</summary>
    public TimeSpan? RetryAfter { get; init; }

    /// <summary>Duration of the attempt.</summary>
    public TimeSpan Elapsed { get; init; }
}

/// <summary>
/// The agent side of the protocol: one call per operation, one HTTP attempt
/// per call. Retries belong to the caller. Redirects are never followed.
/// </summary>
internal sealed class AgentApiClient(HttpClient http, Uri origin, TimeProvider time)
{
    /// <summary>Time one attempt may take.</summary>
    public static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(30);

    /// <summary>The longest <c>Retry-After</c> the agent honors.</summary>
    public static readonly TimeSpan MaxRetryAfter = TimeSpan.FromHours(1);

    /// <summary>Creates the HTTP handler the service uses.</summary>
    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(15),
    };

    public Uri Origin => origin;

    public Task<ApiResult<RegisterResponse>> RegisterAsync(RegisterRequest request, CancellationToken cancellationToken) =>
        SendAsync(
            "api/agent/register",
            request,
            ProtocolJsonContext.Default.RegisterRequest,
            ProtocolJsonContext.Default.RegisterResponse,
            token: null,
            static r => r.AgentId != Guid.Empty && r.HeartbeatIntervalSeconds > 0 && r.ServerTime != default,
            cancellationToken);

    public Task<ApiResult<HeartbeatResponse>> HeartbeatAsync(HeartbeatRequest request, string token, CancellationToken cancellationToken) =>
        SendAsync(
            "api/agent/heartbeat",
            request,
            ProtocolJsonContext.Default.HeartbeatRequest,
            ProtocolJsonContext.Default.HeartbeatResponse,
            token,
            static r => !string.IsNullOrEmpty(r.SyncId) && r.NextIntervalSeconds > 0 && r.ServerTime != default,
            cancellationToken);

    /// <summary>
    /// Sends events. The caller checks that the results match the request
    /// one by one; a 2xx without a <c>results</c> array is a bad body.
    /// </summary>
    public Task<ApiResult<EventsResponse>> EventsAsync(EventsRequest request, string token, CancellationToken cancellationToken) =>
        SendAsync(
            "api/agent/events",
            request,
            ProtocolJsonContext.Default.EventsRequest,
            ProtocolJsonContext.Default.EventsResponse,
            token,
            static r => r.Results is not null,
            cancellationToken);

    /// <summary>Time the connectivity check may take.</summary>
    public static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// The connectivity check: <c>GET /api/agent/health</c> without a token.
    /// Success shows only that the Mashkif server answers.
    /// </summary>
    public Task<ApiResult<HealthResponse>> HealthAsync(CancellationToken cancellationToken) =>
        SendCoreAsync(
            HttpMethod.Get,
            "api/agent/health",
            content: null,
            ProtocolJsonContext.Default.HealthResponse,
            token: null,
            static r => r.Status == "ok",
            HealthTimeout,
            cancellationToken);

    private Task<ApiResult<TResponse>> SendAsync<TRequest, TResponse>(
        string path,
        TRequest body,
        JsonTypeInfo<TRequest> requestInfo,
        JsonTypeInfo<TResponse> responseInfo,
        string? token,
        Func<TResponse, bool> isValid,
        CancellationToken cancellationToken)
        where TResponse : class =>
        SendCoreAsync(HttpMethod.Post, path, JsonContent.Create(body, requestInfo), responseInfo, token, isValid, AttemptTimeout, cancellationToken);

    private async Task<ApiResult<TResponse>> SendCoreAsync<TResponse>(
        HttpMethod method,
        string path,
        HttpContent? content,
        JsonTypeInfo<TResponse> responseInfo,
        string? token,
        Func<TResponse, bool> isValid,
        TimeSpan attemptTimeout,
        CancellationToken cancellationToken)
        where TResponse : class
    {
        var started = time.GetTimestamp();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(attemptTimeout);
        using var request = new HttpRequestMessage(method, new Uri(origin, path))
        {
            Content = content,
        };
        request.Headers.Add(ProtocolConstants.ProtocolVersionHeader, ProtocolConstants.ProtocolVersion.ToString(CultureInfo.InvariantCulture));
        if (token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token).ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            return NoResponse<TResponse>(started);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return NoResponse<TResponse>(started);
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            byte[] received;
            try
            {
                received = await response.Content.ReadAsByteArrayAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (HttpRequestException)
            {
                return NoResponse<TResponse>(started);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return NoResponse<TResponse>(started);
            }

            var elapsed = time.GetElapsedTime(started);
            if (response.IsSuccessStatusCode)
            {
                var value = TryParse(received, responseInfo);
                return value is not null && isValid(value)
                    ? new ApiResult<TResponse> { Outcome = ApiOutcome.Success, StatusCode = status, Value = value, Elapsed = elapsed }
                    : new ApiResult<TResponse> { Outcome = ApiOutcome.Status, StatusCode = status, BadBody = true, Elapsed = elapsed };
            }

            return new ApiResult<TResponse>
            {
                Outcome = ApiOutcome.Status,
                StatusCode = status,
                ErrorCode = TryParse(received, ProtocolJsonContext.Default.ErrorBody)?.Error,
                RetryAfter = response.StatusCode == HttpStatusCode.TooManyRequests ? RetryAfterOf(response) : null,
                Elapsed = elapsed,
            };
        }
    }

    private ApiResult<T> NoResponse<T>(long started)
        where T : class =>
        new() { Outcome = ApiOutcome.NoResponse, Elapsed = time.GetElapsedTime(started) };

    private static T? TryParse<T>(byte[] content, JsonTypeInfo<T> info)
        where T : class
    {
        if (content.Length == 0)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(content, info);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private TimeSpan RetryAfterOf(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        var delay = header?.Delta
            ?? (header?.Date is { } date ? date - time.GetUtcNow() : (TimeSpan?)null)
            ?? TimeSpan.FromMinutes(1);
        if (delay < TimeSpan.FromSeconds(1))
        {
            return TimeSpan.FromSeconds(1);
        }

        return delay > MaxRetryAfter ? MaxRetryAfter : delay;
    }
}
