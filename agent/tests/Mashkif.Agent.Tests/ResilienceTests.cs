using System.Collections.Concurrent;
using System.Net;
using System.Text.Json.Nodes;
using Mashkif.Agent.Tests.Support;
using Mashkif.Common.Pipe;
using Mashkif.Service.Agent;
using Mashkif.Service.Events;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;

namespace Mashkif.Agent.Tests;

/// <summary>
/// Stops the agent at a chosen durable write, like a crash: from that write
/// on, every write of <c>state.json</c> (before its move) and of the queue
/// (before its flush, or before a compaction's move) throws, as if the
/// process were gone. Counting the writes of a clean run gives every point.
/// </summary>
internal sealed class CrashPoint(int at)
{
    private readonly ConcurrentQueue<string> _writes = new();
    private int _count;

    public bool Crashed { get; private set; }

    /// <summary>Runs once at the crash: a crashed process sends nothing more either.</summary>
    public Action? OnCrash { get; set; }

    public IReadOnlyList<string> Writes => [.. _writes];

    public void Wire(StateStore store, EventQueue queue)
    {
        store.BeforeReplace = () => Hit("state");
        queue.BeforeFlush = () => Hit("append");
        queue.BeforeReplace = () => Hit("compact");
    }

    private void Hit(string what)
    {
        var n = Interlocked.Increment(ref _count);
        _writes.Enqueue(what);
        if (Crashed || (at > 0 && n >= at))
        {
            if (!Crashed)
            {
                Crashed = true;
                OnCrash?.Invoke();
            }

            throw new IOException($"crashed at durable write {n} ({what})");
        }
    }
}

/// <summary>
/// Crash safety, identity switches, and sender pacing of step 2c, through the
/// engine with a fake clock. Waits advance the fake clock until a condition
/// holds; nothing sleeps for a fixed time.
/// </summary>
public sealed class ResilienceTests
{
    private static readonly TimeSpan Step = TimeSpan.FromSeconds(5);

    /// <summary>Advances the fake clock in steps until <paramref name="condition"/> holds.</summary>
    private static Task UntilAsync(EventsFixture f, Func<bool> condition, string because, TimeSpan? step = null) =>
        Eventually.TrueAsync(
            () =>
            {
                if (condition())
                {
                    return true;
                }

                f.Time.Advance(step ?? Step);
                return false;
            },
            because,
            TimeSpan.FromSeconds(20));

    private static IEnumerable<JsonNode> Bodies(EventsFixture f) => f.Handler.Events.Select(r => JsonNode.Parse(r.Body)!);

    private static IEnumerable<string> SentIds(EventsFixture f) =>
        Bodies(f).SelectMany(b => b["events"]!.AsArray()).Select(e => e!["id"]!.GetValue<string>());

    private static HttpResponseMessage TokenInvalid() => RoutedHandler.Json(HttpStatusCode.Unauthorized, """{"error":"token_invalid"}""");

    // 1. Interruption between every pair of durable writes (P3, P8).

