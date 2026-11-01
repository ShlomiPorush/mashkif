using Mashkif.Common;

namespace Mashkif.Tray;

/// <summary>
/// Notification area icon with an Exit menu. A hidden top-level window lets
/// Windows Installer and Restart Manager close the app during uninstall or upgrade.
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    private readonly FileLog _log;
    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly SessionEndWindow _sessionWindow;

    public TrayContext(FileLog log)
    {
        _log = log;
        _menu = new ContextMenuStrip
        {
            RightToLeft = TrayStrings.IsRightToLeft() ? RightToLeft.Yes : RightToLeft.No,
        };
        _menu.Items.Add(new ToolStripLabel(TrayStrings.ProductName()) { Font = new Font(_menu.Font, FontStyle.Bold) });
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
    }

    private void Exit(string reason)
    {
        _log.Write("info", $"Mashkif tray exiting: {reason}");
        _icon.Visible = false;
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
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
