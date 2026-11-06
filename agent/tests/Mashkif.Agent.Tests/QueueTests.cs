using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Mashkif.Agent.Tests.Support;
using Mashkif.Service.Events;
using Mashkif.Service.Protocol;
using Mashkif.Service.State;

namespace Mashkif.Agent.Tests;

/// <summary>The offline queue file (step 2c): format, binding, limits, counts, and crash safety.</summary>
public sealed class QueueTests : IDisposable
{
    private const long Frequency = 10_000_000;
    private static readonly DateTimeOffset Now = new(2026, 11, 5, 8, 0, 0, TimeSpan.Zero);
    private static readonly Guid Boot = Guid.Parse("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    private static readonly Guid OtherBoot = Guid.Parse("2b4c6d8e-0a1b-4c3d-8e5f-6a7b8c9d0e1f");
    private static readonly QueueBinding Binding = new(EngineFixture.InstallId, EngineFixture.Origin);

    private readonly StateFixture _f = new();

    public void Dispose() => _f.Dispose();

    private EventQueue Open(QueueBinding? binding = null, int capacity = EventQueue.MaxEvents, DateTimeOffset? now = null, long timestamp = 1_000)
    {
        var queue = new EventQueue(_f.StateDirectory, _f.Policy) { Capacity = capacity };
        Assert.Null(queue.Load(binding ?? Binding, Boot, now ?? Now, timestamp, Frequency));
        return queue;
    }

    private static QueuedEvent Event(string kind = EventKinds.ConnectivityLost, Guid? boot = null, DateTimeOffset? at = null, long timestamp = 1_000) =>
        new(new AgentEvent { Id = Guid.NewGuid(), Kind = kind, BootId = boot ?? Boot, SyncId = "sync-1", ElapsedMs = 42 }, at ?? Now, timestamp);

    private static void Append(EventQueue queue, QueuedEvent e, DateTimeOffset? now = null, long timestamp = 1_000) =>
        queue.Append(e, Boot, now ?? Now, timestamp, Frequency);

    [Fact]
    public void Appended_events_read_back_in_order_with_their_fields()
    {
        var queue = Open();
        var a = Event();
        var b = Event(EventKinds.ConnectivityRestored);
        Append(queue, a);
        Append(queue, b);

        var again = Open();
        Assert.Equal([a.Event, b.Event], again.Pending.Select(p => p.Event));
        Assert.Equal(Now, again.Pending[0].RecordedUtc);
        Assert.True(again.LastOnline);
    }

    [Fact]
    public void Every_line_is_JSON_a_space_and_its_SHA_256_and_holds_the_binding()
    {
        var queue = Open();
        Append(queue, Event());
        var line = File.ReadAllLines(queue.FilePath).Single();
        Assert.Matches(@"^\{.*\} [0-9a-f]{64}$", line);
        Assert.Contains(EngineFixture.InstallId.ToString(), line, StringComparison.Ordinal);
        Assert.Contains(EngineFixture.Origin, line, StringComparison.Ordinal);
        Assert.NotNull(EventQueue.Parse(Encoding.UTF8.GetBytes(line)));
    }

    [Fact]
    public void Records_of_another_binding_are_never_loaded_and_compaction_removes_them()
    {
        var queue = Open();
        Append(queue, Event());

        var other = Open(new QueueBinding(Guid.NewGuid(), EngineFixture.Origin));
        Assert.Empty(other.Pending);
        Assert.Empty(Open().Pending);

        var otherServer = Open(new QueueBinding(EngineFixture.InstallId, "https://other.test"));
        Assert.Empty(otherServer.Pending);
    }

    [Fact]
    public void Rebind_discards_every_record_of_the_old_identity()
    {
        var queue = Open();
        Append(queue, Event());
        var rejoined = new QueueBinding(Guid.NewGuid(), EngineFixture.Origin);
        queue.Rebind(rejoined);
        Assert.Empty(queue.Pending);
        Assert.Empty(Open(rejoined).Pending);
        Assert.Empty(Open().Pending);
    }

    [Fact]
    public void A_torn_last_line_is_dropped_without_counting_and_a_bad_line_in_the_middle_is_counted()
    {
        var queue = Open();
        var a = Event();
        var b = Event();
        Append(queue, a);
        Append(queue, b);
        var lines = File.ReadAllLines(queue.FilePath);

        // A bad checksum in the middle, a valid line, and a torn last line.
        var broken = lines[0][..^1] + (lines[0][^1] == '0' ? '1' : '0');
        File.WriteAllText(queue.FilePath, broken + "\n" + lines[1] + "\n" + "{\"type\":\"event\"");

        var again = Open();
        Assert.Equal([b.Event], again.Pending.Select(p => p.Event));
        Assert.Equal(1, again.DroppedCount(Boot));
        Assert.Equal(new DroppedEvents { BootId = Boot, Count = 1 }, again.NextDroppedCount());
    }

    [Fact]
    public void After_a_failed_append_the_file_is_cut_back_to_the_last_valid_record_before_the_next_write()
    {
        var queue = Open();
        var a = Event();
        var lost = Event();
        var c = Event();
        Append(queue, a);
        queue.BeforeFlush = () => throw new IOException("disk full");
        Assert.Throws<IOException>(() => Append(queue, lost));
        queue.BeforeFlush = null;
        Append(queue, c);

        Assert.Equal([a.Event, c.Event], Open().Pending.Select(p => p.Event));
        Assert.All(File.ReadAllLines(queue.FilePath), line => Assert.NotNull(EventQueue.Parse(Encoding.UTF8.GetBytes(line))));
    }

    [Fact]
    public void A_compaction_interrupted_before_the_move_leaves_the_queue_and_the_leftover_is_deleted()
    {
        var queue = Open();
        var a = Event();
        Append(queue, a);
        queue.BeforeReplace = () => throw new IOException("power cut");
        Assert.Throws<IOException>(() => queue.Rebind(Binding));
        Assert.True(File.Exists(queue.TempPath));

        var again = Open();
        Assert.False(File.Exists(again.TempPath));
        Assert.Equal([a.Event], again.Pending.Select(p => p.Event));
    }

    [Fact]
    public void Past_the_cap_the_oldest_are_dropped_first_and_counted_in_the_same_line()
    {
        var queue = Open(capacity: 3);
        var events = Enumerable.Range(0, 5).Select(_ => Event()).ToList();
        foreach (var e in events)
        {
            Append(queue, e);
        }

        Assert.Equal(events.Skip(2).Select(e => e.Event), queue.Pending.Select(p => p.Event));
        Assert.Equal(2, queue.DroppedCount(Boot));
        Assert.Contains(File.ReadAllLines(queue.FilePath), line => line.Contains("\"type\":\"drop\"", StringComparison.Ordinal) && line.Contains(events[1].Event.Id.ToString(), StringComparison.Ordinal) && line.Contains("\"count\":2", StringComparison.Ordinal));

        var again = Open(capacity: 3);
        Assert.Equal(2, again.DroppedCount(Boot));
    }

    [Fact]
    public void Events_older_than_seven_days_are_dropped_by_the_monotonic_clock_in_their_boot_and_by_UTC_otherwise()
    {
        var queue = Open();
        var sameBoot = Event(timestamp: 1_000);
        var otherBoot = Event(boot: OtherBoot, at: Now);
        Append(queue, sameBoot);
        Append(queue, otherBoot);

        // The wall clock was set back: only the monotonic clock says 8 days passed.
        var eightDays = 1_000 + (long)TimeSpan.FromDays(8).TotalSeconds * Frequency;
        queue.Prune(Boot, Now - TimeSpan.FromDays(1), eightDays, Frequency);
        Assert.Equal([otherBoot.Event], queue.Pending.Select(p => p.Event));

        queue.Prune(Boot, Now + TimeSpan.FromDays(8), eightDays, Frequency);
        Assert.Empty(queue.Pending);
        Assert.Equal(2, queue.DroppedCount(Boot));
        Assert.Equal(2, Open(now: Now + TimeSpan.FromDays(8), timestamp: eightDays).DroppedCount(Boot));
    }

    [Fact]
    public void A_dropped_count_keeps_growing_after_the_server_confirmed_it_also_across_a_restart_and_compaction()
    {
        var queue = Open(capacity: 1);
        Append(queue, Event());
        Append(queue, Event());
        Assert.Equal(new DroppedEvents { BootId = Boot, Count = 1 }, queue.NextDroppedCount());
        queue.ConfirmDropped(new DroppedEvents { BootId = Boot, Count = 1 });
        Assert.Null(queue.NextDroppedCount());

        var again = Open(capacity: 1); // a restart, which compacts
        Assert.Null(again.NextDroppedCount());
        Append(again, Event());
        Assert.Equal(new DroppedEvents { BootId = Boot, Count = 2 }, again.NextDroppedCount());
        Assert.Equal(2, Open(capacity: 1).DroppedCount(Boot));
    }

    [Fact]
    public void At_most_ten_boots_wait_for_confirmation_and_the_eleventh_discards_the_oldest()
    {
        var boots = Enumerable.Range(0, 11).Select(_ => Guid.NewGuid()).ToList();
        foreach (var boot in boots)
        {
            var queue = new EventQueue(_f.StateDirectory, _f.Policy) { Capacity = 1 };
            Assert.Null(queue.Load(Binding, boot, Now, 1_000, Frequency));
            queue.Append(Event(boot: boot), boot, Now, 1_000, Frequency);
            queue.Append(Event(boot: boot), boot, Now, 1_000, Frequency);
        }

        var last = Open();
        Assert.Equal(0, last.DroppedCount(boots[0]));
        Assert.Equal(boots[1], last.NextDroppedCount()!.BootId);

        // Each later boot drops the event left by the boot before it, then its own first one.
        Assert.Equal(2, last.DroppedCount(boots[10]));
    }

    [Fact]
    public void Removed_events_are_not_loaded_again()
    {
        var queue = Open();
        var a = Event();
        var b = Event();
        Append(queue, a);
        Append(queue, b);
        queue.Complete([a.Event.Id]);
        Assert.Equal([b.Event], Open().Pending.Select(p => p.Event));
    }

    [Fact]
    public void The_queue_and_its_compacted_replacement_have_the_protected_DACL()
    {
        var queue = Open();
        Append(queue, Event());
        AssertStateDacl(queue.FilePath);

        queue.Rebind(Binding); // a compaction replaces the file
        AssertStateDacl(queue.FilePath);
    }

    [Fact]
    public void A_queue_file_another_account_can_read_is_refused_and_left_untouched()
    {
        var queue = Open();
        Append(queue, Event());
        var security = new FileInfo(queue.FilePath).GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Read, AccessControlType.Allow));
        new FileInfo(queue.FilePath).SetAccessControl(security);
        var before = File.ReadAllBytes(queue.FilePath);

