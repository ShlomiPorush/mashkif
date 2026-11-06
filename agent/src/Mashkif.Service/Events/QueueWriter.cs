using System.Threading.Channels;

namespace Mashkif.Service.Events;

/// <summary>
/// The single writer of the queue: every write runs on one background loop,
/// in the order it was posted. A caller can stop waiting for a write at a
/// deadline without cancelling it; a write that has started always runs to
/// its end (a synchronous flush to disk takes no cancellation token).
/// </summary>
internal sealed class QueueWriter(EventQueue queue)
{
    private readonly Channel<Action> _work = Channel.CreateUnbounded<Action>(new UnboundedChannelOptions { SingleReader = true });

    public EventQueue Queue => queue;

    /// <summary>Queues a write and returns a task for its result.</summary>
    public Task<T> Post<T>(Func<EventQueue, T> write)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var posted = _work.Writer.TryWrite(() =>
        {
            try
            {
                done.TrySetResult(write(queue));
            }
            catch (Exception exception)
            {
                done.TrySetException(exception);
            }
        });
        if (!posted)
        {
            done.TrySetException(new InvalidOperationException("The queue writer has stopped."));
        }

        return done.Task;
    }

    /// <summary>Queues a write without a result.</summary>
    public Task Post(Action<EventQueue> write) => Post(q =>
    {
        write(q);
        return true;
    });

    /// <summary>Runs the queued writes until <paramref name="stoppingToken"/> is cancelled.</summary>
    public async Task RunAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (await _work.Reader.WaitToReadAsync(stoppingToken).ConfigureAwait(false))
            {
                while (_work.Reader.TryRead(out var write))
                {
                    write();
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // No write is accepted after the stop: a later Post fails at once instead of
            // waiting forever, so nothing that awaits a write can hold the stop. Writes
            // posted before it still run, so a shutdown record is not left behind.
            _work.Writer.TryComplete();
            while (_work.Reader.TryRead(out var write))
            {
                write();
            }
        }
    }
}
