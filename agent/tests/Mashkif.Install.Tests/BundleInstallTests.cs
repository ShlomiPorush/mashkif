using Mashkif.Common.Pipe;
using WixToolset.Dtf.WindowsInstaller;

namespace Mashkif.Install.Tests;

/// <summary>
/// The EXE installer on a disposable runner: its lifecycle (T2) and every mix
/// with the MSI (T3a to T3h). Every run points the agent at the loopback API,
/// passed as SERVER_URL or remembered by the MSI, never at the real server.
/// The mixed scenarios pin what Windows Installer and Burn do, so a change is
/// noticed; the README supports T2, T3c, T3e, and T3f and says "do not mix" for
/// the rest.
/// </summary>
public sealed partial class InstallTests
{
    private static string BundleData => RequiredFolder("MASHKIF_TEST_BUNDLE_BA");

    private static string UpgradeBundleData => RequiredFolder("MASHKIF_TEST_UPGRADE_BUNDLE_BA");

    [Fact]
    public async Task Exe_installs_repairs_upgrades_refuses_a_downgrade_and_uninstalls_with_one_Apps_and_Features_entry()
    {
        Assert.True(gate.Passed);
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var upgradeExe = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_EXE");
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var upgradeMsi = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_MSI");
        var logs = LogFolder("exe");

        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();

            // 1. Install quietly with the loopback server: one Apps and Features
            //    entry, the EXE's; the MSI is hidden; the token is in no log.
            var installLog = Path.Combine(logs, "install.log");
            Exe(exe, "/quiet", "/norestart", "/log", installLog, $"SERVER_URL={api.Origin}");
            await WaitForStatusAsync(AgentStates.Connected);
            AssertAcls();
            var registration = api.Registrations.Single();
            var identity = Identity();

            var bundle = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.Equal(InstallSafetyGate.BundleCode(BundleData), bundle.Code, ignoreCase: true);
            Assert.Equal("0.1.0", bundle.DisplayVersion);
            Assert.Equal(bundle.Code, Assert.Single(VisibleEntries()), ignoreCase: true);
            var product = Assert.Single(Products());
            Assert.True(InstallSafetyGate.ProductHidden(product.ProductCode));

            var bundleCache = Path.Combine(InstallSafetyGate.PackageCache, bundle.Code);
            Assert.Equal(Path.Combine(bundleCache, "Mashkif.exe"), bundle.BundleCachePath, ignoreCase: true);
            var msiCache = Path.Combine(InstallSafetyGate.PackageCache, InstallSafetyGate.MsiCacheId(msi));
            Assert.True(Directory.Exists(msiCache), $"{msiCache} is missing");
            Record($"Package Cache after the EXE install: bundle {Megabytes(FolderSize(bundleCache))}, MSI {Megabytes(FolderSize(msiCache))}");

            // Burn writes the MSI log next to the bundle log.
            var installLogs = Directory.GetFiles(logs, "install*.log");
            Assert.True(installLogs.Length >= 2, $"No MSI log next to {installLog}: {string.Join(", ", installLogs)}");
            AssertTokenAbsent(registration.Token, [.. installLogs, ServiceLog]);

            // 2. Repair keeps the identity, the ACLs, and the server URL.
            Exe(exe, "/repair", "/quiet", "/norestart", "/log", Path.Combine(logs, "repair.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            AssertAcls();
            Assert.Equal(identity, Identity());
            Assert.Equal(api.Origin, ServerUrlValue());

            // 3. A newer EXE without SERVER_URL replaces the old EXE and MSI and
            //    keeps the remembered server URL and the identity.
            var oldCache = Path.GetDirectoryName(bundle.BundleCachePath)!;
            Exe(upgradeExe, "/quiet", "/norestart", "/log", Path.Combine(logs, "upgrade.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var upgraded = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.Equal(InstallSafetyGate.BundleCode(UpgradeBundleData), upgraded.Code, ignoreCase: true);
            Assert.Equal("0.1.1", upgraded.DisplayVersion);
            Assert.False(Directory.Exists(oldCache), $"{oldCache} is left after the upgrade");
            Assert.Equal(upgraded.Code, Assert.Single(VisibleEntries()), ignoreCase: true);
            Assert.Equal("0.1.1", VersionOf(Assert.Single(Products())));
            Assert.Equal(api.Origin, ServerUrlValue());
            Assert.Equal(identity, Identity());
            Assert.Single(api.Registrations);

            // 4. The older EXE refuses the downgrade and changes nothing.
            var downgrade = TryRun(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "downgrade.log"));
            Assert.False(downgrade.TimedOut, "the downgrade timed out");
            Assert.NotEqual(0, downgrade.ExitCode);
            Assert.Equal("0.1.1", Assert.Single(InstallSafetyGate.BundleEntries()).DisplayVersion);
            Assert.Equal("0.1.1", VersionOf(Assert.Single(Products())));

            // 5. The registered quiet uninstall (with /norestart) removes the EXE,
            //    the MSI, and their cache; the state stays.
            var cache = Path.GetDirectoryName(upgraded.BundleCachePath)!;
            var upgradeMsiCache = Path.Combine(InstallSafetyGate.PackageCache, InstallSafetyGate.MsiCacheId(upgradeMsi));
            var uninstall = QuietUninstall(upgraded);
            Assert.True(uninstall.Succeeded, $"uninstall exited with {uninstall.ExitCode}: {uninstall.Output}");
            await WaitUntilAsync(() => !ServiceExists(), "the service is removed");
            Assert.Empty(InstallSafetyGate.BundleEntries());
            Assert.Empty(Products());
            using (var machine = Hklm())
            using (var key = machine.OpenSubKey(InstallSafetyGate.ProductRegistryKey))
            {
                Assert.Null(key);
            }

            Assert.False(Directory.Exists(cache), $"{cache} is left after the uninstall");
            Assert.False(Directory.Exists(upgradeMsiCache), $"{upgradeMsiCache} is left after the uninstall");
            Assert.True(File.Exists(StateFile));
            Assert.Equal(identity, Identity());
        });
    }

    /// <summary>T3a: the MSI removed directly under an installed EXE leaves the EXE entry, which still uninstalls.</summary>
    [Fact]
    public async Task Mix_exe_then_msiexec_uninstall_leaves_an_orphaned_entry_that_still_uninstalls()
    {
        Assert.True(gate.Passed);
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var logs = LogFolder("mix-a");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Exe(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "install.log"), $"SERVER_URL={api.Origin}");
            await WaitForStatusAsync(AgentStates.Connected);
            var product = Assert.Single(Products());

            Msiexec("/x", product.ProductCode, "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi-uninstall.log"));
            Assert.Empty(Products());
            var orphan = Assert.Single(InstallSafetyGate.BundleEntries());

