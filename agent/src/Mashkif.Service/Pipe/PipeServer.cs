using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Mashkif.Common.Pipe;
using Mashkif.Service.Agent;
using Mashkif.Service.State;
using Microsoft.Win32.SafeHandles;

namespace Mashkif.Service.Pipe;

/// <summary>The access rules of the service pipe.</summary>
internal static class PipeAcl
{
    /// <summary>NT AUTHORITY\NETWORK: every remote logon carries it.</summary>
    public static readonly SecurityIdentifier Network = new(WellKnownSidType.NetworkSid, null);

    /// <summary>NT AUTHORITY\INTERACTIVE: users signed in at the PC or over Remote Desktop.</summary>
    public static readonly SecurityIdentifier Interactive = new(WellKnownSidType.InteractiveSid, null);

    /// <summary>
    /// What an interactive client may do: read and write data, read attributes,
    /// and wait. No CreateNewInstance, no WriteAttributes (the pipe stays in byte mode).
    /// </summary>
    public const PipeAccessRights ClientRights =
        PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize;

    /// <summary>
    /// Deny NETWORK; allow SYSTEM, Administrators, and the service SID full
    /// control; allow INTERACTIVE <see cref="ClientRights"/>; restrict the
    /// owner (LocalService, shared by other services) to read control.
    /// </summary>
    public static PipeSecurity Create(SecurityIdentifier serviceSid)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(Network, PipeAccessRights.FullControl, AccessControlType.Deny));
        foreach (var sid in new[] { PathPolicy.LocalSystem, PathPolicy.Administrators, serviceSid })
        {
            security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        }

        security.AddAccessRule(new PipeAccessRule(Interactive, ClientRights, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(PathPolicy.OwnerRights, PipeAccessRights.ReadPermissions, AccessControlType.Allow));
        return security;
    }
}

/// <summary>
/// The local pipe the tray app talks to. One request line and one response
/// line per connection.
/// </summary>
/// <remarks>
/// The pipe name must never be free while the service runs, or a local user
/// could create a pipe with that name and receive the tray's requests. So the
/// service creates a fixed pool of instances once, the first with
/// <see cref="PipeOptions.FirstPipeInstance"/> (a pipe that someone else
/// created is never joined), and never closes one while it runs. Each
/// instance serves one client at a time and is disconnected and reused after
/// it; only a service stop disposes the pool.
/// </remarks>
internal sealed partial class PipeServer(AgentEngine engine, PipeSecurity security, string pipeName, ILogger<PipeServer> logger, TimeProvider time)
{
    /// <summary>Instances in the pool, so up to this many clients at once.</summary>
    public const int MaxInstances = 4;

    private static readonly TimeSpan SquatRetry = TimeSpan.FromSeconds(30);

    private static readonly TimeSpan ResetRetry = TimeSpan.FromSeconds(1);

    // Instances of this process that exist now.
    private int _instances;

    /// <summary>Instances of this process that exist now. For tests.</summary>
    internal int Instances => Volatile.Read(ref _instances);

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        var pool = await CreatePoolAsync(stoppingToken).ConfigureAwait(false);
        try
        {
            await Task.WhenAll(pool.Select(pipe => ServeAsync(pipe, stoppingToken))).ConfigureAwait(false);
        }
        finally
        {
            await DisposeAsync(pool).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Creates every instance of the pool, the first as the first instance of
    /// the name. When any creation fails, nothing is served: the created
    /// instances are closed, the failure is logged, and the whole pool is
    /// tried again later, again starting with a first instance.
    /// </summary>
    private async Task<List<NamedPipeServerStream>> CreatePoolAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            var pool = new List<NamedPipeServerStream>(MaxInstances);
            try
            {
                for (var i = 0; i < MaxInstances; i++)
                {
                    pool.Add(Create(first: i == 0));
                }

                return pool;
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
            {
                await DisposeAsync(pool).ConfigureAwait(false);
                LogPoolFailed(logger, pipeName, exception.GetType().Name);
            }

            await Task.Delay(SquatRetry, time, stoppingToken).ConfigureAwait(false);
        }
    }

