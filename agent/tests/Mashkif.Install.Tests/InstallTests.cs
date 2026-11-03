using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using Mashkif.Common.Pipe;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using WixToolset.Dtf.WindowsInstaller;

namespace Mashkif.Install.Tests;

/// <summary>
/// A real install, repair, upgrade, and uninstall on a disposable runner,
/// against a fake agent API on loopback. One test, because the steps build
/// on each other.
/// </summary>
public sealed partial class InstallTests(InstallSafetyGate gate)
{
    private const string ServiceSid = "S-1-5-80-955452773-2337780239-555098662-296726712-2311605372";

    private const string ProductSddl = "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)(A;;RC;;;OW)";
    private const string StateSddl = $"D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{ServiceSid})(A;OICI;RC;;;OW)";
    private const string RegistrySddl = $"D:PAI(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KA;;;{ServiceSid})(A;CI;RC;;;OW)";

    private static readonly string StateDirectory = Path.Combine(InstallSafetyGate.ProductDirectory, "state");
    private static readonly string StateFile = Path.Combine(StateDirectory, "state.json");
    private static readonly string ServiceLog = Path.Combine(InstallSafetyGate.ProductDirectory, "logs", "service.log");

    [Fact]
    public async Task Install_registers_by_itself_and_repair_upgrade_and_uninstall_keep_the_identity_and_the_ACLs()
    {
        Assert.True(gate.Passed);
        var msi = RequiredFile("MASHKIF_INSTALL_TEST_MSI");
        var upgradeMsi = RequiredFile("MASHKIF_INSTALL_TEST_UPGRADE_MSI");
        var logs = Environment.GetEnvironmentVariable("MASHKIF_TEST_TMP") ?? Path.GetTempPath();
        Directory.CreateDirectory(logs);

        using var api = new FakeAgentApi();
        var userCreated = false;
        try
        {
            // 1. Install with no property but the loopback server: the service registers by itself.
            var installLog = Path.Combine(logs, "install.log");
            Msiexec("/i", msi, $"SERVER_URL={api.Origin}", "/qn", "/l*v", installLog);

            // 2. Service SID type and ACLs.
            Assert.Contains("UNRESTRICTED", Run("sc.exe", "qsidtype", "Mashkif"), StringComparison.Ordinal);
            await WaitForStatusAsync(AgentStates.Connected);
            AssertAcls();

            // 3. One registration with the saved install ID and token, and the
            //    token in no log.
            var registration = api.Registrations.Single();
            var identity = Identity();
            Assert.Equal(registration.InstallId, StateValue("installId"));
            Assert.Equal(registration.Token, IdentityToken());
            AssertTokenAbsent(registration.Token, installLog, ServiceLog);

            // 4. A standard user: status yes, a server instance and the state no.
            //    A network logon of the same user is refused by the NETWORK rule.
            var password = "Mk1!" + Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
            Run("net.exe", "user", InstallSafetyGate.TestUser, password, "/add");
            userCreated = true;
            AsUser(LogonInteractive, password, () =>
            {
                Assert.Equal(AgentStates.Connected, Status()?.State);
                Assert.Throws<UnauthorizedAccessException>(() => Connect(PipeDirection.InOut));
                Assert.Throws<UnauthorizedAccessException>(() => new NamedPipeServerStream(PipeProtocol.PipeName, PipeDirection.InOut, 4).Dispose());
                Assert.Throws<UnauthorizedAccessException>(() => Directory.GetFiles(StateDirectory));
                Assert.Throws<UnauthorizedAccessException>(() => File.ReadAllBytes(StateFile));
            });
            AsUser(LogonNetwork, password, () =>
                Assert.Throws<UnauthorizedAccessException>(() => ConnectWithClientRights().Dispose()));

            // 5. Repair, then an upgrade to a higher version: the ACLs, the install
            //    ID, and the identity stay, SERVER_URL is remembered, and the PC
            //    never registers again.
            var repairLog = Path.Combine(logs, "repair.log");
            Msiexec("/fa", msi, "/qn", "/l*v", repairLog);
            await WaitForStatusAsync(AgentStates.Connected);
            AssertAcls();
            Assert.Equal(identity, Identity());

            var oldProducts = ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode).Select(p => p.ProductCode).ToList();
            var upgradeLog = Path.Combine(logs, "upgrade.log");
            Msiexec("/i", upgradeMsi, "/qn", "/l*v", upgradeLog);
            await WaitForStatusAsync(AgentStates.Connected);
            Assert.All(oldProducts, code => Assert.False(new ProductInstallation(code).IsInstalled));
            var installed = ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode).Single();
            Assert.Equal(new Version(0, 1, 1), new Version(installed.ProductVersion.Major, installed.ProductVersion.Minor, installed.ProductVersion.Build));
            Assert.Equal(api.Origin, ServerUrlValue());
            AssertAcls();
            Assert.Equal(identity, Identity());
            Assert.Single(api.Registrations);
            AssertTokenAbsent(registration.Token, repairLog, upgradeLog, ServiceLog);

