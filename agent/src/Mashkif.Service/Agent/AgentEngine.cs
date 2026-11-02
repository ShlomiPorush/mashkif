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

    public required IEnrollmentKeySource MsiKey { get; init; }

    public required HttpClient Http { get; init; }

    public required Guid BootId { get; init; }

    public required string AgentVersion { get; init; }

    public string? OsVersion { get; init; }

    public TimeProvider Time { get; init; } = TimeProvider.System;

    public Func<Credentials> NewCredentials { get; init; } = Credentials.Create;

    /// <summary>Measures the DNS time of a host in milliseconds, or null.</summary>
    public Func<string, CancellationToken, Task<int?>>? MeasureDns { get; init; }
}

/// <summary>
/// The agent state machine. One loop owns the network work; pipe commands
/// change the state under the same lock and wake the loop. The token and the
/// enrollment key are sent only to the origin they are bound to and never logged.
/// </summary>
internal sealed partial class AgentEngine : IDisposable
{
    /// <summary>Time the DNS measurement may take.</summary>
    public static readonly TimeSpan DnsBudget = TimeSpan.FromSeconds(5);

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

    // What the last attempt in the current phase found, for the status.
    private string? _attemptState;
    private string? _attemptReason;
    private string? _enrollmentError;
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
    /// Checks the configuration, the path, and the state, then adopts an MSI
    /// key. Runs once, before <see cref="RunAsync"/> and before the pipe opens.
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

            AdoptMsiKey();
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

    /// <summary>The pipe command <c>register</c>.</summary>
    public PipeResponse Register(string? key)
    {
        lock (_gate)
        {
            if (_blockedReason is not null)
            {
                return PipeResponse.Failure(PipeErrors.NotAvailable, BuildStatus());
            }

            if (!EnrollmentKeyFormat.IsValid(key))
            {
                return PipeResponse.Failure(PipeErrors.EnrollmentKeyFormat, BuildStatus());
            }

            if (_state.Pending is not null)
            {
                return PipeResponse.Failure(PipeErrors.RegistrationInProgress, BuildStatus());
            }

            if (!CanEnroll())
            {
                return PipeResponse.Failure(PipeErrors.AlreadyRegistered, BuildStatus());
            }

            if (!TrySave(_state with { Pending = NewPending(key!, AgentState.SourceTray) }))
            {
                return PipeResponse.Failure(PipeErrors.NotAvailable, BuildStatus());
            }

            _enrollmentError = null;
            ResetAttempt();
            LogEnrollmentStarted(_logger, AgentState.SourceTray);
            WakeLocked();
            return PipeResponse.Success(BuildStatus());
        }
    }

