using System.Globalization;
using System.Xml.Linq;
using WixToolset.Dtf.WindowsInstaller;

namespace Mashkif.Installer.Tests;

/// <summary>
/// The installer as built: the tables that decide how the enrollment key,
/// the server URL, the service SID type, and the ACLs are installed.
/// </summary>
public sealed class MsiTableTests
{
    /// <summary>The service SID of NT SERVICE\Mashkif (sc showsid Mashkif; checked in the agent tests).</summary>
    private const string ServiceSid = "S-1-5-80-955452773-2337780239-555098662-296726712-2311605372";

    private const int Transitive = 0x40;
    private const int RegistryKeyPath = 0x4;

    private const string StateSddl = $"D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{ServiceSid})(A;OICI;RC;;;OW)";
    private const string RegistrySddl = $"D:PAI(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KA;;;{ServiceSid})(A;CI;RC;;;OW)";

    public static TheoryData<string> Packages => ["Mashkif-{0}-x64.msi", "Mashkif-{0}-x64-he-IL.msi"];

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_enrollment_key_is_written_only_when_the_property_is_given(string package)
    {
        using var db = Open(package);
        var component = Row(db, "SELECT `Condition`, `Attributes` FROM `Component` WHERE `Component` = 'EnrollmentKeyValue'");
        Assert.Equal("ENROLLMENT_KEY", component[0]);
        var attributes = Number(component[1]);
        Assert.NotEqual(0, attributes & Transitive);
        Assert.NotEqual(0, attributes & RegistryKeyPath);

        var registry = Row(db, "SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry` WHERE `Component_` = 'EnrollmentKeyValue'");
        Assert.Equal(["2", @"SOFTWARE\Mashkif\Agent\Enrollment", "Key", "[ENROLLMENT_KEY]"], registry);
    }

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_enrollment_key_is_hidden_from_the_log_and_reaches_the_execute_sequence(string package)
    {
        using var db = Open(package);
        Assert.Contains("ENROLLMENT_KEY", PropertyList(db, "MsiHiddenProperties"));
        var secure = PropertyList(db, "SecureCustomProperties");
        Assert.Contains("ENROLLMENT_KEY", secure);
        Assert.Contains("SERVER_URL", secure);
    }

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_server_URL_is_remembered_by_a_registry_search_and_set_only_when_not_given(string package)
    {
        using var db = Open(package);
        var locator = Row(db, "SELECT `Root`, `Key`, `Name`, `Type` FROM `RegLocator` WHERE `Signature_` = 'SavedServerUrl'");
        Assert.Equal(["2", @"SOFTWARE\Mashkif\Agent", "ServerUrl"], locator.Take(3));
        // msidbLocatorTypeRawValue (2) in the 64-bit view (16).
        Assert.Equal(18, Number(locator[3]));
        Assert.Equal("SavedServerUrl", Row(db, "SELECT `Signature_` FROM `AppSearch` WHERE `Property` = 'SAVED_SERVER_URL'")[0]);

        var action = Row(db, "SELECT `Action`, `Type`, `Target` FROM `CustomAction` WHERE `Source` = 'SERVER_URL'");
        Assert.Equal(51, Number(action[1]) & 0x3F);
        Assert.Equal("[SAVED_SERVER_URL]", action[2]);
        Assert.Equal("NOT SERVER_URL AND SAVED_SERVER_URL", Row(db, $"SELECT `Condition` FROM `InstallExecuteSequence` WHERE `Action` = '{action[0]}'")[0]);

        var component = Row(db, "SELECT `Condition`, `Attributes` FROM `Component` WHERE `Component` = 'ServerUrlValue'");
        Assert.Equal("SERVER_URL", component[0]);
        Assert.NotEqual(0, Number(component[1]) & Transitive);
    }

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_service_runs_as_LocalService_with_an_unrestricted_service_SID(string package)
    {
        using var db = Open(package);
        Assert.Equal(["Mashkif", @"NT AUTHORITY\LocalService"], Row(db, "SELECT `Name`, `StartName` FROM `ServiceInstall`"));

        var config = Row(db, "SELECT `Name`, `Event`, `ConfigType`, `Argument` FROM `MsiServiceConfig`");
        Assert.Equal("Mashkif", config[0]);
        Assert.Equal(1 | 4, Number(config[1]) & (1 | 4));
        // SERVICE_CONFIG_SERVICE_SID_INFO (5) with SERVICE_SID_TYPE_UNRESTRICTED (1).
        Assert.Equal(["5", "1"], config.Skip(2));
    }

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_product_path_and_the_registry_keys_get_their_protected_ACLs(string package)
    {
        using var db = Open(package);
        var locks = Rows(db, "SELECT `LockObject`, `Table`, `SDDLText` FROM `MsiLockPermissionsEx`")
            .Select(r => (Object: r[0], Table: r[1], Sddl: r[2]))
            .ToList();

        Assert.Contains(("DataFolder", "CreateFolder", "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)(A;;RC;;;OW)"), locks);
        Assert.Contains(("ServiceLogFolder", "CreateFolder", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;LS)(A;OICI;0x1200a9;;;BU)(A;OICI;RC;;;OW)"), locks);
        Assert.Contains(("StateFolder", "CreateFolder", StateSddl), locks);

        var registryLocks = locks
            .Where(l => l.Table == "Registry")
            .Select(l => (Row: Row(db, $"SELECT `Key`, `Component_` FROM `Registry` WHERE `Registry` = '{l.Object}'"), l.Sddl))
            .ToList();
        Assert.Contains(registryLocks, l => l.Row[0] == @"SOFTWARE\Mashkif\Agent\Enrollment" && l.Row[1] == "AgentRegistryKeys");
        Assert.Contains(registryLocks, l => l.Row[0] == @"SOFTWARE\Mashkif\Agent\Service" && l.Row[1] == "AgentRegistryKeys");
        Assert.Contains(registryLocks, l => l.Row[0] == @"SOFTWARE\Mashkif\Agent\Enrollment" && l.Row[1] == "EnrollmentKeyValue");
        Assert.All(registryLocks, l => Assert.Equal(RegistrySddl, l.Sddl));
    }

    [Theory]
    [MemberData(nameof(Packages))]
    public void The_whole_registry_tree_is_removed_on_uninstall(string package)
    {
        using var db = Open(package);
        // A Registry row named "-" removes the key and its subkeys on uninstall.
        var rows = Rows(db, "SELECT `Key`, `Name` FROM `Registry` WHERE `Component_` = 'AgentRegistryKeys'");
        Assert.Contains(rows, r => r[0] == @"SOFTWARE\Mashkif" && r[1] == "-");
    }

    [Fact]
    public void The_upgrade_code_never_changes()
    {
        using var db = Open("Mashkif-{0}-x64.msi");
        Assert.Equal("{D80A17FB-1D99-47D0-A228-8FC027BE1667}", Row(db, "SELECT `Value` FROM `Property` WHERE `Property` = 'UpgradeCode'")[0]);
    }

    private static string AgentDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Mashkif.Agent.slnx")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new InvalidOperationException("agent/ not found above the test output");
    }

