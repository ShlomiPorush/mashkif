using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;

namespace Mashkif.Service.Events;

/// <summary>
/// The identity the queue belongs to: the install ID and the server origin
/// of <c>state.json</c>. A record of another binding is never sent.
/// </summary>
internal readonly record struct QueueBinding(Guid InstallId, string ServerOrigin);

/// <summary>An event in the queue, with the local times it was recorded at (never sent).</summary>
internal sealed record QueuedEvent(AgentEvent Event, DateTimeOffset RecordedUtc, long RecordedTimestamp);

/// <summary>
/// One line of <c>queue.jsonl</c>. Every record carries the binding.
/// <list type="bullet">
/// <item><c>event</c>: an event and the local times it was recorded at.</item>
/// <item><c>done</c>: events removed after a final server outcome (accepted, duplicate, rejected).</item>
/// <item><c>drop</c>: events dropped (age, size, an unreadable line) and the new cumulative count of the boot the drop happened in, in one line.</item>
/// <item><c>dropConfirmed</c>: the count of a boot the server confirmed.</item>
/// <item><c>connectivity</c>: the last confirmed connectivity state (written by compaction).</item>
/// </list>
/// </summary>
internal sealed record QueueRecord
{
    public required string Type { get; init; }

    public required Guid InstallId { get; init; }

    public required string ServerOrigin { get; init; }

    public Guid? Id { get; init; }

    public string? Kind { get; init; }

    public Guid? BootId { get; init; }

    public string? SyncId { get; init; }

    public long? ElapsedMs { get; init; }

    public DateTimeOffset? RecordedUtc { get; init; }

    public long? RecordedTimestamp { get; init; }

    public IReadOnlyList<Guid>? Ids { get; init; }

    public long? Count { get; init; }

    public bool? Online { get; init; }
}

/// <summary>Source-generated JSON for the queue lines.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(QueueRecord))]
internal sealed partial class QueueJsonContext : JsonSerializerContext;

/// <summary>
/// The offline queue, <c>%ProgramData%\Mashkif\state\queue.jsonl</c>: one
/// record per line (its JSON, a space, the SHA-256 of the JSON in hex, a line
/// feed), appended and flushed to disk. A torn last line is dropped at load;
/// a bad line elsewhere is dropped and counted. After a failed or partial
/// append the file is cut back to the last valid record before the next
/// write. Compaction writes the live records to <c>queue.jsonl.tmp</c> with
/// the protected DACL and moves it over the file in one step.
/// </summary>
/// <remarks>
/// Only one writer calls the methods that write (<see cref="QueueWriter"/>);
/// the read methods may be called from any thread.
/// </remarks>
internal sealed class EventQueue(string stateDirectory, PathPolicy policy)
{
    public const string FileName = "queue.jsonl";

    public const string TempFileName = "queue.jsonl.tmp";

    /// <summary>Most live events; past it the oldest are dropped first.</summary>
    public const int MaxEvents = 10_000;

    /// <summary>Most boots whose dropped count the server has not confirmed (the server keeps 10).</summary>
    public const int MaxUnconfirmedBoots = 10;

    /// <summary>Removed records that start a compaction.</summary>
    public const long CompactionDeadBytes = 256 * 1024;

    /// <summary>Age after which an event is dropped.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    private const int ChecksumLength = 64;

    private readonly Lock _gate = new();
    private readonly List<(QueuedEvent Item, int Bytes)> _events = [];
    private readonly List<BootCount> _boots = [];
    private QueueBinding? _binding;
    private bool? _lastOnline;
    private long _validLength;
    private long _deadBytes;
    private long _bootOrder;
    private bool _needsRepair;
    private Guid _currentBoot;

    public string FilePath => Path.Combine(stateDirectory, FileName);

    public string TempPath => Path.Combine(stateDirectory, TempFileName);

    /// <summary>Most live events (<see cref="MaxEvents"/>; smaller in tests).</summary>
    public int Capacity { get; init; } = MaxEvents;

    /// <summary>Test hook: runs after the bytes are written and before the flush to disk.</summary>
    internal Action? BeforeFlush { get; set; }

