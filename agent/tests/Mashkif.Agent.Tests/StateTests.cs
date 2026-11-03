using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using Mashkif.Agent.Tests.Support;
using Mashkif.Service.Config;
using Mashkif.Service.State;
using Microsoft.Win32;

namespace Mashkif.Agent.Tests;

public sealed class StateTests : IDisposable
{
    private readonly StateFixture _f = new();

    public void Dispose() => _f.Dispose();

    private static AgentState Sample() => AgentState.Empty with
    {
        InstallId = EngineFixture.InstallId,
        Identity = EngineFixture.Identity(),
        IdentityState = IdentityStates.Active,
        IntervalSeconds = 120,
        NextSequence = 7,
    };

    [Fact]
    public void A_missing_file_is_an_empty_state()
    {
        var load = _f.CreateStore().Load();
        Assert.Null(load.Problem);
        Assert.Equal(AgentState.Empty, load.State);
    }

    [Fact]
    public void A_saved_state_reads_back_and_the_file_has_the_protected_DACL()
    {
        var store = _f.CreateStore();
        store.Save(Sample());
        Assert.Equal(Sample(), store.Load().State);
        Assert.False(File.Exists(store.TempPath));

        var acl = new FileInfo(store.FilePath).GetAccessControl();
        Assert.True(acl.AreAccessRulesProtected);
        var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(r => (((SecurityIdentifier)r.IdentityReference).Value, r.FileSystemRights))
            .ToHashSet();
        Assert.Equal(
            new HashSet<(string, FileSystemRights)>
            {
                (PathPolicy.LocalSystem.Value, FileSystemRights.FullControl),
                (PathPolicy.Administrators.Value, FileSystemRights.FullControl),
                (StateFixture.CurrentUser.Value, FileSystemRights.FullControl),
                (PathPolicy.OwnerRights.Value, FileSystemRights.ReadPermissions | FileSystemRights.Synchronize),
            },
            rules);
    }

    [Fact]
    public void A_leftover_temporary_file_is_replaced()
    {
        var store = _f.CreateStore();
        File.WriteAllText(store.TempPath, "garbage");
        store.Save(Sample());
        Assert.Equal(Sample(), store.Load().State);
        Assert.False(File.Exists(store.TempPath));
    }

