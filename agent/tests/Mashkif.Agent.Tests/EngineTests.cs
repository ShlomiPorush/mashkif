using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mashkif.Agent.Tests.Support;
using Mashkif.Common.Pipe;
using Mashkif.Service.Agent;
using Mashkif.Service.State;

namespace Mashkif.Agent.Tests;

public sealed class EngineTests : IDisposable
{
    private const string AgentId = "0b5f3c1a-9d2e-4f6a-8b7c-1d2e3f4a5b6c";
    private const string OldOrigin = "https://old.test";
    private static readonly string PendingToken = System.Buffers.Text.Base64Url.EncodeToString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));

    private readonly EngineFixture _f = new();

    public void Dispose() => _f.Dispose();

    private static string Registered(int interval = 60) =>
        $$"""{"agentId":"{{AgentId}}","heartbeatIntervalSeconds":{{interval}},"serverTime":"2026-11-02T09:00:00Z"}""";

    private static string Recorded(int next) =>
        $$"""{"syncId":"sync-{{next}}","serverTime":"2026-11-02T09:01:00Z","nextIntervalSeconds":{{next}}}""";

    private static string Error(string code) => $$"""{"error":"{{code}}"}""";

    private static JsonNode Body(RecordedRequest request) => JsonNode.Parse(request.Body)!;

    private static bool IsRegister(RecordedRequest request) => request.Uri.AbsolutePath.EndsWith("/register", StringComparison.Ordinal);

    private static async Task Advance(EngineFixture f, TimeSpan by)
    {
        await Eventually.SettleAsync();
        f.Time.Advance(by);
    }

    private async Task<AgentEngine> RegisteredAgentAsync(int interval = 60, int next = 60)
    {
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered(interval));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(next));
        var engine = _f.Start();
        await _f.Handler.WaitForRequestsAsync(2);
        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Connected, "connected");
        return engine;
    }

    /// <summary>The 401 cycle as a restart finds it: the old token kept, a pending token for the same install ID.</summary>
    private static AgentState InTokenCycle(DateTimeOffset? lastAttempt) => EngineFixture.Registered() with
    {
        IdentityState = IdentityStates.TokenRejected,
        Pending = new PendingRegistration { ServerOrigin = EngineFixture.Origin, Token = PendingToken },
        LastRegisterAttemptUtc = lastAttempt,
    };

    // First start.

    [Fact]
    public async Task The_first_start_registers_by_itself_with_the_install_ID_and_token_saved_before_sending()
    {
        JsonNode? onDisk = null;
        _f.Handler.OnRequest = request =>
        {
            if (IsRegister(request))
            {
                onDisk = JsonNode.Parse(File.ReadAllText(_f.State.StateFile));
            }
        };
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered(30));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(120));

        var engine = _f.Start();
        await _f.Handler.WaitForRequestsAsync(2);

        var register = _f.Handler.Requests[0];
        Assert.Equal("https://mashkif.test/api/agent/register", register.Uri.ToString());
        Assert.Equal("1", register.ProtocolVersion);
        Assert.Null(register.Authorization);
        var issued = _f.IssuedCredentials.Single();
        var body = Body(register).AsObject();
        Assert.Equal(["agentVersion", "installId", "osVersion", "token"], body.Select(p => p.Key).Order());
        Assert.Equal(issued.InstallId.ToString(), body["installId"]!.GetValue<string>());
        Assert.Equal(issued.Token, body["token"]!.GetValue<string>());
        Assert.Equal("10.0.26100", body["osVersion"]!.GetValue<string>());

        // Saved before the request went out.
        Assert.Equal(issued.InstallId.ToString(), onDisk!["installId"]!.GetValue<string>());
        Assert.Equal(issued.Token, onDisk["pending"]!["token"]!.GetValue<string>());
        Assert.Equal(EngineFixture.Origin, onDisk["pending"]!["serverOrigin"]!.GetValue<string>());
        Assert.NotNull(onDisk["lastRegisterAttemptUtc"]);

        var heartbeat = _f.Handler.Requests[1];
        Assert.Equal("https://mashkif.test/api/agent/heartbeat", heartbeat.Uri.ToString());
        Assert.Equal($"Bearer {issued.Token}", heartbeat.Authorization);
        var beat = Body(heartbeat);
        Assert.Equal(0, beat["sequence"]!.GetValue<long>());
        Assert.Equal(30, beat["intervalSeconds"]!.GetValue<int>());
        Assert.Null(beat["roundTripMs"]);
        Assert.Equal(4, beat["dnsMs"]!.GetValue<int>());
        Assert.Null(beat["areaCell"]);
        Assert.Equal("unknown", beat["infrastructure"]!.GetValue<string>());
        Assert.Equal(_f.BootId.ToString(), beat["bootId"]!.GetValue<string>());

        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Connected, "connected");
        var state = engine.State;
        Assert.Null(state.Pending);
        Assert.Equal(issued.InstallId, state.InstallId);
        Assert.Equal(IdentityStates.Active, state.IdentityState);
        Assert.Equal(Guid.Parse(AgentId), state.Identity!.AgentId);
        Assert.Equal(120, state.IntervalSeconds);
        Assert.Equal(1, state.NextSequence);
        Assert.False(engine.Status().CanRejoin);
    }

    [Fact]
    public async Task A_failed_first_save_sends_nothing_and_is_tried_again_a_minute_later()
    {
        var engine = _f.Create();
        _f.Store.BeforeReplace = () => throw new IOException("disk full");
        engine.Initialize();
        _f.Run(engine);
        await Eventually.SettleAsync();
        Assert.Empty(_f.Handler.Requests);
        Assert.Equal(AgentStates.Unregistered, engine.Status().State);

        _f.Store.BeforeReplace = null;
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        await Advance(_f, AgentEngine.SaveRetryDelay);
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task Registration_closed_is_shown_and_retried_hourly_with_the_same_body()
    {
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("registration_closed"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Start();

        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(StatusReasons.RegistrationClosed, status.Reason);
        Assert.False(status.CanRejoin);
        await Advance(_f, TimeSpan.FromMinutes(59));
        await Eventually.SettleAsync();
        Assert.Single(_f.Handler.Requests);

        _f.Time.Advance(TimeSpan.FromMinutes(6));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task An_install_ID_conflict_at_the_first_registration_keeps_the_IDs_and_retries_hourly()
    {
        _f.Handler.Enqueue(HttpStatusCode.Conflict, Error("install_id_conflict"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var engine = _f.Start();

        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(StatusReasons.InstallIdConflict, status.Reason);
        await Advance(_f, TimeSpan.FromMinutes(59));
        await Eventually.SettleAsync();
        Assert.Single(_f.Handler.Requests);

        _f.Time.Advance(TimeSpan.FromMinutes(6));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
        Assert.Single(_f.IssuedCredentials);
        Assert.Equal(_f.IssuedCredentials[0].InstallId, engine.State.InstallId);
    }

    [Fact]
    public async Task A_lost_register_response_is_retried_with_the_identical_body()
    {
        _f.Handler.EnqueueLost();
        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Start();

        await _f.Handler.WaitForRequestsAsync(1);
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task A_crash_after_saving_the_registration_resends_the_same_registration_after_a_restart()
    {
        _f.Handler.Enqueue(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        _f.Start();
        await _f.Handler.WaitForRequestsAsync(1);
        await _f.StopAllAsync();

        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var restarted = _f.Start();
        await _f.Handler.WaitForRequestsAsync(3);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await Eventually.TrueAsync(() => restarted.Status().State == AgentStates.Connected, "connected after restart");
        Assert.Single(_f.IssuedCredentials);
    }

    [Fact]
    public async Task A_failed_state_write_after_a_successful_register_retries_and_is_answered_again()
    {
        var failNext = false;
        _f.Handler.OnRequest = request => failNext = IsRegister(request) && _f.Handler.Requests.Count == 0;
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var engine = _f.Create();
        engine.Initialize();
        _f.Store.BeforeReplace = () =>
        {
            if (failNext)
            {
                failNext = false;
                throw new IOException("disk full");
            }
        };
        _f.Run(engine);

        await _f.Handler.WaitForRequestsAsync(1);
        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Registering, "still registering");
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
        await _f.Handler.WaitForRequestsAsync(3);
        await Eventually.SettleAsync();
        Assert.NotNull(_f.State.CreateStore().Load().State!.Identity);
    }

    [Fact]
    public async Task Unknown_response_fields_are_ignored()
    {
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered().Replace("}", ""","futureField":{"a":1}}""", StringComparison.Ordinal));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Start();
        await WaitForState(AgentStates.Connected);
    }

    // Heartbeats.

    [Fact]
    public async Task The_next_heartbeat_waits_for_the_interval_from_the_last_response()
    {
        await RegisteredAgentAsync(next: 120);
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(120));

        await Advance(_f, TimeSpan.FromSeconds(119));
        await Eventually.SettleAsync();
        Assert.Equal(2, _f.Handler.Requests.Count);

        _f.Time.Advance(TimeSpan.FromSeconds(1));
        await _f.Handler.WaitForRequestsAsync(3);
        var body = Body(_f.Handler.Requests[2]);
        Assert.Equal(1, body["sequence"]!.GetValue<long>());
        Assert.Equal(120, body["intervalSeconds"]!.GetValue<int>());
        Assert.NotNull(body["roundTripMs"]);
    }

    [Fact]
    public async Task A_lost_heartbeat_response_is_retried_with_the_identical_body_and_the_old_interval()
    {
        await RegisteredAgentAsync(next: 60);
        // The server raises the interval to 300, but that answer is lost.
        _f.Handler.EnqueueLost();
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(300));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(300));

        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(3);
        Assert.Equal(AgentStates.Unreachable, (await WaitForState(AgentStates.Unreachable)).State);

        // The retry comes after the backoff, never later than the interval.
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(4);
        Assert.Equal(_f.Handler.Requests[2].Body, _f.Handler.Requests[3].Body);
        Assert.Equal(60, Body(_f.Handler.Requests[3])["intervalSeconds"]!.GetValue<int>());

        // The answer of the retry arrives: the next heartbeat reports 300 after 300 seconds.
        await Advance(_f, TimeSpan.FromSeconds(299));
        await Eventually.SettleAsync();
        Assert.Equal(4, _f.Handler.Requests.Count);
        _f.Time.Advance(TimeSpan.FromSeconds(1));
        await _f.Handler.WaitForRequestsAsync(5);
        var body = Body(_f.Handler.Requests[4]);
        Assert.Equal(300, body["intervalSeconds"]!.GetValue<int>());
        Assert.Equal(2, body["sequence"]!.GetValue<long>());
    }

    [Fact]
    public async Task An_interval_decrease_with_a_lost_response_keeps_the_old_interval_until_an_answer_arrives()
    {
        await RegisteredAgentAsync(next: 300);
        _f.Handler.EnqueueLost();
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(30));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(30));

        await Advance(_f, TimeSpan.FromSeconds(300));
        await _f.Handler.WaitForRequestsAsync(3);
        await Advance(_f, TimeSpan.FromSeconds(300));
        await _f.Handler.WaitForRequestsAsync(4);
        Assert.Equal(300, Body(_f.Handler.Requests[3])["intervalSeconds"]!.GetValue<int>());

        await Advance(_f, TimeSpan.FromSeconds(30));
        await _f.Handler.WaitForRequestsAsync(5);
        Assert.Equal(30, Body(_f.Handler.Requests[4])["intervalSeconds"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(5, 30)]
    [InlineData(9999, 600)]
    public async Task An_out_of_range_interval_is_clamped(int sent, int used)
    {
        var engine = await RegisteredAgentAsync(next: sent);
        await Eventually.TrueAsync(() => engine.State.IntervalSeconds == used, "clamped interval saved");
    }

    [Fact]
    public async Task Retry_After_of_a_429_is_honored()
    {
        await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.TooManyRequests, Error("rate_limited"), r => r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(500)));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));

        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(3);
        await Advance(_f, TimeSpan.FromSeconds(499));
        await Eventually.SettleAsync();
        Assert.Equal(3, _f.Handler.Requests.Count);
        _f.Time.Advance(TimeSpan.FromSeconds(1));
        await _f.Handler.WaitForRequestsAsync(4);
    }

    [Fact]
    public async Task Heartbeat_backoff_never_waits_longer_than_the_interval()
    {
        await RegisteredAgentAsync(interval: 30, next: 30);
        for (var i = 0; i < 6; i++)
        {
            _f.Handler.Enqueue(HttpStatusCode.ServiceUnavailable, Error("internal_error"));
        }

        await Advance(_f, TimeSpan.FromSeconds(30));
        for (var expected = 3; expected <= 8; expected++)
        {
            await _f.Handler.WaitForRequestsAsync(expected);
            await Advance(_f, TimeSpan.FromSeconds(30));
        }
    }

    [Fact]
    public async Task A_redirect_is_never_followed_and_retried_only_hourly()
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Found, string.Empty, r => r.Headers.Location = new Uri("https://elsewhere.test/"));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));

        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(3);
        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(StatusReasons.ServerRedirect, status.Reason);
        Assert.All(_f.Handler.Requests, r => Assert.Equal("mashkif.test", r.Uri.Host));

        await Advance(_f, TimeSpan.FromMinutes(59));
        await Eventually.SettleAsync();
        Assert.Equal(3, _f.Handler.Requests.Count);
        _f.Time.Advance(TimeSpan.FromMinutes(6));
        await _f.Handler.WaitForRequestsAsync(4);
        await WaitForState(AgentStates.Connected);
        Assert.Equal(AgentStates.Connected, engine.Status().State);
    }

    [Theory]
    [InlineData("agent_blocked")]
    [InlineData("address_blocked")]
    public async Task A_blocked_agent_keeps_its_token_and_retries(string code)
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error(code));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));

        await Advance(_f, TimeSpan.FromSeconds(60));
        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(code, status.Reason);
        Assert.NotNull(engine.State.Identity);
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Connected);
    }

    [Theory]
    [InlineData("""{"error":"protocol_version_unsupported","supportedVersions":[2]}""", "protocol_unsupported")]
    [InlineData("""{"error":"request_invalid","field":"sequence"}""", "request_invalid")]
    public async Task A_400_is_refused_and_retried_hourly(string json, string reason)
    {
        await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.BadRequest, json);

        await Advance(_f, TimeSpan.FromSeconds(60));
        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(reason, status.Reason);
        await Advance(_f, TimeSpan.FromMinutes(30));
        await Eventually.SettleAsync();
        Assert.Equal(3, _f.Handler.Requests.Count);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""{"syncId":"x"}""")]
    public async Task A_2xx_without_a_valid_body_counts_as_a_server_error(string body)
    {
        await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.OK, body);
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));

        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Unreachable);
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(4);
        Assert.Equal(_f.Handler.Requests[2].Body, _f.Handler.Requests[3].Body);
        await WaitForState(AgentStates.Connected);
    }

    // Revoke.

    [Fact]
    public async Task A_revoke_stops_reporting_survives_a_restart_and_never_registers_by_itself()
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("agent_revoked"));

        await Advance(_f, TimeSpan.FromSeconds(60));
        var status = await WaitForState(AgentStates.Revoked);
        Assert.True(status.CanRejoin);
        Assert.Null(engine.State.Identity);
        Assert.Null(engine.State.Pending);
        var saved = _f.State.CreateStore().Load().State!;
        Assert.Equal(IdentityStates.Revoked, saved.IdentityState);
        Assert.Null(saved.Identity);

        await Advance(_f, TimeSpan.FromHours(3));
        await Eventually.SettleAsync();
        Assert.Equal(3, _f.Handler.Requests.Count);

        await _f.StopAllAsync();
        var restarted = _f.Start();
        await Advance(_f, TimeSpan.FromHours(3));
        await Eventually.SettleAsync();
        Assert.Equal(AgentStates.Revoked, restarted.Status().State);
        Assert.Equal(3, _f.Handler.Requests.Count);
    }

    [Fact]
    public async Task A_revoke_answered_to_the_first_registration_leaves_the_agent_revoked()
    {
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("agent_revoked"));
        var engine = _f.Start();
        var status = await WaitForState(AgentStates.Revoked);
        Assert.True(status.CanRejoin);
        Assert.Null(engine.State.Pending);
        await Advance(_f, TimeSpan.FromHours(2));
        await Eventually.SettleAsync();
        Assert.Single(_f.Handler.Requests);
    }

    // The 401 cycle.

    [Fact]
    public async Task A_401_keeps_the_token_and_registers_a_pending_token_for_the_same_install_ID_when_it_fails_again()
    {
        // The agent was deleted by cleanup: 401, then 401 again, then 201.
        var engine = await RegisteredAgentAsync();
        var installId = engine.State.InstallId;
        var oldToken = engine.State.Identity!.Token;
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));

        await Advance(_f, TimeSpan.FromSeconds(60));
        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(StatusReasons.TokenInvalid, status.Reason);
        Assert.False(status.CanRejoin);
        var saved = _f.State.CreateStore().Load().State!;
        Assert.Equal(IdentityStates.TokenRejected, saved.IdentityState);
        Assert.Equal(oldToken, saved.Identity!.Token);
        Assert.Equal(installId, saved.InstallId);
        var pendingToken = saved.Pending!.Token;
        Assert.NotEqual(oldToken, pendingToken);

        // Nothing for the next hour.
        await Advance(_f, TimeSpan.FromMinutes(59));
        await Eventually.SettleAsync();
        Assert.Equal(3, _f.Handler.Requests.Count);

        // Then the old token first, and on 401 the pending token for the same install ID.
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Time.Advance(TimeSpan.FromMinutes(7));
        await _f.Handler.WaitForRequestsAsync(6);
        Assert.Equal($"Bearer {oldToken}", _f.Handler.Requests[3].Authorization);
        var register = Body(_f.Handler.Requests[4]);
        Assert.True(IsRegister(_f.Handler.Requests[4]));
        Assert.Equal(installId.ToString(), register["installId"]!.GetValue<string>());
        Assert.Equal(pendingToken, register["token"]!.GetValue<string>());
        Assert.Equal($"Bearer {pendingToken}", _f.Handler.Requests[5].Authorization);

        await WaitForState(AgentStates.Connected);
        var state = engine.State;
        Assert.Equal(IdentityStates.Active, state.IdentityState);
        Assert.Equal(pendingToken, state.Identity!.Token);
        Assert.Equal(installId, state.InstallId);
        Assert.Null(state.Pending);
    }

    [Fact]
    public async Task A_401_then_409_then_a_200_keeps_the_old_token_and_drops_the_pending_one_also_after_a_restart()
    {
        var engine = await RegisteredAgentAsync();
        var oldToken = engine.State.Identity!.Token;
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Refused);
        var pendingToken = engine.State.Pending!.Token;

        // The server still knows the install ID with the old token.
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.Enqueue(HttpStatusCode.Conflict, Error("install_id_conflict"));
        await Advance(_f, TimeSpan.FromMinutes(66));
        await _f.Handler.WaitForRequestsAsync(5);
        await Eventually.SettleAsync();
        Assert.Equal(IdentityStates.TokenRejected, engine.State.IdentityState);
        Assert.Equal(oldToken, engine.State.Identity!.Token);
        Assert.Equal(pendingToken, engine.State.Pending!.Token);

        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        await Advance(_f, TimeSpan.FromMinutes(66));
        await _f.Handler.WaitForRequestsAsync(6);
        Assert.Equal($"Bearer {oldToken}", _f.Handler.Requests[5].Authorization);
        var status = await WaitForState(AgentStates.Connected);
        Assert.Null(status.Reason);
        Assert.Null(engine.State.Pending);
        Assert.Equal(oldToken, engine.State.Identity!.Token);

        await _f.StopAllAsync();
        var restarted = _f.Create();
        restarted.Initialize();
        Assert.Equal(IdentityStates.Active, restarted.State.IdentityState);
        Assert.Null(restarted.State.Pending);
    }

    [Fact]
    public async Task A_lost_register_response_in_the_cycle_is_retried_at_the_next_hour_with_the_same_body()
    {
        await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Refused);

        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.EnqueueLost();
        await Advance(_f, TimeSpan.FromMinutes(66));
        await _f.Handler.WaitForRequestsAsync(5);

        // No backoff retry inside the hour.
        await Advance(_f, TimeSpan.FromMinutes(59));
        await Eventually.SettleAsync();
        Assert.Equal(5, _f.Handler.Requests.Count);

        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Time.Advance(TimeSpan.FromMinutes(7));
        await _f.Handler.WaitForRequestsAsync(8);
        Assert.Equal(_f.Handler.Requests[4].Body, _f.Handler.Requests[6].Body);
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task A_failed_save_of_the_attempt_time_sends_no_register_request()
    {
        await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Refused);
        var before = _f.State.CreateStore().Load().State!;

        // The heartbeat of the cycle arms a failure of the next save, which is the attempt time.
        var arm = false;
        _f.Handler.OnRequest = request => arm = !IsRegister(request);
        _f.Store.BeforeReplace = () =>
        {
            if (arm)
            {
                arm = false;
                throw new IOException("disk full");
            }
        };
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromMinutes(66));
        await _f.Handler.WaitForRequestsAsync(4);
        await Eventually.SettleAsync();

        Assert.Equal(4, _f.Handler.Requests.Count);
        Assert.DoesNotContain(_f.Handler.Requests.Skip(1), IsRegister);
        Assert.Equal(before.LastRegisterAttemptUtc, _f.State.CreateStore().Load().State!.LastRegisterAttemptUtc);
    }

    [Theory]
    [InlineData(59, false)]
    [InlineData(61, true)]
    public async Task The_hourly_register_limit_of_the_cycle_holds_across_a_restart(int minutesAgo, bool registersAtOnce)
    {
        _f.Seed(InTokenCycle(_f.Time.GetUtcNow() - TimeSpan.FromMinutes(minutesAgo)));
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.Enqueue(registersAtOnce ? HttpStatusCode.Created : HttpStatusCode.Unauthorized, registersAtOnce ? Registered() : Error("token_invalid"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        _f.Start();

        // A restart sends the old token's heartbeat at once.
        await _f.Handler.WaitForRequestsAsync(1);
        await Eventually.SettleAsync();
        if (registersAtOnce)
        {
            await _f.Handler.WaitForRequestsAsync(2);
            Assert.True(IsRegister(_f.Handler.Requests[1]));
            return;
        }

        Assert.Single(_f.Handler.Requests);

        // The register request waits for the end of the hour: one more minute.
        await Advance(_f, TimeSpan.FromMinutes(1));
        await _f.Handler.WaitForRequestsAsync(3);
        Assert.False(IsRegister(_f.Handler.Requests[1]));
        Assert.True(IsRegister(_f.Handler.Requests[2]));
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task A_clock_set_back_allows_a_register_attempt_and_the_next_one_waits_an_hour()
    {
        // The saved attempt time is later than the clock: the clock was set back.
        _f.Seed(InTokenCycle(_f.Time.GetUtcNow() + TimeSpan.FromHours(3)));
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.EnqueueLost();
        var engine = _f.Start();

        await _f.Handler.WaitForRequestsAsync(2);
        Assert.True(IsRegister(_f.Handler.Requests[1]));
        await Eventually.TrueAsync(() => engine.State.LastRegisterAttemptUtc == _f.Time.GetUtcNow(), "attempt time saved");
    }

    [Theory]
    [InlineData(null, 0, true)]
    [InlineData(0, 59, false)]
    [InlineData(0, 60, true)]
    [InlineData(0, 61, true)]
    [InlineData(180, 0, true)]
    public void The_cycle_register_limit_allows_one_attempt_an_hour_and_one_after_a_clock_change(int? lastMinutes, int nowMinutes, bool allowed)
    {
        var start = new DateTimeOffset(2026, 11, 2, 9, 0, 0, TimeSpan.Zero);
        DateTimeOffset? last = lastMinutes is { } m ? start + TimeSpan.FromMinutes(m) : null;
        Assert.Equal(allowed, AgentEngine.CycleRegisterAllowed(last, start + TimeSpan.FromMinutes(nowMinutes)));
    }

    [Fact]
    public void A_clock_set_forward_allows_at_most_one_early_attempt()
    {
        var saved = new DateTimeOffset(2026, 11, 2, 9, 0, 0, TimeSpan.Zero);
        var jumped = saved + TimeSpan.FromHours(5);
        Assert.True(AgentEngine.CycleRegisterAllowed(saved, jumped));

        // The attempt saves the new time; the next one waits a full hour from it.
        Assert.False(AgentEngine.CycleRegisterAllowed(jumped, jumped + TimeSpan.FromMinutes(59)));
    }

    [Fact]
    public void Rejoin_does_not_apply_to_the_401_cycle_and_keeps_the_install_ID()
    {
        _f.Seed(InTokenCycle(lastAttempt: null));
        var engine = _f.Create();
        engine.Initialize();
        var reply = engine.Rejoin();
        Assert.Equal(PipeErrors.NotRejoinable, reply.Error);
        Assert.False(reply.Status!.CanRejoin);
        Assert.Equal(EngineFixture.InstallId, engine.State.InstallId);
    }

    // A changed server and joining again.

    public static TheoryData<string> RejoinCases => ["revoked", "identity_on_old_server", "pending_on_old_server", "both_on_old_server"];

    private static AgentState RejoinSeed(string name) => name switch
    {
        "revoked" => AgentState.Empty with { InstallId = EngineFixture.InstallId, IdentityState = IdentityStates.Revoked },
        "identity_on_old_server" => EngineFixture.Registered(OldOrigin),
        "pending_on_old_server" => AgentState.Empty with
        {
            InstallId = EngineFixture.InstallId,
            Pending = new PendingRegistration { ServerOrigin = OldOrigin, Token = PendingToken },
        },
        _ => EngineFixture.Registered(OldOrigin) with
        {
            IdentityState = IdentityStates.TokenRejected,
            Pending = new PendingRegistration { ServerOrigin = OldOrigin, Token = PendingToken },
        },
    };

    [Theory]
    [MemberData(nameof(RejoinCases))]
    public async Task Nothing_is_sent_until_the_user_joins_again_which_registers_a_new_install_ID_and_token(string seed)
    {
        var old = RejoinSeed(seed);
        _f.Seed(old);
        var engine = _f.Start();
        await Advance(_f, TimeSpan.FromHours(2));
        await Eventually.SettleAsync();

        // A lost registration from before the change is not retried either.
        Assert.Empty(_f.Handler.Requests);
        var status = engine.Status();
        Assert.True(status.CanRejoin);
        Assert.Equal(seed == "revoked" ? AgentStates.Revoked : AgentStates.Refused, status.State);
        Assert.Equal(seed == "revoked" ? null : StatusReasons.ServerChanged, status.Reason);

        // The file is read while the register request is out, when the service is not writing it.
        AgentState? saved = null;
        _f.Handler.OnRequest = request => saved ??= IsRegister(request) ? _f.State.CreateStore().Load().State : null;
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var reply = engine.Rejoin();
        Assert.True(reply.Ok);
        Assert.False(reply.Status!.CanRejoin);
        await _f.Handler.WaitForRequestsAsync(1);

        // One atomic write: a new install ID and a pending token for this server, nothing old left.
        var issued = _f.IssuedCredentials.Single();
        Assert.NotNull(saved);
        Assert.Equal(issued.InstallId, saved.InstallId);
        Assert.Null(saved.Identity);
        Assert.Equal(IdentityStates.None, saved.IdentityState);
        Assert.Equal(new PendingRegistration { ServerOrigin = EngineFixture.Origin, Token = issued.Token }, saved.Pending);

        await WaitForState(AgentStates.Connected);
        var register = Body(_f.Handler.Requests[0]);
        Assert.Equal(issued.InstallId.ToString(), register["installId"]!.GetValue<string>());
        Assert.Equal(issued.Token, register["token"]!.GetValue<string>());
        Assert.All(_f.Handler.Requests, r =>
        {
            Assert.Equal("mashkif.test", r.Uri.Host);
            Assert.DoesNotContain(EngineFixture.Identity().Token, r.Body + r.Authorization, StringComparison.Ordinal);
            Assert.DoesNotContain(PendingToken, r.Body + r.Authorization, StringComparison.Ordinal);
        });
    }

    [Theory]
    [MemberData(nameof(RejoinCases))]
    public async Task A_rejoin_survives_a_restart_and_registers_the_same_new_identity(string seed)
    {
        _f.Seed(RejoinSeed(seed));
        _f.Handler.Enqueue(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        var engine = _f.Start();
        Assert.True(engine.Rejoin().Ok);
        await _f.Handler.WaitForRequestsAsync(1);
        await _f.StopAllAsync();

        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var restarted = _f.Start();
        await _f.Handler.WaitForRequestsAsync(3);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await Eventually.TrueAsync(() => restarted.Status().State == AgentStates.Connected, "connected after restart");
        Assert.Equal(_f.IssuedCredentials.Single().InstallId, restarted.State.InstallId);
    }

    [Theory]
    [MemberData(nameof(RejoinCases))]
    public void A_failed_rejoin_write_leaves_the_old_state_whole(string seed)
    {
        var old = RejoinSeed(seed);
        _f.Seed(old);
        var engine = _f.Create();
        engine.Initialize();
        _f.Store.BeforeReplace = () => throw new IOException("disk full");

        var reply = engine.Rejoin();
        Assert.Equal(PipeErrors.NotAvailable, reply.Error);
        Assert.True(reply.Status!.CanRejoin);
        Assert.Equal(old, engine.State);
        _f.Store.BeforeReplace = null;
        Assert.Equal(old, _f.State.CreateStore().Load().State);
    }

    [Fact]
    public async Task Rejoin_is_refused_while_registering_and_while_connected()
    {
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("registration_closed"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var engine = _f.Start();
        await WaitForState(AgentStates.Refused);
        Assert.Equal(PipeErrors.NotRejoinable, engine.Rejoin().Error);

        await Advance(_f, TimeSpan.FromMinutes(66));
        await WaitForState(AgentStates.Connected);
        Assert.Equal(PipeErrors.NotRejoinable, engine.Rejoin().Error);
        Assert.Single(_f.IssuedCredentials);
    }

    // Configuration, state, and secrets.

    [Fact]
    public async Task An_invalid_SERVER_URL_sends_nothing_and_creates_nothing()
    {
        var engine = _f.Start(origin: "http://192.168.1.10:8080");
        await Eventually.SettleAsync();
        var status = engine.Status();
        Assert.Equal(AgentStates.Refused, status.State);
        Assert.Equal(StatusReasons.ConfigInvalid, status.Reason);
        Assert.False(status.CanRejoin);
        Assert.Equal(PipeErrors.NotAvailable, engine.Rejoin().Error);
        Assert.Empty(_f.Handler.Requests);
        Assert.False(File.Exists(_f.State.StateFile));
    }

    [Fact]
    public async Task An_invalid_state_is_left_untouched_and_nothing_is_sent()
    {
        File.WriteAllText(_f.State.StateFile, "{ not json");
        var engine = _f.Start();
        await Eventually.SettleAsync();
        Assert.Equal(StatusReasons.StateInvalid, engine.Status().Reason);
        Assert.Equal(PipeErrors.NotAvailable, engine.Rejoin().Error);
        Assert.Empty(_f.Handler.Requests);
        Assert.Equal("{ not json", File.ReadAllText(_f.State.StateFile));
    }

    [Fact]
    public async Task No_token_reaches_the_log_or_the_status()
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Refused);

        var state = engine.State;
        var status = JsonSerializer.Serialize(engine.Status(), PipeJsonContext.Default.AgentStatus);
        Assert.NotEmpty(_f.Logs.Lines);
        foreach (var line in _f.Logs.Lines.Append(status))
        {
            Assert.DoesNotContain(state.Identity!.Token, line, StringComparison.Ordinal);
            Assert.DoesNotContain(state.Pending!.Token, line, StringComparison.Ordinal);
        }

        Assert.DoesNotContain(state.InstallId!.Value.ToString(), status, StringComparison.Ordinal);
    }

    private async Task<AgentStatus> WaitForState(string state)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (true)
        {
            var status = _f.LastEngine.Status();
            if (status.State == state)
            {
                return status;
            }

            if (DateTime.UtcNow > deadline)
            {
                var requests = string.Join(", ", _f.Handler.Requests.Select(r => r.Uri.AbsolutePath));
                Assert.Fail($"Expected {state}, got {status}; requests: {requests}");
            }

            await Task.Delay(10);
        }
    }
}