    /// <summary>The network loop: registration, heartbeats, and waiting for commands.</summary>
    public async Task RunAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Phase phase;
            int epoch;
            CancellationToken wake;
            lock (_gate)
            {
                phase = CurrentPhase();
                epoch = _epoch;
                wake = _wake.Token;
            }

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, wake);
            try
            {
                switch (phase)
                {
                    case Phase.Register:
                        await _registerPipeline.ExecuteAsync(
                            async token => await RegisterAttemptAsync(epoch, token).ConfigureAwait(false),
                            linked.Token).ConfigureAwait(false);
                        break;
                    case Phase.Heartbeat:
                        await HeartbeatAsync(epoch, linked.Token).ConfigureAwait(false);
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
        }
    }

    private enum Phase
    {
        Idle,
        Register,
        Heartbeat,
    }

    private Phase CurrentPhase()
    {
        if (_blockedReason is not null)
        {
            return Phase.Idle;
        }

        if (_state.Pending is { } pending)
        {
            return pending.ServerOrigin == _origin ? Phase.Register : Phase.Idle;
        }

        return _state.Identity is { } identity && identity.ServerOrigin == _origin
            ? Phase.Heartbeat
            : Phase.Idle;
    }

    private bool CanEnroll() =>
        _blockedReason is null
        && _state.Pending is null
        && (_state.Identity is null
            || _state.IdentityState == IdentityStates.TokenRejected
            || _state.Identity.ServerOrigin != _origin);

    // MSI key adoption, in the fixed order of the plan: A (blocked, handled by
    // Initialize), B, C, D, E. B always completes before C, so a key that was
    // saved for one origin can never be adopted for another.
    private void AdoptMsiKey()
    {
        string? value;
        try
        {
            value = _options.MsiKey.Read();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            LogMsiKeyFailed(_logger, "read", exception.GetType().Name);
            return;
        }

        // B: a crash between saving pending and deleting the value.
        if (value is not null && _state.Pending is { } saved && saved.Key == value)
        {
            if (!TryDeleteMsiKey())
            {
                return;
            }

            value = null;
        }

        // C: a pending registration for another server is dropped.
        if (_state.Pending is { } other && other.ServerOrigin != _origin)
        {
            if (!TrySave(_state with { Pending = null }))
            {
                return;
            }

            LogPendingDiscarded(_logger);
        }

        if (value is null)
        {
            return;
        }

        // D: adopt the value for the current origin.
        if (CanEnroll() && EnrollmentKeyFormat.IsValid(value))
        {
            if (!TrySave(_state with { Pending = NewPending(value, AgentState.SourceMsi) }))
            {
                return;
            }

            LogEnrollmentStarted(_logger, AgentState.SourceMsi);
            TryDeleteMsiKey();
            return;
        }

        // E: a value that cannot be used now.
        if (!EnrollmentKeyFormat.IsValid(value))
        {
            _enrollmentError = StatusReasons.EnrollmentKeyInvalid;
        }

        LogMsiKeyIgnored(_logger);
        TryDeleteMsiKey();
    }

    private bool TryDeleteMsiKey()
    {
        try
        {
            _options.MsiKey.Delete();
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            LogMsiKeyFailed(_logger, "delete", exception.GetType().Name);
            return false;
        }
    }

    private PendingRegistration NewPending(string key, string source)
    {
        var credentials = _options.NewCredentials();
        return new PendingRegistration
        {
            ServerOrigin = _origin!,
            Key = key,
            Source = source,
            InstallId = credentials.InstallId,
            Token = credentials.Token,
        };
    }

    private async Task<Step> RegisterAttemptAsync(int epoch, CancellationToken cancellationToken)
    {
        PendingRegistration pending;
        lock (_gate)
        {
            if (_epoch != epoch || _state.Pending is null)
            {
                return Step.Stop;
            }

            pending = _state.Pending;
        }

        var result = await _api!.RegisterAsync(
            new RegisterRequest
            {
                EnrollmentKey = pending.Key,
                InstallId = pending.InstallId,
                Token = pending.Token,
                AgentVersion = _options.AgentVersion,
                OsVersion = _options.OsVersion,
            },
            cancellationToken).ConfigureAwait(false);

        lock (_gate)
        {
            return _epoch != epoch || !ReferenceEquals(_state.Pending, pending) ? Step.Stop : ApplyRegister(pending, result);
        }
    }

    private Step ApplyRegister(PendingRegistration pending, ApiResult<RegisterResponse> result)
    {
        if (result.Outcome == ApiOutcome.Success)
        {
            var interval = ClampInterval(result.Value!.HeartbeatIntervalSeconds);
            var identity = new AgentIdentity
            {
                ServerOrigin = pending.ServerOrigin,
                InstallId = pending.InstallId,
                Token = pending.Token,
                AgentId = result.Value.AgentId,
            };
            if (!TrySave(_state with { Identity = identity, IdentityState = IdentityStates.Active, Pending = null, IntervalSeconds = interval }))
            {
                // The server answers the same registration with 200 again.
                SetAttempt(AgentStates.Registering, null);
                return Step.Retry;
            }

            _enrollmentError = null;
            _lastContact = _time.GetUtcNow();
            _lastRoundTripMs = null;
            SetAttempt(AgentStates.Connected, null);
            LogRegistered(_logger, identity.AgentId);
            return Step.Done;
        }

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
            case Refusal.KeyRefused:
                return DropPending(result.ErrorCode!);
            case Refusal.Revoked:
                return DropPending(StatusReasons.AgentRevoked);
            case Refusal.InstallIdConflict:
                var credentials = _options.NewCredentials();
                if (!TrySave(_state with { Pending = pending with { InstallId = credentials.InstallId, Token = credentials.Token } }))
                {
                    return Step.Retry;
                }

                return Step.After(TimeSpan.Zero);
            default:
                SetAttempt(AgentStates.Registering, null);
                return Step.Retry;
        }
    }

    /// <summary>
    /// A definitive failure of a new registration drops only <c>pending</c>.
    /// A kept identity stays with its earlier status; without one, a revoke
    /// leaves the agent revoked.
    /// </summary>
    private Step DropPending(string error)
    {
        var identityState = _state.Identity is null && error == StatusReasons.AgentRevoked
            ? IdentityStates.Revoked
            : _state.IdentityState;
        if (!TrySave(_state with { Pending = null, IdentityState = identityState }))
        {
            return Step.Retry;
        }

        _enrollmentError = error;
        ResetAttempt();
        LogEnrollmentFailed(_logger, error);
        return Step.Stop;
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

                var result = await _api!.HeartbeatAsync(body, identity.Token, token).ConfigureAwait(false);
                lock (_gate)
                {
                    return _epoch != epoch || !ReferenceEquals(_state.Identity, identity) ? Step.Stop : ApplyHeartbeat(result);
                }
            },
            cancellationToken).ConfigureAwait(false);

        if (step.Kind == StepKind.Done)
        {
            int next;
            lock (_gate)
            {
                next = _state.IntervalSeconds;
            }

            await Task.Delay(TimeSpan.FromSeconds(next), _time, cancellationToken).ConfigureAwait(false);
        }
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
            var updated = _state with { IntervalSeconds = interval, IdentityState = IdentityStates.Active };
            if (updated != _state && !TrySave(updated))
            {
                // Keep using the answer; the next save writes it.
                _state = updated;
            }

            _lastRoundTripMs = (int)Math.Min(result.Elapsed.TotalMilliseconds, ProtocolConstants.MaxLatencyMs);
            _lastContact = _time.GetUtcNow();
            SetAttempt(AgentStates.Connected, null);
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
                if (_state.IdentityState != IdentityStates.TokenRejected
                    && !TrySave(_state with { IdentityState = IdentityStates.TokenRejected }))
                {
                    return Step.Retry;
                }

                ResetAttempt();
                LogTokenRejected(_logger);
                return Step.Slow;
            case Refusal.Revoked:
                if (!TrySave(_state with { Identity = null, IdentityState = IdentityStates.Revoked }))
                {
                    return Step.Retry;
                }

                ResetAttempt();
                LogRevoked(_logger);
                return Step.Stop;
            default:
                SetAttempt(AgentStates.Unreachable, null);
                return Step.Retry;
        }
    }

    private enum Refusal
    {
        Transient,
        RetryAfter,
        Redirect,
        BadRequest,
        Blocked,
        KeyRefused,
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
                StatusReasons.EnrollmentKeyInvalid or StatusReasons.EnrollmentKeyExpired
                    or StatusReasons.EnrollmentKeyRevoked or StatusReasons.EnrollmentKeyUsed => Refusal.KeyRefused,
                _ => Refusal.Transient,
            },
            409 when result.ErrorCode == "install_id_conflict" => Refusal.InstallIdConflict,
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
        else if (_state.Pending is { } pending && pending.ServerOrigin == _origin)
        {
            state = _attemptState is AgentStates.Refused ? AgentStates.Refused : AgentStates.Registering;
            reason = state == AgentStates.Refused ? _attemptReason : null;
        }
        else if (_state.Identity is { } identity)
        {
            if (identity.ServerOrigin != _origin)
            {
                state = AgentStates.Refused;
                reason = StatusReasons.ServerChanged;
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
        }
        else
        {
            state = _state.IdentityState == IdentityStates.Revoked ? AgentStates.Revoked : AgentStates.Unregistered;
        }

        return new AgentStatus
        {
            State = state,
            Reason = reason,
            EnrollmentError = _enrollmentError,
            CanEnroll = CanEnroll(),
            LastContactUtc = _lastContact,
            ServerHost = _options.Origin?.Host,
        };
    }

    [LoggerMessage(EventId = 10, Level = LogLevel.Error, Message = "The agent state cannot be used: {Problem}. Fix or delete it, then restart the service")]
    private static partial void LogStateInvalid(ILogger logger, string problem);

    [LoggerMessage(EventId = 11, Level = LogLevel.Error, Message = "SERVER_URL is not an https origin or a loopback http origin; nothing is sent")]
    private static partial void LogConfigInvalid(ILogger logger);

    [LoggerMessage(EventId = 12, Level = LogLevel.Warning, Message = "Could not {Operation} the MSI enrollment key value: {Error}")]
    private static partial void LogMsiKeyFailed(ILogger logger, string operation, string error);

    [LoggerMessage(EventId = 13, Level = LogLevel.Information, Message = "A pending registration for another server was discarded")]
    private static partial void LogPendingDiscarded(ILogger logger);

    [LoggerMessage(EventId = 14, Level = LogLevel.Information, Message = "Enrollment started from the {Source}")]
    private static partial void LogEnrollmentStarted(ILogger logger, string source);

    [LoggerMessage(EventId = 15, Level = LogLevel.Information, Message = "The MSI enrollment key was ignored and deleted")]
    private static partial void LogMsiKeyIgnored(ILogger logger);

    [LoggerMessage(EventId = 16, Level = LogLevel.Information, Message = "Registered as agent {AgentId}")]
    private static partial void LogRegistered(ILogger logger, Guid agentId);

    [LoggerMessage(EventId = 17, Level = LogLevel.Warning, Message = "Enrollment failed: {Error}")]
    private static partial void LogEnrollmentFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 18, Level = LogLevel.Warning, Message = "The server does not recognize the token; it is kept and tried again hourly")]
    private static partial void LogTokenRejected(ILogger logger);

    [LoggerMessage(EventId = 19, Level = LogLevel.Warning, Message = "The admin revoked this agent; its identity was discarded")]
    private static partial void LogRevoked(ILogger logger);

    [LoggerMessage(EventId = 20, Level = LogLevel.Warning, Message = "The server sent the interval {Seconds} s; using {Clamped} s")]
    private static partial void LogIntervalClamped(ILogger logger, int seconds, int clamped);

    [LoggerMessage(EventId = 21, Level = LogLevel.Error, Message = "The agent state could not be saved: {Error}")]
    private static partial void LogSaveFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 22, Level = LogLevel.Error, Message = "The agent loop failed: {Error}; retrying in a minute")]
    private static partial void LogLoopFailed(ILogger logger, string error);
}