    private static Database Open(string package)
    {
        var agent = AgentDirectory();
        var version = (string)XDocument.Load(Path.Combine(agent, "Directory.Build.props")).Descendants("Version").First();
        var path = Path.Combine(agent, "artifacts", "msi", string.Format(CultureInfo.InvariantCulture, package, version));
        Assert.True(File.Exists(path), $"{path} is missing: build the MSI first (scripts/verify.sh --area agent does)");
        return new Database(path, DatabaseOpenMode.ReadOnly);
    }

    private static List<string[]> Rows(Database db, string sql)
    {
        using var view = db.OpenView(sql);
        view.Execute();
        var rows = new List<string[]>();
        foreach (var record in view)
        {
            using (record)
            {
                rows.Add([.. Enumerable.Range(1, record.FieldCount).Select(i => record.GetString(i) ?? string.Empty)]);
            }
        }

        return rows;
    }

    private static string[] Row(Database db, string sql)
    {
        var rows = Rows(db, sql);
        Assert.True(rows.Count == 1, $"Expected one row for: {sql}; got {rows.Count}");
        return rows[0];
    }

    private static int Number(string value) => int.Parse(value, CultureInfo.InvariantCulture);

    private static string[] PropertyList(Database db, string property) =>
        Row(db, $"SELECT `Value` FROM `Property` WHERE `Property` = '{property}'")[0].Split(';');
}
