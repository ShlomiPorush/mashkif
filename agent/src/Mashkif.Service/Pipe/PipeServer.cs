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
/// could create a pipe with that name and receive the tray's requests. So an
/// instance is released only when another instance of this process exists,
/// and a broken listening instance is put back to listening instead of being
/// replaced when no replacement can be created. An instance created while
/// the process has none uses <see cref="PipeOptions.FirstPipeInstance"/>, so
/// a pipe that another process created is never joined.
/// </remarks>
internal sealed partial class PipeServer(AgentEngine engine, PipeSecurity security, string pipeName, ILogger<PipeServer> logger, TimeProvider time)
{
    /// <summary>Most instances: one listening, the rest handling connections.</summary>
    public const int MaxInstances = 4;

    private static readonly TimeSpan SquatRetry = TimeSpan.FromSeconds(30);

    private static readonly TimeSpan CreateRetry = TimeSpan.FromSeconds(1);

    // Instances of this process that exist now, listening or connected.
    private int _instances;

    /// <summary>Instances of this process that exist now. For tests.</summary>
    internal int Instances => Volatile.Read(ref _instances);

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        using var handlers = new SemaphoreSlim(MaxInstances - 1, MaxInstances - 1);
        NamedPipeServerStream? listening = await CreateFirstAsync(stoppingToken).ConfigureAwait(false);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                while (listening is null)
                {
                    await Task.Delay(CreateRetry, time, stoppingToken).ConfigureAwait(false);
                    listening = CreateListening();
                }

                try
                {
                    await listening.WaitForConnectionAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    // A client connected and closed before the wait completed
                    // ("the pipe is being closed").
                    listening = await RecoverAsync(listening, stoppingToken).ConfigureAwait(false);
                    continue;
                }

                await handlers.WaitAsync(stoppingToken).ConfigureAwait(false);

                // The next instance is created before this one is handed off.
                // If that fails, the connected instance still holds the name
                // until the loop creates one.
                var next = CreateListening();
                var connected = listening;
                listening = next;
                _ = HandleAsync(connected, handlers, stoppingToken);
            }
        }
        finally
        {
            if (listening is not null)
            {
                await ReleaseAsync(listening).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Creates a listening instance. Without an instance of this process the
    /// name may belong to someone else, so the instance must be the first one.
    /// </summary>
    internal NamedPipeServerStream? CreateListening() => TryCreate(first: Instances == 0);

    /// <summary>
    /// After a client left before the wait completed: puts the instance back to
    /// listening, or replaces it when that fails. It is released only after a
    /// replacement exists; with neither, it is kept and tried again shortly.
    /// </summary>
    internal async Task<NamedPipeServerStream> RecoverAsync(NamedPipeServerStream broken, CancellationToken cancellationToken)
    {
        // Documented reuse: DisconnectNamedPipe, then ConnectNamedPipe again.
        if (DisconnectNamedPipe(broken.SafePipeHandle))
        {
            return broken;
        }

        var replacement = CreateListening();
        if (replacement is not null)
        {
            await ReleaseAsync(broken).ConfigureAwait(false);
            return replacement;
        }

        LogRecoverFailed(logger);
        await Task.Delay(CreateRetry, time, cancellationToken).ConfigureAwait(false);
        return broken;
    }

    /// <summary>Disposes an instance of this process.</summary>
    internal async ValueTask ReleaseAsync(NamedPipeServerStream pipe)
    {
        await pipe.DisposeAsync().ConfigureAwait(false);
        Interlocked.Decrement(ref _instances);
    }

    private async Task<NamedPipeServerStream> CreateFirstAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            var pipe = TryCreate(first: true);
            if (pipe is not null)
            {
                return pipe;
            }

            await Task.Delay(SquatRetry, time, stoppingToken).ConfigureAwait(false);
        }
    }

    private NamedPipeServerStream? TryCreate(bool first)
    {
        try
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
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            if (first)
            {
                LogSquatted(logger, pipeName, exception.GetType().Name);
            }
            else
            {
                LogCreateFailed(logger, exception.GetType().Name);
            }

            return null;
        }
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, SemaphoreSlim handlers, CancellationToken stoppingToken)
    {
        try
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
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException)
        {
            // The client went away or was too slow; nothing to answer.
        }
        finally
        {
            await ReleaseAsync(pipe).ConfigureAwait(false);
            handlers.Release();
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

    [LoggerMessage(EventId = 30, Level = LogLevel.Error, Message = "The pipe {PipeName} already exists in another process ({Error}); retrying in 30 seconds")]
    private static partial void LogSquatted(ILogger logger, string pipeName, string error);

    [LoggerMessage(EventId = 31, Level = LogLevel.Warning, Message = "A new pipe instance could not be created: {Error}")]
    private static partial void LogCreateFailed(ILogger logger, string error);

    [LoggerMessage(EventId = 32, Level = LogLevel.Warning, Message = "A pipe instance whose client left could not be reset or replaced; trying again in a second")]
    private static partial void LogRecoverFailed(ILogger logger);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DisconnectNamedPipe(SafePipeHandle pipe);
}
