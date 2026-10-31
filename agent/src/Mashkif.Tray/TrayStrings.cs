using System.Globalization;
using System.Resources;

namespace Mashkif.Tray;

/// <summary>
/// Localized tray strings from Resources/Strings.resx (English) and its
/// satellite files. A Hebrew UI culture gets Hebrew; any other culture gets English.
/// </summary>
internal static class TrayStrings
{
    internal const string BaseName = "Mashkif.Tray.Resources.Strings";

    private static readonly ResourceManager Resources = new(BaseName, typeof(TrayStrings).Assembly);

    public static string ProductName(CultureInfo? culture = null) => Get(nameof(ProductName), culture);

    public static string Tooltip(CultureInfo? culture = null) => Get(nameof(Tooltip), culture);

    public static string MenuExit(CultureInfo? culture = null) => Get(nameof(MenuExit), culture);

    public static bool IsRightToLeft(CultureInfo? culture = null) =>
        (culture ?? CultureInfo.CurrentUICulture).TextInfo.IsRightToLeft;

    private static string Get(string name, CultureInfo? culture) =>
        Resources.GetString(name, culture ?? CultureInfo.CurrentUICulture)
        ?? throw new InvalidOperationException($"Missing tray string: {name}");
}
