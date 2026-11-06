using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using Mashkif.Common.Pipe;
using Mashkif.Service.Config;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;
using Polly;

namespace Mashkif.Service.Agent;

/// <summary>A new install ID and token: 32 random bytes in base64url without padding.</summary>
internal readonly record struct Credentials(Guid InstallId, string Token)
{
    public static Credentials Create() =>
        new(Guid.NewGuid(), Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)));
}

/// <summary>Everything the engine depends on; tests replace the parts.</summary>
internal sealed record AgentEngineOptions
{
    public required StateStore Store { get; init; }

    /// <summary>The normalized server origin, or null when <c>SERVER_URL</c> is invalid.</summary>
    public required Uri? Origin { get; init; }

    public required HttpClient Http { get; init; }

    public required Guid BootId { get; init; }

    public required string AgentVersion { get; init; }

    public string? OsVersion { get; init; }

    public TimeProvider Time { get; init; } = TimeProvider.System;

    public Func<Credentials> NewCredentials { get; init; } = Credentials.Create;

    /// <summary>Measures the DNS time of a host in milliseconds, or null.</summary>
    public Func<string, CancellationToken, Task<int?>>? MeasureDns { get; init; }

    /// <summary>The offline queue; null runs the engine without events, the probe, and the sender.</summary>
    public Events.EventQueue? Queue { get; init; }
}

/// <summary>
/// The agent state machine. One loop owns the network work; the pipe command
/// <c>rejoin</c> changes the state under the same lock and wakes the loop.
/// A token is sent only to the origin it is bound to and is never logged.
/// </summary>
/// <remarks>
/// <para>A first start creates the install ID and a pending token, saves
/// them, and registers. A 401 starts the cycle: the old token is kept, a
/// pending token for the same install ID is saved, and every hour a heartbeat
/// with the old token goes first; when it gets 401 again, the pending token is
/// registered, at most once an hour.</para>
/// <para>A revoke or a changed server stops all reporting until the user
/// joins again, which creates a new install ID and token.</para>
/// </remarks>
internal sealed partial class AgentEngine : IDisposable
{
    /// <summary>Time the DNS measurement may take.</summary>
    public static readonly TimeSpan DnsBudget = TimeSpan.FromSeconds(5);

    /// <summary>Shortest time between two register requests of the 401 cycle.</summary>
    public static readonly TimeSpan CycleRegisterSpacing = TimeSpan.FromHours(1);

    /// <summary>Wait after a failed state write before the loop tries again.</summary>
    public static readonly TimeSpan SaveRetryDelay = TimeSpan.FromMinutes(1);

    private readonly AgentEngineOptions _options;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly AgentApiClient? _api;
    private readonly string? _origin;
    private readonly Lock _gate = new();
    private readonly ResiliencePipeline<Step> _registerPipeline;
    private readonly Dictionary<int, ResiliencePipeline<Step>> _heartbeatPipelines = [];

    private AgentState _state = AgentState.Empty;
    private string? _blockedReason;
    private int _epoch;
    private CancellationTokenSource _wake = new();

    // The 401 cycle waits this long before its next step; zero after a start.
    private TimeSpan _cycleDelay = TimeSpan.Zero;

    // What the last attempt in the current phase found, for the status.
    private string? _attemptState;
    private string? _attemptReason;
    private DateTimeOffset? _lastContact;
    private int? _lastRoundTripMs;

    public AgentEngine(AgentEngineOptions options, ILogger<AgentEngine> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = options;
        _logger = logger;
        _time = options.Time;
        _registerPipeline = RetryPolicies.Create(RetryPolicies.RegisterMaxDelay, _time);
        if (options.Origin is not null)
        {
            _origin = ServerOrigin.Key(options.Origin);
            _api = new AgentApiClient(options.Http, options.Origin, _time);
        }
    }

    /// <summary>The current state, for tests.</summary>
    internal AgentState State
    {
        get
        {
            lock (_gate)
            {
                return _state;
            }
        }
    }

    /// <summary>
    /// Whether the 401 cycle may send a register request now: an hour after
    /// the last one, or at once when the clock is earlier than the saved time
    /// (it was set back). A clock set forward allows one early request, which
    /// saves the new time.
    /// </summary>
    internal static bool CycleRegisterAllowed(DateTimeOffset? lastAttempt, DateTimeOffset now) =>
        lastAttempt is not { } last || now < last || now - last >= CycleRegisterSpacing;

