using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mashkif.Agent.Tests.Support;
using Mashkif.Service;
using Mashkif.Service.Agent;
using Mashkif.Service.Config;
using Mashkif.Service.Protocol;
using Microsoft.Extensions.Time.Testing;

namespace Mashkif.Agent.Tests;

/// <summary>
/// The agent against contracts/examples: its requests must equal the request
/// examples of its own version, and it must read every response example.
/// Redocly validates the same examples against the schemas.
/// </summary>
public sealed class ProtocolTests
{
    private static readonly string ExamplesRoot = Path.Combine(AppContext.BaseDirectory, "ContractExamples");

    /// <summary>A token made for this run; no fixed token is ever sent, also not to a fake server.</summary>
    private static readonly string TestToken = System.Buffers.Text.Base64Url.EncodeToString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));

    private static JsonNode Example(params string[] path) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine([ExamplesRoot, .. path])))!["value"]!;

    private static string VersionFolder => $"agent-{AgentService.Version}";

    [Fact]
    public void Every_request_example_exists_for_this_agent_version()
    {
        Assert.True(File.Exists(Path.Combine(ExamplesRoot, VersionFolder, "register-request.json")), $"contracts/examples/{VersionFolder}/register-request.json is missing");
        Assert.True(File.Exists(Path.Combine(ExamplesRoot, VersionFolder, "heartbeat-request.json")), $"contracts/examples/{VersionFolder}/heartbeat-request.json is missing");
        Assert.True(File.Exists(Path.Combine(ExamplesRoot, VersionFolder, "events-request.json")), $"contracts/examples/{VersionFolder}/events-request.json is missing");
    }

    [Fact]
    public void The_events_request_equals_the_contract_example_and_carries_no_wall_clock_time()
    {
        var example = Example(VersionFolder, "events-request.json");
        var request = new EventsRequest
        {
            Events =
            [
                .. example["events"]!.AsArray().Select(e => new AgentEvent
                {
                    Id = Guid.Parse(e!["id"]!.GetValue<string>()),
                    Kind = e["kind"]!.GetValue<string>(),
                    BootId = Guid.Parse(e["bootId"]!.GetValue<string>()),
                    SyncId = e["syncId"]?.GetValue<string>(),
                    ElapsedMs = e["elapsedMs"]?.GetValue<long>(),
                }),
            ],
            DroppedEvents = new DroppedEvents
            {
                BootId = Guid.Parse(example["droppedEvents"]!["bootId"]!.GetValue<string>()),
                Count = example["droppedEvents"]!["count"]!.GetValue<long>(),
            },
        };
        var json = JsonNode.Parse(JsonSerializer.Serialize(request, ProtocolJsonContext.Default.EventsRequest));
        Assert.True(JsonNode.DeepEquals(example, json), json!.ToJsonString());

        // An event without a sync sends both as null, never leaves them out.
        var resume = json!["events"]!.AsArray()[2]!.AsObject();
        Assert.True(resume.ContainsKey("syncId"));
        Assert.True(resume.ContainsKey("elapsedMs"));
    }

    [Fact]
    public async Task The_client_reads_the_events_response_example_with_its_deferred_wait()
    {
        var events = await Answer<EventsResponse>(
            HttpStatusCode.OK,
            "events-200.json",
            (api, ct) => api.EventsAsync(new EventsRequest { Events = [] }, TestToken, ct));
        Assert.Equal(ApiOutcome.Success, events.Outcome);
        Assert.Equal(["accepted", "duplicate", "deferred"], events.Value!.Results!.Select(r => r.Status));
        Assert.Equal(1520, events.Value.RetryAfterSeconds);
    }

    [Fact]
    public async Task The_connectivity_check_is_a_GET_without_a_token()
    {
        using var handler = new ScriptedHandler();
        handler.Enqueue(HttpStatusCode.OK, """{"status":"ok","protocolVersion":1}""");
        using var http = new HttpClient(handler);
        var api = new AgentApiClient(http, new Uri("https://mashkif.test/"), TimeProvider.System);
        var result = await api.HealthAsync(TestContext.Current.CancellationToken);
        Assert.Equal(ApiOutcome.Success, result.Outcome);
        var request = handler.Requests.Single();
        Assert.Equal(HttpMethod.Get.Method, request.Method);
        Assert.Equal("https://mashkif.test/api/agent/health", request.Uri.ToString());
        Assert.Null(request.Authorization);
        Assert.Equal("1", request.ProtocolVersion);
    }

    [Fact]
    public void The_register_request_equals_the_contract_example()
    {
        var example = Example(VersionFolder, "register-request.json");
        var request = new RegisterRequest
        {
            InstallId = Guid.Parse(example["installId"]!.GetValue<string>()),
            Token = example["token"]!.GetValue<string>(),
            AgentVersion = AgentService.Version,
            OsVersion = example["osVersion"]!.GetValue<string>(),
        };
        var json = JsonNode.Parse(JsonSerializer.Serialize(request, ProtocolJsonContext.Default.RegisterRequest));
        Assert.True(JsonNode.DeepEquals(example, json), json!.ToJsonString());
    }

    [Fact]
    public void The_heartbeat_request_equals_the_contract_example()
    {
        var example = Example(VersionFolder, "heartbeat-request.json");
        var request = new HeartbeatRequest
        {
            Sequence = example["sequence"]!.GetValue<long>(),
            BootId = Guid.Parse(example["bootId"]!.GetValue<string>()),
            AreaCell = null,
            Infrastructure = ProtocolConstants.InfrastructureUnknown,
            IntervalSeconds = example["intervalSeconds"]!.GetValue<int>(),
            RoundTripMs = example["roundTripMs"]!.GetValue<int>(),
            DnsMs = example["dnsMs"]!.GetValue<int>(),
            AgentVersion = AgentService.Version,
        };
        var json = JsonNode.Parse(JsonSerializer.Serialize(request, ProtocolJsonContext.Default.HeartbeatRequest));
        Assert.True(JsonNode.DeepEquals(example, json), json!.ToJsonString());
    }

    [Fact]
    public void A_first_heartbeat_sends_null_for_unknown_values_instead_of_leaving_them_out()
    {
        var request = new HeartbeatRequest
        {
            Sequence = 0,
            BootId = Guid.NewGuid(),
            AreaCell = null,
            Infrastructure = ProtocolConstants.InfrastructureUnknown,
            IntervalSeconds = 60,
            RoundTripMs = null,
            DnsMs = null,
        };
        var json = JsonNode.Parse(JsonSerializer.Serialize(request, ProtocolJsonContext.Default.HeartbeatRequest))!.AsObject();
        Assert.True(json.ContainsKey("areaCell"));
        Assert.True(json.ContainsKey("roundTripMs"));
        Assert.True(json.ContainsKey("dnsMs"));
        Assert.False(json.ContainsKey("agentVersion"));
    }

    [Fact]
    public async Task The_client_reads_every_response_example()
    {
        var register = await Answer<RegisterResponse>(HttpStatusCode.Created, "register-201.json", (api, ct) => api.RegisterAsync(SampleRegister(), ct));
        Assert.Equal(ApiOutcome.Success, register.Outcome);
        Assert.Equal(60, register.Value!.HeartbeatIntervalSeconds);

        var heartbeat = await Answer<HeartbeatResponse>(HttpStatusCode.OK, "heartbeat-200.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct));
        Assert.Equal(ApiOutcome.Success, heartbeat.Outcome);
        Assert.Equal(120, heartbeat.Value!.NextIntervalSeconds);

        var revoked = await Answer<HeartbeatResponse>(HttpStatusCode.Forbidden, "agent-error-403.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct));
        Assert.Equal("agent_revoked", revoked.ErrorCode);

        var closed = await Answer<RegisterResponse>(HttpStatusCode.Forbidden, "registration-closed-403.json", (api, ct) => api.RegisterAsync(SampleRegister(), ct));
        Assert.Equal("registration_closed", closed.ErrorCode);

        var protocol = await Answer<HeartbeatResponse>(HttpStatusCode.BadRequest, "protocol-error-400.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct));
        Assert.Equal("protocol_version_unsupported", protocol.ErrorCode);

        var limited = await Answer<HeartbeatResponse>(HttpStatusCode.TooManyRequests, "rate-limited-429.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct), retryAfter: 42);
        Assert.Equal("rate_limited", limited.ErrorCode);
        Assert.Equal(TimeSpan.FromSeconds(42), limited.RetryAfter);
    }

    [Fact]
    public async Task Retry_After_is_capped_at_an_hour_and_never_below_a_second()
    {
        var huge = await Answer<HeartbeatResponse>(HttpStatusCode.TooManyRequests, "rate-limited-429.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct), retryAfter: 999999);
        Assert.Equal(TimeSpan.FromHours(1), huge.RetryAfter);
        var zero = await Answer<HeartbeatResponse>(HttpStatusCode.TooManyRequests, "rate-limited-429.json", (api, ct) => api.HeartbeatAsync(SampleHeartbeat(), "t", ct), retryAfter: 0);
        Assert.Equal(TimeSpan.FromSeconds(1), zero.RetryAfter);
    }

    [Fact]
    public async Task Every_request_carries_the_protocol_version_and_heartbeats_the_bearer_token()
    {
        using var handler = new ScriptedHandler();
        handler.Enqueue(HttpStatusCode.OK, Example("responses", "heartbeat-200.json").ToJsonString());
        using var http = new HttpClient(handler);
        var api = new AgentApiClient(http, new Uri("https://mashkif.test/"), TimeProvider.System);
        await api.HeartbeatAsync(SampleHeartbeat(), TestToken, TestContext.Current.CancellationToken);
        var request = handler.Requests.Single();
        Assert.Equal("1", request.ProtocolVersion);
        Assert.Equal($"Bearer {TestToken}", request.Authorization);
        Assert.Equal(HttpMethod.Post.Method, request.Method);
    }

    [Fact]
    public void The_HTTP_handler_never_follows_redirects()
    {
        using var handler = AgentApiClient.CreateHandler();
        Assert.False(handler.AllowAutoRedirect);
    }

    [Fact]
    public void A_new_token_is_32_random_bytes_in_base64url()
    {
        var a = Credentials.Create();
        var b = Credentials.Create();
        Assert.Matches("^[A-Za-z0-9_-]{43}$", a.Token);
        Assert.Equal(32, System.Buffers.Text.Base64Url.DecodeFromChars(a.Token).Length);
        Assert.NotEqual(a.Token, b.Token);
        Assert.NotEqual(a.InstallId, b.InstallId);
    }

    [Theory]
    [InlineData(null, "https://mashkif.co.il/")]
    [InlineData("", "https://mashkif.co.il/")]
    [InlineData("https://Mashkif.Example:443", "https://mashkif.example/")]
    [InlineData("https://mashkif.example:8443/", "https://mashkif.example:8443/")]
    [InlineData("http://localhost:8080", "http://localhost:8080/")]
    [InlineData("http://127.0.0.1:8080", "http://127.0.0.1:8080/")]
    [InlineData("http://[::1]:8080", "http://[::1]:8080/")]
    public void Accepted_server_URLs_are_normalized_origins(string? value, string expected)
    {
        Assert.Equal(expected, ServerOrigin.Parse(value)?.ToString());
    }

    [Theory]
    [InlineData("http://mashkif.co.il")]
    [InlineData("http://192.168.1.10:8080")]
    [InlineData("https://mashkif.co.il/api")]
    [InlineData("https://user:pass@mashkif.co.il")]
    [InlineData("https://mashkif.co.il/?x=1")]
    [InlineData("ftp://mashkif.co.il")]
    [InlineData("mashkif.co.il")]
    public void Other_server_URLs_are_refused(string value)
    {
        Assert.Null(ServerOrigin.Parse(value));
    }

    [Fact]
    public async Task DNS_timing_returns_null_for_an_IP_literal_a_failure_or_a_lookup_over_its_budget()
    {
        var time = new FakeTimeProvider();
        var ct = TestContext.Current.CancellationToken;
        Assert.Null(await DnsTiming.MeasureAsync((_, _) => Task.CompletedTask, "127.0.0.1", TimeSpan.FromSeconds(5), time, ct));
        Assert.Null(await DnsTiming.MeasureAsync((_, _) => throw new System.Net.Sockets.SocketException(11001), "mashkif.test", TimeSpan.FromSeconds(5), time, ct));
        Assert.Null(await DnsTiming.MeasureAsync((_, token) => Task.Delay(Timeout.Infinite, token), "mashkif.test", TimeSpan.FromMilliseconds(50), time, ct));
        Assert.Equal(25, await DnsTiming.MeasureAsync(
            (_, _) =>
            {
                time.Advance(TimeSpan.FromMilliseconds(25));
                return Task.CompletedTask;
            },
            "mashkif.test",
            TimeSpan.FromSeconds(5),
            time,
            ct));
    }

    [Fact]
    public async Task DNS_timing_is_cancelled_with_its_caller()
    {
        using var stop = new CancellationTokenSource();
        var lookup = DnsTiming.MeasureAsync((_, token) => Task.Delay(Timeout.Infinite, token), "mashkif.test", TimeSpan.FromMinutes(5), TimeProvider.System, stop.Token);
        await stop.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lookup);
    }

    [Fact]
    public void The_OS_version_has_the_contract_format()
    {
        Assert.Matches(@"^\d+\.\d+\.\d+$", AgentRuntime.OsVersion());
    }

    private static RegisterRequest SampleRegister() => new()
    {
        InstallId = Guid.NewGuid(),
        Token = TestToken,
        AgentVersion = "0.1.0",
    };

    private static HeartbeatRequest SampleHeartbeat() => new()
    {
        Sequence = 1,
        BootId = Guid.NewGuid(),
        AreaCell = null,
        Infrastructure = "unknown",
        IntervalSeconds = 60,
        RoundTripMs = null,
        DnsMs = null,
    };

    private static async Task<ApiResult<T>> Answer<T>(HttpStatusCode status, string example, Func<AgentApiClient, CancellationToken, Task<ApiResult<T>>> call, int? retryAfter = null)
        where T : class
    {
        using var handler = new ScriptedHandler();
        handler.Enqueue(status, Example("responses", example).ToJsonString(), response =>
        {
            if (retryAfter is { } seconds)
            {
                response.Headers.TryAddWithoutValidation("Retry-After", seconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        });
        using var http = new HttpClient(handler);
        return await call(new AgentApiClient(http, new Uri("https://mashkif.test/"), TimeProvider.System), TestContext.Current.CancellationToken);
    }
}
