using System.Text.Json;

namespace Mashkif.Service.State;

/// <summary>The outcome of reading <c>state.json</c>.</summary>
internal sealed record StateLoad(AgentState? State, string? Problem);

/// <summary>
/// Reads and writes <c>state.json</c> in the state directory. A write goes to
/// a new <c>state.json.tmp</c> created with an explicit protected DACL, is
/// flushed to disk, and then replaces <c>state.json</c> in one move.
/// </summary>
internal sealed class StateStore(string productDirectory, string stateDirectory, PathPolicy policy)
{
    public const string FileName = "state.json";

    public const string TempFileName = "state.json.tmp";

    /// <summary>Production paths: %ProgramData%\Mashkif and %ProgramData%\Mashkif\state.</summary>
    public static StateStore Production()
    {
        var product = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Mashkif");
        return new StateStore(product, Path.Combine(product, "state"), PathPolicy.Production());
    }

    public string StateDirectory => stateDirectory;

    public PathPolicy Policy => policy;

    public string FilePath => Path.Combine(stateDirectory, FileName);

    public string TempPath => Path.Combine(stateDirectory, TempFileName);

    /// <summary>Test hook: runs after the temporary file is written and before it replaces the state.</summary>
    internal Action? BeforeReplace { get; set; }

    /// <summary>
    /// Checks the path and reads the state. A missing file is an empty state.
    /// Anything unsafe, unreadable, or invalid is a problem, and the file is left untouched.
    /// </summary>
    public StateLoad Load()
    {
        string? problem;
        try
        {
            problem = PathSecurity.Check(productDirectory, stateDirectory, FilePath, policy);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            // For example a DACL that denies the service READ_CONTROL. Nothing
            // is changed; the service reports state_invalid like any other problem.
            problem = $"the path checks of {stateDirectory} failed: {exception.GetType().Name}";
        }

        if (problem is not null)
        {
            return new StateLoad(null, problem);
        }

        if (!File.Exists(FilePath))
        {
            return new StateLoad(AgentState.Empty, null);
        }

        AgentState? state;
        try
        {
            using var stream = new FileStream(FilePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            state = JsonSerializer.Deserialize(stream, StateJsonContext.Default.AgentState);
        }
        catch (JsonException)
        {
            return new StateLoad(null, $"{FilePath} is not a valid state file");
        }
        catch (IOException exception)
        {
            return new StateLoad(null, $"{FilePath} cannot be read: {exception.GetType().Name}");
        }
        catch (UnauthorizedAccessException)
        {
            return new StateLoad(null, $"{FilePath} cannot be read: access denied");
        }

        if (state is null || state.SchemaVersion is not (AgentState.CurrentSchemaVersion or AgentState.PreviousSchemaVersion))
        {
            return new StateLoad(null, $"{FilePath} has an unknown schema version");
        }

        if (state.SchemaVersion == AgentState.PreviousSchemaVersion)
        {
            // Version 1 (0.1.0 before step 2c) has none of the version 2 fields;
            // the migration only raises the version, and the next save writes it.
            if (state.LastSync is not null || state.DeferredUntilUtc is not null || state.DeferredSeconds is not null)
            {
                return new StateLoad(null, $"{FilePath} is not consistent");
            }

            state = state with { SchemaVersion = AgentState.CurrentSchemaVersion };
        }

        return state.IsValid() ? new StateLoad(state, null) : new StateLoad(null, $"{FilePath} is not consistent");
    }

    /// <summary>Writes <paramref name="state"/> atomically. Throws on failure; the old file stays.</summary>
    public void Save(AgentState state)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(state, StateJsonContext.Default.AgentState);
        File.Delete(TempPath);
        var temp = new FileInfo(TempPath);
        using (var stream = temp.Create(
                   FileMode.CreateNew,
                   System.Security.AccessControl.FileSystemRights.Write | System.Security.AccessControl.FileSystemRights.Read,
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
    }
}
