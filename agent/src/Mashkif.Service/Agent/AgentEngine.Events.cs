using System.Text.Json;
using Mashkif.Common.Pipe;
using Mashkif.Service.Events;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;

namespace Mashkif.Service.Agent;

/// <summary>A moment on the monotonic clock and the last heartbeat answer known at that moment.</summary>
internal readonly record struct Observation(long Timestamp, SyncPoint? Sync);

/// <summary>
/// Events, the offline queue, the connectivity probe, and the order around
/// sleep and shutdown (step 2c of docs/mvp-stage-1.md). Without a queue in
/// the options none of this runs.
/// </summary>
internal sealed partial class AgentEngine
{
    /// <summary>Time between two connectivity checks, also offline.</summary>
    public static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(15);

    /// <summary>A sleep pauses reporting for at most this long on the monotonic clock (P25).</summary>
    public static readonly TimeSpan QuiescingExpiry = TimeSpan.FromSeconds(5);

    /// <summary>Shortest time between two events requests (the server allows 30 a minute).</summary>
    public static readonly TimeSpan SenderSpacing = TimeSpan.FromSeconds(3);

    /// <summary>Wait after a new event before the sender sends, so close events go together.</summary>
    public static readonly TimeSpan SenderDebounce = TimeSpan.FromSeconds(2);

    /// <summary>Shutdown: the end of the wait for a heartbeat in flight.</summary>
    public static readonly TimeSpan ShutdownHeartbeatWait = TimeSpan.FromSeconds(1);

    /// <summary>Shutdown: the end of the wait for the durable append.</summary>
    public static readonly TimeSpan ShutdownAppendBy = TimeSpan.FromSeconds(3);

    /// <summary>Shutdown: the end of the immediate send.</summary>
    public static readonly TimeSpan ShutdownSendBy = TimeSpan.FromSeconds(5);

    /// <summary>Sleep: the end of the append and the immediate send, from handler entry.</summary>
    public static readonly TimeSpan SleepBudget = TimeSpan.FromMilliseconds(1500);

    /// <summary>Most events in one batch; 413 halves it.</summary>
    public const int MaxBatchEvents = 300;

    /// <summary>Largest serialized batch, under the 64 KB body limit.</summary>
    public const int MaxBatchBytes = 60 * 1024;

    /// <summary>Connectivity results in a row that change the state.</summary>
    public const int ConnectivityConfirmations = 2;

    private readonly SemaphoreSlim _senderSignal = new(0);

    // Cancelled by every identity switch, so a running deferral wait of the old identity ends (P17).
    private CancellationTokenSource _senderWake = new();
    private QueueWriter? _writer;
    private long _powerSequence;
    private long? _quiescingSince;
    private bool _shuttingDown;
    private Task _heartbeatInFlight = Task.CompletedTask;
    private bool? _confirmedOnline;
    private bool? _candidateOnline;
    private int _candidateCount;
    private Observation _candidateObservation;
    private long? _deferredUntilTimestamp;
    private int _batchLimit = MaxBatchEvents;

    /// <summary>The power-event sequence number of the last handler, for tests.</summary>
    internal long PowerSequence
    {
        get
        {
            lock (_gate)
            {
                return _powerSequence;
            }
        }
    }

    /// <summary>Whether heartbeats are paused by a sleep or a shutdown now, for tests.</summary>
    internal bool IsQuiescing
    {
        get
        {
            lock (_gate)
            {
                return IsQuiescingLocked();
            }
        }
    }

