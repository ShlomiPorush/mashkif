using System.Diagnostics;
using System.Security.Principal;
using Microsoft.Win32;
using WixToolset.Dtf.WindowsInstaller;

[assembly: AssemblyFixture(typeof(Mashkif.Install.Tests.InstallSafetyGate))]

namespace Mashkif.Install.Tests;

/// <summary>
/// Runs before any install test and before any change to the machine. It
/// refuses unless this is a disposable GitHub-hosted runner, elevated, with no
/// trace of Mashkif. On a refusal the constructor throws, so every install
/// test fails (never skips) and nothing is touched.
/// </summary>
public sealed class InstallSafetyGate
{
    public const string UpgradeCode = "{D80A17FB-1D99-47D0-A228-8FC027BE1667}";

    public const string TestUser = "mashkif-install-test";

    public static readonly string ProductDirectory =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Mashkif");

    public const string ProductRegistryKey = @"SOFTWARE\Mashkif";

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
