using Mashkif.Service.Agent;
using Mashkif.Service.Protocol;

namespace Mashkif.Service;

/// <summary>
/// Hands the service's power, shutdown, and stop notifications to the
/// engine. The service lifetime is built before the engine, so the engine
/// attaches here once its state is loaded; a notification before that is
/// dropped. Every call returns within the engine's own deadlines.
/// </summary>
internal sealed class LifecycleRecorder
{
    private AgentEngine? _engine;

    public void Attach(AgentEngine engine) => Volatile.Write(ref _engine, engine);

    public void Detach() => Volatile.Write(ref _engine, null);

    public void Suspend() => Run(engine => engine.SuspendAsync());

    public void Resume() => Volatile.Read(ref _engine)?.Resume();

    public void Shutdown() => Run(engine => engine.ShutdownAsync(EventKinds.Shutdown));

    public void Stop() => Run(engine => engine.ShutdownAsync(EventKinds.ServiceStop));

    private void Run(Func<AgentEngine, Task> work)
    {
        if (Volatile.Read(ref _engine) is { } engine)
        {
            // Runs on the thread pool worker that ServiceBase queued; the engine bounds the time.
            work(engine).GetAwaiter().GetResult();
        }
    }
}
