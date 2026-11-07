using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Mashkif.Service.Protocol;

namespace Mashkif.Service.State;

/// <summary>States of the stored identity.</summary>
internal static class IdentityStates
{
    /// <summary>No identity yet: a first registration, or one after joining again.</summary>
    public const string None = "none";

    /// <summary>The server accepts the token.</summary>
    public const string Active = "active";

    /// <summary>
    /// The server answered 401: the token is kept and tried hourly, and a
    /// pending token for the same install ID is registered when it fails again.
    /// </summary>
    public const string TokenRejected = "token_rejected";

    /// <summary>The admin revoked the agent; the tokens were discarded. Only joining again leaves this state.</summary>
    public const string Revoked = "revoked";
}

/// <summary>The registered identity on one server; its install ID is <see cref="AgentState.InstallId"/>.</summary>
internal sealed record AgentIdentity
{
    public required string ServerOrigin { get; init; }

    public required string Token { get; init; }

    public required Guid AgentId { get; init; }
}

/// <summary>
/// A registration that has not been answered with success yet. The token is
/// saved before it is sent, so every retry sends the identical body.
/// </summary>
internal sealed record PendingRegistration
{
    public required string ServerOrigin { get; init; }

    public required string Token { get; init; }
}

/// <summary>
/// The last heartbeat answer of a boot: its sync ID and the monotonic
/// reading (<see cref="TimeProvider.GetTimestamp"/>, which counts through
/// sleep) when the answer arrived. Events measure their elapsed time from it.
/// </summary>
internal sealed record SyncPoint
{
    public required Guid BootId { get; init; }

    public required string SyncId { get; init; }

    public required long Timestamp { get; init; }

    public required long Frequency { get; init; }
}

/// <summary>
/// The content of <c>state.json</c>, schema version 2 (version 1 is read and
/// migrated). The tokens live only here and in requests to the server they
/// are bound to.
/// </summary>
internal sealed partial record AgentState
{
    public const int CurrentSchemaVersion = 2;

    /// <summary>The schema version of the 0.1.0 builds before step 2c; read and migrated.</summary>
    public const int PreviousSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    /// <summary>Created at the first start; replaced only by joining again.</summary>
    public Guid? InstallId { get; init; }

    public AgentIdentity? Identity { get; init; }

    public string IdentityState { get; init; } = IdentityStates.None;

    public PendingRegistration? Pending { get; init; }

    /// <summary>Saved before each register request; the 401 cycle sends at most one an hour.</summary>
    public DateTimeOffset? LastRegisterAttemptUtc { get; init; }

    public int IntervalSeconds { get; init; } = ProtocolConstants.DefaultIntervalSeconds;

    public long NextSequence { get; init; }

    /// <summary>The last heartbeat answer; cleared by every identity switch.</summary>
    public SyncPoint? LastSync { get; init; }

    /// <summary>
    /// The end of the last <c>deferred</c> wait of the event budget, with its
    /// length, so a restart still honors it. Cleared by every identity switch.
    /// </summary>
    public DateTimeOffset? DeferredUntilUtc { get; init; }

    public int? DeferredSeconds { get; init; }

    /// <summary>
    /// Events dropped because the queue file was at its size bound, as a
    /// cumulative count per boot (at most 10 boots). They live here, a separate
    /// file, because the queue file could not take them; cleared by Join again.
    /// </summary>
    public IReadOnlyList<DroppedEvents>? QueueRejected { get; init; }

    /// <summary>A state with nothing in it, for a PC that never registered.</summary>
    public static AgentState Empty { get; } = new();

    /// <summary>Whether the content is consistent and has the formats of the contract.</summary>
    public bool IsValid()
    {
        if (SchemaVersion != CurrentSchemaVersion
            || IntervalSeconds is < ProtocolConstants.MinIntervalSeconds or > ProtocolConstants.MaxIntervalSeconds
            || NextSequence is < 0 or > 9007199254740991)
        {
            return false;
        }

        if (LastSync is { } sync
            && (sync.BootId == Guid.Empty || !SyncIdPattern().IsMatch(sync.SyncId ?? string.Empty) || sync.Timestamp < 0 || sync.Frequency <= 0))
        {
            return false;
        }

        if ((DeferredUntilUtc is null) != (DeferredSeconds is null) || DeferredSeconds is < 1)
        {
            return false;
        }

        if (QueueRejected is { } rejected
            && (rejected.Count > 10 || rejected.Any(r => r is null || r.BootId == Guid.Empty || r.Count < 1) || rejected.Select(r => r.BootId).Distinct().Count() != rejected.Count))
        {
            return false;
        }

        if (InstallId == Guid.Empty || ((Identity is not null || Pending is not null) && InstallId is null))
        {
            return false;
        }

        // A pending token next to an identity is the 401 cycle, always for the identity's server.
        if (Identity is not null && Pending is not null && Identity.ServerOrigin != Pending.ServerOrigin)
        {
            return false;
        }

        var shapeOk = IdentityState switch
        {
            IdentityStates.None => Identity is null,
            IdentityStates.Active => Identity is not null && Pending is null,
            // The 401 cycle always has the pending token it registers next.
            IdentityStates.TokenRejected => Identity is not null && Pending is not null,
            IdentityStates.Revoked => Identity is null && Pending is null,
            _ => false,
        };

        var identityOk = Identity is null
            || (IsOrigin(Identity.ServerOrigin) && Identity.AgentId != Guid.Empty && IsToken(Identity.Token));
        var pendingOk = Pending is null || (IsOrigin(Pending.ServerOrigin) && IsToken(Pending.Token));
        return shapeOk && identityOk && pendingOk;
    }

    private static bool IsToken(string? token) => token is not null && TokenPattern().IsMatch(token);

    private static bool IsOrigin(string? origin) =>
        origin is not null
        && Config.ServerOrigin.Parse(origin) is { } parsed
        && Config.ServerOrigin.Key(parsed) == origin;

    [GeneratedRegex("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex SyncIdPattern();
}

/// <summary>Source-generated JSON for <c>state.json</c>. Unknown members make the file invalid.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    RespectNullableAnnotations = true,
    RespectRequiredConstructorParameters = true)]
[JsonSerializable(typeof(AgentState))]
internal sealed partial class StateJsonContext : JsonSerializerContext;
