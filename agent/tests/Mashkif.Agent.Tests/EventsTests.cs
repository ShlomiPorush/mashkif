using System.Net;
using System.Text.Json.Nodes;
using Mashkif.Agent.Tests.Support;
using Mashkif.Service.Agent;
using Mashkif.Service.Config;
using Mashkif.Service.Events;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Mashkif.Agent.Tests;

/// <summary>Builds engines with the offline queue over one state directory, as a service restart would.</summary>
internal sealed class EventsFixture : IDisposable
{
    private readonly List<AgentEngine> _engines = [];
    private readonly List<(Task Task, CancellationTokenSource Stop)> _running = [];

    public EventsFixture()
    {
        Http = new HttpClient(Handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public StateFixture State { get; } = new();

    public RoutedHandler Handler { get; } = new();

    public HttpClient Http { get; }

    public FakeTimeProvider Time { get; } = new(new DateTimeOffset(2026, 11, 5, 8, 0, 0, TimeSpan.Zero));

    public ListLoggerProvider Logs { get; } = new();

    public Guid BootId { get; set; } = Guid.Parse("7c9e6679-7425-40de-944b-e07fc1f90ae7");

    public StateStore Store { get; private set; } = null!;

    public EventQueue Queue { get; private set; } = null!;

    /// <summary>Starts an engine; <paramref name="configure"/> sets test hooks before the state and the queue are loaded.</summary>
    public AgentEngine Start(int capacity = EventQueue.MaxEvents, Action<StateStore, EventQueue>? configure = null, long maxFileBytes = 16L * 1024 * 1024)
    {
        Queue = new EventQueue(State.StateDirectory, State.Policy) { Capacity = capacity, MaxFileBytes = maxFileBytes };
        Store = State.CreateStore();
        configure?.Invoke(Store, Queue);
        var loggerFactory = LoggerFactory.Create(builder => builder.AddProvider(Logs).SetMinimumLevel(LogLevel.Trace));
        var engine = new AgentEngine(
            new AgentEngineOptions
            {
                Store = Store,
                Origin = ServerOrigin.Parse(EngineFixture.Origin),
                Http = Http,
                BootId = BootId,
                AgentVersion = "0.1.0",
                Time = Time,
                MeasureDns = static (_, _) => Task.FromResult<int?>(4),
                Queue = Queue,
                NewCredentials = static () => new Credentials(Guid.NewGuid(), EngineFixture.NewToken()),
            },
            loggerFactory.CreateLogger<AgentEngine>());
        _engines.Add(engine);
        engine.Initialize();
        var stop = new CancellationTokenSource();
        _running.Add((Task.Run(() => engine.RunAsync(stop.Token)), stop));
        return engine;
    }

    public void Seed(AgentState state) => State.CreateStore().Save(state);

    /// <summary>Lets ready work run, advances the fake clock, and lets the work it releases run.</summary>
    public async Task AdvanceAsync(TimeSpan by)
    {
        await Eventually.SettleAsync();
        Time.Advance(by);
        await Eventually.SettleAsync();
    }

    public async Task StopAllAsync()
    {
        foreach (var (task, stop) in _running)
        {
            await stop.CancelAsync();
            try
            {
                await task;
            }
            catch (OperationCanceledException)
            {
            }

            stop.Dispose();
        }

        _running.Clear();
    }

    public void Dispose()
    {
        StopAllAsync().GetAwaiter().GetResult();
        foreach (var engine in _engines)
        {
            engine.Dispose();
        }

        Http.Dispose();
        Handler.Dispose();
        Logs.Dispose();
        State.Dispose();
    }
}

public sealed class EventsTests : IDisposable
{
    private readonly EventsFixture _f = new();

    public void Dispose() => _f.Dispose();

    private async Task<AgentEngine> StartRegisteredAsync(int capacity = EventQueue.MaxEvents)
    {
        _f.Seed(EngineFixture.Registered());
        var engine = _f.Start(capacity);
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count >= 1 && engine.State.LastSync is not null, "first heartbeat answered");
        return engine;
    }

    private IReadOnlyList<JsonNode> SentEvents() => [.. _f.Handler.Events.SelectMany(RoutedHandler.EventsOf)];

    private static string Kind(JsonNode e) => e["kind"]!.GetValue<string>();

    // Connectivity.

    [Fact]
    public async Task Connectivity_lost_and_restored_are_recorded_after_two_results_with_the_time_of_the_first()
    {
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(AgentEngine.ProbeInterval); // t=15 s: online, now known

        _f.Handler.Online = false;
        await _f.AdvanceAsync(AgentEngine.ProbeInterval); // t=30 s: the first failure
        await _f.AdvanceAsync(AgentEngine.ProbeInterval); // t=45 s: the second confirms
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.ConnectivityLost), "lost recorded");
        var lost = _f.Queue.Pending.Single(p => p.Event.Kind == EventKinds.ConnectivityLost).Event;
        Assert.Equal("sync-1", lost.SyncId);
        Assert.Equal(30_000, lost.ElapsedMs);