    /// <summary>Test hook: runs after the compacted file is written and before it replaces the queue.</summary>
    internal Action? BeforeReplace { get; set; }

    /// <summary>Called with a message whenever something is dropped or discarded.</summary>
    internal Action<string>? Log { get; set; }

    /// <summary>
    /// The batch for an identity: up to <paramref name="limit"/> of the oldest
    /// events and the oldest unconfirmed dropped count, only when the queue
    /// belongs to <paramref name="expected"/>; otherwise nothing. Checked under
    /// the queue lock, so a batch never mixes in records of another identity.
    /// </summary>
    public (IReadOnlyList<AgentEvent> Events, DroppedEvents? Dropped) Batch(QueueBinding expected, int limit)
    {
        lock (_gate)
        {
            if (_binding != expected)
            {
                return ([], null);
            }

            var boot = _boots.Where(b => b.Total > b.Confirmed).OrderBy(b => b.Order).FirstOrDefault();
            return ([.. _events.Take(limit).Select(e => e.Item.Event)], boot is null ? null : new DroppedEvents { BootId = boot.BootId, Count = boot.Total });
        }
    }

    /// <summary>Whether a write meant for <paramref name="expected"/> may run: the queue still has that binding.</summary>
    private bool Matches(QueueBinding? expected)
    {
        if (expected is null)
        {
            return true;
        }

        lock (_gate)
        {
            if (_binding == expected)
            {
                return true;
            }
        }

        Log?.Invoke("a write for another identity was dropped");
        return false;
    }

    /// <summary>The live events, oldest first.</summary>
    public IReadOnlyList<QueuedEvent> Pending
    {
        get
        {
            lock (_gate)
            {
                return [.. _events.Select(e => e.Item)];
            }
        }
    }

    /// <summary>The last confirmed connectivity state, or null when unknown.</summary>
    public bool? LastOnline
    {
        get
        {
            lock (_gate)
            {
                return _lastOnline;
            }
        }
    }

    /// <summary>The oldest boot whose cumulative dropped count is above what the server confirmed.</summary>
    public DroppedEvents? NextDroppedCount()
    {
        lock (_gate)
        {
            var boot = _boots.Where(b => b.Total > b.Confirmed).OrderBy(b => b.Order).FirstOrDefault();
            return boot is null ? null : new DroppedEvents { BootId = boot.BootId, Count = boot.Total };
        }
    }

    /// <summary>The cumulative dropped count of a boot, for tests and the status.</summary>
    public long DroppedCount(Guid bootId)
    {
        lock (_gate)
        {
            return _boots.FirstOrDefault(b => b.BootId == bootId)?.Total ?? 0;
        }
    }

    /// <summary>
    /// Checks the queue files like <c>state.json</c>, deletes a leftover
    /// temporary file, reads the queue, drops records of another binding,
    /// and compacts. Returns a problem when a file fails its checks.
    /// </summary>
    public string? Load(QueueBinding? binding, Guid currentBoot, DateTimeOffset nowUtc, long nowTimestamp, long frequency)
    {
        var problem = PathSecurity.CheckStateFile(TempPath, policy) ?? PathSecurity.CheckStateFile(FilePath, policy);
        if (problem is not null)
        {
            return problem;
        }

        if (File.Exists(TempPath))
        {
            File.Delete(TempPath);
        }

        lock (_gate)
        {
            _binding = binding;
            _currentBoot = currentBoot;
            _events.Clear();
            _boots.Clear();
            _lastOnline = null;
        }

        var bad = 0;
        if (File.Exists(FilePath))
        {
            var bytes = File.ReadAllBytes(FilePath);
            var start = 0;
            while (start < bytes.Length)
            {
                var end = Array.IndexOf(bytes, (byte)'\n', start);
                if (end < 0)
                {
                    // A torn last line: the write never finished.
                    break;
                }

                var record = Parse(bytes.AsSpan(start, end - start));
                if (record is null)
                {
                    bad++;
                }
                else if (binding is { } b && record.InstallId == b.InstallId && record.ServerOrigin == b.ServerOrigin)
                {
                    Apply(record, end - start + 1);
                }

                start = end + 1;
            }
        }

        if (bad > 0)
        {
            AddDropped(currentBoot, bad);
            Log?.Invoke($"{bad} unreadable queue lines were dropped");
        }

        CompactCore();
        Prune(currentBoot, nowUtc, nowTimestamp, frequency);
        return null;
    }