    [Fact]
    public void A_failed_write_keeps_the_previous_state()
    {
        var store = _f.CreateStore();
        store.Save(Sample());
        store.BeforeReplace = () => throw new IOException("power cut");
        Assert.Throws<IOException>(() => store.Save(Sample() with { NextSequence = 99 }));
        store.BeforeReplace = null;
        Assert.Equal(7, store.Load().State!.NextSequence);
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("""{"schemaVersion":2,"identityState":"none","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"identityState":"active","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"identityState":"none","intervalSeconds":5,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"identityState":"none","intervalSeconds":60,"nextSequence":0,"surprise":true}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identity":{"serverOrigin":"https://mashkif.test","token":"short","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"active","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identityState":"none","pending":{"serverOrigin":"https://mashkif.test/path","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"identity":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"active","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identity":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"none","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identity":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"active","pending":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identityState":"revoked","pending":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identity":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"token_rejected","pending":{"serverOrigin":"https://other.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identityState":"suspended","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"00000000-0000-0000-0000-000000000000","identityState":"none","intervalSeconds":60,"nextSequence":0}""")]
    public void An_unreadable_or_inconsistent_state_is_a_problem_and_stays_untouched(string content)
    {
        File.WriteAllText(_f.StateFile, content);
        var load = _f.CreateStore().Load();
        Assert.NotNull(load.Problem);
        Assert.Null(load.State);
        Assert.Equal(content, File.ReadAllText(_f.StateFile));
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identityState":"none","pending":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identity":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","agentId":"22222222-2222-4222-8222-222222222222"},"identityState":"token_rejected","pending":{"serverOrigin":"https://mashkif.test","token":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"lastRegisterAttemptUtc":"2026-11-02T09:00:00+00:00","intervalSeconds":60,"nextSequence":0}""")]
    [InlineData("""{"schemaVersion":1,"installId":"11111111-1111-4111-8111-111111111111","identityState":"revoked","intervalSeconds":60,"nextSequence":0}""")]
    public void The_states_of_registration_the_401_cycle_and_a_revoke_are_valid(string content)
    {
        File.WriteAllText(_f.StateFile, content);
        var load = _f.CreateStore().Load();
        Assert.Null(load.Problem);
        Assert.NotNull(load.State);
    }

    [Fact]
    public void The_production_path_checks_accept_the_installed_ACL_shape()
    {
        Assert.Null(PathSecurity.Check(_f.ProductDirectory, _f.StateDirectory, _f.StateFile, _f.Policy));
        _f.CreateStore().Save(Sample());
        Assert.Null(PathSecurity.Check(_f.ProductDirectory, _f.StateDirectory, _f.StateFile, _f.Policy));
    }

    [Fact]
    public void An_unprotected_product_directory_is_refused()
    {
        var acl = new DirectoryInfo(_f.ProductDirectory).GetAccessControl();
        acl.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);
        new DirectoryInfo(_f.ProductDirectory).SetAccessControl(acl);
        Assert.Contains("inherits", Check(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_product_directory_that_lets_users_write_is_refused()
    {
        AddRule(_f.ProductDirectory, new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Modify);
        Assert.Contains("S-1-5-32-545", Check(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(WellKnownSidType.BuiltinUsersSid)]
    [InlineData(WellKnownSidType.LocalServiceSid)]
    [InlineData(WellKnownSidType.WorldSid)]
    public void A_state_directory_that_lets_anyone_else_read_is_refused(WellKnownSidType type)
    {
        var sid = new SecurityIdentifier(type, null);
        AddRule(_f.StateDirectory, sid, FileSystemRights.Read);
        Assert.Contains(sid.Value, Check(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_state_file_that_lets_users_read_is_refused()
    {
        _f.CreateStore().Save(Sample());
        var info = new FileInfo(_f.StateFile);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Read, AccessControlType.Allow));
        info.SetAccessControl(acl);
        Assert.Contains("S-1-5-32-545", Check(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_state_directory_without_the_owner_restriction_is_refused()
    {
        using var other = new StateFixtureWith(StateFixture.StateSecurity(includeOwnerRights: false));
        Assert.Contains("OWNER RIGHTS", other.Check(), StringComparison.Ordinal);
    }

    [Fact]
    public void An_owner_restriction_that_grants_more_than_read_control_is_refused()
    {
        using var other = new StateFixtureWith(StateFixture.StateSecurity(ownerRights: FileSystemRights.ReadPermissions | FileSystemRights.ChangePermissions));
        Assert.Contains("OWNER RIGHTS", other.Check(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_directory_owned_by_someone_unexpected_is_refused()
    {
        var policy = new PathPolicy(
            StateFixture.CurrentUser,
            [PathPolicy.LocalSystem, PathPolicy.Administrators, StateFixture.CurrentUser],
            [PathPolicy.LocalSystem],
            [PathPolicy.LocalSystem]);
        var owner = new DirectoryInfo(_f.ProductDirectory).GetAccessControl().GetOwner(typeof(SecurityIdentifier))!;
        Assert.NotEqual(PathPolicy.LocalSystem, owner);
        Assert.Contains("owner", PathSecurity.Check(_f.ProductDirectory, _f.StateDirectory, _f.StateFile, policy), StringComparison.Ordinal);
    }

    [Fact]
    public void A_missing_directory_is_refused()
    {
        Assert.NotNull(PathSecurity.Check(Path.Combine(_f.ProductDirectory, "missing"), _f.StateDirectory, _f.StateFile, _f.Policy));
        Assert.NotNull(PathSecurity.Check(_f.ProductDirectory, Path.Combine(_f.StateDirectory, "missing"), _f.StateFile, _f.Policy));
    }

    [Fact]
    public void A_junction_at_the_product_level_is_refused()
    {
        using var scratch = new TestScratch();
        var link = scratch.File("Mashkif");
        Junction(link, _f.ProductDirectory);
        var problem = PathSecurity.Check(link, Path.Combine(link, "state"), Path.Combine(link, "state", StateStore.FileName), _f.Policy);
        Assert.Contains("reparse point", problem, StringComparison.Ordinal);
        Directory.Delete(link);
    }

    [Fact]
    public void A_junction_at_the_state_level_is_refused()
    {
        using var scratch = new TestScratch();
        var link = Path.Combine(_f.ProductDirectory, "linked-state");
        Junction(link, _f.StateDirectory);
        var problem = PathSecurity.Check(_f.ProductDirectory, link, Path.Combine(link, StateStore.FileName), _f.Policy);
        Assert.Contains("reparse point", problem, StringComparison.Ordinal);
        Directory.Delete(link);
    }

    [Fact]
    public void The_service_SID_constant_is_the_SID_of_NT_SERVICE_Mashkif()
    {
        // sc showsid computes the service SID from the name, also before the service exists.
        using var process = Process.Start(new ProcessStartInfo("sc.exe", ["showsid", "Mashkif"])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
        })!;
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        var sid = System.Text.RegularExpressions.Regex.Match(output, @"S-1-5-80(-\d+){5}").Value;
        Assert.Equal(PathPolicy.MashkifServiceSid.Value, sid);
    }

    [Fact]
    public void The_production_policy_allows_only_SYSTEM_and_Administrators_to_own_or_write_the_product_path()
    {
        var policy = PathPolicy.Production();
        Assert.Equal(PathPolicy.MashkifServiceSid, policy.ServiceSid);
        Assert.Equal([PathPolicy.LocalSystem, PathPolicy.Administrators], policy.ProductWriters);
        Assert.Equal([PathPolicy.LocalSystem, PathPolicy.Administrators], policy.DirectoryOwners);
        Assert.Equal([PathPolicy.LocalSystem, PathPolicy.Administrators, PathPolicy.LocalService, PathPolicy.MashkifServiceSid], policy.FileOwners);
    }

    [Fact]
    public void The_boot_ID_survives_a_restart_and_lives_in_a_volatile_key()
    {
        using var registry = new TestRegistry();
        using (registry.Root.CreateSubKey(registry.ServiceKeyPath))
        {
        }

        var first = BootIdentity.GetOrCreate(registry.Root, registry.ServiceKeyPath);
        var second = BootIdentity.GetOrCreate(registry.Root, registry.ServiceKeyPath);
        Assert.Equal(first, second);
        Assert.NotEqual(Guid.Empty, first);

        // Only a volatile key refuses a non-volatile child (ERROR_CHILD_MUST_BE_VOLATILE).
        using var boot = registry.Root.OpenSubKey($@"{registry.ServiceKeyPath}\{BootIdentity.BootSubkey}", writable: true)!;
        Assert.ThrowsAny<IOException>(() => boot.CreateSubKey("child"));
    }

    [Fact]
    public void A_missing_service_key_is_an_error()
    {
        using var registry = new TestRegistry();
        Assert.Throws<InvalidOperationException>(() => BootIdentity.GetOrCreate(registry.Root, registry.ServiceKeyPath));
    }

    [Fact]
    public void The_server_URL_is_read_from_the_registry()
    {
        using var registry = new TestRegistry();
        Assert.Null(registry.Agent.ReadServerUrl());
        using (var agent = registry.Root.CreateSubKey(registry.Agent.AgentKeyPath))
        {
            agent.SetValue(AgentRegistry.ServerUrlValue, "http://localhost:8080");
        }

        Assert.Equal("http://localhost:8080", registry.Agent.ReadServerUrl());
    }

    private string Check() => PathSecurity.Check(_f.ProductDirectory, _f.StateDirectory, _f.StateFile, _f.Policy) ?? "(no problem)";

    private static void AddRule(string directory, SecurityIdentifier sid, FileSystemRights rights)
    {
        var info = new DirectoryInfo(directory);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }

    private static void Junction(string link, string target)
    {
        // mklink /J needs no privilege, unlike a symbolic link.
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
        })!;
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
    }

    /// <summary>A state directory created with a given DACL.</summary>
    private sealed class StateFixtureWith : IDisposable
    {
        private readonly TestScratch _scratch = new();
        private readonly string _product;
        private readonly string _state;
        private readonly PathPolicy _policy;

        public StateFixtureWith(DirectorySecurity stateSecurity)
        {
            _product = _scratch.File("Mashkif");
            _state = Path.Combine(_product, "state");
            new DirectoryInfo(_product).Create(StateFixture.ProductSecurity());
            new DirectoryInfo(_state).Create(stateSecurity);
            using var reference = new StateFixture();
            _policy = reference.Policy;
        }

        public string Check() => PathSecurity.Check(_product, _state, Path.Combine(_state, StateStore.FileName), _policy) ?? "(no problem)";

        public void Dispose() => _scratch.Dispose();
    }
}

/// <summary>A throwaway registry location under HKCU\Software\Mashkif.Tests.</summary>
internal sealed class TestRegistry : IDisposable
{
    private readonly string _base = $@"Software\Mashkif.Tests\{Guid.NewGuid():N}";

    public TestRegistry()
    {
        Agent = new AgentRegistry(Root, $@"{_base}\Agent");
    }

    public RegistryKey Root { get; } = Registry.CurrentUser;

    public AgentRegistry Agent { get; }

    public string ServiceKeyPath => Agent.ServiceKeyPath;

    public void Dispose() => Root.DeleteSubKeyTree(_base, throwOnMissingSubKey: false);
}
