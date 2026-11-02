using System.Security.AccessControl;
using System.Security.Principal;

namespace Mashkif.Service.State;

/// <summary>
/// The access rules of the product path. The MSI sets them; the service only
/// checks them and refuses to use a path that does not match.
/// </summary>
internal sealed class PathPolicy
{
    /// <summary>NT AUTHORITY\SYSTEM.</summary>
    public static readonly SecurityIdentifier LocalSystem = new(WellKnownSidType.LocalSystemSid, null);

    /// <summary>BUILTIN\Administrators.</summary>
    public static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    /// <summary>NT AUTHORITY\LOCAL SERVICE.</summary>
    public static readonly SecurityIdentifier LocalService = new(WellKnownSidType.LocalServiceSid, null);

    /// <summary>OWNER RIGHTS. An ACE for it replaces the owner's implicit rights.</summary>
    public static readonly SecurityIdentifier OwnerRights = new("S-1-3-4");

    /// <summary>The service SID of <c>NT SERVICE\Mashkif</c> (<c>sc showsid Mashkif</c>).</summary>
    public static readonly SecurityIdentifier MashkifServiceSid = new("S-1-5-80-955452773-2337780239-555098662-296726712-2311605372");

    /// <summary>Read, list, and traverse, nothing more.</summary>
    public const FileSystemRights ReadOnlyRights = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;

    public PathPolicy(
        SecurityIdentifier serviceSid,
        IReadOnlyCollection<SecurityIdentifier> productWriters,
        IReadOnlyCollection<SecurityIdentifier> directoryOwners,
        IReadOnlyCollection<SecurityIdentifier> fileOwners)
    {
        ServiceSid = serviceSid;
        ProductWriters = productWriters;
        DirectoryOwners = directoryOwners;
        FileOwners = fileOwners;
    }

    /// <summary>SIDs that may have more than read access to the product directory.</summary>
    public IReadOnlyCollection<SecurityIdentifier> ProductWriters { get; }

    public SecurityIdentifier ServiceSid { get; }

    public IReadOnlyCollection<SecurityIdentifier> DirectoryOwners { get; }

    public IReadOnlyCollection<SecurityIdentifier> FileOwners { get; }

    /// <summary>The installed service: directories owned by SYSTEM or Administrators.</summary>
    public static PathPolicy Production() => new(
        MashkifServiceSid,
        [LocalSystem, Administrators],
        [LocalSystem, Administrators],
        [LocalSystem, Administrators, LocalService, MashkifServiceSid]);

    /// <summary>
    /// The protected DACL of the state directory and its files:
    /// SYSTEM, Administrators, and the service SID full control, OWNER RIGHTS read control only.
    /// </summary>
    public FileSecurity CreateStateFileSecurity()
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { LocalSystem, Administrators, ServiceSid })
        {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        }

        security.AddAccessRule(new FileSystemAccessRule(OwnerRights, FileSystemRights.ReadPermissions, AccessControlType.Allow));
        return security;
    }
}

/// <summary>Checks owner, DACL, and reparse points of the product path before the state is used.</summary>
internal static class PathSecurity
{
    /// <summary>
    /// Returns null when the product directory, the state directory, and the
    /// state file (if present) are safe, or a description of the first failed check.
    /// </summary>
    public static string? Check(string productDirectory, string stateDirectory, string stateFile, PathPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (!Directory.Exists(productDirectory))
        {
            return $"{productDirectory} does not exist";
        }

        if (!Directory.Exists(stateDirectory))
        {
            return $"{stateDirectory} does not exist";
        }

        var product = new DirectoryInfo(productDirectory);
        var state = new DirectoryInfo(stateDirectory);
        var problem = CheckReparse(product) ?? CheckReparse(state);
        if (problem is not null)
        {
            return problem;
        }

        var productAcl = product.GetAccessControl();
        problem = CheckProtectedAndOwner(productAcl, productDirectory, policy.DirectoryOwners)
            ?? CheckRules(productAcl, productDirectory, onlyFull: [.. policy.ProductWriters], readOnlyAllowed: true, requireOwnerRights: false);
        if (problem is not null)
        {
            return problem;
        }

        var stateAcl = state.GetAccessControl();
        problem = CheckProtectedAndOwner(stateAcl, stateDirectory, policy.DirectoryOwners)
            ?? CheckRules(stateAcl, stateDirectory, onlyFull: [PathPolicy.LocalSystem, PathPolicy.Administrators, policy.ServiceSid], readOnlyAllowed: false, requireOwnerRights: true);
        if (problem is not null)
        {
            return problem;
        }

        var file = new FileInfo(stateFile);
        if (!file.Exists)
        {
            return null;
        }

        problem = CheckReparse(file);
        if (problem is not null)
        {
            return problem;
        }

        var fileAcl = file.GetAccessControl();
        var owner = fileAcl.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner is null || !policy.FileOwners.Contains(owner))
        {
            return $"{stateFile} has an unexpected owner {owner?.Value ?? "(none)"}";
        }

        return CheckRules(fileAcl, stateFile, onlyFull: [PathPolicy.LocalSystem, PathPolicy.Administrators, policy.ServiceSid], readOnlyAllowed: false, requireOwnerRights: true);
    }

    private static string? CheckReparse(FileSystemInfo info) =>
        info.Attributes.HasFlag(FileAttributes.ReparsePoint) ? $"{info.FullName} is a reparse point" : null;

    private static string? CheckProtectedAndOwner(DirectorySecurity acl, string path, IReadOnlyCollection<SecurityIdentifier> owners)
    {
        if (!acl.AreAccessRulesProtected)
        {
            return $"{path} inherits its access rules";
        }

        var owner = acl.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        return owner is not null && owners.Contains(owner) ? null : $"{path} has an unexpected owner {owner?.Value ?? "(none)"}";
    }

    /// <summary>
    /// Allow rules may name only <paramref name="onlyFull"/>, OWNER RIGHTS with
    /// read control, and, when <paramref name="readOnlyAllowed"/>, other SIDs
    /// with read rights only.
    /// </summary>
    private static string? CheckRules(FileSystemSecurity acl, string path, SecurityIdentifier[] onlyFull, bool readOnlyAllowed, bool requireOwnerRights)
    {
        var ownerRightsSeen = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow)
            {
                continue;
            }

            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (onlyFull.Contains(sid))
            {
                continue;
            }

            if (sid == PathPolicy.OwnerRights)
            {
                if ((rule.FileSystemRights & ~(FileSystemRights.ReadPermissions | FileSystemRights.Synchronize)) != 0)
                {
                    return $"{path} gives OWNER RIGHTS more than read control";
                }

                ownerRightsSeen = true;
                continue;
            }

            if (readOnlyAllowed && (rule.FileSystemRights & ~PathPolicy.ReadOnlyRights) == 0)
            {
                continue;
            }

            return $"{path} gives {sid.Value} access";
        }

        return requireOwnerRights && !ownerRightsSeen ? $"{path} does not restrict the owner (no OWNER RIGHTS rule)" : null;
    }
}
