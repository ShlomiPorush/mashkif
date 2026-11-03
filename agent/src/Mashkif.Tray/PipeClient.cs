using System.IO.Pipes;
using System.Security.Principal;
using Mashkif.Common.Pipe;

namespace Mashkif.Tray;

/// <summary>Why a pipe request did not get an answer.</summary>
internal enum PipeFailure
{
    None,

    /// <summary>No pipe, a timeout, or a broken connection.</summary>
    ServiceUnavailable,

    /// <summary>The server end is not the running Mashkif service.</summary>
    NotTheService,
}

/// <summary>The answer of one request, or why there is none.</summary>
internal sealed record PipeReply(PipeResponse? Response, PipeFailure Failure);

/// <summary>
/// Talks to the service pipe. Connects with explicit access rights (no
/// CreateNewInstance), at identification level only, and checks that the
/// server end is the running service before it writes anything.
/// </summary>
internal sealed class PipeClient(string pipeName, Func<int?> servicePid)
{
    /// <summary>Time to connect, and again to get the answer.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    /// <summary>The installed tray app: the real pipe and the real service.</summary>
    public static PipeClient Production() =>
        new(PipeProtocol.PipeName, static () => ServiceProcessCheck.RunningServicePid("Mashkif"));

    /// <summary>Access rights the client asks for.</summary>
    public const PipeAccessRights Rights =
        PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize;

    public async Task<PipeReply> SendAsync(PipeRequest request, CancellationToken cancellationToken)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                Rights,
                PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification,
                HandleInheritability.None);
            await pipe.ConnectAsync(Timeout, cancellationToken).ConfigureAwait(false);
            if (!ServiceProcessCheck.IsServedBy(pipe.SafePipeHandle, servicePid))
            {
                return new PipeReply(null, PipeFailure.NotTheService);
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            await PipeLines.WriteLineAsync(pipe, request, PipeJsonContext.Default.PipeRequest, timeout.Token).ConfigureAwait(false);
            var line = await PipeLines.ReadLineAsync(pipe, PipeProtocol.MaxResponseBytes, timeout.Token).ConfigureAwait(false);
            var response = PipeLines.Parse(line, PipeJsonContext.Default.PipeResponse);
            return response is null ? new PipeReply(null, PipeFailure.ServiceUnavailable) : new PipeReply(response, PipeFailure.None);
        }
        catch (Exception exception) when (exception is IOException or TimeoutException or UnauthorizedAccessException)
        {
            return new PipeReply(null, PipeFailure.ServiceUnavailable);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new PipeReply(null, PipeFailure.ServiceUnavailable);
        }
    }
}
