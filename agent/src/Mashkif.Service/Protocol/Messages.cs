using System.Text.Json.Serialization;

namespace Mashkif.Service.Protocol;

// Request and response bodies of contracts/openapi.yaml, protocol version 1.
// The request examples in contracts/examples/agent-<version>/ are the golden
// output of these records; tests compare them.

/// <summary><c>RegisterRequest</c>.</summary>
internal sealed record RegisterRequest
{
    public required string EnrollmentKey { get; init; }

    public required Guid InstallId { get; init; }

    public required string Token { get; init; }

    public required string AgentVersion { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OsVersion { get; init; }
}

/// <summary><c>RegisterResponse</c>.</summary>
internal sealed record RegisterResponse
{
    public Guid AgentId { get; init; }

    public int HeartbeatIntervalSeconds { get; init; }

    public DateTimeOffset ServerTime { get; init; }
}

/// <summary><c>HeartbeatRequest</c>. Nullable fields are required and sent as null.</summary>
internal sealed record HeartbeatRequest
{
    public required long Sequence { get; init; }

    public required Guid BootId { get; init; }

    public required string? AreaCell { get; init; }

    public required string Infrastructure { get; init; }

    public required int IntervalSeconds { get; init; }

    public required int? RoundTripMs { get; init; }

    public required int? DnsMs { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AgentVersion { get; init; }
}

/// <summary><c>HeartbeatResponse</c>.</summary>
internal sealed record HeartbeatResponse
{
    public string? SyncId { get; init; }

    public DateTimeOffset ServerTime { get; init; }

    public int NextIntervalSeconds { get; init; }
}

/// <summary>The <c>error</c> field shared by <c>AgentError</c> and <c>ProtocolError</c>.</summary>
internal sealed record ErrorBody
{
    public string? Error { get; init; }
}

/// <summary>Source-generated JSON for the protocol bodies.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip)]
[JsonSerializable(typeof(RegisterRequest))]
[JsonSerializable(typeof(RegisterResponse))]
[JsonSerializable(typeof(HeartbeatRequest))]
[JsonSerializable(typeof(HeartbeatResponse))]
[JsonSerializable(typeof(ErrorBody))]
internal sealed partial class ProtocolJsonContext : JsonSerializerContext;

/// <summary>Constants of the contract that the agent uses.</summary>
internal static class ProtocolConstants
{
    public const int ProtocolVersion = 1;

    public const string ProtocolVersionHeader = "Mashkif-Protocol-Version";

    public const int MinIntervalSeconds = 30;

    public const int MaxIntervalSeconds = 600;

    public const int DefaultIntervalSeconds = 60;

    /// <summary>Largest round trip or DNS time the contract accepts.</summary>
    public const int MaxLatencyMs = 600_000;

    public const string InfrastructureUnknown = "unknown";
}