    /// <summary>Opens the queue after the state is known. A queue file that fails its checks is <c>state_invalid</c>.</summary>
    private void InitializeEvents()
    {
        if (_options.Queue is not { } queue || _blockedReason is not null)
        {
            return;
        }

        queue.Log = message => LogQueue(_logger, message);
        string? problem;
        try
        {
            problem = queue.Load(BindingLocked(), _options.BootId, _time.GetUtcNow(), _time.GetTimestamp(), _time.TimestampFrequency);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            problem = $"the queue cannot be read: {exception.GetType().Name}";
        }

        if (problem is not null)
        {
            _blockedReason = StatusReasons.StateInvalid;
            LogStateInvalid(_logger, problem);
            return;
        }

        _writer = new QueueWriter(queue);
        _confirmedOnline = queue.LastOnline;
        if (_state is { DeferredUntilUtc: { } until, DeferredSeconds: { } seconds })
        {
            // After a restart the wait continues until the saved end, never longer
            // than its length counted from now, so a clock set back cannot stall it.
            var left = until - _time.GetUtcNow();
            var max = TimeSpan.FromSeconds(seconds);
            if (left > TimeSpan.Zero)
            {
                _deferredUntilTimestamp = _time.GetTimestamp() + ToTicks(left < max ? left : max);
            }
        }
    }

    /// <summary>The background loops of the events: the queue writer, the probe, and the sender.</summary>
    private IEnumerable<Task> EventLoops(CancellationToken stoppingToken)
    {
        if (_writer is null)
        {
            return [];
        }

        return [_writer.RunAsync(stoppingToken), ProbeLoopAsync(stoppingToken), SenderLoopAsync(stoppingToken)];
    }

    /// <summary>
    /// Marks a heartbeat as in flight, so a shutdown can wait for its answer;
    /// returns null while heartbeats are paused by a sleep or a shutdown.
    /// </summary>
    private TaskCompletionSource? BeginHeartbeat()
    {
        lock (_gate)
        {
            if (IsQuiescingLocked())
            {
                return null;
            }

            var inFlight = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _heartbeatInFlight = inFlight.Task;
            return inFlight;
        }
    }

    /// <summary>Wakes the network loop without dropping the current identity's work (no new epoch).</summary>
    private void WakeLoopLocked()
    {
        var previous = _wake;
        _wake = new CancellationTokenSource();
        previous.Cancel();
        previous.Dispose();
    }

    private QueueBinding? BindingLocked() =>
        _state.InstallId is { } installId && _origin is not null ? new QueueBinding(installId, _origin) : null;

    /// <summary>Events are recorded only while the agent may report: never in the Idle phase.</summary>
    private bool CanRecordLocked() =>
        _writer is not null
        && _blockedReason is null
        && !ServerChanged()
        && _state.IdentityState != IdentityStates.Revoked
        && _state.InstallId is not null;

    private bool IsQuiescingLocked()
    {
        if (_shuttingDown)
        {
            return true;
        }

        if (_quiescingSince is { } since && _time.GetElapsedTime(since) >= QuiescingExpiry)
        {
            // The PC slept, or the resume never came: reporting never stays paused on an awake PC.
            _quiescingSince = null;
        }

        return _quiescingSince is not null;
    }

    private TimeSpan QuiescingLeftLocked() =>
        _shuttingDown || _quiescingSince is not { } since ? Timeout.InfiniteTimeSpan : QuiescingExpiry - _time.GetElapsedTime(since);

    private Observation ObserveLocked() => new(_time.GetTimestamp(), _state.LastSync);

    private long ToTicks(TimeSpan span) => (long)(span.TotalSeconds * _time.TimestampFrequency);

    /// <summary>
    /// An event at <paramref name="at"/>: the sync ID of the last heartbeat
    /// answer of this boot and the milliseconds since it on the monotonic
    /// clock, or no sync when there is none in this boot (or the reading went back).
    /// </summary>
    private AgentEvent BuildEvent(string kind, Observation at)
    {
        string? syncId = null;
        long? elapsedMs = null;
        if (ElapsedMs(at) is { } ms)
        {
            syncId = at.Sync!.SyncId;
            elapsedMs = ms;
        }

        return new AgentEvent { Id = Guid.NewGuid(), Kind = kind, BootId = _options.BootId, SyncId = syncId, ElapsedMs = elapsedMs };
    }

