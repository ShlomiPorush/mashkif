using System.Text.Json.Serialization;

namespace Mashkif.Service.Protocol;

// Request and response bodies of contracts/openapi.yaml, protocol version 1.
// The request examples in contracts/examples/agent-<version>/ are the golden
// output of these records; tests compare them.

/// <summary><c>RegisterRequest</c>.</summary>
internal sealed record RegisterRequest
{
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

/// <summary><c>Event</c>. <c>SyncId</c> and <c>ElapsedMs</c> are both null or both set; there is no wall-clock time.</summary>
internal sealed record AgentEvent
{
    public required Guid Id { get; init; }

    public required string Kind { get; init; }

    public required Guid BootId { get; init; }

    public required string? SyncId { get; init; }

    public required long? ElapsedMs { get; init; }
}

/// <summary><c>DroppedEvents</c>: the cumulative count of one boot.</summary>
internal sealed record DroppedEvents
{
    public required Guid BootId { get; init; }

    public required long Count { get; init; }
}

/// <summary><c>EventsRequest</c>.</summary>
internal sealed record EventsRequest
{
    public required IReadOnlyList<AgentEvent> Events { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DroppedEvents? DroppedEvents { get; init; }
}

/// <summary><c>EventResult</c>.</summary>
internal sealed record EventResult
{
    public Guid? Id { get; init; }

    public string? Status { get; init; }

    public string? Error { get; init; }

    public bool? TimeUncertain { get; init; }
}

/// <summary><c>EventsResponse</c>.</summary>
internal sealed record EventsResponse
{
    public IReadOnlyList<EventResult>? Results { get; init; }

    public int? RetryAfterSeconds { get; init; }
}

/// <summary><c>AgentHealth</c>.</summary>
internal sealed record HealthResponse
{
    public string? Status { get; init; }

    public int ProtocolVersion { get; init; }
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
[JsonSerializable(typeof(EventsRequest))]
[JsonSerializable(typeof(EventsResponse))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(ErrorBody))]
internal sealed partial class ProtocolJsonContext : JsonSerializerContext;

/// <summary>Event kinds of the contract (<c>EventKind</c>).</summary>
internal static class EventKinds
{
    public const string ConnectivityLost = "connectivity_lost";
    public const string ConnectivityRestored = "connectivity_restored";
    public const string Shutdown = "shutdown";
    public const string Sleep = "sleep";
    public const string Resume = "resume";
    public const string ServiceStop = "service_stop";
}

/// <summary>Event result statuses of the contract.</summary>
internal static class EventStatuses
{
    public const string Accepted = "accepted";
    public const string Duplicate = "duplicate";
    public const string Rejected = "rejected";
    public const string Deferred = "deferred";
}

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

    /// <summary>Most events in one request.</summary>
    public const int MaxEventsPerRequest = 500;

    /// <summary>Largest request body.</summary>
    public const int MaxBodyBytes = 64 * 1024;

    /// <summary>Longest elapsed time an event may report: 400 days.</summary>
    public const long MaxElapsedMs = 400L * 24 * 60 * 60 * 1000;
}
