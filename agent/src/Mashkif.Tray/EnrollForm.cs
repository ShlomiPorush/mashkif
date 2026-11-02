using Mashkif.Common.Pipe;

namespace Mashkif.Tray;

/// <summary>
/// Asks for an enrollment key. The key is checked for its format here and
/// sent to the service only through the pipe; it is never logged.
/// </summary>
internal sealed class EnrollForm : Form
{
    private readonly TextBox _key;
    private readonly Label _message;
    private readonly Button _ok;
    private readonly Func<string, Task<string?>> _submit;

    /// <param name="submit">Sends the key; returns null on success or a message to show.</param>
    public EnrollForm(Func<string, Task<string?>> submit)
    {
        _submit = submit;
        var rightToLeft = TrayStrings.IsRightToLeft();
        Text = TrayStrings.Get("EnrollTitle");
        RightToLeft = rightToLeft ? RightToLeft.Yes : RightToLeft.No;
        RightToLeftLayout = rightToLeft;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        ShowInTaskbar = true;
        TopMost = true;

        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        var prompt = new Label { Text = TrayStrings.Get("EnrollPrompt"), AutoSize = true, MaximumSize = new Size(420, 0) };
        _key = new TextBox { Width = 420, MaxLength = 64, RightToLeft = RightToLeft.No };
        _message = new Label { AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = SystemColors.HotTrack };
        _ok = new Button { Text = TrayStrings.Get("EnrollOk"), AutoSize = true };
        var cancel = new Button { Text = TrayStrings.Get("EnrollCancel"), AutoSize = true, DialogResult = DialogResult.Cancel };
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Anchor = AnchorStyles.Right };
        buttons.Controls.Add(_ok);
        buttons.Controls.Add(cancel);
        layout.Controls.Add(prompt);
        layout.Controls.Add(_key);
        layout.Controls.Add(_message);
        layout.Controls.Add(buttons);
        Controls.Add(layout);
        AcceptButton = _ok;
        CancelButton = cancel;
        _ok.Click += async (_, _) => await SubmitAsync().ConfigureAwait(true);
    }

    /// <summary>The message currently shown, for tests.</summary>
    internal string MessageText => _message.Text;

    /// <summary>Validates and submits the key; public for tests.</summary>
    internal async Task SubmitAsync()
    {
        var key = _key.Text.Trim();
        if (!EnrollmentKeyFormat.IsValid(key))
        {
            _message.Text = TrayStrings.Get("EnrollFormatInvalid");
            return;
        }

        _ok.Enabled = false;
        try
        {
            var error = await _submit(key).ConfigureAwait(true);
            if (error is null)
            {
                DialogResult = DialogResult.OK;
                Close();
                return;
            }

            _message.Text = error;
        }
        finally
        {
            _ok.Enabled = true;
        }
    }

    /// <summary>For tests: sets the key text.</summary>
    internal void SetKey(string key) => _key.Text = key;
}