    /// <summary>
    /// Drops, a deferred answer, the removal, and the confirmation of the
    /// count: capacity 1 and three events give two drops; the first send is
    /// deferred for 30 s, the second accepted.
    /// </summary>
    private static async Task DropsAndConfirmationAsync(EventsFixture f, CrashPoint crash)
    {
        f.Seed(EngineFixture.Registered());
        var calls = 0;
        f.Handler.EventsAnswer = (body, _) => Task.FromResult(Interlocked.Increment(ref calls) == 1
            ? RoutedHandler.Results(body, "deferred", retryAfterSeconds: 30)
            : RoutedHandler.Results(body));
        crash.OnCrash = () => f.Handler.Online = false;
        var engine = f.Start(capacity: 1, configure: crash.Wire);
        await UntilAsync(f, () => crash.Crashed || engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        engine.Resume();
        engine.Resume();
        await UntilAsync(f, () => crash.Crashed || (f.Handler.Events.Count >= 2 && f.Queue.Pending.Count == 0 && f.Queue.NextDroppedCount() is null), "delivered and confirmed");
    }

    [Fact]
    public async Task A_crash_at_any_durable_write_of_drops_deferral_removal_and_confirmation_keeps_queue_and_counts_consistent()
    {
        int writes;
        using (var clean = new EventsFixture())
        {
            var none = new CrashPoint(0);
            await DropsAndConfirmationAsync(clean, none);
            Assert.Contains("append", none.Writes);
            Assert.Contains("state", none.Writes);
            Assert.Equal(2, clean.Queue.DroppedCount(clean.BootId));
            writes = none.Writes.Count;
        }

        for (var at = 1; at <= writes; at++)
        {
            using var f = new EventsFixture();
            var crash = new CrashPoint(at);
            await DropsAndConfirmationAsync(f, crash);
            await f.StopAllAsync();
            f.Handler.Online = true;

            // The restart reads what reached the disk and finishes the work.
            var restarted = f.Start(capacity: 1);
            await UntilAsync(f, () => restarted.Status().State == AgentStates.Connected && f.Queue.Pending.Count == 0 && f.Queue.NextDroppedCount() is null, $"finished after a crash at write {at}");

            // Counts never double or go back; the last one sent is what the disk holds.
            var counts = Bodies(f).Select(b => b["droppedEvents"]).Where(d => d is not null).Select(d => d!["count"]!.GetValue<long>()).ToList();
            Assert.True(counts.All(c => c is >= 1 and <= 2), $"crash at write {at} of {string.Join(",", crash.Writes)}: counts {string.Join(",", counts)}");
            Assert.Equal(counts.OrderBy(c => c), counts);
            Assert.Equal(f.Queue.DroppedCount(f.BootId), counts.Count == 0 ? 0 : counts[^1]);

            // One event ID is always the same event.
            var kinds = Bodies(f).SelectMany(b => b["events"]!.AsArray()).GroupBy(e => e!["id"]!.GetValue<string>());
            Assert.All(kinds, g => Assert.Single(g.Select(e => e!["kind"]!.GetValue<string>()).Distinct()));
            Assert.All(f.Handler.Events, r => Assert.Equal($"Bearer {EngineFixture.SeededToken}", r.Authorization));
        }
    }

    /// <summary>
    /// Join again with events and a dropped count of the revoked identity in
    /// the queue: the new install ID, the rebind, the registration, the first
    /// heartbeat, and a new event.
    /// </summary>
    private static async Task<(IReadOnlySet<string> OldIds, AgentEngine Engine)> RejoinWithOldEventsAsync(EventsFixture f, CrashPoint crash)
    {
        f.Seed(AgentState.Empty with { InstallId = EngineFixture.InstallId, IdentityState = IdentityStates.Revoked });
        var old = new EventQueue(f.State.StateDirectory, f.State.Policy) { Capacity = 1 };
        Assert.Null(old.Load(new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin), f.BootId, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency));
        HashSet<string> oldIds = [];
        for (var i = 0; i < 2; i++)
        {
            var e = new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Shutdown, BootId = f.BootId, SyncId = null, ElapsedMs = null };
            oldIds.Add(e.Id.ToString());
            old.Append(new QueuedEvent(e, f.Time.GetUtcNow(), f.Time.GetTimestamp()), f.BootId, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency);
        }

