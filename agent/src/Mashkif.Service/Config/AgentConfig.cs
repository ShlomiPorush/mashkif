using System.Net;
using Microsoft.Win32;

namespace Mashkif.Service.Config;

/// <summary>Registry locations that the MSI creates and the service reads.</summary>
internal sealed class AgentRegistry(RegistryKey root, string agentKeyPath)
{
    /// <summary>The service's location: HKLM (64-bit view), SOFTWARE\Mashkif\Agent.</summary>
    public const string ProductionAgentKeyPath = @"SOFTWARE\Mashkif\Agent";

    public const string ServerUrlValue = "ServerUrl";

    public const string EnrollmentSubkey = "Enrollment";

    public const string EnrollmentKeyValue = "Key";

    public const string ServiceSubkey = "Service";

    public RegistryKey Root => root;

    public string AgentKeyPath => agentKeyPath;

    public string EnrollmentKeyPath => $@"{agentKeyPath}\{EnrollmentSubkey}";

    public string ServiceKeyPath => $@"{agentKeyPath}\{ServiceSubkey}";

    public static AgentRegistry Production() =>
        new(RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64), ProductionAgentKeyPath);

    /// <summary>The configured server URL, or null when the value is absent.</summary>
    public string? ReadServerUrl()
    {
        using var key = root.OpenSubKey(agentKeyPath, writable: false);
        return key?.GetValue(ServerUrlValue) as string;
    }
}

/// <summary>
/// The server the agent talks to. <c>SERVER_URL</c> must be an origin: https,
/// or plain http only to loopback for development.
/// </summary>
internal static class ServerOrigin
{
    public const string DefaultServerUrl = "https://mashkif.co.il";

    /// <summary>
    /// Validates <paramref name="value"/> (null means the default) and returns
    /// its normalized origin, <c>scheme://host[:port]</c> in lowercase without
    /// the default port, or null when it is not acceptable.
    /// </summary>
    public static Uri? Parse(string? value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? DefaultServerUrl : value.Trim();
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            return null;
        }

        var secure = uri.Scheme == Uri.UriSchemeHttps;
        if (!secure && !(uri.Scheme == Uri.UriSchemeHttp && IsLoopback(uri)))
        {
            return null;
        }

        if (uri.UserInfo.Length > 0 || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0
            || string.IsNullOrEmpty(uri.Host))
        {
            return null;
        }

        var normalized = uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped).ToLowerInvariant();
        return new Uri(normalized + "/");
    }

    /// <summary>The origin as stored in the state file, without the trailing slash.</summary>
    public static string Key(Uri origin) => origin.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped);

    private static bool IsLoopback(Uri uri) =>
        uri.IsLoopback
        || (IPAddress.TryParse(uri.DnsSafeHost, out var address) && IPAddress.IsLoopback(address));
}