    /// <summary>
    /// A new identity (Join again): every record of the old one is
    /// discarded. Called after <c>state.json</c> holds the new install ID,
    /// so a crash before this point already leaves the old records ignored.
    /// </summary>
    public void Rebind(QueueBinding? binding)
    {
        lock (_gate)
        {
            _binding = binding;
            _events.Clear();
            _boots.Clear();
            _lastOnline = null;
        }

        CompactCore();
    }

    /// <summary>Appends an event, after dropping expired events and making room under the cap.</summary>
    public void Append(QueuedEvent queued, Guid currentBoot, DateTimeOffset nowUtc, long nowTimestamp, long frequency, QueueBinding? expected = null)
    {
        if (!Matches(expected))
        {
            return;
        }

        var binding = RequireBinding();
        Prune(currentBoot, nowUtc, nowTimestamp, frequency);

        List<QueueRecord> records = [];
        List<Guid> overflow;
        long newCount;
        lock (_gate)
        {
            overflow = [.. _events.Take(Math.Max(0, _events.Count - Capacity + 1)).Select(e => e.Item.Event.Id)];
            newCount = (_boots.FirstOrDefault(b => b.BootId == currentBoot)?.Total ?? 0) + overflow.Count;
        }

        if (overflow.Count > 0)
        {
            records.Add(DropRecord(binding, overflow, currentBoot, newCount));
        }

        var e = queued.Event;
        var eventRecord = new QueueRecord
        {
            Type = RecordTypes.Event,
            InstallId = binding.InstallId,
            ServerOrigin = binding.ServerOrigin,
            Id = e.Id,
            Kind = e.Kind,
            BootId = e.BootId,
            SyncId = e.SyncId,
            ElapsedMs = e.ElapsedMs,
            RecordedUtc = queued.RecordedUtc,
            RecordedTimestamp = queued.RecordedTimestamp,
        };
        records.Add(eventRecord);
        var sizes = Write(records);

        lock (_gate)
        {
            if (overflow.Count > 0)
            {
                _deadBytes += sizes[0] + RemoveLocked(overflow);
                SetTotalLocked(currentBoot, newCount);
                Log?.Invoke($"{overflow.Count} events were dropped because the queue is full");
            }

            _events.Add((queued, sizes[^1]));
            if (IsConnectivity(e.Kind))
            {
                _lastOnline = e.Kind == EventKinds.ConnectivityRestored;
            }
        }

        CompactIfNeeded();
    }

    /// <summary>Removes events after a final server outcome (accepted, duplicate, rejected).</summary>
    public void Complete(IReadOnlyCollection<Guid> ids, QueueBinding? expected = null)
    {
        if (!Matches(expected))
        {
            return;
        }

        if (ids.Count == 0)
        {
            return;
        }

        var binding = RequireBinding();
        List<Guid> present;
        lock (_gate)
        {
            present = [.. ids.Where(id => _events.Any(e => e.Item.Event.Id == id)).Distinct()];
        }

        if (present.Count == 0)
        {
            return;
        }

        var sizes = Write([new QueueRecord { Type = RecordTypes.Done, InstallId = binding.InstallId, ServerOrigin = binding.ServerOrigin, Ids = present }]);
        lock (_gate)
        {
            _deadBytes += sizes[0] + RemoveLocked(present);
        }

        CompactIfNeeded();
    }

    /// <summary>Records the dropped count of a boot that the server confirmed with a 200.</summary>
    public void ConfirmDropped(DroppedEvents confirmed, QueueBinding? expected = null)
    {
        ArgumentNullException.ThrowIfNull(confirmed);
        if (!Matches(expected))
        {
            return;
        }

        var binding = RequireBinding();
        var sizes = Write([new QueueRecord { Type = RecordTypes.DropConfirmed, InstallId = binding.InstallId, ServerOrigin = binding.ServerOrigin, BootId = confirmed.BootId, Count = confirmed.Count }]);
        lock (_gate)
        {
            var boot = _boots.FirstOrDefault(b => b.BootId == confirmed.BootId);
            if (boot is not null)
            {
                boot.Confirmed = Math.Max(boot.Confirmed, confirmed.Count);
            }

            _deadBytes += sizes[0];
        }

        CompactIfNeeded();
    }