        Assert.Equal(1, old.DroppedCount(f.BootId));
        crash.OnCrash = () => f.Handler.Online = false;
        var engine = f.Start(configure: crash.Wire);
        engine.Rejoin();
        await UntilAsync(f, () => crash.Crashed || engine.State.LastSync is not null, "rejoined", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => crash.Crashed || SentKinds(f).Contains(EventKinds.Resume), "the new event sent");
        return (oldIds, engine);
    }

    private static List<string> SentKinds(EventsFixture f) =>
        [.. Bodies(f).SelectMany(b => b["events"]!.AsArray()).Select(e => e!["kind"]!.GetValue<string>())];

    [Fact]
    public async Task A_crash_at_any_durable_write_of_Join_again_never_sends_the_old_identitys_events_or_count()
    {
        int writes;
        using (var clean = new EventsFixture())
        {
            var none = new CrashPoint(0);
            await RejoinWithOldEventsAsync(clean, none);
            writes = none.Writes.Count;
            Assert.Contains("compact", none.Writes);
        }

        for (var at = 1; at <= writes; at++)
        {
            using var f = new EventsFixture();
            var crash = new CrashPoint(at);
            var (oldIds, _) = await RejoinWithOldEventsAsync(f, crash);
            await f.StopAllAsync();
            f.Handler.Online = true;

            var restarted = f.Start();
            if (restarted.State.IdentityState == IdentityStates.Revoked)
            {
                // The crash came before Join again was saved: still revoked, and it may be chosen again.
                Assert.True(restarted.Rejoin().Ok);
            }

            await UntilAsync(f, () => restarted.State.LastSync is not null, $"registered after a crash at write {at}", TimeSpan.FromMilliseconds(1));
            f.Time.Advance(TimeSpan.FromSeconds(1));
            restarted.Resume();
            await UntilAsync(f, () => SentKinds(f).Contains(EventKinds.Resume) && f.Queue.Pending.Count == 0, "the new event sent");

            Assert.DoesNotContain(SentIds(f), oldIds.Contains);
            Assert.DoesNotContain(SentKinds(f), k => k == EventKinds.Shutdown);
            Assert.All(Bodies(f), b => Assert.Null(b["droppedEvents"]));
            Assert.All(f.Handler.Events, r => Assert.NotEqual($"Bearer {EngineFixture.SeededToken}", r.Authorization));
        }
    }

    // 2. A registration of the 401 cycle in the middle of a deferral (P17).

    [Fact]
    public async Task A_401_cycle_registration_in_the_middle_of_a_deferral_ends_it_and_its_running_wait()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        var deferring = true;
        f.Handler.EventsAnswer = (body, _) => Task.FromResult(deferring ? RoutedHandler.Results(body, "deferred", retryAfterSeconds: 9000) : RoutedHandler.Results(body));
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        var start = f.Time.GetUtcNow();
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => engine.State.DeferredSeconds == 9000, "deferred", TimeSpan.FromSeconds(1));

        // The server no longer knows the token: the cycle registers the pending token about an hour later.
        var oldToken = EngineFixture.SeededToken;
        f.Handler.HeartbeatAnswer = (request, _) => Task.FromResult(request.Authorization == $"Bearer {oldToken}" ? TokenInvalid() : f.Handler.NextSync());
        deferring = false;
        await UntilAsync(f, () => engine.State.Identity is { } identity && identity.Token != oldToken, "registered again", TimeSpan.FromMinutes(1));
        Assert.Null(engine.State.DeferredUntilUtc);
        Assert.Null(engine.State.DeferredSeconds);

        var newToken = engine.State.Identity!.Token;
        await UntilAsync(f, () => f.Handler.Events.Any(r => r.Authorization == $"Bearer {newToken}"), "sent under the new identity");
        Assert.True(f.Time.GetUtcNow() - start < TimeSpan.FromSeconds(9000), "the old deferral did not hold the sender");
        Assert.Empty(f.Queue.Pending);
    }

    // 3. A late result after an identity switch.

    [Fact]
    public async Task A_late_answer_to_the_old_identity_changes_nothing()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        f.Handler.EventsAnswer = async (body, _) =>
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                // Held until the identity switched, then a deferral of an hour and more.
                await release.Task;
                return RoutedHandler.Results(body, "deferred", retryAfterSeconds: 9000);
            }

            return RoutedHandler.Results(body);
        };
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => f.Handler.Events.Count == 1, "the request in flight", TimeSpan.FromSeconds(1));

        var oldToken = EngineFixture.SeededToken;
        f.Handler.HeartbeatAnswer = (request, _) => Task.FromResult(request.Authorization == $"Bearer {oldToken}" ? TokenInvalid() : f.Handler.NextSync());
        await UntilAsync(f, () => engine.State.Identity is { } identity && identity.Token != oldToken, "registered again", TimeSpan.FromMinutes(1));

        release.SetResult();
        var newToken = engine.State.Identity!.Token;
        await UntilAsync(f, () => f.Handler.Events.Any(r => r.Authorization == $"Bearer {newToken}") && f.Queue.Pending.Count == 0, "sent under the new identity");
        Assert.Null(engine.State.DeferredUntilUtc);
        Assert.Null(engine.State.DeferredSeconds);
    }

    // Review R1: the queue is isolated from a new identity at run time.

    [Fact]
    public async Task With_the_writer_held_behind_an_old_write_the_new_identity_never_sends_the_old_events()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => f.Queue.Pending.Count == 1, "an old event queued", TimeSpan.FromMilliseconds(1));
        var oldIds = f.Queue.Pending.Select(p => p.Event.Id.ToString()).ToHashSet();

        // A second old event whose write is held, so the Rebind of Join again waits behind it.
        using var held = new ManualResetEventSlim();
        f.Queue.BeforeFlush = () => held.Wait(TimeSpan.FromSeconds(30));
        engine.Resume();
        f.Handler.HeartbeatAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.Forbidden, """{"error":"agent_revoked"}"""));
        await UntilAsync(f, () => engine.State.IdentityState == IdentityStates.Revoked, "revoked", TimeSpan.FromSeconds(10));
        f.Handler.HeartbeatAnswer = null;
        f.Handler.EventsAnswer = null;
        Assert.True(engine.Rejoin().Ok);
        await UntilAsync(f, () => engine.State.LastSync is not null && engine.State.IdentityState == IdentityStates.Active, "the new identity reports", TimeSpan.FromMilliseconds(500));
        var newToken = engine.State.Identity!.Token;
        f.Time.Advance(TimeSpan.FromMinutes(1)); // the sender is signalled while the writer is still held

        f.Queue.BeforeFlush = null;
        held.Set();
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => f.Handler.Events.Any(r => r.Authorization == $"Bearer {newToken}") && f.Queue.Pending.Count == 0, "the new event sent");

        var underNewToken = f.Handler.Events.Where(r => r.Authorization == $"Bearer {newToken}").Select(r => JsonNode.Parse(r.Body)!).ToList();
        Assert.All(underNewToken, b => Assert.Null(b["droppedEvents"]));
        var newIds = underNewToken.SelectMany(b => b["events"]!.AsArray()).Select(e => e!["id"]!.GetValue<string>()).ToList();
        Assert.NotEmpty(newIds);
        Assert.DoesNotContain(newIds, oldIds.Contains);
        Assert.All(underNewToken.SelectMany(b => b["events"]!.AsArray()), e => Assert.Equal(EventKinds.Resume, e!["kind"]!.GetValue<string>()));
        Assert.Single(newIds.Distinct());
    }

    [Fact]
    public async Task A_sleep_written_late_after_a_revoke_and_Join_again_is_never_sent_with_the_new_token()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));

        // A heartbeat in flight that will answer "revoked".
        var heartbeatHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Handler.HeartbeatAnswer = async (_, _) =>
        {
            await heartbeatHeld.Task;
            return RoutedHandler.Json(HttpStatusCode.Forbidden, """{"error":"agent_revoked"}""");
        };
        var beats = f.Handler.Heartbeats.Count;
        await UntilAsync(f, () => f.Handler.Heartbeats.Count > beats, "a heartbeat in flight", TimeSpan.FromSeconds(10));

        // The sleep event of the old identity, whose write is held.
        using var writeHeld = new ManualResetEventSlim();
        using var inWrite = new ManualResetEventSlim();
        f.Queue.BeforeFlush = () =>
        {
            inWrite.Set();
            writeHeld.Wait(TimeSpan.FromSeconds(30));
        };
        var sleep = Task.Run(engine.SuspendAsync, TestContext.Current.CancellationToken);
        await Eventually.TrueAsync(() => inWrite.IsSet, "the sleep write is held");

        // The heartbeat returns revoked; Join again and the registration run while the write waits.
        heartbeatHeld.SetResult();
        await Eventually.TrueAsync(() => engine.State.IdentityState == IdentityStates.Revoked, "revoked");
        f.Handler.HeartbeatAnswer = null;
        Assert.True(engine.Rejoin().Ok);
        await Eventually.TrueAsync(() => engine.State.IdentityState == IdentityStates.Active, "registered again");
        var newToken = engine.State.Identity!.Token;

        f.Queue.BeforeFlush = null;
        writeHeld.Set();
        await sleep.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.DoesNotContain(f.Handler.Events, r => r.Authorization == $"Bearer {newToken}");
        Assert.DoesNotContain(SentKinds(f), k => k == EventKinds.Sleep);
    }

    // Review R6: a lasting compaction failure.

    [Fact]
    public async Task At_the_file_bound_new_events_are_counted_in_the_state_file_exactly_also_after_a_reload()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        var engine = f.Start(maxFileBytes: 4 * 1024, configure: (_, queue) => queue.BeforeReplace = () =>
        {
            // The first compaction, at load, works; later ones fail, as when another process holds the file.
            if (queue.Pending.Count > 0)
            {
                throw new IOException("the replacement fails");
            }
        });
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        const int Recorded = 30;
        for (var i = 0; i < Recorded; i++)
        {
            engine.Resume();
        }

        await Eventually.TrueAsync(() => f.Queue.Pending.Count + f.Queue.DroppedCount(f.BootId) == Recorded, "every event queued or counted");
        Assert.InRange(new FileInfo(f.Queue.FilePath).Length, 1, 4 * 1024);
        var rejected = engine.State.QueueRejected!.Single();
        Assert.Equal(f.BootId, rejected.BootId);
        Assert.Equal(Recorded - f.Queue.Pending.Count, rejected.Count);
        Assert.Single(f.Logs.Lines, line => line.Contains("size bound", StringComparison.Ordinal));

        // A reload: the counts come back exactly, from the queue and from the state file.
        var pending = f.Queue.Pending.Count;
        await f.StopAllAsync();
        f.Handler.EventsAnswer = null;
        f.Start(maxFileBytes: 4 * 1024);
        Assert.Equal(pending, f.Queue.Pending.Count);
        Assert.Equal(Recorded - pending, f.Queue.DroppedCount(f.BootId));
        await UntilAsync(f, () => f.Queue.Pending.Count == 0 && f.Queue.NextDroppedCount() is null, "sent and confirmed");
        var last = Bodies(f).Select(b => b["droppedEvents"]).Last(d => d is not null)!;
        Assert.Equal(Recorded - pending, last["count"]!.GetValue<long>());
    }

    [Fact]
    public async Task An_old_write_that_comes_back_full_after_Join_again_does_not_count_for_the_new_identity()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        using var compactionHeld = new ManualResetEventSlim();
        using var inCompaction = new ManualResetEventSlim();
        var armed = false;

        // A bound below one line: the next append tries a compaction to make room, which is held, then fails.
        var engine = f.Start(maxFileBytes: 100, configure: (_, queue) => queue.BeforeReplace = () =>
        {
            if (Volatile.Read(ref armed))
            {
                inCompaction.Set();
                compactionHeld.Wait(TimeSpan.FromSeconds(30));
                throw new IOException("the replacement fails");
            }
        });
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));

        var heartbeatHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Handler.HeartbeatAnswer = async (_, _) =>
        {
            await heartbeatHeld.Task;
            return RoutedHandler.Json(HttpStatusCode.Forbidden, """{"error":"agent_revoked"}""");
        };
        var beats = f.Handler.Heartbeats.Count;
        await UntilAsync(f, () => f.Handler.Heartbeats.Count > beats, "a heartbeat in flight", TimeSpan.FromSeconds(10));

        // The old identity's event: its write waits in the compaction attempt.
        Volatile.Write(ref armed, true);
        engine.Resume();
        await Eventually.TrueAsync(() => inCompaction.IsSet, "the old write is in its compaction");

        heartbeatHeld.SetResult();
        await Eventually.TrueAsync(() => engine.State.IdentityState == IdentityStates.Revoked, "revoked");
        f.Handler.HeartbeatAnswer = null;
        Assert.True(engine.Rejoin().Ok);
        await Eventually.TrueAsync(() => engine.State.IdentityState == IdentityStates.Active, "registered again");

        // The old write now comes back Full.
        Volatile.Write(ref armed, false);
        compactionHeld.Set();
        await Eventually.TrueAsync(() => f.Queue.Pending.Count == 0 && !f.Queue.Holds(new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin)), "the Rebind ran");
        Assert.Null(engine.State.QueueRejected);
        Assert.Equal(0, f.Queue.DroppedCount(f.BootId));
    }

    [Fact]
    public async Task A_boot_with_confirmed_drops_and_rejections_in_the_state_file_reports_its_whole_count_after_a_reboot()
    {
        using var f = new EventsFixture();
        var bootA = f.BootId;
        var binding = new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin);

        // Boot A: 5 drops in the queue, confirmed by the server, and 10 rejections in state.json not yet reported.
        var queueA = new EventQueue(f.State.StateDirectory, f.State.Policy) { Capacity = 1 };
        Assert.Null(queueA.Load(binding, bootA, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency));
        for (var i = 0; i < 6; i++)
        {
            queueA.Append(new QueuedEvent(new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Resume, BootId = bootA, SyncId = null, ElapsedMs = null }, f.Time.GetUtcNow(), f.Time.GetTimestamp()), bootA, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency);
        }

        queueA.ConfirmDropped(new DroppedEvents { BootId = bootA, Count = 5 });
        f.Seed(EngineFixture.Registered() with { QueueRejected = [new DroppedEvents { BootId = bootA, Count = 10 }] });

        // A reboot: boot B.
        f.BootId = Guid.NewGuid();
        f.Start(capacity: 1);
        Assert.Equal(15, f.Queue.DroppedCount(bootA));
        await UntilAsync(f, () => f.Queue.NextDroppedCount() is null && f.Queue.Pending.Count == 0, "reported and confirmed");
        var last = Bodies(f).Select(b => b["droppedEvents"]).Last(d => d is not null && d["bootId"]!.GetValue<string>() == bootA.ToString())!;
        Assert.Equal(15, last["count"]!.GetValue<long>());
    }

    // Review R2: expiry while the service keeps running.

    [Fact]
    public async Task An_event_that_ages_past_seven_days_while_running_is_dropped_and_counted_not_sent()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => f.Queue.Pending.Count == 1, "queued", TimeSpan.FromMilliseconds(1));
        var aged = f.Queue.Pending.Single().Event.Id.ToString();
        var start = f.Time.GetUtcNow();

        // /events fails for more than 7 days while heartbeats keep succeeding.
        await UntilAsync(f, () => f.Time.GetUtcNow() - start > TimeSpan.FromDays(7) + TimeSpan.FromHours(2), "8 days", TimeSpan.FromHours(2));
        await UntilAsync(f, () => f.Queue.Pending.Count == 0, "dropped while running", TimeSpan.FromMinutes(15));

        var before = f.Handler.Events.Count;
        f.Handler.EventsAnswer = null;
        await UntilAsync(f, () => f.Queue.NextDroppedCount() is null, "the count confirmed");
        var later = f.Handler.Events.Skip(before).Select(r => JsonNode.Parse(r.Body)!).ToList();
        Assert.DoesNotContain(later.SelectMany(b => b["events"]!.AsArray()), e => e!["id"]!.GetValue<string>() == aged);
        Assert.Contains(later, b => b["droppedEvents"]?["count"]?.GetValue<long>() == 1);
        Assert.Equal(1, f.Queue.DroppedCount(f.BootId));
    }

    // Deviation 4: a deferred answer without retryAfterSeconds.

    [Fact]
    public async Task A_deferred_answer_without_a_retry_time_waits_60_seconds()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        ConcurrentQueue<DateTimeOffset> times = new();
        f.Handler.EventsAnswer = (body, _) =>
        {
            times.Enqueue(f.Time.GetUtcNow());
            return Task.FromResult(times.Count == 1 ? RoutedHandler.Results(body, "deferred") : RoutedHandler.Results(body));
        };
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => times.Count >= 2, "sent again", TimeSpan.FromSeconds(1));
        var sent = times.ToArray();
        Assert.Equal(60, engine.State.DeferredSeconds);
        Assert.True(sent[1] - sent[0] >= TimeSpan.FromSeconds(60), $"waited {sent[1] - sent[0]}");
        Assert.True(sent[1] - sent[0] < TimeSpan.FromSeconds(90), $"waited {sent[1] - sent[0]}");
        Assert.Empty(f.Queue.Pending);
    }

    // 4. 429 and the spacing between requests.

    [Fact]
    public async Task A_429_waits_its_Retry_After()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        ConcurrentQueue<DateTimeOffset> times = new();
        f.Handler.EventsAnswer = (body, _) =>
        {
            times.Enqueue(f.Time.GetUtcNow());
            if (times.Count == 1)
            {
                var limited = RoutedHandler.Json(HttpStatusCode.TooManyRequests, """{"error":"rate_limited"}""");
                limited.Headers.TryAddWithoutValidation("Retry-After", "120");
                return Task.FromResult(limited);
            }

            return Task.FromResult(RoutedHandler.Results(body));
        };
        var engine = f.Start();
        await UntilAsync(f, () => engine.State.LastSync is not null, "first answer", TimeSpan.FromMilliseconds(1));
        f.Time.Advance(TimeSpan.FromSeconds(1));
        engine.Resume();
        await UntilAsync(f, () => times.Count >= 2, "sent again", TimeSpan.FromSeconds(1));
        var sent = times.ToArray();
        Assert.True(sent[1] - sent[0] >= TimeSpan.FromSeconds(120), $"waited {sent[1] - sent[0]}");
        Assert.Empty(f.Queue.Pending);
    }

    [Fact]
    public async Task Requests_are_at_least_3_seconds_apart_and_a_batch_holds_at_most_300_events()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        var backlog = new EventQueue(f.State.StateDirectory, f.State.Policy);
        Assert.Null(backlog.Load(new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin), f.BootId, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency));
        for (var i = 0; i < 301; i++)
        {
            backlog.Append(new QueuedEvent(new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Resume, BootId = f.BootId, SyncId = null, ElapsedMs = null }, f.Time.GetUtcNow(), f.Time.GetTimestamp()), f.BootId, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency);
        }

        ConcurrentQueue<(DateTimeOffset At, int Count)> sent = new();
        f.Handler.EventsAnswer = (body, _) =>
        {
            sent.Enqueue((f.Time.GetUtcNow(), body["events"]!.AsArray().Count));
            return Task.FromResult(RoutedHandler.Results(body));
        };
        f.Start();
        await UntilAsync(f, () => sent.Count >= 2, "both batches sent", TimeSpan.FromMilliseconds(500));
        var batches = sent.ToArray();
        Assert.Equal(300, batches[0].Count);
        Assert.Equal(1, batches[1].Count);
        Assert.True(batches[1].At - batches[0].At >= AgentEngine.SenderSpacing, $"spaced {batches[1].At - batches[0].At}");
    }

    // 5. The queue limits through the engine.

    [Fact]
    public async Task Events_older_than_seven_days_are_never_sent_and_are_reported_as_dropped()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        var seeded = new EventQueue(f.State.StateDirectory, f.State.Policy);
        Assert.Null(seeded.Load(new QueueBinding(EngineFixture.InstallId, EngineFixture.Origin), f.BootId, f.Time.GetUtcNow(), f.Time.GetTimestamp(), f.Time.TimestampFrequency));
        var eightDays = TimeSpan.FromDays(8);
        var otherBoot = new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Shutdown, BootId = Guid.NewGuid(), SyncId = null, ElapsedMs = null };
        var sameBoot = new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Sleep, BootId = f.BootId, SyncId = null, ElapsedMs = null };
        var fresh = new AgentEvent { Id = Guid.NewGuid(), Kind = EventKinds.Resume, BootId = f.BootId, SyncId = null, ElapsedMs = null };
        var oldTimestamp = f.Time.GetTimestamp() - (long)(eightDays.TotalSeconds * f.Time.TimestampFrequency);
        void Add(AgentEvent e, DateTimeOffset utc, long timestamp) =>
            seeded.Append(new QueuedEvent(e, utc, timestamp), f.BootId, f.Time.GetUtcNow() - eightDays, oldTimestamp, f.Time.TimestampFrequency); // seeded as of 8 days ago: nothing expires before the engine starts
        Add(sameBoot, f.Time.GetUtcNow(), oldTimestamp); // only the monotonic clock says it is old
        Add(otherBoot, f.Time.GetUtcNow() - eightDays, oldTimestamp);
        Add(fresh, f.Time.GetUtcNow(), f.Time.GetTimestamp());

        f.Start();
        await UntilAsync(f, () => f.Queue.Pending.Count == 0 && f.Queue.NextDroppedCount() is null, "sent and confirmed");
        Assert.Equal([fresh.Id.ToString()], SentIds(f).Distinct());
        var dropped = Bodies(f).Select(b => b["droppedEvents"]).Last(d => d is not null)!;
        Assert.Equal(f.BootId.ToString(), dropped["bootId"]!.GetValue<string>());
        Assert.Equal(2, dropped["count"]!.GetValue<long>());
    }

    [Fact]
    public async Task An_event_more_than_400_days_after_its_sync_is_sent_without_a_sync()
    {
        using var f = new EventsFixture();
        var old = f.Time.GetTimestamp() - (long)(TimeSpan.FromDays(401).TotalSeconds * f.Time.TimestampFrequency);
        f.Seed(EngineFixture.Registered() with
        {
            LastSync = new SyncPoint { BootId = f.BootId, SyncId = "sync-old", Timestamp = old, Frequency = f.Time.TimestampFrequency },
        });

        // Heartbeats fail, so the old sync stays the latest answer of this boot.
        f.Handler.HeartbeatAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        var engine = f.Start();
        engine.Resume();
        await UntilAsync(f, () => f.Handler.Events.Count >= 1, "sent", TimeSpan.FromSeconds(1));
        var resume = Bodies(f).First()["events"]!.AsArray().Single()!;
        Assert.Null(resume["syncId"]);
        Assert.Null(resume["elapsedMs"]);
    }

    [Fact]
    public async Task The_eleventh_boot_waiting_for_its_count_discards_the_oldest_and_the_rest_are_sent()
    {
        using var f = new EventsFixture();
        f.Seed(EngineFixture.Registered());
        f.Handler.EventsAnswer = static (_, _) => Task.FromResult(RoutedHandler.Json(HttpStatusCode.ServiceUnavailable, "{}"));
        List<Guid> boots = [];
        for (var i = 0; i < 11; i++)
        {
            f.BootId = Guid.NewGuid();
            boots.Add(f.BootId);
            var engine = f.Start(capacity: 1);
            await UntilAsync(f, () => engine.State.LastSync is not null, "answered", TimeSpan.FromMilliseconds(1));
            engine.Resume();
            engine.Resume();
            await UntilAsync(f, () => f.Queue.DroppedCount(boots[^1]) >= 1, "a drop in this boot", TimeSpan.FromMilliseconds(1));
            await f.StopAllAsync();
        }

        var before = f.Handler.Events.Count;
        f.BootId = Guid.NewGuid();
        f.Handler.EventsAnswer = null;
        f.Start(capacity: 1);
        await UntilAsync(f, () => f.Queue.NextDroppedCount() is null, "every kept count confirmed");
        var reported = Bodies(f).Skip(before).Select(b => b["droppedEvents"]).Where(d => d is not null).Select(d => Guid.Parse(d!["bootId"]!.GetValue<string>())).ToHashSet();
        Assert.DoesNotContain(boots[0], reported);
        Assert.All(boots.Skip(1), boot => Assert.Contains(boot, reported));
    }
}
