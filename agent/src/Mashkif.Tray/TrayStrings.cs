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
        "StatusRefusedTokenInvalid", "StatusRefusedServerChanged", "StatusRevoked", "StatusServiceUnavailable",
        "StatusLastContact", "MenuEnroll",
        "EnrollTitle", "EnrollPrompt", "EnrollOk", "EnrollCancel", "EnrollFormatInvalid",
        "EnrollErrorKeyInvalid", "EnrollErrorKeyExpired", "EnrollErrorKeyRevoked", "EnrollErrorKeyUsed",
        "EnrollErrorAgentRevoked", "EnrollErrorAlreadyRegistered", "EnrollErrorInProgress", "EnrollErrorNotAvailable",
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
            AgentStates.Refused when status.Reason == StatusReasons.TokenInvalid => Get("StatusRefusedTokenInvalid", culture),
            AgentStates.Refused when status.Reason == StatusReasons.ServerChanged => Get("StatusRefusedServerChanged", culture),
            _ => string.Format(culture ?? CultureInfo.CurrentCulture, Get("StatusRefused", culture), status.Reason ?? status.State),
        };
    }

    /// <summary>The message for a pipe error or an enrollment error code, or null for an unknown code.</summary>
    public static string? EnrollmentMessage(string? code, CultureInfo? culture = null) => code switch
    {
        StatusReasons.EnrollmentKeyInvalid => Get("EnrollErrorKeyInvalid", culture),
        StatusReasons.EnrollmentKeyExpired => Get("EnrollErrorKeyExpired", culture),
        StatusReasons.EnrollmentKeyRevoked => Get("EnrollErrorKeyRevoked", culture),
        StatusReasons.EnrollmentKeyUsed => Get("EnrollErrorKeyUsed", culture),
        StatusReasons.AgentRevoked => Get("EnrollErrorAgentRevoked", culture),
        PipeErrors.AlreadyRegistered => Get("EnrollErrorAlreadyRegistered", culture),
        PipeErrors.RegistrationInProgress => Get("EnrollErrorInProgress", culture),
        PipeErrors.EnrollmentKeyFormat => Get("EnrollFormatInvalid", culture),
        PipeErrors.NotAvailable => Get("EnrollErrorNotAvailable", culture),
        _ => null,
    };
}
