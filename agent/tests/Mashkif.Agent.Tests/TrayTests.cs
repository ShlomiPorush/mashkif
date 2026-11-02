using System.Globalization;
using System.Xml.Linq;
using Mashkif.Tray;

namespace Mashkif.Agent.Tests;

public sealed class TrayTests
{
    private static readonly string[] Keys = TrayStrings.Keys;

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

public sealed class TrayStatusTests
{
    private static readonly CultureInfo English = CultureInfo.GetCultureInfo("en-US");
    private static readonly CultureInfo Hebrew = CultureInfo.GetCultureInfo("he-IL");

    public static TheoryData<string, string?, string> StatusLines => new()
    {
        { Mashkif.Common.Pipe.AgentStates.Unregistered, null, "StatusUnregistered" },
        { Mashkif.Common.Pipe.AgentStates.Registering, null, "StatusRegistering" },
        { Mashkif.Common.Pipe.AgentStates.Connected, null, "StatusConnected" },
        { Mashkif.Common.Pipe.AgentStates.Unreachable, null, "StatusUnreachable" },
        { Mashkif.Common.Pipe.AgentStates.Revoked, null, "StatusRevoked" },
        { Mashkif.Common.Pipe.AgentStates.Refused, "token_invalid", "StatusRefusedTokenInvalid" },
        { Mashkif.Common.Pipe.AgentStates.Refused, "server_changed", "StatusRefusedServerChanged" },
    };

    [Theory]
    [MemberData(nameof(StatusLines))]
    public void Each_state_has_its_own_line_in_both_languages(string state, string? reason, string key)
    {
        var status = new Mashkif.Common.Pipe.AgentStatus { State = state, Reason = reason };
        Assert.Equal(TrayStrings.Get(key, English), TrayStrings.StatusLine(status, English));
        Assert.Equal(TrayStrings.Get(key, Hebrew), TrayStrings.StatusLine(status, Hebrew));
    }

    [Fact]
    public void Other_refusals_show_their_code()
    {
        var status = new Mashkif.Common.Pipe.AgentStatus { State = Mashkif.Common.Pipe.AgentStates.Refused, Reason = "agent_blocked" };
        Assert.Contains("agent_blocked", TrayStrings.StatusLine(status, English), StringComparison.Ordinal);
        Assert.Contains("agent_blocked", TrayStrings.StatusLine(status, Hebrew), StringComparison.Ordinal);
    }

    [Fact]
    public void No_status_means_the_service_is_not_running()
    {
        Assert.Equal(TrayStrings.Get("StatusServiceUnavailable", English), TrayStrings.StatusLine(null, English));
    }

    [Theory]
    [InlineData("enrollment_key_invalid", "EnrollErrorKeyInvalid")]
    [InlineData("enrollment_key_expired", "EnrollErrorKeyExpired")]
    [InlineData("enrollment_key_revoked", "EnrollErrorKeyRevoked")]
    [InlineData("enrollment_key_used", "EnrollErrorKeyUsed")]
    [InlineData("agent_revoked", "EnrollErrorAgentRevoked")]
    [InlineData("already_registered", "EnrollErrorAlreadyRegistered")]
    [InlineData("registration_in_progress", "EnrollErrorInProgress")]
    [InlineData("enrollment_key_format", "EnrollFormatInvalid")]
    [InlineData("not_available", "EnrollErrorNotAvailable")]
    public void Enrollment_errors_have_messages(string code, string key)
    {
        Assert.Equal(TrayStrings.Get(key, Hebrew), TrayStrings.EnrollmentMessage(code, Hebrew));
    }

    [Fact]
    public void Every_status_line_fits_the_tooltip_with_the_product_name()
    {
        foreach (var culture in new[] { English, Hebrew })
        {
            foreach (var key in TrayStrings.Keys.Where(k => k.StartsWith("Status", StringComparison.Ordinal)))
            {
                var tooltip = $"{TrayStrings.ProductName(culture)}: {TrayStrings.Get(key, culture)}";
                Assert.InRange(tooltip.Length, 1, 127);
            }
        }
    }

    [Fact]
    public async Task The_enrollment_form_checks_the_key_format_before_sending_it()
    {
        var sent = new List<string>();
        using var form = new EnrollForm(key =>
        {
            sent.Add(key);
            return Task.FromResult<string?>("server says no");
        });
        form.SetKey("too-short");
        await form.SubmitAsync();
        Assert.Empty(sent);
        Assert.Equal(TrayStrings.Get("EnrollFormatInvalid"), form.MessageText);

        form.SetKey("  ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7 ");
        await form.SubmitAsync();
        Assert.Equal(["ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7"], sent);
        Assert.Equal("server says no", form.MessageText);
    }
}
