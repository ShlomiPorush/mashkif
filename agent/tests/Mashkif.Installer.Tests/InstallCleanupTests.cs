using System.ComponentModel;
using static Mashkif.Install.Tests.CleanupLogic;

namespace Mashkif.Installer.Tests;

/// <summary>
/// The cleanup logic of the install tests (CleanupLogic.cs, linked), run
/// against a fake machine: no process starts and nothing is installed.
/// </summary>
public sealed class InstallCleanupTests
{
    private const string Cached = @"""C:\ProgramData\Package Cache\{B1}\Mashkif.exe"" /uninstall /quiet";

    [Fact]
    public void A_partial_registration_without_an_uninstall_string_is_reported_and_cleanup_goes_on()
    {
        var fake = new FakeMachine
        {
            Bundles = [new BundleEntry("{A1}", null), new BundleEntry("{B1}", Cached)],
            Products = ["{P1}"],
            UserCreated = true,
        };

        var failures = CleanUp(fake.Build());

        // The complete entry, the product, and the user are still removed.
        Assert.Contains(@"C:\ProgramData\Package Cache\{B1}\Mashkif.exe /uninstall /quiet /norestart", fake.Runs);
        Assert.Contains("msiexec.exe /x {P1} /qn /norestart", fake.Runs);
        Assert.Contains("net.exe user mashkif-install-test /delete", fake.Runs);
        Assert.Contains(failures, f => f.StartsWith("uninstall the EXE {A1}: it has no QuietUninstallString", StringComparison.Ordinal));

        // The partial entry is still registered, so no data is deleted, and the
        // leftovers are reported with the failures.
        Assert.False(fake.DataDeleted);
        Assert.Contains(failures, f => f.Contains("Mashkif is still installed", StringComparison.Ordinal));
        Assert.Contains("leftover", failures);
    }

    [Fact]
    public void A_step_that_throws_is_reported_and_the_other_steps_still_run()
    {
        var fake = new FakeMachine
        {
            Bundles = [new BundleEntry("{B1}", Cached)],
            Products = ["{P1}"],
            UserCreated = true,
            Throw = file => file.EndsWith("Mashkif.exe", StringComparison.Ordinal) ? new Win32Exception(2, "The system cannot find the file specified.") : null,
        };

        var failures = CleanUp(fake.Build());

        Assert.Contains(failures, f => f.StartsWith("uninstall the EXE {B1}: Win32Exception:", StringComparison.Ordinal));
        Assert.Contains("msiexec.exe /x {P1} /qn /norestart", fake.Runs);
        Assert.Contains("net.exe user mashkif-install-test /delete", fake.Runs);
        Assert.False(fake.DataDeleted);
    }

    [Fact]
    public void A_registry_that_cannot_be_read_blocks_the_data_deletion_but_not_the_product_removal()
    {
        var fake = new FakeMachine { Products = ["{P1}"], ThrowOnBundles = true };

        var failures = CleanUp(fake.Build());

        Assert.Contains(failures, f => f.StartsWith("list the registered Mashkif EXEs:", StringComparison.Ordinal));
        Assert.Contains("msiexec.exe /x {P1} /qn /norestart", fake.Runs);
        Assert.Contains(failures, f => f.Contains("the install state could not be read", StringComparison.Ordinal));
        Assert.False(fake.DataDeleted);
    }

    [Fact]
    public void A_bundle_key_without_BundleUpgradeCode_blocks_the_data_deletion()
    {
        // Burn stopped before it wrote BundleUpgradeCode: the key is invisible
        // to BundleEntries and is found only by its bundle code.
        var fake = new FakeMachine { Products = ["{P1}"], KnownKeys = ["{B1}"], NoLeftovers = true };

        var failures = CleanUp(fake.Build());

        Assert.Contains("msiexec.exe /x {P1} /qn /norestart", fake.Runs);
        Assert.Contains(failures, f => f.Contains("Mashkif is still installed", StringComparison.Ordinal));
        Assert.False(fake.DataDeleted);
    }

    [Fact]
    public void A_timeout_blocks_the_data_deletion()
    {
        var fake = new FakeMachine { Products = ["{P1}"], TimedOut = true };

        var failures = CleanUp(fake.Build());

        Assert.Contains("msiexec.exe /x {P1} /qn /norestart", fake.Runs);
        Assert.Contains(failures, f => f.Contains("a run timed out", StringComparison.Ordinal));
        Assert.False(fake.DataDeleted);
    }

    [Fact]
    public void A_clean_removal_deletes_the_data_and_reports_nothing()
    {
        var fake = new FakeMachine { Bundles = [new BundleEntry("{B1}", Cached)], Products = ["{P1}"], NoLeftovers = true };

        var failures = CleanUp(fake.Build());

        Assert.Empty(failures);
        Assert.True(fake.DataDeleted);
        Assert.DoesNotContain("net.exe user mashkif-install-test /delete", fake.Runs);
    }

    [Fact]
    public void The_failure_of_the_test_body_stays_the_primary_error()
    {
        var body = new InvalidOperationException("the body failed");

        Assert.Null(Outcome(null, []));
        Assert.Same(body, Outcome(body, []));

        var both = Outcome(body, ["a leftover"]);
        Assert.NotNull(both);
        Assert.Same(body, both.InnerException);
        Assert.StartsWith("the body failed", both.Message, StringComparison.Ordinal);
        Assert.Contains("a leftover", both.Message, StringComparison.Ordinal);

        var cleanupOnly = Outcome(null, ["a leftover"]);
        Assert.NotNull(cleanupOnly);
        Assert.Contains("a leftover", cleanupOnly.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_registered_uninstall_string_gets_norestart()
    {
        var command = QuietUninstallCommand(Cached);
        Assert.NotNull(command);
        Assert.Equal(@"C:\ProgramData\Package Cache\{B1}\Mashkif.exe", command.Value.File);
        Assert.Equal(["/uninstall", "/quiet", "/norestart"], command.Value.Arguments);
        Assert.Null(QuietUninstallCommand(null));
        Assert.Null(QuietUninstallCommand(" "));
    }

    /// <summary>
    /// A machine in memory: uninstalls remove the entry, msiexec /x removes the
    /// product, and an entry without an uninstall string stays registered.
    /// </summary>
    private sealed class FakeMachine
    {
        public List<BundleEntry> Bundles { get; init; } = [];

        public List<string> Products { get; init; } = [];

        public bool UserCreated { get; init; }

        public bool TimedOut { get; init; }

        public bool ThrowOnBundles { get; init; }

        public bool NoLeftovers { get; init; }

        /// <summary>Uninstall keys of the bundles under test, found by code (they may lack BundleUpgradeCode).</summary>
        public List<string> KnownKeys { get; init; } = [];

        public Func<string, Exception?> Throw { get; init; } = _ => null;

        public List<string> Runs { get; } = [];

        public bool DataDeleted { get; private set; }

        public Machine Build() => new(
            BundleEntries: () => ThrowOnBundles ? throw new UnauthorizedAccessException("registry denied") : [.. Bundles],
            ProductCodes: () => [.. Products],
            KnownBundleKeys: () => [.. KnownKeys],
            Run: RunFake,
            UserCreated: UserCreated,
            TestUser: "mashkif-install-test",
            TimedOut: () => TimedOut,
            DeleteData: () => DataDeleted = true,
            Leftovers: () => NoLeftovers || (Bundles.Count == 0 && Products.Count == 0) ? [] : ["leftover"]);

        private RunResult RunFake(string file, string[] arguments)
        {
            if (Throw(file) is { } exception)
            {
                throw exception;
            }

            Runs.Add($"{file} {string.Join(' ', arguments)}");
            if (file == "msiexec.exe")
            {
                Products.Remove(arguments[1]);
            }
            else if (file.EndsWith("Mashkif.exe", StringComparison.Ordinal))
            {
                Bundles.RemoveAll(b => b.QuietUninstallString is not null && file == QuietUninstallCommand(b.QuietUninstallString)!.Value.File);
            }

            return new RunResult(0, string.Empty, TimedOut: false);
        }
    }
}