    /// <summary>
    /// Checks the configuration, the path, and the state. Runs once, before
    /// <see cref="RunAsync"/> and before the pipe opens.
    /// </summary>
    public void Initialize()
    {
        lock (_gate)
        {
            var load = _options.Store.Load();
            if (load.Problem is not null)
            {
                _blockedReason = StatusReasons.StateInvalid;
                LogStateInvalid(_logger, load.Problem);
                return;
            }

            _state = load.State!;
            if (_origin is null)
            {
                _blockedReason = StatusReasons.ConfigInvalid;
                LogConfigInvalid(_logger);
                return;
            }

            if (ServerChanged())
            {
                LogServerChanged(_logger);
            }

            InitializeEvents();
        }
    }

    /// <summary>The status the pipe reports. Contains nothing secret.</summary>
    public AgentStatus Status()
    {
        lock (_gate)
        {
            return BuildStatus();
        }
    }

    /// <summary>
    /// The pipe command <c>rejoin</c>: after a revoke or a server change,
    /// replaces the install ID, the identity, and any pending registration
    /// with a new install ID and token for the configured server, in one
    /// atomic write. The loop then registers them.
    /// </summary>
    public PipeResponse Rejoin()
    {
        lock (_gate)
        {
            if (_blockedReason is not null)
            {
                return PipeResponse.Failure(PipeErrors.NotAvailable, BuildStatus());
            }

            if (!CanRejoin())
            {
                return PipeResponse.Failure(PipeErrors.NotRejoinable, BuildStatus());
            }

            var credentials = _options.NewCredentials();
            var rejoined = _state with
            {
                InstallId = credentials.InstallId,
                Identity = null,
                IdentityState = IdentityStates.None,
                Pending = new PendingRegistration { ServerOrigin = _origin!, Token = credentials.Token },
                LastRegisterAttemptUtc = null,
                LastSync = null,
                DeferredUntilUtc = null,
                DeferredSeconds = null,
                QueueRejected = null,
            };
            if (!TrySave(rejoined))
            {
                return PipeResponse.Failure(PipeErrors.NotAvailable, BuildStatus());
            }

            // The new install ID is saved first, so the old records are ignored even after a crash here.
            var binding = BindingLocked();
            _ = _writer?.Post(queue => queue.Rebind(binding));
            ResetIdentityTimingLocked();
            ResetAttempt();
            _lastContact = null;
            _lastRoundTripMs = null;
            LogRejoined(_logger);
            WakeLocked();
            return PipeResponse.Success(BuildStatus());
        }
    }

    /// <summary>
    /// The network loop (registration, heartbeats, the 401 cycle, and waiting
    /// for commands) and, with a queue, the queue writer, the probe, and the sender.
    /// </summary>
    public Task RunAsync(CancellationToken stoppingToken) =>
        Task.WhenAll([MainLoopAsync(stoppingToken), .. EventLoops(stoppingToken)]);

