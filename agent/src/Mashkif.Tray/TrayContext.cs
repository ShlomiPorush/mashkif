using System.Globalization;
using Mashkif.Common;
using Mashkif.Common.Pipe;

namespace Mashkif.Tray;

/// <summary>
/// Notification area icon with the agent status, Join again, and Exit. A
/// hidden top-level window lets Windows Installer and Restart Manager close
/// the app during uninstall or upgrade.
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FastPollInterval = TimeSpan.FromSeconds(2);

    // NotifyIcon.Text accepts at most 127 characters.
    private const int TooltipLimit = 127;

    private readonly FileLog _log;
    private readonly PipeClient _pipe;
    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _rejoinItem;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly SessionEndWindow _sessionWindow;
    private AgentStatus? _status;
    private bool _polling;
    private bool _rejoining;

    public TrayContext(FileLog log, PipeClient pipe)
    {
        _log = log;
        _pipe = pipe;
        _menu = new ContextMenuStrip
        {
            RightToLeft = TrayStrings.IsRightToLeft() ? RightToLeft.Yes : RightToLeft.No,
        };
        _menu.Items.Add(new ToolStripLabel(TrayStrings.ProductName()) { Font = new Font(_menu.Font, FontStyle.Bold) });
        _statusItem = new ToolStripMenuItem(TrayStrings.StatusLine(null)) { Enabled = false };
        _rejoinItem = new ToolStripMenuItem(TrayStrings.Get("MenuRejoin"), null, async (_, _) => await RejoinAsync().ConfigureAwait(true)) { Visible = false };
        _menu.Items.Add(_statusItem);
        _menu.Items.Add(_rejoinItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(TrayStrings.MenuExit(), null, (_, _) => Exit("user chose Exit"));

        _icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = TrayStrings.Tooltip(),
            ContextMenuStrip = _menu,
            Visible = true,
        };

        _sessionWindow = new SessionEndWindow(() => Exit("session ending or close requested"));
        _timer = new System.Windows.Forms.Timer { Interval = (int)FastPollInterval.TotalMilliseconds };
        _timer.Tick += async (_, _) => await PollAsync().ConfigureAwait(true);
        _timer.Start();
    }

    private async Task PollAsync()
    {
        if (_polling)
        {
            return;
        }

        _polling = true;
        try
        {
            var reply = await _pipe.SendAsync(new PipeRequest { Command = PipeProtocol.StatusCommand }, CancellationToken.None).ConfigureAwait(true);
            Show(reply.Response?.Status);
        }
        finally
        {
            _polling = false;
        }
    }

    private void Show(AgentStatus? status)
    {
        _status = status;
        var line = TrayStrings.StatusLine(status);
        if (status?.LastContactUtc is { } contact && status.State == AgentStates.Connected)
        {
            line += Environment.NewLine + string.Format(
                CultureInfo.CurrentCulture,
                TrayStrings.Get("StatusLastContact"),
                contact.ToLocalTime().ToString("g", CultureInfo.CurrentCulture));
        }

        _statusItem.Text = line;
        _rejoinItem.Visible = status?.CanRejoin == true;
        var tooltip = $"{TrayStrings.ProductName()}: {TrayStrings.StatusLine(status)}";
        _icon.Text = tooltip.Length <= TooltipLimit ? tooltip : tooltip[..TooltipLimit];
        _timer.Interval = (int)(status?.State == AgentStates.Registering ? FastPollInterval : PollInterval).TotalMilliseconds;
    }

    /// <summary>Asks the service to join again; one click sends one request.</summary>
    private async Task RejoinAsync()
    {
        if (_rejoining)
        {
            return;
        }

        _rejoining = true;
        try
        {
            var reply = await _pipe.SendAsync(new PipeRequest { Command = PipeProtocol.RejoinCommand }, CancellationToken.None).ConfigureAwait(true);
            if (reply.Response?.Status is { } status)
            {
                Show(status);
            }

            if (reply.Response?.Ok == true)
            {
                _log.Write("info", "Asked the service to join again");
                return;
            }

            _log.Write("warning", $"Joining again was refused: {reply.Response?.Error ?? reply.Failure.ToString()}");
            _icon.ShowBalloonTip(10_000, TrayStrings.ProductName(), TrayStrings.Get("RejoinFailed"), ToolTipIcon.Warning);
        }
        finally
        {
            _rejoining = false;
        }
    }

    private void Exit(string reason)
    {
        _log.Write("info", $"Mashkif tray exiting: {reason}");
        _timer.Stop();
        _icon.Visible = false;
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _sessionWindow.DestroyHandle();
            _icon.Dispose();
            _menu.Dispose();
        }

        base.Dispose(disposing);
    }

    /// <summary>
    /// Hidden top-level window. Restart Manager sends WM_QUERYENDSESSION and
    /// WM_ENDSESSION, or WM_CLOSE, to top-level windows of a process holding
    /// files in use; a notification icon alone has no such window.
    /// </summary>
    private sealed class SessionEndWindow : NativeWindow
    {
        private const int WmClose = 0x0010;
        private const int WmQueryEndSession = 0x0011;
        private const int WmEndSession = 0x0016;

        private readonly Action _onEnd;

        public SessionEndWindow(Action onEnd)
        {
            _onEnd = onEnd;
            CreateHandle(new CreateParams { Caption = "Mashkif.Tray.SessionEnd" });
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case WmQueryEndSession:
                    m.Result = 1;
                    return;
                case WmEndSession when m.WParam != IntPtr.Zero:
                case WmClose:
                    _onEnd();
                    m.Result = IntPtr.Zero;
                    return;
                default:
                    base.WndProc(ref m);
                    return;
            }
        }
    }
}