    /// <summary>
    /// Drops events older than <see cref="MaxAge"/>: by the monotonic reading
    /// within their own boot, by the recorded UTC time for other boots. The
    /// removal and the new count of <paramref name="currentBoot"/> are one line.
    /// </summary>
    public void Prune(Guid currentBoot, DateTimeOffset nowUtc, long nowTimestamp, long frequency)
    {
        if (_binding is not { } binding)
        {
            return;
        }

        List<Guid> expired;
        long newCount;
        lock (_gate)
        {
            expired = [.. _events.Where(e => IsExpired(e.Item, currentBoot, nowUtc, nowTimestamp, frequency)).Select(e => e.Item.Event.Id)];
            if (expired.Count == 0)
            {
                return;
            }

            newCount = (_boots.FirstOrDefault(b => b.BootId == currentBoot)?.Total ?? 0) + expired.Count;
        }

        var sizes = Write([DropRecord(binding, expired, currentBoot, newCount)]);
        lock (_gate)
        {
            _deadBytes += sizes[0] + RemoveLocked(expired);
            SetTotalLocked(currentBoot, newCount);
        }

        Log?.Invoke($"{expired.Count} events older than {MaxAge.TotalDays} days were dropped");
        CompactIfNeeded();
    }

    /// <summary>
    /// An event that could not be written (for example a full disk) is lost;
    /// it counts as dropped in memory only.
    /// </summary>
    public void CountLostInMemory(Guid currentBoot)
    {
        lock (_gate)
        {
            AddDroppedLocked(currentBoot, 1);
        }
    }

    private static bool IsExpired(QueuedEvent queued, Guid currentBoot, DateTimeOffset nowUtc, long nowTimestamp, long frequency)
    {
        if (queued.Event.BootId == currentBoot && nowTimestamp >= queued.RecordedTimestamp)
        {
            return (nowTimestamp - queued.RecordedTimestamp) / (double)frequency > MaxAge.TotalSeconds;
        }

        return nowUtc - queued.RecordedUtc > MaxAge;
    }

    private static bool IsConnectivity(string? kind) =>
        kind is EventKinds.ConnectivityLost or EventKinds.ConnectivityRestored;

    private QueueBinding RequireBinding() =>
        _binding ?? throw new InvalidOperationException("The queue has no binding.");

    private static QueueRecord DropRecord(QueueBinding binding, IReadOnlyList<Guid> ids, Guid boot, long count) => new()
    {
        Type = RecordTypes.Drop,
        InstallId = binding.InstallId,
        ServerOrigin = binding.ServerOrigin,
        Ids = ids,
        BootId = boot,
        Count = count,
    };

    private void Apply(QueueRecord record, int bytes)
    {
        lock (_gate)
        {
            switch (record.Type)
            {
                case RecordTypes.Event when record.Id is { } id && record.Kind is { } kind && record.BootId is { } bootId && record.RecordedUtc is { } utc && record.RecordedTimestamp is { } ts:
                    if (_events.All(e => e.Item.Event.Id != id))
                    {
                        _events.Add((new QueuedEvent(new AgentEvent { Id = id, Kind = kind, BootId = bootId, SyncId = record.SyncId, ElapsedMs = record.ElapsedMs }, utc, ts), bytes));
                    }

                    if (IsConnectivity(kind))
                    {
                        _lastOnline = kind == EventKinds.ConnectivityRestored;
                    }

                    break;
                case RecordTypes.Done when record.Ids is { } ids:
                    _deadBytes += bytes + RemoveLocked(ids);
                    break;
                case RecordTypes.Drop when record.BootId is { } boot && record.Count is { } count:
                    _deadBytes += bytes + RemoveLocked(record.Ids ?? []);
                    SetTotalLocked(boot, count);
                    break;
                case RecordTypes.DropConfirmed when record.BootId is { } boot && record.Count is { } count:
                    var entry = BootLocked(boot);
                    entry.Confirmed = Math.Max(entry.Confirmed, count);
                    _deadBytes += bytes;
                    break;
                case RecordTypes.Connectivity when record.Online is { } online:
                    _lastOnline = online;
                    break;
            }
        }
    }

