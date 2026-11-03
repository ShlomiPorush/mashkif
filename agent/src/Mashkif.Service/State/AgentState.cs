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
/// The content of <c>state.json</c>, schema version 1. The tokens live only
/// here and in requests to the server they are bound to.
/// </summary>
internal sealed partial record AgentState
{
    public const int CurrentSchemaVersion = 1;

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
            IdentityStates.TokenRejected => Identity is not null,
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