        var refused = new EventQueue(_f.StateDirectory, _f.Policy);
        Assert.NotNull(refused.Load(Binding, Boot, Now, 1_000, Frequency));
        Assert.Equal(before, File.ReadAllBytes(queue.FilePath));
    }

    [Fact]
    public void A_leftover_temporary_file_another_account_can_read_is_refused()
    {
        var queue = Open();
        File.WriteAllText(queue.TempPath, string.Empty);
        var security = new FileInfo(queue.TempPath).GetAccessControl();
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Read, AccessControlType.Allow));
        new FileInfo(queue.TempPath).SetAccessControl(security);
        Assert.NotNull(new EventQueue(_f.StateDirectory, _f.Policy).Load(Binding, Boot, Now, 1_000, Frequency));
    }

    [Fact]
    public void No_token_ever_reaches_the_queue()
    {
        var queue = Open();
        Append(queue, Event());
        Assert.DoesNotContain(EngineFixture.SeededToken, File.ReadAllText(queue.FilePath), StringComparison.Ordinal);
    }

    private static void AssertStateDacl(string path)
    {
        var acl = new FileInfo(path).GetAccessControl();
        Assert.True(acl.AreAccessRulesProtected);
        var sids = acl.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(r => ((SecurityIdentifier)r.IdentityReference).Value)
            .ToHashSet();
        Assert.Equal(
            new HashSet<string> { PathPolicy.LocalSystem.Value, PathPolicy.Administrators.Value, StateFixture.CurrentUser.Value, PathPolicy.OwnerRights.Value },
            sids);
    }
}
