using System.Globalization;
using System.Resources;
using Mashkif.Common.Pipe;

namespace Mashkif.Tray;

/// <summary>
/// Localized tray strings from Resources/Strings.resx (English) and its
/// satellite files. A Hebrew UI culture gets Hebrew; any other culture gets English.
/// </summary>
internal static class TrayStrings
{
    internal const string BaseName = "Mashkif.Tray.Resources.Strings";

    /// <summary>Every key in the locale files.</summary>
    internal static readonly string[] Keys =
    [
        "ProductName", "Tooltip", "MenuExit",
        "StatusUnregistered", "StatusRegistering", "StatusConnected", "StatusUnreachable", "StatusRefused",
        "StatusRefusedRegistrationClosed", "StatusRefusedTokenInvalid", "StatusRefusedServerChanged", "StatusRevoked",
        "StatusServiceUnavailable", "StatusLastContact", "MenuRejoin", "RejoinFailed",
    ];

    private static readonly ResourceManager Resources = new(BaseName, typeof(TrayStrings).Assembly);

    public static string ProductName(CultureInfo? culture = null) => Get(nameof(ProductName), culture);

    public static string Tooltip(CultureInfo? culture = null) => Get(nameof(Tooltip), culture);

    public static string MenuExit(CultureInfo? culture = null) => Get(nameof(MenuExit), culture);

    public static bool IsRightToLeft(CultureInfo? culture = null) =>
        (culture ?? CultureInfo.CurrentUICulture).TextInfo.IsRightToLeft;

    /// <summary>The string <paramref name="name"/>; throws when a locale file lacks it.</summary>
    public static string Get(string name, CultureInfo? culture = null) =>
        Resources.GetString(name, culture ?? CultureInfo.CurrentUICulture)
        ?? throw new InvalidOperationException($"Missing tray string: {name}");

    /// <summary>The status line for <paramref name="status"/>, or the "service not running" line when it is null.</summary>
    public static string StatusLine(AgentStatus? status, CultureInfo? culture = null)
    {
        if (status is null)
        {
            return Get("StatusServiceUnavailable", culture);
        }

        return status.State switch
        {
            AgentStates.Unregistered => Get("StatusUnregistered", culture),
            AgentStates.Registering => Get("StatusRegistering", culture),
            AgentStates.Connected => Get("StatusConnected", culture),
            AgentStates.Unreachable => Get("StatusUnreachable", culture),
            AgentStates.Revoked => Get("StatusRevoked", culture),
            AgentStates.Refused when status.Reason == StatusReasons.RegistrationClosed => Get("StatusRefusedRegistrationClosed", culture),
            AgentStates.Refused when status.Reason == StatusReasons.TokenInvalid => Get("StatusRefusedTokenInvalid", culture),
            AgentStates.Refused when status.Reason == StatusReasons.ServerChanged => Get("StatusRefusedServerChanged", culture),
            _ => string.Format(culture ?? CultureInfo.CurrentCulture, Get("StatusRefused", culture), status.Reason ?? status.State),
        };
    }
}
