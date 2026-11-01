namespace Mashkif.Agent.Tests;

/// <summary>
/// A unique scratch folder for one test. The root comes from MASHKIF_TEST_TMP
/// when set (scripts/lib/verify-agent.sh points it at the scratch location),
/// otherwise from the system temporary folder.
/// </summary>
internal sealed class TestScratch : IDisposable
{
    public TestScratch()
    {
        var root = Environment.GetEnvironmentVariable("MASHKIF_TEST_TMP");
        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.GetTempPath();
        }

        DirectoryPath = Path.Combine(root, "mashkif-agent-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(DirectoryPath);
    }

    public string DirectoryPath { get; }

    public string File(params string[] parts) => Path.Combine([DirectoryPath, .. parts]);

    public void Dispose()
    {
        try
        {
            Directory.Delete(DirectoryPath, recursive: true);
        }
        catch (IOException)
        {
            // Best effort; the owner of the scratch root cleans it up.
        }
    }
}

/// <summary>A clock fixed at a known instant.</summary>
internal sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}