    private long? ElapsedMs(Observation at)
    {
        if (at.Sync is not { } sync || sync.BootId != _options.BootId || sync.Frequency != _time.TimestampFrequency || at.Timestamp < sync.Timestamp)
        {
            return null;
        }

        var ms = (long)((at.Timestamp - sync.Timestamp) * 1000.0 / sync.Frequency);
        return ms <= ProtocolConstants.MaxElapsedMs ? ms : null;
    }

    /// <summary>
    /// The observation of a sleep or shutdown event, at least 1 ms after the
    /// latest anchor: the server moves the state only for a strictly later
    /// event (events.ts), so this waits for the monotonic clock to advance.
    /// </summary>
    private async Task<Observation> LifecycleObservationAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            Observation at;
            lock (_gate)
            {
                at = ObserveLocked();
            }

            if (ElapsedMs(at) is not 0)
            {
                return at;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(1), _time, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>Posts an append to the single writer; called under the lock so writes keep their order.</summary>
    private Task PostAppendLocked(AgentEvent agentEvent, Observation at)
    {
        var queued = new QueuedEvent(agentEvent, _time.GetUtcNow(), at.Timestamp);
        var boot = _options.BootId;
        var now = _time.GetUtcNow();
        var nowTimestamp = _time.GetTimestamp();
        var frequency = _time.TimestampFrequency;
        var binding = BindingLocked();
        var append = _writer!.Post(queue =>
        {
            try
            {
                queue.Append(queued, boot, now, nowTimestamp, frequency, binding);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                queue.CountLostInMemory(boot);
                LogQueue(_logger, $"an event could not be written ({exception.GetType().Name}) and is lost");
                throw;
            }

            _senderSignal.Release();
        });
        return append;
    }

    // Connectivity.

    /// <summary>
    /// One connectivity result. The state changes after
    /// <see cref="ConnectivityConfirmations"/> results in a row, and the event
    /// carries the observation of the first of them. Without a saved state a
    /// first online result only sets the state.
    /// </summary>
    private void ObserveConnectivityLocked(bool online, Observation at)
    {
        if (!CanRecordLocked() || IsQuiescingLocked())
        {
            return;
        }

        if (_confirmedOnline == online)
        {
            _candidateOnline = null;
            _candidateCount = 0;
            return;
        }

        if (_candidateOnline != online)
        {
            _candidateOnline = online;
            _candidateCount = 1;
            _candidateObservation = at;
        }
        else
        {
            _candidateCount++;
        }

        if (_candidateCount < ConnectivityConfirmations)
        {
            return;
        }

        var first = _candidateObservation;
        var known = _confirmedOnline;
        _confirmedOnline = online;
        _candidateOnline = null;
        _candidateCount = 0;
        if (known is null && online)
        {
            return;
        }

        var agentEvent = BuildEvent(online ? EventKinds.ConnectivityRestored : EventKinds.ConnectivityLost, first);
        _ = PostAppendLocked(agentEvent, first).ContinueWith(static _ => { }, TaskScheduler.Default);
    }

    private async Task ProbeLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(ProbeInterval, _time, stoppingToken).ConfigureAwait(false);
                Observation at;
                lock (_gate)
                {
                    if (!CanRecordLocked() || IsQuiescingLocked() || _api is null)
                    {
                        continue;
                    }

                    at = ObserveLocked();
                }

                var result = await _api.HealthAsync(stoppingToken).ConfigureAwait(false);
                lock (_gate)
                {
                    ObserveConnectivityLocked(result.Outcome == ApiOutcome.Success, at);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    // Sending.

    private bool DeferredLocked(out TimeSpan left)
    {
        left = TimeSpan.Zero;
        if (_deferredUntilTimestamp is not { } until)
        {
            return false;
        }

        var now = _time.GetTimestamp();
        if (now >= until)
        {
            _deferredUntilTimestamp = null;
            return false;
        }

        left = TimeSpan.FromSeconds((until - now) / (double)_time.TimestampFrequency);
        return true;
    }

    private async Task SenderLoopAsync(CancellationToken stoppingToken)
    {
        var pipeline = RetryPolicies.Create(RetryPolicies.RegisterMaxDelay, _time);
        var first = true;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!first)
                {
                    // A new event, a heartbeat answer, or an identity switch.
                    await _senderSignal.WaitAsync(stoppingToken).ConfigureAwait(false);
                    await Task.Delay(SenderDebounce, _time, stoppingToken).ConfigureAwait(false);
                    while (_senderSignal.CurrentCount > 0)
                    {
                        await _senderSignal.WaitAsync(stoppingToken).ConfigureAwait(false);
                    }
                }

                first = false;
                while (!stoppingToken.IsCancellationRequested)
                {
                    TimeSpan wait;
                    bool deferred;
                    CancellationToken wake;
                    lock (_gate)
                    {
                        if (CurrentPhase() != Phase.Heartbeat || _writer is null)
                        {
                            break;
                        }

                        deferred = DeferredLocked(out wait);
                        wake = _senderWake.Token;
                    }

                    if (deferred)
                    {
                        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, wake);
                        try
                        {
                            await Task.Delay(wait, _time, linked.Token).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                        {
                            // An identity switch ended the deferral of the old identity.
                        }

                        continue;
                    }

                    var step = await pipeline.ExecuteAsync(
                        async token => await SendBatchAsync(only: null, token).ConfigureAwait(false),
                        stoppingToken).ConfigureAwait(false);
                    if (step.Kind != StepKind.Done || (_writer.Queue.Pending.Count == 0 && _writer.Queue.NextDroppedCount() is null))
                    {
                        break;
                    }

                    await Task.Delay(SenderSpacing, _time, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                LogLoopFailed(_logger, exception.GetType().Name);
                await Task.Delay(TimeSpan.FromMinutes(1), _time, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// One events request: the queue head (or exactly <paramref name="only"/>
    /// for an immediate send) with the oldest unconfirmed dropped count.
    /// Results are applied only while the identity and its epoch are unchanged.
    /// </summary>
    private async Task<Step> SendBatchAsync(IReadOnlyList<AgentEvent>? only, CancellationToken cancellationToken)
    {
        AgentIdentity identity;
        QueueBinding binding;
        int epoch;
        int limit;
        lock (_gate)
        {
            if (_writer is null || _state.Identity is null || _state.IdentityState != IdentityStates.Active || _blockedReason is not null || ServerChanged() || BindingLocked() is not { } current)
            {
                return Step.Stop;
            }

            binding = current;

            if (only is null && (IsQuiescingLocked() || DeferredLocked(out _)))
            {
                return Step.Stop;
            }

            identity = _state.Identity;
            epoch = _epoch;
            limit = _batchLimit;
        }

        IReadOnlyList<AgentEvent> events;
        DroppedEvents? dropped = null;
        if (only is null)
        {
            // Expired events go first, through the drop record (P8); then the batch, only from
            // the queue of the identity this request is sent with (an unfinished Rebind gives nothing).
            var boot = _options.BootId;
            var (now, nowTimestamp, frequency) = (_time.GetUtcNow(), _time.GetTimestamp(), _time.TimestampFrequency);
            await _writer.Post(q => q.Prune(boot, now, nowTimestamp, frequency)).ConfigureAwait(false);
            (events, dropped) = _writer.Queue.Batch(binding, limit);
        }
        else
        {
            events = only;
        }
        if (events.Count == 0 && dropped is null)
        {
            // Nothing for this identity: the sender waits for the next signal.
            return Step.Stop;
        }

        var request = new EventsRequest { Events = events, DroppedEvents = dropped };
        while (request.Events.Count > 1 && JsonSerializer.SerializeToUtf8Bytes(request, ProtocolJsonContext.Default.EventsRequest).Length > MaxBatchBytes)
        {
            request = request with { Events = [.. request.Events.Take(request.Events.Count / 2)] };
        }

        var result = await _api!.EventsAsync(request, identity.Token, cancellationToken).ConfigureAwait(false);
        List<Guid> done = [];
        Step step;
        lock (_gate)
        {
            if (_epoch != epoch || !ReferenceEquals(_state.Identity, identity))
            {
                return Step.Stop;
            }

            step = ApplyEventsResult(request, result, done);
        }

        if (done.Count > 0)
        {
            // The writer drops this when the queue no longer belongs to the identity of the request.
            await _writer.Post(q => q.Complete(done, binding)).ConfigureAwait(false);
        }

        if (step.Kind == StepKind.Done && request.DroppedEvents is { } confirmed)
        {
            await _writer.Post(q => q.ConfirmDropped(confirmed, binding)).ConfigureAwait(false);
        }

        return step;
    }

    private Step ApplyEventsResult(EventsRequest request, ApiResult<EventsResponse> result, List<Guid> done)
    {
        if (result.Outcome == ApiOutcome.Success)
        {
            var results = result.Value!.Results!;
            if (results.Count != request.Events.Count || results.Where((r, i) => r.Id != request.Events[i].Id).Any())
            {
                LogEventsMismatch(_logger);
                return Step.Retry;
            }

            _batchLimit = MaxBatchEvents;
            var deferred = false;
            for (var i = 0; i < results.Count; i++)
            {
                switch (results[i].Status)
                {
                    case EventStatuses.Accepted or EventStatuses.Duplicate or EventStatuses.Rejected:
                        done.Add(request.Events[i].Id);
                        break;
                    case EventStatuses.Deferred:
                        deferred = true;
                        break;
                }
            }

            if (deferred)
            {
                // The full wait, also past an hour (the contract allows it after the server clock moved back).
                var seconds = Math.Max(1, result.Value.RetryAfterSeconds ?? 60);
                _deferredUntilTimestamp = _time.GetTimestamp() + ToTicks(TimeSpan.FromSeconds(seconds));
                TrySave(_state with { DeferredUntilUtc = _time.GetUtcNow().AddSeconds(seconds), DeferredSeconds = seconds });
            }

            return Step.Done;
        }

        switch (Classify(result))
        {
            case Refusal.RetryAfter:
                return Step.After(result.RetryAfter!.Value);
            case Refusal.TokenInvalid:
                return StartTokenCycle() ? Step.Stop : Step.Retry;
            case Refusal.Revoked:
                return Revoke() ? Step.Stop : Step.Retry;
            case Refusal.Redirect or Refusal.BadRequest:
                return Step.Slow;
            default:
                if (result.StatusCode == 413)
                {
                    _batchLimit = Math.Max(1, request.Events.Count / 2);
                    return Step.After(TimeSpan.Zero);
                }

                return Step.Retry;
        }
    }

    /// <summary>Clears the deferral of the old identity (P17); called under the lock with every identity switch.</summary>
    private void ResetIdentityTimingLocked()
    {
        _deferredUntilTimestamp = null;
        _batchLimit = MaxBatchEvents;
        _candidateOnline = null;
        _candidateCount = 0;
        var previous = _senderWake;
        _senderWake = new CancellationTokenSource();
        previous.Cancel();
        previous.Dispose();
        if (_writer is not null)
        {
            _senderSignal.Release();
        }
    }

    // Sleep, resume, shutdown, and service stop.

    /// <summary>
    /// A suspend (best effort, P22): pauses heartbeats, records the event
    /// without waiting for a heartbeat in flight, appends it, and sends it
    /// only while time remains within <see cref="SleepBudget"/> of entry.
    /// </summary>
    public async Task SuspendAsync()
    {
        var start = _time.GetTimestamp();
        long sequence;
        lock (_gate)
        {
            sequence = ++_powerSequence;
            if (!CanRecordLocked())
            {
                return;
            }

            _quiescingSince = start;
        }

        using var budget = new CancellationTokenSource(SleepBudget, _time);
        try
        {
            var at = await LifecycleObservationAsync(budget.Token).ConfigureAwait(false);
            AgentEvent sleep;
            Task append;
            lock (_gate)
            {
                // A resume handler that ran meanwhile wins: no stale record.
                if (sequence != _powerSequence || !CanRecordLocked())
                {
                    return;
                }

                sleep = BuildEvent(EventKinds.Sleep, at);
                append = PostAppendLocked(sleep, at);
            }

            await append.WaitAsync(budget.Token).ConfigureAwait(false);
            await SendNowAsync(sleep, budget.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OperationCanceledException or IOException or UnauthorizedAccessException)
        {
            // Past the budget, or the write failed: the sleep event is best effort.
        }
    }

    /// <summary>A resume: ends the pause, records the event, and lets the heartbeat run at once.</summary>
    public void Resume()
    {
        lock (_gate)
        {
            ++_powerSequence;
            _quiescingSince = null;
            if (!CanRecordLocked())
            {
                return;
            }

            var at = ObserveLocked();
            _ = PostAppendLocked(BuildEvent(EventKinds.Resume, at), at).ContinueWith(static _ => { }, TaskScheduler.Default);
            WakeLoopLocked();
        }
    }

    /// <summary>
    /// A shutdown or a service stop: stops heartbeats for good, waits for a
    /// heartbeat in flight until <see cref="ShutdownHeartbeatWait"/>, records
    /// at least 1 ms after the latest anchor, waits for the append until
    /// <see cref="ShutdownAppendBy"/>, and sends the event until
    /// <see cref="ShutdownSendBy"/>. It writes no log line.
    /// </summary>
    public async Task ShutdownAsync(string kind)
    {
        var start = _time.GetTimestamp();
        Task inFlight;
        lock (_gate)
        {
            _shuttingDown = true;
            if (!CanRecordLocked())
            {
                return;
            }

            inFlight = _heartbeatInFlight;
        }

        try
        {
            using (var heartbeatWait = new CancellationTokenSource(Left(start, ShutdownHeartbeatWait), _time))
            {
                try
                {
                    await inFlight.WaitAsync(heartbeatWait.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Given up on: decision 12 (a).
                }
            }

            using var appendBy = new CancellationTokenSource(Left(start, ShutdownAppendBy), _time);
            var at = await LifecycleObservationAsync(appendBy.Token).ConfigureAwait(false);
            AgentEvent agentEvent;
            Task append;
            lock (_gate)
            {
                agentEvent = BuildEvent(kind, at);
                append = PostAppendLocked(agentEvent, at);
            }

            await append.WaitAsync(appendBy.Token).ConfigureAwait(false);
            using var sendBy = new CancellationTokenSource(Left(start, ShutdownSendBy), _time);
            await SendNowAsync(agentEvent, sendBy.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OperationCanceledException or IOException or UnauthorizedAccessException)
        {
            // The deadline won; the event stays queued if its append finished.
        }
    }

    private TimeSpan Left(long start, TimeSpan deadline)
    {
        var left = deadline - _time.GetElapsedTime(start);
        return left > TimeSpan.Zero ? left : TimeSpan.Zero;
    }

    /// <summary>The immediate send of exactly one lifecycle event; skipped while a deferral runs.</summary>
    private async Task SendNowAsync(AgentEvent agentEvent, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (DeferredLocked(out _))
            {
                return;
            }
        }

        await SendBatchAsync([agentEvent], cancellationToken).ConfigureAwait(false);
    }

    [LoggerMessage(EventId = 30, Level = LogLevel.Warning, Message = "Event queue: {Message}")]
    private static partial void LogQueue(ILogger logger, string message);

    [LoggerMessage(EventId = 31, Level = LogLevel.Warning, Message = "The events answer does not match the request; the batch is sent again")]
    private static partial void LogEventsMismatch(ILogger logger);
}
