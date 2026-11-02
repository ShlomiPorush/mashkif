using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Mashkif.Common.Pipe;
using Mashkif.Service.Protocol;

namespace Mashkif.Service.State;

/// <summary>States of the stored identity.</summary>
internal static class IdentityStates
{
    /// <summary>No identity: never enrolled, or reset.</summary>
    public const string None = "none";

    /// <summary>The server accepts the token.</summary>
    public const string Active = "active";

    /// <summary>The server answered 401; the token is kept and retried hourly.</summary>
    public const string TokenRejected = "token_rejected";

    /// <summary>The admin revoked the agent; the identity was discarded.</summary>
    public const string Revoked = "revoked";
}

/// <summary>The agent identity for one server.</summary>
internal sealed record AgentIdentity
{
    public required string ServerOrigin { get; init; }

    public required Guid InstallId { get; init; }

    public required string Token { get; init; }

    public required Guid AgentId { get; init; }
}

/// <summary>A registration that has not been answered with success yet.</summary>
internal sealed record PendingRegistration
{
    public required string ServerOrigin { get; init; }

    public required string Key { get; init; }

    /// <summary><c>tray</c> or <c>msi</c>.</summary>
    public required string Source { get; init; }

    public required Guid InstallId { get; init; }

    public required string Token { get; init; }
}

/// <summary>
/// The content of <c>state.json</c>, schema version 1. The token and the
/// enrollment key live only here and in requests to their own server.
/// </summary>
internal sealed partial record AgentState
{
    public const int CurrentSchemaVersion = 1;

    public const string SourceTray = "tray";

    public const string SourceMsi = "msi";

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    public AgentIdentity? Identity { get; init; }

    public string IdentityState { get; init; } = IdentityStates.None;

    public PendingRegistration? Pending { get; init; }

    public int IntervalSeconds { get; init; } = ProtocolConstants.DefaultIntervalSeconds;

    public long NextSequence { get; init; }

    /// <summary>A state with nothing in it, for a PC that never enrolled.</summary>
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

        var identityOk = Identity is null
            ? IdentityState is IdentityStates.None or IdentityStates.Revoked
            : IdentityState is IdentityStates.Active or IdentityStates.TokenRejected
                && IsOrigin(Identity.ServerOrigin)
                && Identity.InstallId != Guid.Empty
                && Identity.AgentId != Guid.Empty
                && IsToken(Identity.Token);

        var pendingOk = Pending is null
            || (IsOrigin(Pending.ServerOrigin)
                && EnrollmentKeyFormat.IsValid(Pending.Key)
                && Pending.Source is SourceTray or SourceMsi
                && Pending.InstallId != Guid.Empty
                && IsToken(Pending.Token));

        return identityOk && pendingOk;
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