        // Back: the probe succeeds first (sync-1 is still the latest answer), then a heartbeat
        // answer with a newer sync arrives in the middle of the debounce (P6).
        _f.Handler.HeartbeatAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        _f.Handler.Online = true;
        var probes = _f.Handler.Probes.Count;
        while (_f.Handler.Probes.Count == probes)
        {
            await _f.AdvanceAsync(TimeSpan.FromSeconds(5));
        }

        _f.Handler.HeartbeatAnswer = null;
        await Eventually.TrueAsync(
            () =>
            {
                _f.Time.Advance(TimeSpan.FromSeconds(5));
                return SentEvents().Any(e => Kind(e) == EventKinds.ConnectivityRestored);
            },
            "restored sent");

        var restored = SentEvents().First(e => Kind(e) == EventKinds.ConnectivityRestored);
        Assert.Equal("sync-1", restored["syncId"]!.GetValue<string>());
        Assert.True(restored["elapsedMs"]!.GetValue<long>() >= 45_000);
        Assert.Contains(SentEvents(), e => Kind(e) == EventKinds.ConnectivityLost && e["elapsedMs"]!.GetValue<long>() == 30_000);
        Assert.Null(engine.State.DeferredUntilUtc);
    }

    [Fact]
    public async Task Restored_after_lost_survives_a_restart_in_between()
    {
        await StartRegisteredAsync();
        _f.Handler.EventsAnswer = static (_, ct) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        await _f.AdvanceAsync(AgentEngine.ProbeInterval);
        _f.Handler.Online = false;
        await _f.AdvanceAsync(AgentEngine.ProbeInterval);
        await _f.AdvanceAsync(AgentEngine.ProbeInterval);
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.ConnectivityLost), "lost recorded");

        await _f.StopAllAsync();
        _f.Handler.Online = true;
        _f.Start();
        await _f.AdvanceAsync(AgentEngine.ProbeInterval);
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.ConnectivityRestored), "restored recorded after the restart");
    }

    [Fact]
    public async Task A_revoked_agent_probes_records_and_sends_nothing()
    {
        _f.Seed(AgentState.Empty with { InstallId = EngineFixture.InstallId, IdentityState = IdentityStates.Revoked });
        var engine = _f.Start();
        engine.Resume();
        await engine.SuspendAsync();
        await _f.AdvanceAsync(TimeSpan.FromMinutes(2));
        Assert.Empty(_f.Handler.Requests);
        Assert.Empty(_f.Queue.Pending);
    }

    // Sending.

    [Fact]
    public async Task A_deferred_event_waits_the_full_retry_time_also_across_a_restart()
    {
        _f.Handler.EventsAnswer = static (body, _) => Task.FromResult(RoutedHandler.Results(body, "deferred", retryAfterSeconds: 9000));
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        engine.Resume();
        await _f.AdvanceAsync(AgentEngine.SenderDebounce);
        await Eventually.TrueAsync(() => _f.Handler.Events.Count == 1, "first send");
        await Eventually.TrueAsync(() => engine.State.DeferredSeconds == 9000, "deferral saved");

        await _f.AdvanceAsync(TimeSpan.FromHours(1));
        await _f.AdvanceAsync(TimeSpan.FromMinutes(30));
        Assert.Single(_f.Handler.Events);

        await _f.StopAllAsync();
        _f.Handler.EventsAnswer = null;
        _f.Start();
        await _f.AdvanceAsync(TimeSpan.FromMinutes(30));
        Assert.Single(_f.Handler.Events);

        await _f.AdvanceAsync(TimeSpan.FromHours(1));
        await Eventually.TrueAsync(() => _f.Handler.Events.Count >= 2, "sent after the full wait");
        Assert.Empty(_f.Queue.Pending);
    }

    [Fact]
    public async Task Joining_again_in_the_middle_of_a_deferral_does_not_inherit_it()
    {
        var now = _f.Time.GetUtcNow();
        _f.Seed(AgentState.Empty with
        {
            InstallId = EngineFixture.InstallId,
            IdentityState = IdentityStates.Revoked,
            DeferredUntilUtc = now.AddSeconds(9000),
            DeferredSeconds = 9000,
        });
        var engine = _f.Start();
        Assert.True(engine.Rejoin().Ok);
        Assert.Null(engine.State.DeferredUntilUtc);
        Assert.Null(engine.State.DeferredSeconds);
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count >= 1 && engine.State.LastSync is not null, "registered and heartbeating");

        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        engine.Resume();
        await _f.AdvanceAsync(AgentEngine.SenderDebounce);
        await Eventually.TrueAsync(() => SentEvents().Any(e => Kind(e) == EventKinds.Resume), "sent at once under the new identity");
    }

    [Fact]
    public async Task A_413_halves_the_batch()
    {
        var engine = await StartRegisteredAsync();
        var calls = 0;
        _f.Handler.EventsAnswer = (body, _) => Task.FromResult(
            Interlocked.Increment(ref calls) == 1
                ? RoutedHandler.Json(HttpStatusCode.RequestEntityTooLarge, """{"error":"payload_too_large"}""")
                : RoutedHandler.Results(body));
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        engine.Resume();
        engine.Resume();
        await _f.AdvanceAsync(AgentEngine.SenderDebounce);
        await Eventually.TrueAsync(() => _f.Handler.Events.Count >= 2, "sent again");
        Assert.Equal(2, RoutedHandler.EventsOf(_f.Handler.Events[0]).Count);
        Assert.Single(RoutedHandler.EventsOf(_f.Handler.Events[1]));
    }

    [Fact]
    public async Task Results_that_do_not_match_the_request_keep_the_events()
    {
        var engine = await StartRegisteredAsync();
        _f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.OK, """{"results":[]}"""));
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        engine.Resume();
        await _f.AdvanceAsync(AgentEngine.SenderDebounce);
        await Eventually.TrueAsync(() => _f.Handler.Events.Count >= 1, "sent");
        Assert.Single(_f.Queue.Pending);
    }

    [Fact]
    public async Task Accepted_duplicate_and_rejected_remove_an_event_and_a_dropped_count_goes_with_the_batch()
    {
        var engine = await StartRegisteredAsync(capacity: 1);
        _f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        engine.Resume();
        engine.Resume(); // the cap of 1 drops the first: a dropped count of 1
        await Eventually.TrueAsync(() => _f.Queue.DroppedCount(_f.BootId) == 1, "dropped");

        _f.Handler.EventsAnswer = static (body, _) => Task.FromResult(RoutedHandler.Results(body, "duplicate"));
        await Eventually.TrueAsync(
            () =>
            {
                _f.Time.Advance(TimeSpan.FromSeconds(5));
                return _f.Queue.Pending.Count == 0 && _f.Queue.NextDroppedCount() is null;
            },
            "removed and confirmed");
        var withCount = _f.Handler.Events.Select(r => JsonNode.Parse(r.Body)!).Last(b => b["droppedEvents"] is not null);
        Assert.Equal(1, withCount["droppedEvents"]!["count"]!.GetValue<long>());
        Assert.Equal(_f.BootId.ToString(), withCount["droppedEvents"]!["bootId"]!.GetValue<string>());
    }

    // Shutdown and sleep.

    [Fact]
    public async Task A_shutdown_right_after_an_answer_waits_until_the_clock_advanced_1_ms()
    {
        var engine = await StartRegisteredAsync();
        var shutdown = Task.Run(() => engine.ShutdownAsync(EventKinds.Shutdown), TestContext.Current.CancellationToken);
        await Eventually.SettleAsync();
        Assert.False(shutdown.IsCompleted);
        _f.Time.Advance(TimeSpan.FromMilliseconds(1));
        await shutdown.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        var sent = SentEvents().Single(e => Kind(e) == EventKinds.Shutdown);
        Assert.Equal(1, sent["elapsedMs"]!.GetValue<long>());
        Assert.Equal(_f.Handler.LastSyncId, sent["syncId"]!.GetValue<string>());
        Assert.True(engine.IsQuiescing);
    }

    [Fact]
    public async Task The_immediate_send_holds_exactly_the_new_lifecycle_event_with_its_queue_ID()
    {
        _f.Seed(EngineFixture.Registered());
        var backlog = new EventQueue(_f.State.StateDirectory, _f.State.Policy);
        Assert.Null(backlog.Load(new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin), _f.BootId, _f.Time.GetUtcNow(), _f.Time.GetTimestamp(), _f.Time.TimestampFrequency));
        for (var i = 0; i < 300; i++)
        {
            backlog.Append(new QueuedEvent(new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Resume, BootId = _f.BootId, SyncId = null, ElapsedMs = null }, _f.Time.GetUtcNow(), _f.Time.GetTimestamp()), _f.BootId, _f.Time.GetUtcNow(), _f.Time.GetTimestamp(), _f.Time.TimestampFrequency);
        }

        // The backlog batch hangs; only a request of one event is answered.
        _f.Handler.EventsAnswer = static async (body, ct) =>
        {
            if (body["events"]!.AsArray().Count > 1)
            {
                await Task.Delay(Timeout.Infinite, ct);
            }

            return RoutedHandler.Results(body);
        };
        var engine = _f.Start();
        await Eventually.TrueAsync(() => engine.State.LastSync is not null, "answered");
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        await engine.ShutdownAsync(EventKinds.Shutdown).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        var single = _f.Handler.Events.Select(RoutedHandler.EventsOf).Single(events => events.Count == 1);
        Assert.Equal(EventKinds.Shutdown, Kind(single[0]));
        Assert.DoesNotContain(_f.Queue.Pending, p => p.Event.Id.ToString() == single[0]["id"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_hung_heartbeat_is_abandoned_after_1_s_and_the_shutdown_is_still_recorded_and_sent()
    {
        var engine = await StartRegisteredAsync();
        _f.Handler.HeartbeatAnswer = static async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return RoutedHandler.Json(HttpStatusCode.OK, "{}");
        };
        await _f.AdvanceAsync(TimeSpan.FromSeconds(60));
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count >= 2, "a heartbeat in flight");

        var shutdown = Task.Run(() => engine.ShutdownAsync(EventKinds.Shutdown), TestContext.Current.CancellationToken);
        await Eventually.SettleAsync();
        Assert.False(shutdown.IsCompleted);
        await _f.AdvanceAsync(AgentEngine.ShutdownHeartbeatWait);
        await shutdown.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        var sent = SentEvents().Single(e => Kind(e) == EventKinds.Shutdown);
        Assert.Equal("sync-1", sent["syncId"]!.GetValue<string>());
        Assert.Equal(61_000, sent["elapsedMs"]!.GetValue<long>());
    }

    [Fact]
    public async Task A_shutdown_whose_append_is_stuck_returns_at_its_deadline_and_sends_nothing()
    {
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        using var release = new ManualResetEventSlim();
        _f.Queue.BeforeFlush = () => release.Wait(TimeSpan.FromSeconds(30));

        var shutdown = Task.Run(() => engine.ShutdownAsync(EventKinds.Shutdown), TestContext.Current.CancellationToken);
        await Eventually.SettleAsync();
        Assert.False(shutdown.IsCompleted);
        await _f.AdvanceAsync(AgentEngine.ShutdownAppendBy);
        await shutdown.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.DoesNotContain(SentEvents(), e => Kind(e) == EventKinds.Shutdown);

        // The write was not cancelled: it finishes when the disk answers.
        release.Set();
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.Shutdown), "written afterwards");
    }

    [Fact]
    public async Task The_sleep_budget_starts_at_handler_entry_and_a_stuck_append_past_it_sends_nothing()
    {
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        using var release = new ManualResetEventSlim();
        _f.Queue.BeforeFlush = () => release.Wait(TimeSpan.FromSeconds(30));

        var sleep = Task.Run(engine.SuspendAsync, TestContext.Current.CancellationToken);
        await Eventually.SettleAsync();
        Assert.False(sleep.IsCompleted);
        await _f.AdvanceAsync(AgentEngine.SleepBudget);
        await sleep.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        release.Set();
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.Sleep), "recorded");
        Assert.DoesNotContain(SentEvents(), e => Kind(e) == EventKinds.Sleep);
    }

    [Fact]
    public async Task A_sleep_does_not_wait_for_a_heartbeat_in_flight_and_is_sent_within_its_budget()
    {
        var engine = await StartRegisteredAsync();
        _f.Handler.HeartbeatAnswer = static async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return RoutedHandler.Json(HttpStatusCode.OK, "{}");
        };
        await _f.AdvanceAsync(TimeSpan.FromSeconds(60));
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count >= 2, "a heartbeat in flight");
        await engine.SuspendAsync().WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.Contains(SentEvents(), e => Kind(e) == EventKinds.Sleep);
    }

    // The power-event order (P23, P25).

    private async Task<int> HeartbeatsAfterAsync(TimeSpan by)
    {
        var before = _f.Handler.Heartbeats.Count;
        await _f.AdvanceAsync(by);
        return _f.Handler.Heartbeats.Count - before;
    }

    [Fact]
    public async Task A_resume_with_no_suspend_observed_leaves_heartbeats_running()
    {
        var engine = await StartRegisteredAsync();
        engine.Resume();
        Assert.False(engine.IsQuiescing);
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count >= 2, "a heartbeat at once after the resume");
    }

    [Fact]
    public async Task Two_suspends_then_two_resumes_end_the_pause()
    {
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        await engine.SuspendAsync();
        await engine.SuspendAsync();
        Assert.True(engine.IsQuiescing);
        var before = _f.Handler.Heartbeats.Count;
        engine.Resume();
        engine.Resume();
        Assert.False(engine.IsQuiescing);
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count > before, "a heartbeat at once after the resume");
        Assert.Equal(4, engine.PowerSequence);
    }

    [Fact]
    public async Task A_missing_resume_and_then_a_reversed_pair_never_pause_heartbeats_for_more_than_5_s()
    {
        var engine = await StartRegisteredAsync();

        // A suspend 2 s before the next heartbeat is due; its resume never comes.
        await _f.AdvanceAsync(TimeSpan.FromSeconds(58));
        await engine.SuspendAsync();
        Assert.True(engine.IsQuiescing);
        Assert.Equal(0, await HeartbeatsAfterAsync(TimeSpan.FromSeconds(2))); // due, but paused
        Assert.Equal(1, await HeartbeatsAfterAsync(TimeSpan.FromSeconds(3))); // the pause ended by itself
        Assert.False(engine.IsQuiescing);

        // The next pair, with the resume handler running first: the resume lets a heartbeat
        // run at once, and the stale sleep after it may be written (accepted, P25).
        await _f.AdvanceAsync(TimeSpan.FromSeconds(55));
        var before = _f.Handler.Heartbeats.Count;
        engine.Resume();
        await Eventually.TrueAsync(() => _f.Handler.Heartbeats.Count > before, "a heartbeat at once after the resume");
        await _f.AdvanceAsync(TimeSpan.FromSeconds(58));
        await engine.SuspendAsync();
        Assert.True(engine.IsQuiescing);
        Assert.Equal(0, await HeartbeatsAfterAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(1, await HeartbeatsAfterAsync(TimeSpan.FromSeconds(3)));
        Assert.False(engine.IsQuiescing);
    }

    [Fact]
    public async Task A_resume_before_the_sleep_append_leaves_no_sleep_record()
    {
        var engine = await StartRegisteredAsync();

        // Right after an answer the sleep waits 1 ms of the clock before it records.
        var sleep = Task.Run(engine.SuspendAsync, TestContext.Current.CancellationToken);
        await Eventually.SettleAsync();
        engine.Resume();
        _f.Time.Advance(TimeSpan.FromMilliseconds(1));
        await sleep.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        await Eventually.TrueAsync(() => _f.Queue.Pending.Any(p => p.Event.Kind == EventKinds.Resume) || SentEvents().Any(e => Kind(e) == EventKinds.Resume), "resume recorded");
        Assert.DoesNotContain(_f.Queue.Pending, p => p.Event.Kind == EventKinds.Sleep);
        Assert.DoesNotContain(SentEvents(), e => Kind(e) == EventKinds.Sleep);
        Assert.False(engine.IsQuiescing);
    }

    [Fact]
    public async Task A_resume_after_the_sleep_append_follows_it_in_the_queue()
    {
        var engine = await StartRegisteredAsync();
        _f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        await engine.SuspendAsync();
        engine.Resume();
        await Eventually.TrueAsync(() => _f.Queue.Pending.Count == 2, "both recorded");
        Assert.Equal([EventKinds.Sleep, EventKinds.Resume], _f.Queue.Pending.Select(p => p.Event.Kind));
    }

    [Fact]
    public async Task The_token_never_reaches_the_queue_file_or_the_log()
    {
        _f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        var engine = await StartRegisteredAsync();
        await _f.AdvanceAsync(TimeSpan.FromSeconds(1));
        await engine.SuspendAsync();
        engine.Resume();
        var token = EngineFixture.SeededToken;
        string content = string.Empty;
        await Eventually.TrueAsync(
            () =>
            {
                try
                {
                    // The writer may hold the file or replace it in a compaction at this moment.
                    using var stream = new FileStream(_f.Queue.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var reader = new StreamReader(stream);
                    content = reader.ReadToEnd();
                    return content.Contains(EventKinds.Resume, StringComparison.Ordinal);
                }
                catch (IOException)
                {
                    return false;
                }
            },
            "written");
        Assert.DoesNotContain(token, content, StringComparison.Ordinal);
        Assert.All(_f.Logs.Lines, line => Assert.DoesNotContain(token, line, StringComparison.Ordinal));
    }
}
