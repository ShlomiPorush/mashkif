using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mashkif.Agent.Tests.Support;
using Mashkif.Common.Pipe;
using Mashkif.Service.State;

namespace Mashkif.Agent.Tests;

public sealed class EngineTests : IDisposable
{
    private const string KeyA = "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7";
    private const string KeyB = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC";
    private const string AgentId = "0b5f3c1a-9d2e-4f6a-8b7c-1d2e3f4a5b6c";

    private readonly EngineFixture _f = new();

    public void Dispose() => _f.Dispose();

    private static string Registered(int interval = 60) =>
        $$"""{"agentId":"{{AgentId}}","heartbeatIntervalSeconds":{{interval}},"serverTime":"2026-11-02T09:00:00Z"}""";

    private static string Recorded(int next) =>
        $$"""{"syncId":"sync-{{next}}","serverTime":"2026-11-02T09:01:00Z","nextIntervalSeconds":{{next}}}""";

    private static string Error(string code) => $$"""{"error":"{{code}}"}""";

    private static JsonNode Body(RecordedRequest request) => JsonNode.Parse(request.Body)!;

    private static async Task Advance(EngineFixture f, TimeSpan by)
    {
        await Eventually.SettleAsync();
        f.Time.Advance(by);
    }

    private async Task<Mashkif.Service.Agent.AgentEngine> RegisteredAgentAsync(int interval = 60, int next = 60)
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered(interval));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(next));
        Assert.True(engine.Register(KeyA).Ok);
        await _f.Handler.WaitForRequestsAsync(2);
        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Connected, "connected");
        return engine;
    }

    [Fact]
    public async Task Tray_registration_saves_the_identity_before_sending_and_then_sends_heartbeats()
    {
        var engine = _f.Start();
        Assert.Equal(AgentStates.Unregistered, engine.Status().State);
        Assert.True(engine.Status().CanEnroll);

        string? tokenOnDisk = null;
        _f.Handler.OnRequest = request =>
        {
            if (request.Uri.AbsolutePath.EndsWith("/register", StringComparison.Ordinal))
            {
                tokenOnDisk = JsonNode.Parse(File.ReadAllText(_f.State.StateFile))!["pending"]!["token"]!.GetValue<string>();
            }
        };
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered(30));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(120));

        var reply = engine.Register(KeyA);
        Assert.True(reply.Ok);
        Assert.Equal(AgentStates.Registering, reply.Status!.State);
        await _f.Handler.WaitForRequestsAsync(2);

        var register = _f.Handler.Requests[0];
        Assert.Equal("https://mashkif.test/api/agent/register", register.Uri.ToString());
        Assert.Equal("1", register.ProtocolVersion);
        Assert.Null(register.Authorization);
        var issued = _f.IssuedCredentials.Single();
        Assert.Equal(issued.Token, Body(register)["token"]!.GetValue<string>());
        Assert.Equal(issued.Token, tokenOnDisk);
        Assert.Equal(KeyA, Body(register)["enrollmentKey"]!.GetValue<string>());
        Assert.Equal("10.0.26100", Body(register)["osVersion"]!.GetValue<string>());

        var heartbeat = _f.Handler.Requests[1];
        Assert.Equal("https://mashkif.test/api/agent/heartbeat", heartbeat.Uri.ToString());
        Assert.Equal($"Bearer {issued.Token}", heartbeat.Authorization);
        var body = Body(heartbeat);
        Assert.Equal(0, body["sequence"]!.GetValue<long>());
        Assert.Equal(30, body["intervalSeconds"]!.GetValue<int>());
        Assert.Null(body["roundTripMs"]);
        Assert.Equal(4, body["dnsMs"]!.GetValue<int>());
        Assert.Null(body["areaCell"]);
        Assert.Equal("unknown", body["infrastructure"]!.GetValue<string>());
        Assert.Equal(_f.BootId.ToString(), body["bootId"]!.GetValue<string>());

        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Connected, "connected");
        var state = engine.State;
        Assert.Null(state.Pending);
        Assert.Equal(IdentityStates.Active, state.IdentityState);
        Assert.Equal(Guid.Parse(AgentId), state.Identity!.AgentId);
        Assert.Equal(120, state.IntervalSeconds);
        Assert.Equal(1, state.NextSequence);
        Assert.False(engine.Status().CanEnroll);
    }

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
        await Eventually.TrueAsync(() => _f.Handler.Requests.Count == 3 && _f.Handler.Requests[2].Body.Length > 0, "lost attempt");
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

    [Fact]
    public async Task A_401_keeps_the_token_and_a_later_200_makes_it_active_again_also_after_a_restart()
    {
        var engine = await RegisteredAgentAsync();
        var token = engine.State.Identity!.Token;
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));

        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(3);
        var status = await WaitForState(AgentStates.Refused);
        Assert.Equal(StatusReasons.TokenInvalid, status.Reason);
        Assert.True(status.CanEnroll);
        Assert.Equal(IdentityStates.TokenRejected, _f.State.CreateStore().Load().State!.IdentityState);
        Assert.Equal(token, engine.State.Identity!.Token);

        await Advance(_f, TimeSpan.FromMinutes(66));
        await _f.Handler.WaitForRequestsAsync(4);
        status = await WaitForState(AgentStates.Connected);
        Assert.Null(status.Reason);
        Assert.False(status.CanEnroll);
        Assert.Equal(IdentityStates.Active, _f.State.CreateStore().Load().State!.IdentityState);

        await _f.StopAllAsync();
        var restarted = _f.Create();
        restarted.Initialize();
        Assert.Equal(IdentityStates.Active, restarted.State.IdentityState);
        Assert.False(restarted.Status().CanEnroll);
    }

    [Fact]
    public async Task A_revoked_agent_discards_its_identity_and_can_enroll_again()
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("agent_revoked"));

        await Advance(_f, TimeSpan.FromSeconds(60));
        var status = await WaitForState(AgentStates.Revoked);
        Assert.True(status.CanEnroll);
        Assert.Null(engine.State.Identity);
        Assert.Null(_f.State.CreateStore().Load().State!.Identity);

        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyB).Ok);
        await WaitForState(AgentStates.Connected);
        Assert.NotEqual(_f.IssuedCredentials[0].Token, engine.State.Identity!.Token);
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

    [Fact]
    public async Task Unknown_response_fields_are_ignored()
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered().Replace("}", ""","futureField":{"a":1}}""", StringComparison.Ordinal));
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyA).Ok);
        await WaitForState(AgentStates.Connected);
    }

    [Theory]
    [InlineData("enrollment_key_invalid")]
    [InlineData("enrollment_key_expired")]
    [InlineData("enrollment_key_revoked")]
    [InlineData("enrollment_key_used")]
    public async Task A_refused_key_drops_the_registration_and_says_why(string code)
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error(code));
        Assert.True(engine.Register(KeyA).Ok);

        await Eventually.TrueAsync(() => engine.State.Pending is null, "pending dropped");
        var status = engine.Status();
        Assert.Equal(AgentStates.Unregistered, status.State);
        Assert.Equal(code, status.EnrollmentError);
        Assert.True(status.CanEnroll);
        Assert.Null(_f.State.CreateStore().Load().State!.Pending);
    }

    [Fact]
    public async Task An_install_id_conflict_retries_at_once_with_a_new_install_id_and_token_and_the_same_key()
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(HttpStatusCode.Conflict, Error("install_id_conflict"));
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyA).Ok);

        await _f.Handler.WaitForRequestsAsync(2);
        var first = Body(_f.Handler.Requests[0]);
        var second = Body(_f.Handler.Requests[1]);
        Assert.Equal(KeyA, second["enrollmentKey"]!.GetValue<string>());
        Assert.NotEqual(first["installId"]!.GetValue<string>(), second["installId"]!.GetValue<string>());
        Assert.NotEqual(first["token"]!.GetValue<string>(), second["token"]!.GetValue<string>());
        await WaitForState(AgentStates.Connected);
        Assert.Equal(_f.IssuedCredentials[1].Token, engine.State.Identity!.Token);
    }

    [Fact]
    public async Task A_lost_register_response_is_retried_with_the_identical_body()
    {
        var engine = _f.Start();
        _f.Handler.EnqueueLost();
        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyA).Ok);

        await _f.Handler.WaitForRequestsAsync(1);
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
    }

    [Fact]
    public async Task A_crash_after_saving_the_registration_resends_the_same_registration_after_a_restart()
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        Assert.True(engine.Register(KeyA).Ok);
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
        var engine = _f.Start();
        var failNext = false;
        _f.Handler.OnRequest = request => failNext = request.Uri.AbsolutePath.EndsWith("/register", StringComparison.Ordinal) && _f.Handler.Requests.Count == 0;
        _f.Store.BeforeReplace = () =>
        {
            if (failNext)
            {
                failNext = false;
                throw new IOException("disk full");
            }
        };
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyA).Ok);

        await _f.Handler.WaitForRequestsAsync(1);
        await Eventually.TrueAsync(() => engine.Status().State == AgentStates.Registering, "still registering");
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.Equal(_f.Handler.Requests[0].Body, _f.Handler.Requests[1].Body);
        await WaitForState(AgentStates.Connected);
        Assert.NotNull(_f.State.CreateStore().Load().State!.Identity);
    }

    [Fact]
    public async Task Register_while_a_heartbeat_is_in_flight_cancels_it_and_keeps_the_old_identity_until_success()
    {
        var old = EngineFixture.Identity();
        _f.Seed(AgentState.Empty with { Identity = old, IdentityState = IdentityStates.TokenRejected });
        var inFlight = new TaskCompletionSource();
        _f.Handler.Enqueue(async (_, token) =>
        {
            inFlight.SetResult();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        var engine = _f.Start();
        await inFlight.Task;

        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("enrollment_key_used"));
        // After the refusal the kept identity sends its heartbeat again and is still rejected.
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        Assert.True(engine.Register(KeyB).Ok);
        await _f.Handler.WaitForRequestsAsync(2);
        Assert.EndsWith("/register", _f.Handler.Requests[1].Uri.AbsolutePath, StringComparison.Ordinal);

        // A wrong key keeps the old identity.
        await Eventually.TrueAsync(() => engine.State.Pending is null, "pending dropped");
        Assert.Equal(old, engine.State.Identity);
        Assert.Equal(IdentityStates.TokenRejected, engine.State.IdentityState);
        Assert.Equal(StatusReasons.EnrollmentKeyUsed, engine.Status().EnrollmentError);
        Assert.Equal(StatusReasons.TokenInvalid, engine.Status().Reason);
        await _f.Handler.WaitForRequestsAsync(3);

        // A right key replaces it.
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyA).Ok);
        await WaitForState(AgentStates.Connected);
        Assert.NotEqual(old.Token, engine.State.Identity!.Token);
        Assert.Equal(IdentityStates.Active, engine.State.IdentityState);
    }

    [Fact]
    public async Task A_new_registration_that_is_revoked_after_a_lost_response_keeps_the_old_identity()
    {
        var old = EngineFixture.Identity();
        _f.Seed(AgentState.Empty with { Identity = old, IdentityState = IdentityStates.TokenRejected });
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        var engine = _f.Start();
        await _f.Handler.WaitForRequestsAsync(1);

        // B is created on the server, its answer is lost, the admin revokes B,
        // and the retry gets agent_revoked.
        _f.Handler.EnqueueLost();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("agent_revoked"));
        Assert.True(engine.Register(KeyB).Ok);
        await _f.Handler.WaitForRequestsAsync(2);
        await Advance(_f, TimeSpan.FromSeconds(60));
        await _f.Handler.WaitForRequestsAsync(3);
        Assert.Equal(_f.Handler.Requests[1].Body, _f.Handler.Requests[2].Body);

        await Eventually.TrueAsync(() => engine.State.Pending is null, "pending dropped");
        Assert.Equal(old, engine.State.Identity);
        Assert.Equal(IdentityStates.TokenRejected, engine.State.IdentityState);
        var status = engine.Status();
        Assert.Equal(AgentStates.Refused, status.State);
        Assert.Equal(StatusReasons.TokenInvalid, status.Reason);
        Assert.Equal(StatusReasons.AgentRevoked, status.EnrollmentError);
        Assert.Equal(old, _f.State.CreateStore().Load().State!.Identity);
    }

    [Fact]
    public async Task A_revoked_new_registration_without_an_identity_leaves_the_agent_revoked()
    {
        var engine = _f.Start();
        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("agent_revoked"));
        Assert.True(engine.Register(KeyA).Ok);
        var status = await WaitForState(AgentStates.Revoked);
        Assert.True(status.CanEnroll);
        Assert.Equal(StatusReasons.AgentRevoked, status.EnrollmentError);
    }

    [Fact]
    public async Task A_changed_server_never_gets_the_old_token_and_the_old_identity_stays_until_a_new_enrollment_succeeds()
    {
        var old = EngineFixture.Identity(origin: "https://old.test");
        _f.Seed(AgentState.Empty with { Identity = old, IdentityState = IdentityStates.Active });
        var engine = _f.Start();
        await Eventually.SettleAsync();

        var status = engine.Status();
        Assert.Equal(AgentStates.Refused, status.State);
        Assert.Equal(StatusReasons.ServerChanged, status.Reason);
        Assert.True(status.CanEnroll);
        Assert.Empty(_f.Handler.Requests);

        _f.Handler.Enqueue(HttpStatusCode.Forbidden, Error("enrollment_key_expired"));
        Assert.True(engine.Register(KeyA).Ok);
        await Eventually.TrueAsync(() => engine.State.Pending is null, "pending dropped");
        Assert.Equal(old, engine.State.Identity);

        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        Assert.True(engine.Register(KeyB).Ok);
        await WaitForState(AgentStates.Connected);
        Assert.Equal("https://mashkif.test", engine.State.Identity!.ServerOrigin);
        Assert.All(_f.Handler.Requests, r =>
        {
            Assert.Equal("mashkif.test", r.Uri.Host);
            Assert.DoesNotContain(old.Token, r.Body + r.Authorization, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void The_register_command_is_refused_with_a_reason()
    {
        var engine = _f.Create();
        engine.Initialize();
        Assert.Equal(PipeErrors.EnrollmentKeyFormat, engine.Register("short").Error);
        Assert.True(engine.Register(KeyA).Ok);
        Assert.Equal(PipeErrors.RegistrationInProgress, engine.Register(KeyB).Error);
    }

    [Fact]
    public void The_register_command_is_refused_while_registered()
    {
        _f.Seed(AgentState.Empty with { Identity = EngineFixture.Identity(), IdentityState = IdentityStates.Active });
        var engine = _f.Create();
        engine.Initialize();
        var reply = engine.Register(KeyA);
        Assert.False(reply.Ok);
        Assert.Equal(PipeErrors.AlreadyRegistered, reply.Error);
        Assert.False(reply.Status!.CanEnroll);
    }

    [Fact]
    public async Task An_invalid_SERVER_URL_sends_nothing_and_leaves_the_MSI_key_alone()
    {
        _f.MsiKey.Value = KeyA;
        var engine = _f.Start(origin: "http://192.168.1.10:8080");
        await Eventually.SettleAsync();
        var status = engine.Status();
        Assert.Equal(AgentStates.Refused, status.State);
        Assert.Equal(StatusReasons.ConfigInvalid, status.Reason);
        Assert.Equal(KeyA, _f.MsiKey.Value);
        Assert.Equal(0, _f.MsiKey.Reads);
        Assert.Equal(PipeErrors.NotAvailable, engine.Register(KeyB).Error);
        Assert.Empty(_f.Handler.Requests);
    }

    [Fact]
    public void An_invalid_state_is_left_untouched_and_the_MSI_key_is_not_read()
    {
        File.WriteAllText(_f.State.StateFile, "{ not json");
        _f.MsiKey.Value = KeyA;
        var engine = _f.Create();
        engine.Initialize();
        Assert.Equal(StatusReasons.StateInvalid, engine.Status().Reason);
        Assert.Equal(0, _f.MsiKey.Reads);
        Assert.Equal("{ not json", File.ReadAllText(_f.State.StateFile));
    }

    [Fact]
    public async Task An_MSI_key_is_saved_to_pending_then_deleted_and_registered()
    {
        _f.MsiKey.Value = KeyA;
        _f.Handler.Enqueue(HttpStatusCode.Created, Registered());
        _f.Handler.Enqueue(HttpStatusCode.OK, Recorded(60));
        var deletedAfterSave = false;
        var engine = _f.Create();
        _f.Store.BeforeReplace = () => deletedAfterSave = _f.MsiKey.Value is null;
        engine.Initialize();

        Assert.False(deletedAfterSave);
        Assert.Null(_f.MsiKey.Value);
        Assert.Equal(KeyA, engine.State.Pending!.Key);
        Assert.Equal(AgentState.SourceMsi, engine.State.Pending.Source);
        Assert.Equal("https://mashkif.test", engine.State.Pending.ServerOrigin);
        _f.Run(engine);
        await WaitForState(AgentStates.Connected);
        Assert.Equal(KeyA, Body(_f.Handler.Requests[0])["enrollmentKey"]!.GetValue<string>());
    }

    [Fact]
    public void A_crash_before_saving_pending_leaves_the_MSI_key_for_the_next_start()
    {
        _f.MsiKey.Value = KeyA;
        var engine = _f.Create();
        _f.Store.BeforeReplace = () => throw new IOException("crash");
        engine.Initialize();
        Assert.Equal(KeyA, _f.MsiKey.Value);
        Assert.Null(_f.State.CreateStore().Load().State!.Pending);

        var restarted = _f.Create();
        restarted.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Equal(KeyA, restarted.State.Pending!.Key);
    }

    [Fact]
    public void A_crash_between_saving_pending_and_deleting_the_value_deletes_the_value_at_the_next_start()
    {
        _f.MsiKey.Value = KeyA;
        _f.MsiKey.FailDelete = true;
        var engine = _f.Create();
        engine.Initialize();
        Assert.Equal(KeyA, _f.MsiKey.Value);
        var pending = engine.State.Pending!;

        _f.MsiKey.FailDelete = false;
        var restarted = _f.Create();
        restarted.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Equal(pending, restarted.State.Pending);
        Assert.Single(_f.IssuedCredentials);
    }

    [Fact]
    public void A_crash_between_saving_pending_and_deleting_combined_with_a_server_change_never_adopts_the_old_key()
    {
        _f.MsiKey.Value = KeyA;
        _f.MsiKey.FailDelete = true;
        _f.Create().Initialize();
        Assert.Equal(KeyA, _f.MsiKey.Value);

        _f.MsiKey.FailDelete = false;
        var restarted = _f.Create(origin: "https://new.test");
        restarted.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Null(restarted.State.Pending);
        Assert.Single(_f.IssuedCredentials);
        Assert.Null(_f.State.CreateStore().Load().State!.Pending);
    }

    [Fact]
    public void A_discarded_pending_is_never_read_again()
    {
        _f.Seed(AgentState.Empty with
        {
            Pending = new PendingRegistration { ServerOrigin = "https://old.test", Key = KeyA, Source = AgentState.SourceMsi, InstallId = Guid.NewGuid(), Token = new string('A', 43) },
        });
        var engine = _f.Create();
        engine.Initialize();
        Assert.Null(engine.State.Pending);
        Assert.Equal(1, _f.MsiKey.Reads);

        var again = _f.Create();
        again.Initialize();
        Assert.Null(again.State.Pending);
    }

    [Fact]
    public void An_MSI_key_for_a_registered_agent_is_ignored_and_deleted()
    {
        _f.Seed(AgentState.Empty with { Identity = EngineFixture.Identity(), IdentityState = IdentityStates.Active });
        _f.MsiKey.Value = KeyA;
        var engine = _f.Create();
        engine.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Null(engine.State.Pending);
    }

    [Fact]
    public void An_MSI_key_under_a_server_change_is_used_for_the_new_server()
    {
        _f.Seed(AgentState.Empty with { Identity = EngineFixture.Identity(origin: "https://old.test"), IdentityState = IdentityStates.Active });
        _f.MsiKey.Value = KeyA;
        var engine = _f.Create();
        engine.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Equal("https://mashkif.test", engine.State.Pending!.ServerOrigin);
        Assert.Equal("https://old.test", engine.State.Identity!.ServerOrigin);
    }

    [Fact]
    public void An_MSI_key_with_a_bad_format_is_deleted_and_reported()
    {
        _f.MsiKey.Value = "not-a-key";
        var engine = _f.Create();
        engine.Initialize();
        Assert.Null(_f.MsiKey.Value);
        Assert.Null(engine.State.Pending);
        Assert.Equal(StatusReasons.EnrollmentKeyInvalid, engine.Status().EnrollmentError);
    }

    [Fact]
    public async Task Neither_the_token_nor_the_key_reaches_the_log_or_the_status()
    {
        var engine = await RegisteredAgentAsync();
        _f.Handler.Enqueue(HttpStatusCode.Unauthorized, Error("token_invalid"));
        await Advance(_f, TimeSpan.FromSeconds(60));
        await WaitForState(AgentStates.Refused);

        var token = engine.State.Identity!.Token;
        var status = JsonSerializer.Serialize(engine.Status(), PipeJsonContext.Default.AgentStatus);
        Assert.NotEmpty(_f.Logs.Lines);
        foreach (var line in _f.Logs.Lines.Append(status))
        {
            Assert.DoesNotContain(token, line, StringComparison.Ordinal);
            Assert.DoesNotContain(KeyA, line, StringComparison.Ordinal);
        }
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
