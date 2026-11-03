using System.Diagnostics;
using System.Security.Principal;
using System.Xml.Linq;
using Microsoft.Win32;
using WixToolset.Dtf.WindowsInstaller;

[assembly: AssemblyFixture(typeof(Mashkif.Install.Tests.InstallSafetyGate))]
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

namespace Mashkif.Install.Tests;

/// <summary>
/// Runs before any install test and before any change to the machine. It
/// refuses unless this is a disposable GitHub-hosted runner, elevated, with no
/// trace of Mashkif. On a refusal the constructor throws, so every install
/// test fails (never skips) and nothing is touched. Every test runs the same
/// checks again at its start and its end (<see cref="AssertClean"/>).
/// </summary>
public sealed class InstallSafetyGate
{
    public const string UpgradeCode = "{D80A17FB-1D99-47D0-A228-8FC027BE1667}";

    /// <summary>The EXE installer's upgrade code (agent/bundle/Bundle.wxs).</summary>
    public const string BundleUpgradeCode = "{8B44898D-0D6E-4E7D-AA33-220084833485}";

    public const string TestUser = "mashkif-install-test";

    public static readonly string ProductDirectory =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Mashkif");

    /// <summary>Where Burn caches per-machine bundles and packages.</summary>
    public static readonly string PackageCache =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Package Cache");

    public const string ProductRegistryKey = @"SOFTWARE\Mashkif";

    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    /// <summary>The bundle manifests (wix burn extract -oba) of the EXEs under test.</summary>
    private static readonly string[] BundleDataVariables = ["MASHKIF_TEST_BUNDLE_BA", "MASHKIF_TEST_UPGRADE_BUNDLE_BA"];

    /// <summary>The MSIs under test.</summary>
    private static readonly string[] MsiVariables = ["MASHKIF_INSTALL_TEST_MSI", "MASHKIF_INSTALL_TEST_UPGRADE_MSI", "MASHKIF_INSTALL_TEST_HE_MSI"];

    public InstallSafetyGate()
    {
        var problems = Check().ToList();
        if (problems.Count > 0)
        {
            throw new InvalidOperationException("Install tests refused before any change: " + string.Join("; ", problems));
        }

        Passed = true;
    }

    /// <summary>Whether every check passed; each test asserts it first.</summary>
    public bool Passed { get; }

    /// <summary>Fails unless the machine is as clean as the gate requires.</summary>
    public static void AssertClean()
    {
        var problems = Check().ToList();
        Assert.True(problems.Count == 0, "The machine is not clean: " + string.Join("; ", problems));
    }

    /// <summary>Everything the gate finds; empty when the machine is clean.</summary>
    public static IReadOnlyList<string> Leftovers() => [.. Check()];

    private static IEnumerable<string> Check()
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
            || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
        {
            yield return "they run only on a GitHub-hosted runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted)";
            yield break;
        }

        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        {
            yield return "the process is not elevated";
        }

        if (ProductInstallation.GetRelatedProducts(UpgradeCode).Any())
        {
            yield return "a Mashkif product is installed";
        }

        foreach (var entry in BundleEntries())
        {
            yield return $"a Mashkif EXE is registered in Apps and Features ({entry.Code})";
        }

        // Burn caches a bundle before it registers it and unregisters it before
        // it removes the cache, so an interrupted run can leave a cache folder
        // without an entry. The folders are named by IDs, never found by globs.
        var cacheProblems = CacheFolders(out var folders, out var bundleCodes);
        foreach (var problem in cacheProblems)
        {
            yield return problem;
        }

        foreach (var folder in folders.Where(Directory.Exists))
        {
            yield return $"{folder} exists";
        }

        // An interrupted install can also leave the Uninstall key of a bundle
        // without a valid BundleUpgradeCode, so look for each bundle code too.
        foreach (var code in bundleCodes.Where(UninstallKeyExists))
        {
            yield return $@"HKLM\{UninstallKey}\{code} exists";
        }

        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using (var service = machine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\Mashkif"))
        {
            if (service is not null)
            {
                yield return "a service named Mashkif exists";
            }
        }

        if (Directory.Exists(ProductDirectory))
        {
            yield return $"{ProductDirectory} exists";
        }

        using (var product = machine.OpenSubKey(ProductRegistryKey))
        {
            if (product is not null)
            {
                yield return $@"HKLM\{ProductRegistryKey} exists";
            }
        }

        if (UserExists(TestUser))
        {
            yield return $"a local user {TestUser} exists";
        }
    }