    private async Task MainLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Phase phase;
            int epoch;
            CancellationToken wake;
            TimeSpan quiet = TimeSpan.Zero;
            lock (_gate)
            {
                phase = CurrentPhase();
                if ((phase is Phase.Heartbeat or Phase.TokenCycle) && IsQuiescingLocked())
                {
                    phase = Phase.Quiescing;
                    quiet = QuiescingLeftLocked();
                }

                epoch = _epoch;
                wake = _wake.Token;
            }

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, wake);
            try
            {
                switch (phase)
                {
                    case Phase.Quiescing:
                        // A sleep or a shutdown pauses heartbeats; a sleep pause ends by itself.
                        await Task.Delay(quiet, _time, linked.Token).ConfigureAwait(false);
                        break;
                    case Phase.CreateIdentity:
                        if (!CreatePending(epoch))
                        {
                            await Task.Delay(SaveRetryDelay, _time, linked.Token).ConfigureAwait(false);
                        }

                        break;
                    case Phase.Register:
                        await _registerPipeline.ExecuteAsync(
                            async token => await RegisterAttemptAsync(epoch, cycle: false, token).ConfigureAwait(false),
                            linked.Token).ConfigureAwait(false);
                        break;
                    case Phase.Heartbeat:
                        await HeartbeatAsync(epoch, linked.Token).ConfigureAwait(false);
                        break;
                    case Phase.TokenCycle:
                        await TokenCycleAsync(epoch, linked.Token).ConfigureAwait(false);
                        break;
                    default:
                        await Task.Delay(Timeout.InfiniteTimeSpan, _time, linked.Token).ConfigureAwait(false);
                        break;
                }
            }
            catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
            {
                // Woken by a command; look at the state again.
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                LogLoopFailed(_logger, exception.GetType().Name);
                await Task.Delay(TimeSpan.FromMinutes(1), _time, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _wake.Dispose();
            _senderWake.Dispose();
        }

        _senderSignal.Dispose();
    }

    private enum Phase
    {
        Idle,
        CreateIdentity,
        Register,
        Heartbeat,
        TokenCycle,
        Quiescing,
    }

    private Phase CurrentPhase()
    {
        if (_blockedReason is not null || ServerChanged() || _state.IdentityState == IdentityStates.Revoked)
        {
            return Phase.Idle;
        }

        if (_state.Identity is null)
        {
            return _state.Pending is null ? Phase.CreateIdentity : Phase.Register;
        }

        return _state.IdentityState == IdentityStates.TokenRejected ? Phase.TokenCycle : Phase.Heartbeat;
    }

    /// <summary>The identity or the pending registration belongs to another server than the configured one.</summary>
    private bool ServerChanged() =>
        (_state.Identity is { } identity && identity.ServerOrigin != _origin)
        || (_state.Pending is { } pending && pending.ServerOrigin != _origin);

    private bool CanRejoin() =>
        _blockedReason is null && (_state.IdentityState == IdentityStates.Revoked || ServerChanged());

    /// <summary>First start: saves a new install ID and a pending token before anything is sent.</summary>
    private bool CreatePending(int epoch)
    {
        lock (_gate)
        {
            if (_epoch != epoch || CurrentPhase() != Phase.CreateIdentity)
            {
                return true;
            }

            var credentials = _options.NewCredentials();
            var hadInstallId = _state.InstallId is not null;
            var created = _state with
            {
                InstallId = _state.InstallId ?? credentials.InstallId,
                Pending = new PendingRegistration { ServerOrigin = _origin!, Token = credentials.Token },
            };
            if (!TrySave(created))
            {
                return false;
            }

            if (!hadInstallId)
            {
                // The first install ID gives the queue its binding.
                var binding = BindingLocked();
                _ = _writer?.Post(queue => queue.Rebind(binding));
            }

            LogRegistrationStarted(_logger);
            return true;
        }
    }

    /// <summary>
    /// One register request with the pending token. The attempt time is saved
    /// before the request is sent; when that fails, nothing is sent.
    /// </summary>
    private async Task<Step> RegisterAttemptAsync(int epoch, bool cycle, CancellationToken cancellationToken)
    {
        PendingRegistration pending;
        Guid installId;
        lock (_gate)
        {
            if (_epoch != epoch || _state.Pending is null || ServerChanged())
            {
                return Step.Stop;
            }

            pending = _state.Pending;
            installId = _state.InstallId!.Value;
            if (!TrySave(_state with { LastRegisterAttemptUtc = _time.GetUtcNow() }))
            {
                if (!cycle)
                {
                    SetAttempt(AgentStates.Registering, null);
                }

                return cycle ? Step.Stop : Step.Retry;
            }
        }

        var result = await _api!.RegisterAsync(
            new RegisterRequest
            {
                InstallId = installId,
                Token = pending.Token,
                AgentVersion = _options.AgentVersion,
                OsVersion = _options.OsVersion,
            },
            cancellationToken).ConfigureAwait(false);

        lock (_gate)
        {
            return _epoch != epoch || !ReferenceEquals(_state.Pending, pending) ? Step.Stop : ApplyRegister(pending, result, cycle);
        }
    }

    private Step ApplyRegister(PendingRegistration pending, ApiResult<RegisterResponse> result, bool cycle)
    {
        if (result.Outcome == ApiOutcome.Success)
        {
            var interval = ClampInterval(result.Value!.HeartbeatIntervalSeconds);
            var identity = new AgentIdentity
            {
                ServerOrigin = pending.ServerOrigin,
                Token = pending.Token,
                AgentId = result.Value.AgentId,
            };
            // An identity switch: the sync and the deferral of the old identity do not carry over (P17).
            if (!TrySave(_state with { Identity = identity, IdentityState = IdentityStates.Active, Pending = null, IntervalSeconds = interval, LastSync = null, DeferredUntilUtc = null, DeferredSeconds = null }))
            {
                // The server answers the same registration with 200 again.
                if (!cycle)
                {
                    SetAttempt(AgentStates.Registering, null);
                }

                return cycle ? Step.Stop : Step.Retry;
            }

            ResetIdentityTimingLocked();
            _lastContact = _time.GetUtcNow();
            _lastRoundTripMs = null;
            SetAttempt(AgentStates.Connected, null);
            LogRegistered(_logger, identity.AgentId);
            return Step.Done;
        }

        var refusal = Classify(result);
        if (refusal == Refusal.Revoked)
        {
            return Revoke() ? Step.Stop : (cycle ? Step.Stop : Step.Retry);
        }

        if (cycle)
        {
            // Any other answer, or none, continues the cycle: the old token
            // and the pending token are both kept for the next hour.
            LogCycleRegisterFailed(_logger, result.ErrorCode ?? result.StatusCode.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return Step.Stop;
        }

        switch (refusal)
        {
            case Refusal.RetryAfter:
                return Step.After(result.RetryAfter!.Value);
            case Refusal.Redirect:
                SetAttempt(AgentStates.Refused, StatusReasons.ServerRedirect);
                return Step.Slow;
            case Refusal.BadRequest:
                SetAttempt(AgentStates.Refused, BadRequestReason(result));
                return Step.Slow;
            case Refusal.Blocked:
                SetAttempt(AgentStates.Refused, result.ErrorCode);
                return Step.Retry;
            case Refusal.RegistrationClosed:
                SetAttempt(AgentStates.Refused, StatusReasons.RegistrationClosed);
                return Step.Slow;
            case Refusal.InstallIdConflict:
                // Random IDs never collide; the IDs are kept and tried hourly.
                SetAttempt(AgentStates.Refused, StatusReasons.InstallIdConflict);
                return Step.Slow;
            default:
                SetAttempt(AgentStates.Registering, null);
                return Step.Retry;
        }
    }

    /// <summary>Discards every token and stays revoked until the user joins again.</summary>
    private bool Revoke()
    {
        if (!TrySave(_state with { Identity = null, Pending = null, IdentityState = IdentityStates.Revoked }))
        {
            return false;
        }

        ResetAttempt();
        LogRevoked(_logger);
        return true;
    }

    private async Task HeartbeatAsync(int epoch, CancellationToken cancellationToken)
    {
        AgentIdentity identity;
        int interval;
        lock (_gate)
        {
            if (_epoch != epoch || _state.Identity is null)
            {
                return;
            }

            identity = _state.Identity;
            interval = _state.IntervalSeconds;
        }

        HeartbeatRequest? body = null;
        var step = await HeartbeatPipeline(interval).ExecuteAsync(
            async token =>
            {
                body ??= await PrepareHeartbeatAsync(epoch, identity, token).ConfigureAwait(false);
                if (body is null)
                {
                    return Step.Retry;
                }

                var inFlight = BeginHeartbeat();
                if (inFlight is null)
                {
                    return Step.Stop;
                }

                try
                {
                    var result = await _api!.HeartbeatAsync(body, identity.Token, token).ConfigureAwait(false);
                    lock (_gate)
                    {
                        return _epoch != epoch || !ReferenceEquals(_state.Identity, identity) ? Step.Stop : ApplyHeartbeat(result);
                    }
                }
                finally
                {
                    inFlight.TrySetResult();
                }
            },
            cancellationToken).ConfigureAwait(false);

        if (step.Kind == StepKind.Done)
        {
            await WaitForNextHeartbeatAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task WaitForNextHeartbeatAsync(CancellationToken cancellationToken)
    {
        int next;
        lock (_gate)
        {
            next = _state.IntervalSeconds;
        }

        await Task.Delay(TimeSpan.FromSeconds(next), _time, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// One step of the 401 cycle: a heartbeat with the old token first; when
    /// it gets 401 again, the pending token is registered for the same
    /// install ID, at most once an hour.
    /// </summary>
    private async Task TokenCycleAsync(int epoch, CancellationToken cancellationToken)
    {
        TimeSpan delay;
        lock (_gate)
        {
            delay = _cycleDelay;
        }

        if (delay > TimeSpan.Zero)
        {
            await Task.Delay(delay, _time, cancellationToken).ConfigureAwait(false);
        }

        AgentIdentity identity;
        lock (_gate)
        {
            if (_epoch != epoch || _state.Identity is null || _state.IdentityState != IdentityStates.TokenRejected)
            {
                return;
            }

            identity = _state.Identity;
            _cycleDelay = RetryPolicies.SlowWithJitter();
        }

        var body = await PrepareHeartbeatAsync(epoch, identity, cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return;
        }

        var inFlight = BeginHeartbeat();
        if (inFlight is null)
        {
            return;
        }

        ApiResult<HeartbeatResponse> result;
        try
        {
            result = await _api!.HeartbeatAsync(body, identity.Token, cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                if (_epoch != epoch || !ReferenceEquals(_state.Identity, identity))
                {
                    return;
                }

                if (result.Outcome == ApiOutcome.Success || Classify(result) != Refusal.TokenInvalid)
                {
                    if (ApplyHeartbeat(result).Kind != StepKind.Done)
                    {
                        return;
                    }
                }
                else if (!CycleRegisterAllowed(_state.LastRegisterAttemptUtc, _time.GetUtcNow()))
                {
                    // Wait until the hour since the last register request is over.
                    _cycleDelay = _state.LastRegisterAttemptUtc!.Value + CycleRegisterSpacing - _time.GetUtcNow();
                    return;
                }
            }
        }
        finally
        {
            // The answer, and its sync, is applied before a shutdown event is timed.
            inFlight.TrySetResult();
        }

        if (result.Outcome == ApiOutcome.Success)
        {
            await WaitForNextHeartbeatAsync(cancellationToken).ConfigureAwait(false);
            return;
        }

        // Success replaces the identity, and the loop sends its first heartbeat
        // at once, as after a first registration.
        await RegisterAttemptAsync(epoch, cycle: true, cancellationToken).ConfigureAwait(false);
    }

    private ResiliencePipeline<Step> HeartbeatPipeline(int interval)
    {
        lock (_gate)
        {
            if (!_heartbeatPipelines.TryGetValue(interval, out var pipeline))
            {
                pipeline = RetryPolicies.Create(TimeSpan.FromSeconds(interval), _time);
                _heartbeatPipelines[interval] = pipeline;
            }

            return pipeline;
        }
    }

    /// <summary>Measures DNS and saves the next sequence before the heartbeat is sent (write-ahead).</summary>
    private async Task<HeartbeatRequest?> PrepareHeartbeatAsync(int epoch, AgentIdentity identity, CancellationToken cancellationToken)
    {
        var dnsMs = await MeasureDnsAsync(_options.Origin!.DnsSafeHost, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            if (_epoch != epoch || !ReferenceEquals(_state.Identity, identity))
            {
                return null;
            }

            var sequence = _state.NextSequence;
            if (!TrySave(_state with { NextSequence = sequence + 1 }))
            {
                return null;
            }

            return new HeartbeatRequest
            {
                Sequence = sequence,
                BootId = _options.BootId,
                AreaCell = null,
                Infrastructure = ProtocolConstants.InfrastructureUnknown,
                IntervalSeconds = _state.IntervalSeconds,
                RoundTripMs = _lastRoundTripMs,
                DnsMs = dnsMs,
                AgentVersion = _options.AgentVersion,
            };
        }
    }

    private Step ApplyHeartbeat(ApiResult<HeartbeatResponse> result)
    {
        if (result.Outcome == ApiOutcome.Success)
        {
            var interval = ClampInterval(result.Value!.NextIntervalSeconds);

            // A 200 for the old token ends the 401 cycle: the pending token is dropped.
            // The sync of the answer is what events measure their elapsed time from.
            var answered = ObserveLocked();
            var sync = new SyncPoint { BootId = _options.BootId, SyncId = result.Value.SyncId!, Timestamp = answered.Timestamp, Frequency = _time.TimestampFrequency };
            var updated = _state with { IntervalSeconds = interval, IdentityState = IdentityStates.Active, Pending = null, LastSync = _writer is null ? _state.LastSync : sync };
            if (updated != _state && !TrySave(updated))
            {
                // Keep using the answer; the next save writes it.
                _state = updated;
            }

            _lastRoundTripMs = (int)Math.Min(result.Elapsed.TotalMilliseconds, ProtocolConstants.MaxLatencyMs);
            _lastContact = _time.GetUtcNow();
            SetAttempt(AgentStates.Connected, null);
            if (_writer is not null)
            {
                // A heartbeat answer counts as a successful connectivity check.
                ObserveConnectivityLocked(online: true, answered with { Sync = sync });
                _senderSignal.Release();
            }

            return Step.Done;
        }

        _lastRoundTripMs = null;
        switch (Classify(result))
        {
            case Refusal.RetryAfter:
                return Step.After(result.RetryAfter!.Value);
            case Refusal.Redirect:
                SetAttempt(AgentStates.Refused, StatusReasons.ServerRedirect);
                return Step.Slow;
            case Refusal.BadRequest:
                SetAttempt(AgentStates.Refused, BadRequestReason(result));
                return Step.Slow;
            case Refusal.Blocked:
                SetAttempt(AgentStates.Refused, result.ErrorCode);
                return Step.Retry;
            case Refusal.TokenInvalid:
                return StartTokenCycle() ? Step.Stop : Step.Retry;
            case Refusal.Revoked:
                return Revoke() ? Step.Stop : Step.Retry;
            default:
                SetAttempt(AgentStates.Unreachable, null);
                return Step.Retry;
        }
    }

    /// <summary>The first 401: keeps the old token and saves a pending token for the same install ID.</summary>
    private bool StartTokenCycle()
    {
        if (_state.IdentityState == IdentityStates.TokenRejected)
        {
            return true;
        }

        var pending = new PendingRegistration { ServerOrigin = _state.Identity!.ServerOrigin, Token = _options.NewCredentials().Token };
        if (!TrySave(_state with { IdentityState = IdentityStates.TokenRejected, Pending = pending }))
        {
            return false;
        }

        _cycleDelay = RetryPolicies.SlowWithJitter();
        ResetAttempt();
        LogTokenRejected(_logger);
        return true;
    }

    private enum Refusal
    {
        Transient,
        RetryAfter,
        Redirect,
        BadRequest,
        Blocked,
        RegistrationClosed,
        Revoked,
        InstallIdConflict,
        TokenInvalid,
    }

    private static Refusal Classify<T>(ApiResult<T> result)
        where T : class
    {
        if (result.Outcome == ApiOutcome.NoResponse || result.BadBody)
        {
            return Refusal.Transient;
        }

        return result.StatusCode switch
        {
            429 when result.RetryAfter is not null => Refusal.RetryAfter,
            >= 300 and < 400 => Refusal.Redirect,
            400 => Refusal.BadRequest,
            401 when result.ErrorCode == StatusReasons.TokenInvalid => Refusal.TokenInvalid,
            403 => result.ErrorCode switch
            {
                StatusReasons.AgentBlocked or StatusReasons.AddressBlocked => Refusal.Blocked,
                StatusReasons.AgentRevoked => Refusal.Revoked,
                StatusReasons.RegistrationClosed => Refusal.RegistrationClosed,
                _ => Refusal.Transient,
            },
            409 when result.ErrorCode == StatusReasons.InstallIdConflict => Refusal.InstallIdConflict,
            _ => Refusal.Transient,
        };
    }

    private static string BadRequestReason<T>(ApiResult<T> result)
        where T : class =>
        result.ErrorCode is { } code && code.StartsWith("protocol_version_", StringComparison.Ordinal)
            ? StatusReasons.ProtocolUnsupported
            : StatusReasons.RequestInvalid;

    private int ClampInterval(int seconds)
    {
        var clamped = Math.Clamp(seconds, ProtocolConstants.MinIntervalSeconds, ProtocolConstants.MaxIntervalSeconds);
        if (clamped != seconds)
        {
            LogIntervalClamped(_logger, seconds, clamped);
        }

        return clamped;
    }

    private async Task<int?> MeasureDnsAsync(string host, CancellationToken cancellationToken)
    {
        if (_options.MeasureDns is { } measure)
        {
            return await measure(host, cancellationToken).ConfigureAwait(false);
        }

        return await DnsTiming.MeasureAsync(
            static async (name, token) => await Dns.GetHostAddressesAsync(name, token).ConfigureAwait(false),
            host,
            DnsBudget,
            _time,
            cancellationToken).ConfigureAwait(false);
    }

    private bool TrySave(AgentState state)
    {
        try
        {
            _options.Store.Save(state);
            _state = state;
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            LogSaveFailed(_logger, exception.GetType().Name);
            return false;
        }
    }

    private void SetAttempt(string state, string? reason)
    {
        _attemptState = state;
        _attemptReason = reason;
    }

    private void ResetAttempt()
    {
        _attemptState = null;
        _attemptReason = null;
    }

    private void WakeLocked()
    {
        _epoch++;
        var previous = _wake;
        _wake = new CancellationTokenSource();
        previous.Cancel();
        previous.Dispose();
    }

    private AgentStatus BuildStatus()
    {
        string state;
        string? reason = null;
        if (_blockedReason is not null)
        {
            state = AgentStates.Refused;
            reason = _blockedReason;
        }
        else if (ServerChanged())
        {
            state = AgentStates.Refused;
            reason = StatusReasons.ServerChanged;
        }
        else if (_state.IdentityState == IdentityStates.Revoked)
        {
            state = AgentStates.Revoked;
        }
        else if (_state.Identity is null)
        {
            if (_state.Pending is null)
            {
                state = AgentStates.Unregistered;
            }
            else
            {
                state = _attemptState is AgentStates.Refused ? AgentStates.Refused : AgentStates.Registering;
                reason = state == AgentStates.Refused ? _attemptReason : null;
            }
        }
        else if (_state.IdentityState == IdentityStates.TokenRejected)
        {
            state = AgentStates.Refused;
            reason = StatusReasons.TokenInvalid;
        }
        else
        {
            state = _attemptState ?? (_lastContact is null ? AgentStates.Unreachable : AgentStates.Connected);
            reason = _attemptReason;
        }

        return new AgentStatus
        {
            State = state,
            Reason = reason,
            CanRejoin = CanRejoin(),
            LastContactUtc = _lastContact,
            ServerHost = _options.Origin?.Host,
        };
    }

    [LoggerMessage(EventId = 10, Level = LogLevel.Error, Message = "The agent state cannot be used: {Problem}. Fix or delete it, then restart the service")]
    private static partial void LogStateInvalid(ILogger logger, string problem);

    [LoggerMessage(EventId = 11, Level = LogLevel.Error, Message = "SERVER_URL is not an https origin or a loopback http origin; nothing is sent")]
    private static partial void LogConfigInvalid(ILogger logger);

    [LoggerMessage(EventId = 12, Level = LogLevel.Warning, Message = "The agent is registered with another server than SERVER_URL; nothing is sent until the user joins again")]
    private static partial void LogServerChanged(ILogger logger);

    [LoggerMessage(EventId = 13, Level = LogLevel.Information, Message = "A new install ID and token were saved; registering")]
    private static partial void LogRegistrationStarted(ILogger logger);

    [LoggerMessage(EventId = 14, Level = LogLevel.Information, Message = "Joining again with a new install ID and token")]
    private static partial void LogRejoined(ILogger logger);

    [LoggerMessage(EventId = 15, Level = LogLevel.Warning, Message = "Registering the pending token failed ({Error}); trying again in an hour")]
    private static partial void LogCycleRegisterFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 16, Level = LogLevel.Information, Message = "Registered as agent {AgentId}")]
    private static partial void LogRegistered(ILogger logger, Guid agentId);

    [LoggerMessage(EventId = 18, Level = LogLevel.Warning, Message = "The server does not recognize the token; it is kept and tried hourly, and the PC registers again when it keeps failing")]
    private static partial void LogTokenRejected(ILogger logger);

    [LoggerMessage(EventId = 19, Level = LogLevel.Warning, Message = "The admin revoked this agent; its tokens were discarded and it stays removed until the user joins again")]
    private static partial void LogRevoked(ILogger logger);

    [LoggerMessage(EventId = 20, Level = LogLevel.Warning, Message = "The server sent the interval {Seconds} s; using {Clamped} s")]
    private static partial void LogIntervalClamped(ILogger logger, int seconds, int clamped);

    [LoggerMessage(EventId = 21, Level = LogLevel.Error, Message = "The agent state could not be saved: {Error}")]
    private static partial void LogSaveFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 22, Level = LogLevel.Error, Message = "The agent loop failed: {Error}; retrying in a minute")]
    private static partial void LogLoopFailed(ILogger logger, string error);
}