    private int RemoveLocked(IEnumerable<Guid> ids)
    {
        var set = ids.ToHashSet();
        var freed = 0;
        _events.RemoveAll(e =>
        {
            if (!set.Contains(e.Item.Event.Id))
            {
                return false;
            }

            freed += e.Bytes;
            return true;
        });
        return freed;
    }

    private BootCount BootLocked(Guid bootId)
    {
        var boot = _boots.FirstOrDefault(b => b.BootId == bootId);
        if (boot is null)
        {
            boot = new BootCount { BootId = bootId, Order = ++_bootOrder };
            _boots.Add(boot);
        }

        return boot;
    }

    private void SetTotalLocked(Guid bootId, long total)
    {
        var boot = BootLocked(bootId);
        boot.Total = Math.Max(boot.Total, total);
        TrimUnconfirmedLocked();
    }

    private void AddDropped(Guid bootId, long count)
    {
        lock (_gate)
        {
            AddDroppedLocked(bootId, count);
        }
    }

    private void AddDroppedLocked(Guid bootId, long count)
    {
        var boot = BootLocked(bootId);
        boot.Total += count;
        TrimUnconfirmedLocked();
    }

    /// <summary>Keeps at most <see cref="MaxUnconfirmedBoots"/> boots with unconfirmed counts; the oldest goes.</summary>
    private void TrimUnconfirmedLocked()
    {
        var unconfirmed = _boots.Where(b => b.Total > b.Confirmed).OrderBy(b => b.Order).ToList();
        foreach (var boot in unconfirmed.Take(Math.Max(0, unconfirmed.Count - MaxUnconfirmedBoots)))
        {
            _boots.Remove(boot);
            Log?.Invoke($"The dropped count of boot {boot.BootId} was discarded: more than {MaxUnconfirmedBoots} boots wait for confirmation");
        }
    }

    private void CompactIfNeeded()
    {
        bool compact;
        lock (_gate)
        {
            compact = _deadBytes > CompactionDeadBytes || (_validLength > 0 && _deadBytes * 2 > _validLength);
        }

        if (!compact)
        {
            return;
        }

        try
        {
            CompactCore();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The record before it is already on disk: a failed compaction is not a failed
            // write, and the queue stays valid (a leftover temporary file is deleted later).
            Log?.Invoke($"compaction failed ({exception.GetType().Name}); tried again later");
        }
    }

    /// <summary>Writes the live records and the summaries to the temporary file, then moves it over the queue.</summary>
    private void CompactCore()
    {
        List<QueueRecord> records = [];
        lock (_gate)
        {
            if (_binding is { } binding)
            {
                // The cumulative and confirmed dropped count of every boot kept.
                foreach (var boot in _boots.OrderBy(b => b.Order))
                {
                    records.Add(new QueueRecord { Type = RecordTypes.Drop, InstallId = binding.InstallId, ServerOrigin = binding.ServerOrigin, BootId = boot.BootId, Count = boot.Total });
                    if (boot.Confirmed > 0)
                    {
                        records.Add(new QueueRecord { Type = RecordTypes.DropConfirmed, InstallId = binding.InstallId, ServerOrigin = binding.ServerOrigin, BootId = boot.BootId, Count = boot.Confirmed });
                    }
                }

                if (_lastOnline is { } online)
                {
                    records.Add(new QueueRecord { Type = RecordTypes.Connectivity, InstallId = binding.InstallId, ServerOrigin = binding.ServerOrigin, Online = online });
                }

                foreach (var (item, _) in _events)
                {
                    var e = item.Event;
                    records.Add(new QueueRecord
                    {
                        Type = RecordTypes.Event,
                        InstallId = binding.InstallId,
                        ServerOrigin = binding.ServerOrigin,
                        Id = e.Id,
                        Kind = e.Kind,
                        BootId = e.BootId,
                        SyncId = e.SyncId,
                        ElapsedMs = e.ElapsedMs,
                        RecordedUtc = item.RecordedUtc,
                        RecordedTimestamp = item.RecordedTimestamp,
                    });
                }
            }
        }

        var lines = records.Select(Encode).ToList();
        var bytes = lines.SelectMany(l => l).ToArray();
        if (File.Exists(TempPath))
        {
            File.Delete(TempPath);
        }

        using (var stream = new FileInfo(TempPath).Create(
                   FileMode.CreateNew,
                   FileSystemRights.Write | FileSystemRights.Read,
                   FileShare.None,
                   bufferSize: 4096,
                   FileOptions.WriteThrough,
                   policy.CreateStateFileSecurity()))
        {
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }

        BeforeReplace?.Invoke();
        File.Move(TempPath, FilePath, overwrite: true);

        lock (_gate)
        {
            _validLength = bytes.Length;
            _deadBytes = 0;
            _needsRepair = false;
            var eventLines = lines.Skip(lines.Count - _events.Count).ToList();
            for (var i = 0; i < _events.Count; i++)
            {
                _events[i] = (_events[i].Item, eventLines[i].Length);
            }

            // A past boot whose count the server confirmed in full cannot grow any more; the current boot can.
            _boots.RemoveAll(b => b.Confirmed >= b.Total && b.BootId != _currentBoot);
        }
    }