            var uninstall = QuietUninstall(orphan);
            Assert.True(uninstall.Succeeded, $"uninstall exited with {uninstall.ExitCode}: {uninstall.Output}");
            Assert.Empty(InstallSafetyGate.BundleEntries());
        });
    }

    /// <summary>T3b: the EXE over the same MSI version adds a second entry; removing the EXE removes the MSI too.</summary>
    [Fact]
    public async Task Mix_msi_then_exe_of_the_same_version_shows_two_entries_and_the_exe_uninstall_removes_both()
    {
        Assert.True(gate.Passed);
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var logs = LogFolder("mix-b");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Msiexec("/i", msi, $"SERVER_URL={api.Origin}", "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi.log"));
            await WaitForStatusAsync(AgentStates.Connected);

            Exe(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"));
            var bundle = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.True(VisibleEntries().Count == 2, State());

            var uninstall = QuietUninstall(bundle);
            Assert.True(uninstall.Succeeded, $"uninstall exited with {uninstall.ExitCode}: {uninstall.Output}");
            Assert.Empty(InstallSafetyGate.BundleEntries());
            Assert.True(Products().Count == 0, State());
        });
    }

    /// <summary>T3c (supported): a newer EXE upgrades the English MSI to one hidden product under one EXE entry.</summary>
    [Fact]
    public async Task Mix_english_msi_then_newer_exe_upgrades_to_one_entry_and_keeps_the_server_url()
    {
        Assert.True(gate.Passed);
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var upgradeExe = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_EXE");
        var logs = LogFolder("mix-c");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Msiexec("/i", msi, $"SERVER_URL={api.Origin}", "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var identity = Identity();

            Exe(upgradeExe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var product = Assert.Single(Products());
            Assert.Equal("0.1.1", VersionOf(product));
            Assert.True(InstallSafetyGate.ProductHidden(product.ProductCode), State());
            var bundle = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.Equal(bundle.Code, Assert.Single(VisibleEntries()), ignoreCase: true);
            Assert.Equal(api.Origin, ServerUrlValue());
            Assert.Equal(identity, Identity());
            Assert.Single(api.Registrations);
        });
    }

    /// <summary>T3d: a newer MSI over an installed EXE replaces the product; the old EXE entry stays until it is removed.</summary>
    [Fact]
    public async Task Mix_exe_then_newer_msi_leaves_the_old_exe_entry_and_its_uninstall_keeps_the_newer_msi()
    {
        Assert.True(gate.Passed);
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var upgradeMsi = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_MSI");
        var logs = LogFolder("mix-d");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Exe(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"), $"SERVER_URL={api.Origin}");
            await WaitForStatusAsync(AgentStates.Connected);

            Msiexec("/i", upgradeMsi, "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi.log"));
            Assert.Equal("0.1.1", VersionOf(Assert.Single(Products())));
            var bundle = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.Equal("0.1.0", bundle.DisplayVersion);
            Assert.True(VisibleEntries().Count == 2, State());

            var uninstall = QuietUninstall(bundle);
            Assert.True(uninstall.Succeeded, $"uninstall exited with {uninstall.ExitCode}: {uninstall.Output}");
            Assert.Empty(InstallSafetyGate.BundleEntries());
            Assert.True(Products().Count == 1 && VersionOf(Products()[0]) == "0.1.1", State());
        });
    }

    /// <summary>T3e (supported): a direct MSI repair under an installed EXE keeps the MSI entry hidden, so one entry stays.</summary>
    [Fact]
    public async Task Mix_exe_then_msiexec_repair_keeps_one_entry()
    {
        Assert.True(gate.Passed);
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var logs = LogFolder("mix-e");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Exe(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"), $"SERVER_URL={api.Origin}");
            await WaitForStatusAsync(AgentStates.Connected);
            Assert.Single(VisibleEntries());

            Msiexec("/fa", msi, "/qn", "/norestart", "/l*v", Path.Combine(logs, "repair.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var product = Assert.Single(Products());
            Assert.True(InstallSafetyGate.ProductHidden(product.ProductCode), State());
            Assert.True(VisibleEntries().Count == 1, State());
        });
    }

    /// <summary>
    /// T3f (supported): a newer EXE replaces the Hebrew MSI. The upgrade rows
    /// match every language (IgnoreLanguage), so its English MSI major-upgrades
    /// the Hebrew product: one product, one Apps and Features entry, and the
    /// remembered server URL and the identity stay.
    /// </summary>
    [Fact]
    public async Task Mix_hebrew_msi_then_newer_exe_upgrades_to_one_entry_and_keeps_the_server_url()
    {
        Assert.True(gate.Passed);
        var heMsi = RequiredFile("MASHKIF_INSTALL_TEST_HE_MSI");
        var upgradeExe = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_EXE");
        var logs = LogFolder("mix-f");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Msiexec("/i", heMsi, $"SERVER_URL={api.Origin}", "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var hebrew = Assert.Single(Products());
            var identity = Identity();

            Exe(upgradeExe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var product = Assert.Single(Products());
            Assert.NotEqual(hebrew.ProductCode, product.ProductCode);
            Assert.Equal("0.1.1", VersionOf(product));
            Assert.True(InstallSafetyGate.ProductHidden(product.ProductCode), State());
            var bundle = Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.Equal(bundle.Code, Assert.Single(VisibleEntries()), ignoreCase: true);
            Assert.Equal(api.Origin, ServerUrlValue());
            Assert.Equal(identity, Identity());
            Assert.Single(api.Registrations);
        });
    }

    /// <summary>
    /// T3g: the EXE of the same version over the Hebrew MSI. MajorUpgrade
    /// upgrades only older versions, so the English product is installed
    /// beside the Hebrew one of the same version, and both stay. Do not mix:
    /// uninstall first to switch languages within one version.
    /// </summary>
    [Fact]
    public async Task Mix_hebrew_msi_then_exe_of_the_same_version_installs_beside_it()
    {
        Assert.True(gate.Passed);
        var heMsi = RequiredFile("MASHKIF_INSTALL_TEST_HE_MSI");
        var exe = RequiredFile("MASHKIF_INSTALL_TEST_EXE");
        var logs = LogFolder("mix-g");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Msiexec("/i", heMsi, $"SERVER_URL={api.Origin}", "/qn", "/norestart", "/l*v", Path.Combine(logs, "msi.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var hebrew = Assert.Single(Products());

            Exe(exe, "/quiet", "/norestart", "/log", Path.Combine(logs, "exe.log"));
            var products = Products();
            Assert.True(products.Count == 2, State());
            Assert.Contains(products, p => p.ProductCode == hebrew.ProductCode && !InstallSafetyGate.ProductHidden(p.ProductCode));
            Assert.Contains(products, p => p.ProductCode != hebrew.ProductCode && VersionOf(p) == "0.1.0" && InstallSafetyGate.ProductHidden(p.ProductCode));
            Assert.Single(InstallSafetyGate.BundleEntries());
            Assert.True(VisibleEntries().Count == 2, State());
        });
    }

    /// <summary>
    /// T3h: the English MSI of the same version over the Hebrew MSI. As in
    /// T3g, both products of the same version stay installed. Do not mix.
    /// </summary>
    [Fact]
    public async Task Mix_hebrew_msi_then_english_msi_of_the_same_version_installs_beside_it()
    {
        Assert.True(gate.Passed);
        var heMsi = RequiredFile("MASHKIF_INSTALL_TEST_HE_MSI");
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var logs = LogFolder("mix-h");
        await RunWithCleanupAsync(async () =>
        {
            using var api = new FakeAgentApi();
            Msiexec("/i", heMsi, $"SERVER_URL={api.Origin}", "/qn", "/norestart", "/l*v", Path.Combine(logs, "he.log"));
            await WaitForStatusAsync(AgentStates.Connected);
            var hebrew = Assert.Single(Products());

            Msiexec("/i", msi, "/qn", "/norestart", "/l*v", Path.Combine(logs, "en.log"));
            var products = Products();
            Assert.True(products.Count == 2, State());
            Assert.Contains(products, p => p.ProductCode == hebrew.ProductCode);
            Assert.True(VisibleEntries().Count == 2, State());
        });
    }

    private static string RequiredFolder(string variable)
    {
        var path = Environment.GetEnvironmentVariable(variable);
        Assert.False(string.IsNullOrEmpty(path), $"{variable} is not set");
        Assert.True(Directory.Exists(path), $"{path} does not exist");
        return path;
    }
}
