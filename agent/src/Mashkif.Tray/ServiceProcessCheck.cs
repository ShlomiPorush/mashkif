using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Mashkif.Tray;

/// <summary>
/// Verifies that the server end of a pipe is the process of a running Windows
/// service: the PID from <c>GetNamedPipeServerProcessId</c> must equal the PID
/// that the Service Control Manager reports. Every Win32 result is checked.
/// </summary>
internal static partial class ServiceProcessCheck
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const int ScStatusProcessInfo = 0;
    private const uint ServiceRunning = 0x00000004;

    /// <summary>The PID of the running service <paramref name="serviceName"/>, or null.</summary>
    public static int? RunningServicePid(string serviceName)
    {
        var manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var service = OpenServiceW(manager, serviceName, ServiceQueryStatus);
            if (service == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                if (!QueryServiceStatusEx(service, ScStatusProcessInfo, out var status, (uint)Marshal.SizeOf<ServiceStatusProcess>(), out _))
                {
                    return null;
                }

                return status.CurrentState == ServiceRunning && status.ProcessId != 0 ? (int)status.ProcessId : null;
            }
            finally
            {
                CloseServiceHandle(service);
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    /// <summary>The PID of the process that created the server end of <paramref name="pipe"/>, or null.</summary>
    public static int? PipeServerPid(SafePipeHandle pipe)
    {
        ArgumentNullException.ThrowIfNull(pipe);
        return GetNamedPipeServerProcessId(pipe, out var pid) && pid != 0 ? (int)pid : null;
    }

    /// <summary>Whether the server end of <paramref name="pipe"/> is the running service.</summary>
    public static bool IsServedBy(SafePipeHandle pipe, Func<int?> servicePid)
    {
        ArgumentNullException.ThrowIfNull(servicePid);
        var expected = servicePid();
        var actual = PipeServerPid(pipe);
        return expected is not null && actual is not null && expected == actual;
    }

    /// <summary>For tests: the last Win32 error as an exception message.</summary>
    internal static string LastError() => new Win32Exception(Marshal.GetLastPInvokeError()).Message;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
        public uint ProcessId;
        public uint ServiceFlags;
    }

    [LibraryImport("advapi32.dll", EntryPoint = "OpenSCManagerW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenSCManagerW(string? machineName, string? databaseName, uint desiredAccess);

    [LibraryImport("advapi32.dll", EntryPoint = "OpenServiceW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenServiceW(IntPtr manager, string serviceName, uint desiredAccess);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool QueryServiceStatusEx(IntPtr service, int infoLevel, out ServiceStatusProcess buffer, uint bufferSize, out uint bytesNeeded);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseServiceHandle(IntPtr handle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
}