    internal NamedPipeServerStream Create(bool first)
    {
        var pipe = NamedPipeServerStreamAcl.Create(
            pipeName,
            PipeDirection.InOut,
            MaxInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None),
            PipeProtocol.MaxRequestBytes,
            PipeProtocol.MaxResponseBytes,
            security);
        Interlocked.Increment(ref _instances);
        return pipe;
    }

    private async Task DisposeAsync(List<NamedPipeServerStream> pool)
    {
        foreach (var pipe in pool)
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            Interlocked.Decrement(ref _instances);
        }
    }

    /// <summary>One instance: wait for a client, answer it, disconnect, and wait again. Internal for tests.</summary>
    internal async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(stoppingToken).ConfigureAwait(false);
                await HandleAsync(pipe, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
            {
                // The client left before the wait completed, or went away or was
                // too slow while it was answered. Nothing ends this loop but a stop.
                LogClientFailed(logger, exception);
            }

            if (!Reset(pipe))
            {
                await Task.Delay(ResetRetry, time, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Ends the connection and keeps the instance for the next client.
    /// <see cref="NamedPipeServerStream.Disconnect"/> also resets a broken
    /// connection. An instance whose client left before the wait completed was
    /// never connected for .NET, which then refuses Disconnect, so it gets
    /// <c>DisconnectNamedPipe</c> directly, the documented step before the
    /// instance can wait again.
    /// </summary>
    private bool Reset(NamedPipeServerStream pipe)
    {
        try
        {
            pipe.Disconnect();
            return true;
        }
        catch (InvalidOperationException)
        {
            // Not connected for .NET: the client left before the wait completed.
        }
        catch (IOException exception)
        {
            LogResetFailed(logger, exception.GetType().Name);
            return false;
        }

        try
        {
            if (DisconnectNamedPipe(pipe.SafePipeHandle))
            {
                return true;
            }

            LogResetFailedCode(logger, Marshal.GetLastPInvokeError());
            return false;
        }
        catch (ObjectDisposedException exception)
        {
            LogResetFailed(logger, exception.GetType().Name);
            return false;
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken stoppingToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        timeout.CancelAfter(PipeProtocol.RequestTimeout);
        var line = await PipeLines.ReadLineAsync(pipe, PipeProtocol.MaxRequestBytes, timeout.Token).ConfigureAwait(false);
        var response = Dispatch(line);
        await PipeLines.WriteLineAsync(pipe, response, PipeJsonContext.Default.PipeResponse, timeout.Token).ConfigureAwait(false);

        // Wait until the client has read the answer and closed its end.
        var rest = new byte[1];
        while (await pipe.ReadAsync(rest, timeout.Token).ConfigureAwait(false) > 0)
        {
        }
    }

    /// <summary>Answers one request line. Public for tests.</summary>
    internal PipeResponse Dispatch(string? line)
    {
        var request = PipeLines.Parse(line, PipeJsonContext.Default.PipeRequest);
        if (request is null)
        {
            return PipeResponse.Failure(PipeErrors.RequestInvalid);
        }

        if (request.Version != PipeProtocol.Version)
        {
            return PipeResponse.Failure(PipeErrors.VersionUnsupported);
        }

        switch (request.Command)
        {
            case PipeProtocol.StatusCommand:
                return PipeResponse.Success(engine.Status());
            case PipeProtocol.RejoinCommand:
                return engine.Rejoin();
            default:
                return PipeResponse.Failure(PipeErrors.UnknownCommand);
        }
    }

    [LoggerMessage(EventId = 30, Level = LogLevel.Error, Message = "The pipe {PipeName} could not be created in full; it may already exist in another process ({Error}). The pipe is not served; retrying in 30 seconds")]
    private static partial void LogPoolFailed(ILogger logger, string pipeName, string error);

    [LoggerMessage(EventId = 31, Level = LogLevel.Warning, Message = "A pipe instance could not be disconnected for its next client ({Error}); trying again in a second")]
    private static partial void LogResetFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 33, Level = LogLevel.Warning, Message = "A pipe instance could not be disconnected for its next client (Win32 error {Code}); trying again in a second")]
    private static partial void LogResetFailedCode(ILogger logger, int code);

    [LoggerMessage(EventId = 32, Level = LogLevel.Debug, Message = "A pipe client went away before it was answered")]
    private static partial void LogClientFailed(ILogger logger, Exception exception);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DisconnectNamedPipe(SafePipeHandle pipe);
}