    /// <summary>
    /// The Package Cache folders of the bundles and MSIs under test: the bundle
    /// code from each manifest, and each MSI's cache ID ({ProductCode}v{ProductVersion}).
    /// </summary>
    private static List<string> CacheFolders(out List<string> folders, out List<string> bundleCodes)
    {
        var problems = new List<string>();
        folders = [];
        bundleCodes = [];
        foreach (var variable in BundleDataVariables)
        {
            var path = Environment.GetEnvironmentVariable(variable);
            if (string.IsNullOrEmpty(path))
            {
                problems.Add($"{variable} is not set, so the bundle cache cannot be checked");
                continue;
            }

            var code = BundleCode(path);
            bundleCodes.Add(code);
            folders.Add(Path.Combine(PackageCache, code));
        }

        foreach (var variable in MsiVariables)
        {
            var path = Environment.GetEnvironmentVariable(variable);
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                problems.Add($"{variable} is not set or missing, so the MSI cache cannot be checked");
                continue;
            }

            folders.Add(Path.Combine(PackageCache, MsiCacheId(path)));
        }

        return problems;
    }

    /// <summary>The bundle code (Registration/@Code) in the manifest under <paramref name="bundleData"/>.</summary>
    public static string BundleCode(string bundleData)
    {
        XNamespace burn = "http://wixtoolset.org/schemas/v4/2008/Burn";
        var manifest = XDocument.Load(Path.Combine(bundleData, "manifest.xml"));
        return (string?)manifest.Root?.Element(burn + "Registration")?.Attribute("Code")
            ?? throw new InvalidOperationException($"No Registration/@Code in {bundleData}");
    }

    /// <summary>Burn's default cache ID of an MSI: {ProductCode}v{ProductVersion}.</summary>
    public static string MsiCacheId(string msi)
    {
        using var db = new Database(msi, DatabaseOpenMode.ReadOnly);
        var code = (string)db.ExecuteScalar("SELECT `Value` FROM `Property` WHERE `Property` = 'ProductCode'");
        var version = (string)db.ExecuteScalar("SELECT `Value` FROM `Property` WHERE `Property` = 'ProductVersion'");
        return $"{code}v{version}";
    }

    /// <summary>One Apps and Features entry of a Mashkif EXE, found by its upgrade code.</summary>
    public sealed record BundleEntry(string Code, string? DisplayVersion, string? QuietUninstallString, string? BundleCachePath, bool SystemComponent);

    /// <summary>Every registered Mashkif EXE, in both registry views.</summary>
    public static List<BundleEntry> BundleEntries()
    {
        var entries = new List<BundleEntry>();
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var uninstall = machine.OpenSubKey(UninstallKey);
            if (uninstall is null)
            {
                continue;
            }

            foreach (var name in uninstall.GetSubKeyNames())
            {
                using var key = uninstall.OpenSubKey(name);
                if (key?.GetValue("BundleUpgradeCode") is string[] codes && codes.Contains(BundleUpgradeCode, StringComparer.OrdinalIgnoreCase))
                {
                    entries.Add(new BundleEntry(
                        name,
                        key.GetValue("DisplayVersion") as string,
                        key.GetValue("QuietUninstallString") as string,
                        key.GetValue("BundleCachePath") as string,
                        key.GetValue("SystemComponent") is int hidden && hidden == 1));
                }
            }
        }

        return entries;
    }

    /// <summary>Whether HKLM\...\Uninstall\<paramref name="code"/> exists in either registry view.</summary>
    private static bool UninstallKeyExists(string code)
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var key = machine.OpenSubKey($@"{UninstallKey}\{code}");
            if (key is not null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Whether the Apps and Features entry of an MSI product is hidden (SystemComponent=1).</summary>
    public static bool ProductHidden(string productCode)
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var key = machine.OpenSubKey($@"{UninstallKey}\{productCode}");
            if (key is not null)
            {
                return key.GetValue("SystemComponent") is int hidden && hidden == 1;
            }
        }

        throw new InvalidOperationException($"No Apps and Features entry for {productCode}");
    }

    internal static bool UserExists(string name)
    {
        using var process = Process.Start(new ProcessStartInfo("net.exe", ["user", name])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        })!;
        process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        process.WaitForExit();
        return process.ExitCode == 0;
    }
}
