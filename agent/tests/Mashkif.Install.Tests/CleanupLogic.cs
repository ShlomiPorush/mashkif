namespace Mashkif.Install.Tests;

/// <summary>
/// The cleanup that runs after every install test, without any registry,
/// process, or install of its own: the machine is reached only through
/// <see cref="Machine"/>. Mashkif.Installer.Tests links this file and tests it
/// with a fake machine, so the logic is checked on any computer; the install
/// tests run it against the real one.
/// </summary>
internal static class CleanupLogic
{
    /// <summary>One registered Mashkif EXE; the uninstall string may be missing after an interrupted install.</summary>
    public sealed record BundleEntry(string Code, string? QuietUninstallString);

    /// <summary>The result of one process run.</summary>
    public sealed record RunResult(int ExitCode, string Output, bool TimedOut)
    {
        public bool Succeeded => !TimedOut && ExitCode == 0;
    }

    /// <summary>What cleanup reads and changes on the machine.</summary>
    public sealed record Machine(
        Func<IReadOnlyList<BundleEntry>> BundleEntries,
        Func<IReadOnlyList<string>> ProductCodes,
        Func<IReadOnlyList<string>> KnownBundleKeys,
        Func<string, string[], RunResult> Run,
        bool UserCreated,
        string TestUser,
        Func<bool> TimedOut,
        Action DeleteData,
        Func<IReadOnlyList<string>> Leftovers);

    /// <summary>
    /// Removes what a test created: every registered Mashkif EXE, then every
    /// remaining Mashkif product, then the test user. Data is deleted only
    /// when nothing timed out and nothing is installed any more. Every step
    /// runs even when an earlier one failed or threw; the result lists every
    /// failure and every leftover.
    /// </summary>
    public static List<string> CleanUp(Machine machine)
    {
        var failures = new List<string>();

        foreach (var entry in Read("list the registered Mashkif EXEs", machine.BundleEntries, failures) ?? [])
        {
            Step($"uninstall the EXE {entry.Code}", () =>
            {
                var command = QuietUninstallCommand(entry.QuietUninstallString);
                return command is null
                    ? "it has no QuietUninstallString (an interrupted registration), so it cannot be uninstalled by its command"
                    : Failure(machine.Run(command.Value.File, command.Value.Arguments));
            }, failures);
        }

        foreach (var productCode in Read("list the Mashkif products", machine.ProductCodes, failures) ?? [])
        {
            Step($"msiexec /x {productCode}", () => Failure(machine.Run("msiexec.exe", ["/x", productCode, "/qn", "/norestart"])), failures);
        }

        if (machine.UserCreated)
        {
            Step("delete the test user", () => Failure(machine.Run("net.exe", ["user", machine.TestUser, "/delete"])), failures);
        }

        var stillInstalled = Read<bool?>(
            "check what is still installed",
            // KnownBundleKeys: the Uninstall keys of the bundles under test, also
            // when Burn stopped before it wrote BundleUpgradeCode, which
            // BundleEntries cannot find.
            () => machine.BundleEntries().Count > 0 || machine.ProductCodes().Count > 0 || machine.KnownBundleKeys().Count > 0,
            failures);
        var blocked = stillInstalled is null
            ? "the install state could not be read"
            : DataDeletionBlocked(machine.TimedOut(), stillInstalled.Value);
        if (blocked is not null)
        {
            failures.Add($"cleanup deleted no data: {blocked}");
        }
        else
        {
            Step("delete the Mashkif data", () =>
            {
                machine.DeleteData();
                return null;
            }, failures);
        }

        failures.AddRange(Read("check for leftovers", machine.Leftovers, failures) ?? []);
        return failures;
    }

    /// <summary>Why cleanup must not delete data now, or null when it may.</summary>
    public static string? DataDeletionBlocked(bool timedOut, bool stillInstalled) =>
        timedOut ? "a run timed out, so the install state may not have settled"
        : stillInstalled ? "Mashkif is still installed"
        : null;

    /// <summary>
    /// The registered QuietUninstallString as a command, with /norestart
    /// appended (Burn registers it without), or null when there is none.
    /// </summary>
    public static (string File, string[] Arguments)? QuietUninstallCommand(string? quietUninstallString)
    {
        if (string.IsNullOrWhiteSpace(quietUninstallString))
        {
            return null;
        }

        var (file, arguments) = SplitCommandLine(quietUninstallString);
        return (file, [.. arguments, "/norestart"]);
    }

    /// <summary>
    /// The msiexec arguments with /norestart appended unless they have it.
    /// A quiet msiexec run without it restarts the PC by itself when a
    /// restart is needed, which takes the runner down with the test.
    /// </summary>
    public static string[] MsiexecArguments(IReadOnlyList<string> arguments) =>
        arguments.Contains("/norestart", StringComparer.OrdinalIgnoreCase) ? [.. arguments] : [.. arguments, "/norestart"];

    /// <summary>Splits a command line whose first token may be a quoted path.</summary>
    public static (string File, string[] Arguments) SplitCommandLine(string commandLine)
    {
        commandLine = commandLine.Trim();
        string file;
        string rest;
        var end = commandLine.StartsWith('"') ? commandLine.IndexOf('"', 1) : -1;
        if (end > 0)
        {
            file = commandLine[1..end];
            rest = commandLine[(end + 1)..];
        }
        else
        {
            var space = commandLine.IndexOf(' ', StringComparison.Ordinal);
            file = (space < 0 ? commandLine : commandLine[..space]).Trim('"');
            rest = space < 0 ? string.Empty : commandLine[space..];
        }

        return (file, rest.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>
    /// The exception a test ends with. A failure of the test body stays the
    /// primary error: it is returned as is when cleanup left nothing, and as
    /// the inner exception, with its message first, when cleanup left
    /// something. Null when the body passed and cleanup left nothing.
    /// </summary>
    public static Exception? Outcome(Exception? bodyFailure, IReadOnlyList<string> leftovers)
    {
        if (leftovers.Count == 0)
        {
            return bodyFailure;
        }

        var report = string.Join("; ", leftovers);
        return bodyFailure is null
            ? new InvalidOperationException("Cleanup left: " + report)
            : new InvalidOperationException($"{bodyFailure.Message}{Environment.NewLine}Cleanup also reports: {report}", bodyFailure);
    }

    private static string? Failure(RunResult result) =>
        result.Succeeded ? null : $"exited with {result.ExitCode}{(result.TimedOut ? " (timed out)" : string.Empty)}: {result.Output}";

    private static void Step(string name, Func<string?> action, List<string> failures)
    {
        try
        {
            var failure = action();
            if (failure is not null)
            {
                failures.Add($"{name}: {failure}");
            }
        }
        catch (Exception exception)
        {
            failures.Add($"{name}: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private static T? Read<T>(string name, Func<T> read, List<string> failures)
    {
        try
        {
            return read();
        }
        catch (Exception exception)
        {
            failures.Add($"{name}: {exception.GetType().Name}: {exception.Message}");
            return default;
        }
    }
}
