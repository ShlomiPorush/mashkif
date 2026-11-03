using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using WixToolset.Dtf.WindowsInstaller;

namespace Mashkif.Install.Tests;

/// <summary>
/// Shared harness of the install tests: processes with a timeout, the
/// cleanup that runs after every test, and the Apps and Features views.
/// </summary>
public sealed partial class InstallTests
{
    private static readonly TimeSpan RunTimeout = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Set when a run timed out in the current test. The install state may not
    /// have settled then, so cleanup deletes no data. The tests never run in
    /// parallel (InstallSafetyGate.cs), so one flag is enough.
    /// </summary>
    private static bool s_timedOut;

    /// <summary>Whether the current test created the test user.</summary>
    private bool _userCreated;

    private sealed record RunResult(int ExitCode, string Output, bool TimedOut)
    {
        public bool Succeeded => !TimedOut && ExitCode == 0;
    }

    /// <summary>
    /// Runs a process and never throws for its exit code. After the timeout it
    /// kills the whole process tree (Burn runs an engine, an elevated
    /// companion, and the bootstrapper application as separate processes).
    /// </summary>
    private static RunResult TryRun(string file, params string[] arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        })!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            s_timedOut = true;
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }

            return new RunResult(-1, $"timed out after {RunTimeout.TotalMinutes} minutes", TimedOut: true);
        }

        process.WaitForExit();
        return new RunResult(process.ExitCode, output.Result + error.Result, TimedOut: false);
    }

    private static string Run(string file, params string[] arguments)
    {
        var result = TryRun(file, arguments);
        Assert.True(result.Succeeded, $"{file} {arguments.FirstOrDefault()} exited with {result.ExitCode}: {result.Output}");
        return result.Output;
    }

    private static void Msiexec(params string[] arguments)
    {
        var result = TryRun("msiexec.exe", arguments);
        Assert.True(result.Succeeded, $"msiexec {string.Join(' ', arguments)} exited with {result.ExitCode}: {result.Output}");
    }

    /// <summary>Runs the EXE installer and asserts success.</summary>
    private static void Exe(string exe, params string[] arguments)
    {
        var result = TryRun(exe, arguments);
        Assert.True(result.Succeeded, $"{Path.GetFileName(exe)} {string.Join(' ', arguments)} exited with {result.ExitCode}: {result.Output}{Environment.NewLine}{State()}");
    }

    /// <summary>
    /// Runs a bundle's registered QuietUninstallString with /norestart
    /// appended: Burn registers it without /norestart, and a quiet run without
    /// it restarts the machine when a restart is needed.
    /// </summary>
    private static RunResult QuietUninstall(InstallSafetyGate.BundleEntry entry)
    {
        Assert.False(string.IsNullOrEmpty(entry.QuietUninstallString), $"{entry.Code} has no QuietUninstallString");
        var (file, arguments) = SplitCommandLine(entry.QuietUninstallString);
        return TryRun(file, [.. arguments, "/norestart"]);
    }

    private static (string File, string[] Arguments) SplitCommandLine(string commandLine)
    {
        commandLine = commandLine.Trim();
        string file;
        string rest;
        if (commandLine.StartsWith('"'))
        {
            var end = commandLine.IndexOf('"', 1);
            file = commandLine[1..end];
            rest = commandLine[(end + 1)..];
        }
        else
        {
            var space = commandLine.IndexOf(' ', StringComparison.Ordinal);
            file = space < 0 ? commandLine : commandLine[..space];
            rest = space < 0 ? string.Empty : commandLine[space..];
        }

        return (file, rest.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>
    /// Runs one test body, then the cleanup, even when the body failed. The
    /// cleanup tries every safe removal, collects every failure, and reports
    /// all leftovers together. A failure of the body stays the primary error.
    /// </summary>
    private async Task RunWithCleanupAsync(Func<Task> body)
    {
        InstallSafetyGate.AssertClean();
        s_timedOut = false;
        _userCreated = false;

        ExceptionDispatchInfo? failure = null;
        try
        {
            await body();
        }
        catch (Exception exception)
        {
            failure = ExceptionDispatchInfo.Capture(exception);
        }

        var leftovers = CleanUp();
        if (failure is not null)
        {
            if (leftovers.Count > 0)
            {
                throw new InvalidOperationException(
                    $"{failure.SourceException.Message}{Environment.NewLine}Cleanup also reports: {string.Join("; ", leftovers)}",
                    failure.SourceException);
            }

            failure.Throw();
        }

        Assert.True(leftovers.Count == 0, "Cleanup left: " + string.Join("; ", leftovers));
    }

    /// <summary>
    /// Removes what a test created: every registered Mashkif EXE, then every
    /// remaining Mashkif product, then the test user. Data
    /// (%ProgramData%\Mashkif, HKLM\SOFTWARE\Mashkif) is deleted only when
    /// nothing timed out and nothing is installed any more. Nothing in the
    /// Package Cache is deleted by hand. Returns every failure and leftover.
    /// </summary>
    private List<string> CleanUp()
    {
        var failures = new List<string>();
        foreach (var entry in InstallSafetyGate.BundleEntries())
        {
            var result = QuietUninstall(entry);
            if (!result.Succeeded)
            {
                failures.Add($"uninstalling the EXE {entry.Code} exited with {result.ExitCode}: {result.Output}");
            }
        }

        foreach (var product in ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode).ToList())
        {
            var result = TryRun("msiexec.exe", "/x", product.ProductCode, "/qn", "/norestart");
            if (!result.Succeeded)
            {
                failures.Add($"msiexec /x {product.ProductCode} exited with {result.ExitCode}: {result.Output}");
            }
        }

        if (_userCreated)
        {
            var result = TryRun("net.exe", "user", InstallSafetyGate.TestUser, "/delete");
            if (!result.Succeeded)
            {
                failures.Add($"deleting the test user exited with {result.ExitCode}: {result.Output}");
            }
        }

        var stillInstalled = InstallSafetyGate.BundleEntries().Count > 0
            || ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode).Any();
        if (s_timedOut)
        {
            failures.Add("a run timed out, so cleanup deleted no data");
        }
        else if (stillInstalled)
        {
            failures.Add("Mashkif is still installed, so cleanup deleted no data");
        }
        else
        {
            try
            {
                if (Directory.Exists(InstallSafetyGate.ProductDirectory))
                {
                    Directory.Delete(InstallSafetyGate.ProductDirectory, recursive: true);
                }

                using var machine = Hklm();
                machine.DeleteSubKeyTree(InstallSafetyGate.ProductRegistryKey, throwOnMissingSubKey: false);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                failures.Add($"deleting the Mashkif data failed: {exception.Message}");
            }
        }

        failures.AddRange(InstallSafetyGate.Leftovers());
        return failures;
    }

    /// <summary>A fresh log folder under MASHKIF_TEST_TMP for one test.</summary>
    private static string LogFolder(string name)
    {
        var root = Environment.GetEnvironmentVariable("MASHKIF_TEST_TMP") ?? Path.GetTempPath();
        var folder = Path.Combine(root, name);
        Directory.CreateDirectory(folder);
        return folder;
    }

    /// <summary>The installed Mashkif products (any language).</summary>
    private static List<ProductInstallation> Products() =>
        [.. ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode)];

    /// <summary>The product version as major.minor.build.</summary>
    private static string VersionOf(ProductInstallation product) =>
        $"{product.ProductVersion.Major}.{product.ProductVersion.Minor}.{product.ProductVersion.Build}";

    /// <summary>The visible Mashkif entries in Apps and Features: bundles and MSI products without SystemComponent.</summary>
    private static List<string> VisibleEntries() =>
    [
        .. InstallSafetyGate.BundleEntries().Where(e => !e.SystemComponent).Select(e => e.Code),
        .. Products().Where(p => !InstallSafetyGate.ProductHidden(p.ProductCode)).Select(p => p.ProductCode),
    ];

    /// <summary>A summary of what is installed, for assertion messages.</summary>
    private static string State()
    {
        var products = Products().Select(p => $"{p.ProductCode} {VersionOf(p)} lang {p["Language"]} hidden {InstallSafetyGate.ProductHidden(p.ProductCode)}");
        var bundles = InstallSafetyGate.BundleEntries().Select(e => $"{e.Code} {e.DisplayVersion} hidden {e.SystemComponent}");
        return $"Products: [{string.Join(", ", products)}]; EXE entries: [{string.Join(", ", bundles)}]";
    }

    /// <summary>The size of a folder in bytes, for the pull request record.</summary>
    private static long FolderSize(string folder) =>
        new DirectoryInfo(folder).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);

    /// <summary>Appends one line to measurements.txt in MASHKIF_TEST_TMP; verify-agent.sh prints it.</summary>
    private static void Record(string line)
    {
        var root = Environment.GetEnvironmentVariable("MASHKIF_TEST_TMP") ?? Path.GetTempPath();
        File.AppendAllText(Path.Combine(root, "measurements.txt"), line + Environment.NewLine);
    }

    private static string Megabytes(long bytes) => (bytes / 1024.0 / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
}
