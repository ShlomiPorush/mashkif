namespace Mashkif.Service.Config;

/// <summary>The enrollment key that the MSI property <c>ENROLLMENT_KEY</c> wrote.</summary>
internal interface IEnrollmentKeySource
{
    /// <summary>The stored value, or null when there is none.</summary>
    string? Read();

    /// <summary>Deletes the value; does nothing when it is absent.</summary>
    void Delete();
}

/// <summary>
/// <c>HKLM\SOFTWARE\Mashkif\Agent\Enrollment</c>, value <c>Key</c>. The MSI
/// gives the key access only for SYSTEM, Administrators, and the service SID.
/// </summary>
internal sealed class RegistryEnrollmentKeySource(AgentRegistry registry) : IEnrollmentKeySource
{
    public string? Read()
    {
        using var key = registry.Root.OpenSubKey(registry.EnrollmentKeyPath, writable: false);
        return key?.GetValue(AgentRegistry.EnrollmentKeyValue) as string;
    }

    public void Delete()
    {
        using var key = registry.Root.OpenSubKey(registry.EnrollmentKeyPath, writable: true);
        key?.DeleteValue(AgentRegistry.EnrollmentKeyValue, throwOnMissingValue: false);
    }
}