            // 6. Uninstall: the service and the registry keys go, the state stays.
            var uninstallLog = Path.Combine(logs, "uninstall.log");
            Msiexec("/x", installed.ProductCode, "/qn", "/l*v", uninstallLog);
            await WaitUntilAsync(() => !ServiceExists(), "the service is removed");
            using (var machine = Hklm())
            using (var product = machine.OpenSubKey(InstallSafetyGate.ProductRegistryKey))
            {
                Assert.Null(product);
            }

            Assert.True(File.Exists(StateFile));
            Assert.Equal(identity, Identity());
            AssertTokenAbsent(registration.Token, uninstallLog);
        }
        finally
        {
            // 7. Clean up only what this test created; the gate proved that none
            //    of it existed before.
            foreach (var product in ProductInstallation.GetRelatedProducts(InstallSafetyGate.UpgradeCode).ToList())
            {
                Run("msiexec.exe", "/x", product.ProductCode, "/qn");
            }

            if (userCreated)
            {
                Run("net.exe", "user", InstallSafetyGate.TestUser, "/delete");
            }

            if (Directory.Exists(InstallSafetyGate.ProductDirectory))
            {
                Directory.Delete(InstallSafetyGate.ProductDirectory, recursive: true);
            }

            using var machine = Hklm();
            machine.DeleteSubKeyTree(InstallSafetyGate.ProductRegistryKey, throwOnMissingSubKey: false);
        }
    }

    private static void AssertAcls()
    {
        AssertSddl(ProductSddl, new DirectoryInfo(InstallSafetyGate.ProductDirectory).GetAccessControl());
        AssertSddl(StateSddl, new DirectoryInfo(StateDirectory).GetAccessControl());
        using var machine = Hklm();
        using (var service = machine.OpenSubKey(@"SOFTWARE\Mashkif\Agent\Service")!)
        {
            AssertSddl(RegistrySddl, service.GetAccessControl());
        }

        Assert.Null(machine.OpenSubKey(@"SOFTWARE\Mashkif\Agent\Enrollment"));

        // state.json: written by the service with its explicit protected DACL.
        var file = new FileInfo(StateFile).GetAccessControl();
        Assert.True(file.AreAccessRulesProtected);
        var rules = Aces(new RawSecurityDescriptor(file.GetSecurityDescriptorSddlForm(AccessControlSections.Access)));
        Assert.Equal(4, rules.Count);
        Assert.Contains(rules, r => r.Sid == ServiceSid);
        Assert.Contains(rules, r => r.Sid == "S-1-3-4" && (r.Mask & ~0x00120000) == 0);
        Assert.All(rules, r => Assert.Contains(r.Sid, new[] { "S-1-5-18", "S-1-5-32-544", ServiceSid, "S-1-3-4" }));
    }

    private static void AssertSddl(string expected, ObjectSecurity actual)
    {
        Assert.True(actual.AreAccessRulesProtected);
        var want = Aces(new RawSecurityDescriptor(expected));
        var have = Aces(new RawSecurityDescriptor(actual.GetSecurityDescriptorSddlForm(AccessControlSections.Access)));
        Assert.Equal(want.OrderBy(a => a.ToString()), have.OrderBy(a => a.ToString()));
    }

    private sealed record Ace(AceType Type, AceFlags Flags, int Mask, string Sid);

    private static List<Ace> Aces(RawSecurityDescriptor descriptor) =>
        [.. descriptor.DiscretionaryAcl!.Cast<CommonAce>().Select(a => new Ace(a.AceType, a.AceFlags & ~AceFlags.Inherited, a.AccessMask, a.SecurityIdentifier.Value))];

    private static RegistryKey Hklm() => RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);

    private static string? ServerUrlValue()
    {
        using var machine = Hklm();
        using var key = machine.OpenSubKey(@"SOFTWARE\Mashkif\Agent");
        return key?.GetValue("ServerUrl") as string;
    }

    private static bool ServiceExists()
    {
        using var machine = Hklm();
        using var service = machine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\Mashkif");
        return service is not null;
    }

    /// <summary>The install ID and the identity, as saved by the service.</summary>
    private static string Identity()
    {
        var state = JsonNode.Parse(File.ReadAllText(StateFile))!;
        return $"{state["installId"]!.ToJsonString()} {state["identity"]!.ToJsonString()}";
    }

    private static string StateValue(string name) => JsonNode.Parse(File.ReadAllText(StateFile))![name]!.GetValue<string>();

    private static string IdentityToken() => JsonNode.Parse(File.ReadAllText(StateFile))!["identity"]!["token"]!.GetValue<string>();

    private static void AssertTokenAbsent(string token, params string[] logFiles)
    {
        foreach (var file in logFiles)
        {
            Assert.True(File.Exists(file), $"{file} is missing");
            Assert.DoesNotContain(token, ReadAll(file), StringComparison.Ordinal);
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, $"Timed out waiting until {what}");
            await Task.Delay(1000);
        }
    }

    private static string ReadAll(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static string RequiredFile(string variable)
    {
        var path = Environment.GetEnvironmentVariable(variable);
        Assert.False(string.IsNullOrEmpty(path), $"{variable} is not set");
        Assert.True(File.Exists(path), $"{path} does not exist");
        return path;
    }

    private static void Msiexec(params string[] arguments)
    {
        var output = RunWithExitCode("msiexec.exe", arguments, out var exitCode);
        Assert.True(exitCode == 0, $"msiexec {string.Join(' ', arguments)} exited with {exitCode}: {output}");
    }

    private static string Run(string file, params string[] arguments)
    {
        var output = RunWithExitCode(file, arguments, out var exitCode);
        Assert.True(exitCode == 0, $"{file} {arguments.FirstOrDefault()} exited with {exitCode}: {output}");
        return output;
    }

    private static string RunWithExitCode(string file, string[] arguments, out int exitCode)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        })!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        exitCode = process.ExitCode;
        return output.Result + error.Result;
    }

    private static async Task WaitForStatusAsync(string state)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(90);
        AgentStatus? last = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                last = Status();
                if (last?.State == state)
                {
                    return;
                }
            }
            catch (Exception exception) when (exception is IOException or TimeoutException or UnauthorizedAccessException)
            {
            }

            await Task.Delay(1000);
        }

        Assert.Fail($"The service did not reach {state}; last status {last}");
    }

    private static NamedPipeClientStream ConnectWithClientRights()
    {
        var pipe = new NamedPipeClientStream(
            ".",
            PipeProtocol.PipeName,
            PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize,
            PipeOptions.None,
            TokenImpersonationLevel.Identification,
            HandleInheritability.None);
        pipe.Connect(5000);
        return pipe;
    }

    private static void Connect(PipeDirection direction)
    {
        using var pipe = new NamedPipeClientStream(".", PipeProtocol.PipeName, direction, PipeOptions.None, TokenImpersonationLevel.Identification);
        pipe.Connect(5000);
    }

    /// <summary>One status request over the pipe, synchronously (it may run impersonated).</summary>
    private static AgentStatus? Status()
    {
        using var pipe = ConnectWithClientRights();
        PipeLines.WriteLineAsync(pipe, new PipeRequest { Command = PipeProtocol.StatusCommand }, PipeJsonContext.Default.PipeRequest, CancellationToken.None).GetAwaiter().GetResult();
        var line = PipeLines.ReadLineAsync(pipe, PipeProtocol.MaxResponseBytes, CancellationToken.None).GetAwaiter().GetResult();
        return PipeLines.Parse(line, PipeJsonContext.Default.PipeResponse)?.Status;
    }

    private const int LogonInteractive = 2;
    private const int LogonNetwork = 3;

    /// <summary>Runs <paramref name="action"/> impersonating the test user, without a new process or desktop.</summary>
    private static void AsUser(int logonType, string password, Action action)
    {
        if (!LogonUserW(InstallSafetyGate.TestUser, ".", password, logonType, 0, out var token))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), $"LogonUser type {logonType} failed");
        }

        using (token)
        {
            WindowsIdentity.RunImpersonated(token, action);
        }
    }

    [LibraryImport("advapi32.dll", EntryPoint = "LogonUserW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool LogonUserW(string user, string domain, string password, int logonType, int logonProvider, out SafeAccessTokenHandle token);

    /// <summary>One register request the fake API received.</summary>
    private sealed record Registration(string InstallId, string Token);

    /// <summary>A minimal agent API on loopback: register answers 201, heartbeat 200.</summary>
    private sealed class FakeAgentApi : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly Task _loop;
        private readonly List<Registration> _registrations = [];

        public FakeAgentApi()
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Origin = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Origin + "/");
            _listener.Start();
            _loop = Task.Run(ServeAsync);
        }

        public string Origin { get; }

        /// <summary>Distinct registrations; a retry of the same body counts once.</summary>
        public IReadOnlyList<Registration> Registrations
        {
            get
            {
                lock (_registrations)
                {
                    return [.. _registrations.Distinct()];
                }
            }
        }

        private async Task ServeAsync()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
                {
                    return;
                }

                using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
                var body = JsonNode.Parse(await reader.ReadToEndAsync());
                string json;
                if (context.Request.Url!.AbsolutePath == "/api/agent/register")
                {
                    lock (_registrations)
                    {
                        _registrations.Add(new Registration(body!["installId"]!.GetValue<string>(), body["token"]!.GetValue<string>()));
                    }

                    context.Response.StatusCode = 201;
                    json = """{"agentId":"0b5f3c1a-9d2e-4f6a-8b7c-1d2e3f4a5b6c","heartbeatIntervalSeconds":30,"serverTime":"2026-11-02T09:00:00Z"}""";
                }
                else
                {
                    context.Response.StatusCode = 200;
                    json = $$"""{"syncId":"sync-{{Guid.NewGuid():N}}","serverTime":"2026-11-02T09:00:00Z","nextIntervalSeconds":30}""";
                }

                var bytes = Encoding.UTF8.GetBytes(json);
                context.Response.ContentType = "application/json";
                context.Response.Headers["Mashkif-Protocol-Version"] = "1";
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        }

        public void Dispose()
        {
            _listener.Stop();
            _listener.Close();
            try
            {
                _loop.Wait(TimeSpan.FromSeconds(5));
            }
            catch (AggregateException)
            {
            }
        }
    }
}
