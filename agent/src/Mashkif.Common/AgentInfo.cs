using System.Reflection;

namespace Mashkif.Common;

/// <summary>Version information shared by the agent components.</summary>
public static class AgentInfo
{
    /// <summary>
    /// Informational version of the given assembly without the source revision
    /// suffix, for example "0.1.0".
    /// </summary>
    public static string VersionOf(Assembly assembly)
    {
        ArgumentNullException.ThrowIfNull(assembly);
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "unknown";
        var plus = version.IndexOf('+', StringComparison.Ordinal);
        return plus >= 0 ? version[..plus] : version;
    }
}
