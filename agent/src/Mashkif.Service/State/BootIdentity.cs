using Microsoft.Win32;

namespace Mashkif.Service.State;

/// <summary>
/// The boot ID: a random UUID kept in a volatile registry key, which survives
/// a service restart and disappears at reboot (<see cref="RegistryOptions.Volatile"/>).
/// The key inherits its ACL from the MSI-created parent, which grants access
/// only to SYSTEM, Administrators, and the service SID.
/// </summary>
internal static class BootIdentity
{
    public const string BootSubkey = "Boot";

    public const string BootIdValue = "BootId";

    /// <summary>Returns the boot ID stored under <paramref name="serviceKeyPath"/>, creating it when absent.</summary>
    public static Guid GetOrCreate(RegistryKey root, string serviceKeyPath)
    {
        ArgumentNullException.ThrowIfNull(root);
        using var parent = root.OpenSubKey(serviceKeyPath, writable: true)
            ?? throw new InvalidOperationException($"The registry key {serviceKeyPath} does not exist.");
        using var boot = parent.CreateSubKey(BootSubkey, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.Volatile);
        if (boot.GetValue(BootIdValue) is string stored && Guid.TryParseExact(stored, "D", out var existing))
        {
            return existing;
        }

        var created = Guid.NewGuid();
        boot.SetValue(BootIdValue, created.ToString("D"), RegistryValueKind.String);
        return created;
    }
}