    /// <summary>
    /// Appends the records and flushes them to disk. After a failure the
    /// file is cut back to the last valid record before the next write.
    /// </summary>
    private int[] Write(IReadOnlyList<QueueRecord> records)
    {
        var lines = records.Select(Encode).ToList();
        var bytes = lines.SelectMany(l => l).ToArray();
        long offset;
        bool repair;
        lock (_gate)
        {
            offset = _validLength;
            repair = _needsRepair;
        }

        try
        {
            using var stream = OpenForAppend();
            if (repair || stream.Length != offset)
            {
                stream.SetLength(offset);
            }

            stream.Seek(offset, SeekOrigin.Begin);
            stream.Write(bytes);
            BeforeFlush?.Invoke();
            stream.Flush(flushToDisk: true);
        }
        catch
        {
            lock (_gate)
            {
                _needsRepair = true;
            }

            throw;
        }

        lock (_gate)
        {
            _validLength = offset + bytes.Length;
            _needsRepair = false;
        }

        return [.. lines.Select(l => l.Length)];
    }

    private FileStream OpenForAppend()
    {
        if (!File.Exists(FilePath))
        {
            return new FileInfo(FilePath).Create(
                FileMode.CreateNew,
                FileSystemRights.Write | FileSystemRights.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.WriteThrough,
                policy.CreateStateFileSecurity());
        }

        return new FileStream(FilePath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read, bufferSize: 4096, FileOptions.WriteThrough);
    }

    internal static byte[] Encode(QueueRecord record)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(record, QueueJsonContext.Default.QueueRecord);
        var checksum = Encoding.ASCII.GetBytes(Convert.ToHexStringLower(SHA256.HashData(json)));
        var line = new byte[json.Length + 1 + checksum.Length + 1];
        json.CopyTo(line, 0);
        line[json.Length] = (byte)' ';
        checksum.CopyTo(line, json.Length + 1);
        line[^1] = (byte)'\n';
        return line;
    }

    internal static QueueRecord? Parse(ReadOnlySpan<byte> line)
    {
        if (line.Length < ChecksumLength + 2 || line[^(ChecksumLength + 1)] != (byte)' ')
        {
            return null;
        }

        var json = line[..^(ChecksumLength + 1)];
        var checksum = Encoding.ASCII.GetString(line[^ChecksumLength..]);
        if (!string.Equals(checksum, Convert.ToHexStringLower(SHA256.HashData(json)), StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(json, QueueJsonContext.Default.QueueRecord);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed class BootCount
    {
        public required Guid BootId { get; init; }

        public long Total { get; set; }

        public long Confirmed { get; set; }

        public required long Order { get; init; }
    }

    private static class RecordTypes
    {
        public const string Event = "event";
        public const string Done = "done";
        public const string Drop = "drop";
        public const string DropConfirmed = "dropConfirmed";
        public const string Connectivity = "connectivity";
    }
}
