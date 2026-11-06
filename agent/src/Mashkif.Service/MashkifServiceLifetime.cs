using System.ServiceProcess;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Options;

namespace Mashkif.Service;

/// <summary>
/// The Windows service lifetime of Microsoft.Extensions.Hosting, extended
/// through the documented <see cref="ServiceBase"/> overrides only: it
/// accepts power events and reports suspend, resume, shutdown, and stop to
/// the <see cref="LifecycleRecorder"/>, then lets the base class do its work.
/// </summary>
/// <remarks>
/// <see cref="ServiceBase"/> runs these overrides on thread pool workers it
/// queued, not in the control callback, so Windows' notification window does
/// not extend to them (step 2c, decision 8).
/// </remarks>
internal sealed class MashkifServiceLifetime : WindowsServiceLifetime
{
    private readonly LifecycleRecorder _recorder;

    public MashkifServiceLifetime(
        IHostEnvironment environment,
        IHostApplicationLifetime applicationLifetime,
        ILoggerFactory loggerFactory,
        IOptions<HostOptions> optionsAccessor,
        IOptions<WindowsServiceLifetimeOptions> windowsServiceOptionsAccessor,
        LifecycleRecorder recorder)
        : base(environment, applicationLifetime, loggerFactory, optionsAccessor, windowsServiceOptionsAccessor)
    {
        _recorder = recorder;
        CanHandlePowerEvent = true;
    }

    protected override bool OnPowerEvent(PowerBroadcastStatus powerStatus)
    {
        switch (powerStatus)
        {
            case PowerBroadcastStatus.Suspend:
                _recorder.Suspend();
                break;
            case PowerBroadcastStatus.ResumeAutomatic:
                _recorder.Resume();
                break;
        }

        return base.OnPowerEvent(powerStatus);
    }

    protected override void OnShutdown()
    {
        // No log line here: a stuck disk must not stall the shutdown before the bounded host stop.
        _recorder.Shutdown();
        base.OnShutdown();
    }

    protected override void OnStop()
    {
        _recorder.Stop();
        base.OnStop();
    }
}
