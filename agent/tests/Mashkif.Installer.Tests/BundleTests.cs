using System.Globalization;
using System.Xml.Linq;
using WixToolset.Dtf.WindowsInstaller;

namespace Mashkif.Installer.Tests;

/// <summary>
/// The EXE installer as built: the Burn manifest and the bootstrapper
/// application data that <c>wix burn extract -oba</c> wrote into the folder
/// in MASHKIF_TEST_BUNDLE_BA (scripts/verify.sh --area agent sets it).
/// Without the variable or the files these tests fail, they never skip.
/// </summary>
public sealed class BundleTests
{
    private const string BundleUpgradeCode = "{8B44898D-0D6E-4E7D-AA33-220084833485}";
    private const string MsiUpgradeCode = "{D80A17FB-1D99-47D0-A228-8FC027BE1667}";

    private static readonly XNamespace Burn = "http://wixtoolset.org/schemas/v4/2008/Burn";
    private static readonly XNamespace BaData = "http://wixtoolset.org/schemas/v4/BootstrapperApplicationData";

    [Fact]
    public void The_bundle_upgrade_code_never_changes_and_is_not_the_MSI_upgrade_code()
    {
        var related = Manifest().Root!.Elements(Burn + "RelatedBundle").ToList();
        var upgrade = Assert.Single(related);
        Assert.Equal("Upgrade", (string?)upgrade.Attribute("Action"));
        Assert.Equal(BundleUpgradeCode, (string?)upgrade.Attribute("Code"));
        Assert.NotEqual(MsiUpgradeCode, BundleUpgradeCode);
    }

    [Fact]
    public void The_bundle_is_per_machine_and_has_one_Apps_and_Features_entry_without_modify()
    {
        var registration = Manifest().Root!.Element(Burn + "Registration")!;
        // WiX 7 writes Scope, not PerMachine, and names the bundle by Code.
        Assert.Equal("perMachine", (string?)registration.Attribute("Scope"));
        Assert.False(string.IsNullOrEmpty((string?)registration.Attribute("Code")));
        Assert.Null(registration.Attribute("BundleId"));
        Assert.Equal(BundleUpgradeCode, (string?)registration.Attribute("PrimaryUpgradeCode"));

        var arp = registration.Element(Burn + "Arp")!;
        Assert.Equal("Mashkif for Windows", (string?)arp.Attribute("DisplayName"));
        Assert.Equal("yes", (string?)arp.Attribute("DisableModify"));
    }

    [Fact]
    public void The_bundle_installs_exactly_the_English_MSI_hidden_from_Apps_and_Features()
    {
        var package = Assert.Single(Manifest().Root!.Element(Burn + "Chain")!.Elements());
        Assert.Equal(Burn + "MsiPackage", package.Name);
        Assert.Equal("perMachine", (string?)package.Attribute("Scope"));

        using var msi = new Database(MsiPath(), DatabaseOpenMode.ReadOnly);
        var productCode = Property(msi, "ProductCode");
        var version = Property(msi, "ProductVersion");
        Assert.Equal(productCode, (string?)package.Attribute("ProductCode"));
        Assert.Equal(Property(msi, "UpgradeCode"), (string?)package.Attribute("UpgradeCode"));
        Assert.Equal(MsiUpgradeCode, (string?)package.Attribute("UpgradeCode"));
        Assert.Equal("1033", (string?)package.Attribute("Language"));
        Assert.Equal($"{productCode}v{version}", (string?)package.Attribute("CacheId"));

        Assert.Equal("1", MsiProperty(package, "ARPSYSTEMCOMPONENT")?.Attribute("Value")?.Value);

        // The MSI's upgrade rows match every language, so Burn detects a
        // Hebrew MSI as related too and the EXE replaces it.
        var related = package.Elements(Burn + "RelatedPackage").ToList();
        Assert.NotEmpty(related);
        Assert.All(related, r =>
        {
            Assert.Equal(MsiUpgradeCode, (string?)r.Attribute("Id"));
            Assert.Empty(r.Elements(Burn + "Language"));
        });
    }

    [Fact]
    public void The_server_URL_reaches_the_MSI_only_when_it_is_set()
    {
        var package = Manifest().Root!.Element(Burn + "Chain")!.Element(Burn + "MsiPackage")!;
        var serverUrl = MsiProperty(package, "SERVER_URL");
        Assert.NotNull(serverUrl);
        Assert.Equal("[SERVER_URL]", (string?)serverUrl.Attribute("Value"));
        Assert.Equal("SERVER_URL", (string?)serverUrl.Attribute("Condition"));

        var variable = Assert.Single(Manifest().Root!.Elements(Burn + "Variable"));
        Assert.Equal("SERVER_URL", (string?)variable.Attribute("Id"));
        Assert.Null(variable.Attribute("Value"));
        Assert.Equal("no", (string?)variable.Attribute("Hidden"));
        Assert.Equal("no", (string?)variable.Attribute("Persisted"));
    }

    [Fact]
    public void Only_the_server_URL_can_be_set_on_the_command_line()
    {
        var overridable = BootstrapperApplicationData().Root!
            .Elements(BaData + "WixStdbaOverridableVariable")
            .Select(e => (string?)e.Attribute("Name"))
            .ToList();
        Assert.Equal(["SERVER_URL"], overridable);
    }

    [Fact]
    public void The_bundle_has_no_enrollment_key()
    {
        Assert.DoesNotContain("ENROLLMENT", Manifest().ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ENROLLMENT", BootstrapperApplicationData().ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static string BaFolder()
    {
        var folder = Environment.GetEnvironmentVariable("MASHKIF_TEST_BUNDLE_BA");
        Assert.False(string.IsNullOrEmpty(folder), "MASHKIF_TEST_BUNDLE_BA is not set: run scripts/verify.sh --area agent, which extracts the bundle");
        Assert.True(Directory.Exists(folder), $"{folder} does not exist");
        return folder;
    }

    private static XDocument Manifest() => Load(Path.Combine(BaFolder(), "manifest.xml"));

    private static XDocument BootstrapperApplicationData() => Load(Path.Combine(BaFolder(), "BootstrapperApplicationData.xml"));

    private static XDocument Load(string path)
    {
        Assert.True(File.Exists(path), $"{path} is missing");
        return XDocument.Load(path);
    }

    private static XElement? MsiProperty(XElement package, string id) =>
        package.Elements(Burn + "MsiProperty").SingleOrDefault(p => (string?)p.Attribute("Id") == id);

    private static string MsiPath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Mashkif.Agent.slnx")))
        {
            directory = directory.Parent;
        }

        var agent = directory?.FullName ?? throw new InvalidOperationException("agent/ not found above the test output");
        var version = (string)XDocument.Load(Path.Combine(agent, "Directory.Build.props")).Descendants("Version").First();
        var path = Path.Combine(agent, "artifacts", "msi", string.Format(CultureInfo.InvariantCulture, "Mashkif-{0}-x64.msi", version));
        Assert.True(File.Exists(path), $"{path} is missing: build the MSI first (scripts/verify.sh --area agent does)");
        return path;
    }

    private static string Property(Database db, string name)
    {
        using var view = db.OpenView($"SELECT `Value` FROM `Property` WHERE `Property` = '{name}'");
        view.Execute();
        using var record = view.Fetch();
        Assert.NotNull(record);
        return record.GetString(1);
    }
}
