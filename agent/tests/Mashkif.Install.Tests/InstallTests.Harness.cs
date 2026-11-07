using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using WixToolset.Dtf.WindowsInstaller;
using RunResult = Mashkif.Install.Tests.CleanupLogic.RunResult;

namespace Mashkif.Install.Tests;

/// <summary>
/// Shared harness of the install tests: processes with a timeout, the
/// cleanup that runs after every test (its logic is in CleanupLogic), and the
/// Apps and Features views.
/// </summary>
public sealed partial class InstallTests
{
    private static readonly TimeSpan RunTimeout = TimeSpan.FromMinutes(10);

    /// <summary>How long a run's output may stay open after the process exited.</summary>
    private static readonly TimeSpan OutputTimeout = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Set when a run timed out in the current test. The install state may not
    /// have settled then, so cleanup deletes no data. The tests never run in
    /// parallel (InstallSafetyGate.cs), so one flag is enough.
    /// </summary>
    private static bool s_timedOut;

    /// <summary>Whether the current test created the test user.</summary>
    private bool _userCreated;

    /// <summary>
    /// Runs a process and never throws: a file that cannot be started and a
    /// nonzero exit code are results. After the timeout it kills the whole
    /// process tree (Burn runs an engine, an elevated companion, and the
    /// bootstrapper application as separate processes).
    /// </summary>
    private static RunResult TryRun(string file, params string[] arguments)
    {
        Process process;
        try
        {
            process = Process.Start(new ProcessStartInfo(file, arguments)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            })!;
        }
        catch (Exception exception) when (exception is Win32Exception or FileNotFoundException or InvalidOperationException)
        {
            return new RunResult(-1, $"{file} could not be started: {exception.Message}", TimedOut: false);
        }

        using (process)
        {
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

            // A child process that inherited the output handles keeps them
            // open after this process exited; never wait for it without a bound.
            if (!Task.WaitAll([output, error], OutputTimeout))
            {
                s_timedOut = true;
                return new RunResult(-1, $"exited with {process.ExitCode}, but a child process kept its output open for {OutputTimeout.TotalMinutes} minute", TimedOut: true);
            }

            return new RunResult(process.ExitCode, output.Result + error.Result, TimedOut: false);
        }
    }

    private static string Run(string file, params string[] arguments)
    {
        var result = TryRun(file, arguments);
        Assert.True(result.Succeeded, $"{file} {arguments.FirstOrDefault()} exited with {result.ExitCode}: {result.Output}");
        return result.Output;
    }

    /// <summary>Runs msiexec with /norestart (CleanupLogic.MsiexecArguments) and asserts success.</summary>
    private static void Msiexec(params string[] arguments)
    {
        arguments = CleanupLogic.MsiexecArguments(arguments);
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
    /// appended (CleanupLogic.QuietUninstallCommand). A test step: it asserts
    /// that the string exists.
    /// </summary>
    private static RunResult QuietUninstall(InstallSafetyGate.BundleEntry entry)
    {
        var command = CleanupLogic.QuietUninstallCommand(entry.QuietUninstallString);
        Assert.True(command is not null, $"{entry.Code} has no QuietUninstallString");
        return TryRun(command.Value.File, command.Value.Arguments);
    }

    /// <summary>
    /// Runs one test body, then the cleanup, even when the body failed. A
    /// failure of the body stays the primary error (CleanupLogic.Outcome).
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

        var outcome = CleanupLogic.Outcome(failure?.SourceException, CleanUp());
        if (failure is not null && ReferenceEquals(outcome, failure.SourceException))
        {
            failure.Throw();
        }

        if (outcome is not null)
        {
            throw outcome;
        }
    }

    /// <summary>
    /// Runs CleanupLogic.CleanUp against this machine. Data
    /// (%ProgramData%\Mashkif, HKLM\SOFTWARE\Mashkif) is deleted only when
    /// nothing timed out and nothing is installed any more. Nothing in the
    /// Package Cache is deleted by hand.
    /// </summary>
    private List<string> CleanUp() => CleanupLogic.CleanUp(new CleanupLogic.Machine(
        BundleEntries: () => [.. InstallSafetyGate.BundleEntries().Select(e => new CleanupLogic.BundleEntry(e.Code, e.QuietUninstallString))],
        ProductCodes: () => [.. Products().Select(p => p.ProductCode)],
        KnownBundleKeys: InstallSafetyGate.KnownBundleKeys,
        Run: TryRun,
        UserCreated: _userCreated,
        TestUser: InstallSafetyGate.TestUser,
        TimedOut: () => s_timedOut,
        DeleteData: () =>
        {
            if (Directory.Exists(InstallSafetyGate.ProductDirectory))
            {
                Directory.Delete(InstallSafetyGate.ProductDirectory, recursive: true);
            }

            using var machine = Hklm();
            machine.DeleteSubKeyTree(InstallSafetyGate.ProductRegistryKey, throwOnMissingSubKey: false);
        },
        Leftovers: InstallSafetyGate.Leftovers));

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
