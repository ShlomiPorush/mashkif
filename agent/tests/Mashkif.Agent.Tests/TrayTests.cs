using System.Globalization;
using System.Xml.Linq;
using Mashkif.Tray;

namespace Mashkif.Agent.Tests;

public sealed class TrayTests
{
    private static readonly string[] Keys = ["ProductName", "Tooltip", "MenuExit"];

    public static TheoryData<string> NonHebrewCultures => ["en-US", "en", "fr-FR", "ar-SA", ""];

    [Theory]
    [InlineData("he-IL")]
    [InlineData("he")]
    public void Hebrew_UI_culture_gets_the_Hebrew_strings(string cultureName)
    {
        var culture = CultureInfo.GetCultureInfo(cultureName);
        var expected = ReadLocaleFile("Strings.he.resx");

        Assert.Equal(expected["ProductName"], TrayStrings.ProductName(culture));
        Assert.Equal(expected["Tooltip"], TrayStrings.Tooltip(culture));
        Assert.Equal(expected["MenuExit"], TrayStrings.MenuExit(culture));
        Assert.True(TrayStrings.IsRightToLeft(culture));
    }

    [Theory]
    [MemberData(nameof(NonHebrewCultures))]
    public void Other_UI_cultures_get_the_English_strings(string cultureName)
    {
        var culture = CultureInfo.GetCultureInfo(cultureName);
        var expected = ReadLocaleFile("Strings.resx");

        Assert.Equal("Mashkif", TrayStrings.ProductName(culture));
        Assert.Equal(expected["Tooltip"], TrayStrings.Tooltip(culture));
        Assert.Equal("Exit", TrayStrings.MenuExit(culture));
    }

    [Fact]
    public void Locale_files_define_the_same_keys_and_Hebrew_values_are_Hebrew()
    {
        var english = ReadLocaleFile("Strings.resx");
        var hebrew = ReadLocaleFile("Strings.he.resx");

        Assert.Equal(Keys.Order(), english.Keys.Order());
        Assert.Equal(Keys.Order(), hebrew.Keys.Order());
        foreach (var key in Keys)
        {
            Assert.True(HasHebrewLetter(hebrew[key]), $"{key} has no Hebrew letter");
            Assert.False(HasHebrewLetter(english[key]), $"{key} has a Hebrew letter");
        }
    }

    [Fact]
    public void Tooltip_fits_the_notification_area_limit()
    {
        // NotifyIcon.Text accepts at most 127 characters.
        foreach (var file in new[] { "Strings.resx", "Strings.he.resx" })
        {
            Assert.InRange(ReadLocaleFile(file)["Tooltip"].Length, 1, 127);
        }
    }

    private static Dictionary<string, string> ReadLocaleFile(string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "LocaleFiles", fileName);
        return XDocument.Load(path).Root!
            .Elements("data")
            .ToDictionary(
                data => (string)data.Attribute("name")!,
                data => (string)data.Element("value")!);
    }

    // Hebrew letters alef (U+05D0) to tav (U+05EA). Written as numbers so this
    // file stays free of Hebrew text.
    private static bool HasHebrewLetter(string value) =>
        value.Any(static c => c is >= (char)0x05D0 and <= (char)0x05EA);
}
