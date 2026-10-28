using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class ChromecraftInstallerBootstrap
{
    private const string ProductName = "Chromecraft";
    private const string PayloadFileName = "ChromecraftSquirrelSetup.exe";

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string installRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            ProductName);
        bool simulateInstalled = Array.IndexOf(args, "--simulate-installed") >= 0;

        if (!simulateInstalled && !IsInstalled(installRoot))
        {
            RunPayloadAndExit();
            return;
        }

        Application.Run(new ExistingInstallForm(installRoot));
    }

    private static bool IsInstalled(string installRoot)
    {
        return File.Exists(Path.Combine(installRoot, "chromecraft.exe")) &&
               File.Exists(Path.Combine(installRoot, "Update.exe"));
    }

    internal static string ExtractPayload()
    {
        string destination = Path.Combine(
            Path.GetTempPath(),
            "ChromecraftInstaller-" + Guid.NewGuid().ToString("N"),
            PayloadFileName);
        Directory.CreateDirectory(Path.GetDirectoryName(destination));

        string executable = Process.GetCurrentProcess().MainModule.FileName;
        using (FileStream input = File.OpenRead(executable))
        {
            if (input.Length < 8)
                throw new InvalidDataException("The installer payload is missing.");

            input.Seek(-8, SeekOrigin.End);
            byte[] sizeBytes = new byte[8];
            ReadExactly(input, sizeBytes, 0, sizeBytes.Length);
            long payloadLength = BitConverter.ToInt64(sizeBytes, 0);
            long payloadOffset = input.Length - 8 - payloadLength;
            if (payloadLength <= 0 || payloadOffset <= 0)
                throw new InvalidDataException("The installer payload is invalid.");

            input.Seek(payloadOffset, SeekOrigin.Begin);
            using (FileStream output = File.Create(destination))
            {
                byte[] buffer = new byte[1024 * 1024];
                long remaining = payloadLength;
                while (remaining > 0)
                {
                    int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                    if (read == 0)
                        throw new EndOfStreamException("The installer payload ended unexpectedly.");
                    output.Write(buffer, 0, read);
                    remaining -= read;
                }
            }
        }

        return destination;
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = stream.Read(buffer, offset, count);
            if (read == 0)
                throw new EndOfStreamException();
            offset += read;
            count -= read;
        }
    }

    internal static void RunPayloadAndExit()
    {
        try
        {
            string payload = ExtractPayload();
            Process.Start(new ProcessStartInfo(payload) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Chromecraft Setup could not start.\n\n" + error.Message,
                "Chromecraft Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private sealed class ExistingInstallForm : Form
    {
        private readonly string installRoot;
        private readonly Button openButton;
        private readonly Button repairButton;
        private readonly Button wipeButton;
        private readonly Label statusLabel;

        internal ExistingInstallForm(string installRoot)
        {
            this.installRoot = installRoot;
            Text = "Chromecraft Setup";
            ClientSize = new Size(720, 520);
            MinimumSize = new Size(680, 500);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(248, 249, 255);
            Font = new Font("Segoe UI", 10F);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;

            var brand = new Label {
                Text = "CHROMECRAFT SETUP",
                ForeColor = Color.FromArgb(15, 89, 214),
                Font = new Font("Segoe UI Semibold", 10F),
                AutoSize = true,
                Location = new Point(54, 42)
            };
            var title = new Label {
                Text = "Chromecraft is already installed!",
                ForeColor = Color.FromArgb(32, 33, 36),
                Font = new Font("Segoe UI Semibold", 25F),
                AutoSize = true,
                Location = new Point(50, 76)
            };
            var subtitle = new Label {
                Text = "Choose what you would like Setup to do.",
                ForeColor = Color.FromArgb(86, 88, 94),
                Font = new Font("Segoe UI", 11F),
                AutoSize = true,
                Location = new Point(54, 128)
            };

            openButton = CreateActionButton(
                "Cancel installation and open Chromecraft",
                "Leave your installation and data exactly as they are.",
                172,
                Color.FromArgb(15, 89, 214),
                Color.White);
            repairButton = CreateActionButton(
                "Repair Chromecraft",
                "Reinstall the browser while keeping your profile, bookmarks and settings.",
                256,
                Color.White,
                Color.FromArgb(32, 33, 36));
            wipeButton = CreateActionButton(
                "Wipe all data and reinstall Chromecraft",
                "Permanently remove the browser profile, then install a fresh copy.",
                340,
                Color.FromArgb(255, 239, 239),
                Color.FromArgb(164, 28, 28));

            openButton.Click += delegate { OpenInstalledBrowser(); };
            repairButton.Click += async delegate { await ReinstallAsync(false); };
            wipeButton.Click += async delegate { await ConfirmAndWipeAsync(); };

            statusLabel = new Label {
                Text = "",
                ForeColor = Color.FromArgb(86, 88, 94),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(54, 443),
                Size = new Size(612, 30)
            };

            Controls.Add(brand);
            Controls.Add(title);
            Controls.Add(subtitle);
            Controls.Add(openButton);
            Controls.Add(repairButton);
            Controls.Add(wipeButton);
            Controls.Add(statusLabel);
            AcceptButton = openButton;
        }

        private Button CreateActionButton(
            string heading,
            string description,
            int top,
            Color background,
            Color foreground)
        {
            var button = new Button {
                Text = heading + "\r\n" + description,
                FlatStyle = FlatStyle.Flat,
                BackColor = background,
                ForeColor = foreground,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(20, 4, 16, 4),
                Location = new Point(54, top),
                Size = new Size(612, 70),
                Font = new Font("Segoe UI Semibold", 10.5F),
                Cursor = Cursors.Hand
            };
            button.FlatAppearance.BorderColor = Color.FromArgb(210, 212, 220);
            button.FlatAppearance.BorderSize = 1;
            return button;
        }

        private void OpenInstalledBrowser()
        {
            string executable = Path.Combine(installRoot, "chromecraft.exe");
            try
            {
                Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
                Close();
            }
            catch (Exception error)
            {
                ShowFailure("Chromecraft could not be opened.", error);
            }
        }

        private async Task ConfirmAndWipeAsync()
        {
            DialogResult choice = MessageBox.Show(
                "This permanently deletes your Chromecraft profile, including local settings, history, bookmarks and sessions. This cannot be undone.\n\nWipe all data and reinstall?",
                "Wipe Chromecraft data?",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (choice == DialogResult.Yes)
                await ReinstallAsync(true);
        }

        private async Task ReinstallAsync(bool wipeProfile)
        {
            SetBusy(true, wipeProfile ? "Preparing a fresh installation..." : "Repairing Chromecraft...");
            try
            {
                await Task.Run(delegate
                {
                    StopChromecraftProcesses();
                    RunUninstaller();
                    if (wipeProfile)
                        DeleteProfileSafely();
                    string payload = ExtractPayload();
                    Process.Start(new ProcessStartInfo(payload) { UseShellExecute = true });
                });
                Close();
            }
            catch (Exception error)
            {
                SetBusy(false, "");
                ShowFailure("Chromecraft could not be reinstalled.", error);
            }
        }

        private void StopChromecraftProcesses()
        {
            foreach (Process process in Process.GetProcessesByName("chromecraft"))
            {
                try
                {
                    process.CloseMainWindow();
                    if (!process.WaitForExit(5000))
                    {
                        process.Kill();
                        process.WaitForExit(5000);
                    }
                }
                catch { }
                finally { process.Dispose(); }
            }
        }

        private void RunUninstaller()
        {
            string updater = Path.Combine(installRoot, "Update.exe");
            if (!File.Exists(updater))
                return;
            using (Process uninstall = Process.Start(new ProcessStartInfo {
                FileName = updater,
                Arguments = "--uninstall -s",
                UseShellExecute = false,
                CreateNoWindow = true
            }))
            {
                if (uninstall == null || !uninstall.WaitForExit(120000))
                    throw new TimeoutException("The existing installation did not finish closing.");
                if (uninstall.ExitCode != 0)
                    throw new InvalidOperationException("The existing installation could not be removed (exit code " + uninstall.ExitCode + ").");
            }
        }

        private void DeleteProfileSafely()
        {
            string applicationData = Path.GetFullPath(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            string profile = Path.GetFullPath(Path.Combine(applicationData, ProductName));
            string profileParent = Path.GetDirectoryName(profile);
            if (!string.Equals(profileParent, applicationData, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetFileName(profile), ProductName, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Setup refused to remove an unexpected profile path.");
            if (Directory.Exists(profile))
                Directory.Delete(profile, true);
        }

        private void SetBusy(bool busy, string status)
        {
            openButton.Enabled = !busy;
            repairButton.Enabled = !busy;
            wipeButton.Enabled = !busy;
            statusLabel.Text = status;
            UseWaitCursor = busy;
        }

        private void ShowFailure(string message, Exception error)
        {
            MessageBox.Show(
                message + "\n\n" + error.Message,
                "Chromecraft Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
