using System.Text.Json.Serialization;

namespace Mashkif.Common.Pipe;

/// <summary>
/// Names and limits of the local named pipe between the tray app and the
/// service. The pipe carries no token, no install ID, and no coordinates.
/// </summary>
public static class PipeProtocol
{
    /// <summary>Pipe name; the full path is <c>\\.\pipe\Mashkif.Agent</c>.</summary>
    public const string PipeName = "Mashkif.Agent";

    /// <summary>Version of the request and response format.</summary>
    public const int Version = 1;

    /// <summary>Largest request line, in bytes, including the line feed.</summary>
    public const int MaxRequestBytes = 4096;

    /// <summary>Largest response line, in bytes, including the line feed.</summary>
    public const int MaxResponseBytes = 16384;

    /// <summary>Time the client has to send its request after connecting.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Command that returns the agent status.</summary>
    public const string StatusCommand = "status";

    /// <summary>
    /// Command that joins again after a revoke or a server change: a new
    /// install ID and token for the configured server. It has no payload.
    /// </summary>
    public const string RejoinCommand = "rejoin";
}

/// <summary>Error codes of a refused pipe request.</summary>
public static class PipeErrors
{
    /// <summary>Joining again is possible only after a revoke or a server change.</summary>
    public const string NotRejoinable = "not_rejoinable";

    /// <summary>The command is not known.</summary>
    public const string UnknownCommand = "unknown_command";

    /// <summary>The request is not a valid request line.</summary>
    public const string RequestInvalid = "request_invalid";

    /// <summary>The request names a version the service does not speak.</summary>
    public const string VersionUnsupported = "version_unsupported";

    /// <summary>The service cannot join again now (invalid state or configuration, or a failed write).</summary>
    public const string NotAvailable = "not_available";
}

/// <summary>Connection states reported in <see cref="AgentStatus.State"/>.</summary>
public static class AgentStates
{
    public const string Unregistered = "unregistered";
    public const string Registering = "registering";
    public const string Connected = "connected";
    public const string Unreachable = "unreachable";
    public const string Refused = "refused";
    public const string Revoked = "revoked";
}

/// <summary>One request from the tray app.</summary>
public sealed record PipeRequest
{
    public int Version { get; init; } = PipeProtocol.Version;

    public string? Command { get; init; }
}

/// <summary>The answer to one request.</summary>
public sealed record PipeResponse
{
    public int Version { get; init; } = PipeProtocol.Version;

    public bool Ok { get; init; }

    public string? Error { get; init; }

    public AgentStatus? Status { get; init; }

    public static PipeResponse Success(AgentStatus status) => new() { Ok = true, Status = status };

    public static PipeResponse Failure(string error, AgentStatus? status = null) =>
        new() { Ok = false, Error = error, Status = status };
}

/// <summary>What the tray app shows. Contains nothing secret.</summary>
public sealed record AgentStatus
{
    /// <summary>One of <see cref="AgentStates"/>.</summary>
    public required string State { get; init; }

    /// <summary>Why the state is what it is, as a stable code, or null.</summary>
    public string? Reason { get; init; }

    /// <summary>Whether the service accepts a <c>rejoin</c> command now.</summary>
    public bool CanRejoin { get; init; }

    /// <summary>Last time the server answered with success.</summary>
    public DateTimeOffset? LastContactUtc { get; init; }

    /// <summary>Host name of the configured server, or null when the configuration is invalid.</summary>
    public string? ServerHost { get; init; }
}

/// <summary>Source-generated JSON for the pipe messages.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(PipeRequest))]
[JsonSerializable(typeof(PipeResponse))]
public sealed partial class PipeJsonContext : JsonSerializerContext;

/// <summary>Codes in <see cref="AgentStatus.Reason"/>.</summary>
public static class StatusReasons
{
    public const string AgentRevoked = "agent_revoked";
    public const string TokenInvalid = "token_invalid";
    public const string AgentBlocked = "agent_blocked";
    public const string AddressBlocked = "address_blocked";
    public const string RegistrationClosed = "registration_closed";
    public const string InstallIdConflict = "install_id_conflict";
    public const string RequestInvalid = "request_invalid";
    public const string ProtocolUnsupported = "protocol_unsupported";
    public const string ConfigInvalid = "config_invalid";
    public const string StateInvalid = "state_invalid";
    public const string ServerChanged = "server_changed";
    public const string ServerRedirect = "server_redirect";
}
