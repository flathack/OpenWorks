using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OpenWorks {
    public class Branding {
        public string title, theme, layout, accent;
        public bool search, favorites;
    }
    public class Entry {
        public int bundle;
        public long? launch;
        public bool unavailable;
        public string name, description, symbol, icon_path;
        public string[] phases;
    }
    public class Catalog {
        public string principal;
        public long updated;
        public Branding policy;
        public Entry[] apps;
    }

    class Canvas : FlowLayoutPanel {
        public string Theme = "orbit";
        public Canvas() { DoubleBuffered = true; AutoScroll = true; Padding = new Padding(12); }
        protected override void OnPaintBackground(PaintEventArgs e) {
            if (ClientSize.Width == 0 || ClientSize.Height == 0) return;
            bool light = Theme == "light";
            using (var fill = new LinearGradientBrush(ClientRectangle,
                light ? Color.FromArgb(245,249,253) : Color.FromArgb(14,22,44),
                light ? Color.FromArgb(217,233,242) : Theme == "orbit" ? Color.FromArgb(17,61,94) : Color.FromArgb(37,48,65), 42f))
                e.Graphics.FillRectangle(fill, ClientRectangle);
            if (Theme == "orbit") {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                for (int i = 0; i < 3; i++)
                    using (var pen = new Pen(Color.FromArgb(35 + i * 12,90,190,226), 1+i))
                        e.Graphics.DrawEllipse(pen, -Width/3, Height/2+i*9, Width*2, Height+120);
            }
        }
    }

    class Window : Form {
        readonly string root = AppDomain.CurrentDomain.BaseDirectory;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8388608 };
        readonly Canvas canvas = new Canvas { Dock = DockStyle.Fill };
        readonly Label banner = new Label { Dock = DockStyle.Top, Height = 42, Padding = new Padding(14,8,0,0),
            BackColor = Color.FromArgb(17,30,54), ForeColor = Color.White, Text = "OpenWorks Anwendungen",
            Font = new Font("Segoe UI",13,FontStyle.Bold) };
        readonly FlowLayoutPanel toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(7), BackColor = Color.FromArgb(234,239,244) };
        readonly Label identity = new Label { AutoSize = true, Margin = new Padding(5,8,12,4) };
        readonly TextBox search = new TextBox { Width = 185, AccessibleName = "Anwendungen durchsuchen" };
        readonly Label searchLabel = new Label { Text = "Suchen", AutoSize = true, Margin = new Padding(8,8,0,4) };
        readonly Button favorites = new Button { Text = "☆ Favoriten", AutoSize = true };
        readonly Button layout = new Button { Text = "Listenansicht", AutoSize = true };
        readonly Button reload = new Button { Text = "Aktualisieren", AutoSize = true };
        readonly Label status = new Label { Dock = DockStyle.Bottom, Height = 28, Padding = new Padding(9,4,2,2), BackColor = Color.WhiteSmoke };
        readonly ToolTip tips = new ToolTip();
        readonly Timer timer = new Timer { Interval = 300000 };
        readonly HashSet<int> pinned = new HashSet<int>();
        Catalog catalog;
        bool onlyPinned, list, busy;
        string previousLayout;
        Color ink = Color.White;
        Color accent = Color.DeepSkyBlue;

        public Window() {
            Text = "OpenWorks Anwendungen"; Size = new Size(930,620); MinimumSize = new Size(590,350);
            Font = new Font("Segoe UI", 9); StartPosition = FormStartPosition.CenterScreen;
            toolbar.Controls.AddRange(new Control[] {identity, favorites, layout, reload, searchLabel, search});
            Controls.Add(canvas); Controls.Add(toolbar); Controls.Add(banner); Controls.Add(status);
            var file = Path.Combine(root,"favorites.txt");
            if (File.Exists(file)) foreach (var line in File.ReadAllLines(file)) {
                int key; if (int.TryParse(line,out key)) pinned.Add(key);
            }
            search.TextChanged += (s,e) => DrawCatalog();
            favorites.Click += (s,e) => { onlyPinned = !onlyPinned; DrawCatalog(); };
            layout.Click += (s,e) => { list = !list; DrawCatalog(); };
            reload.Click += async (s,e) => await RefreshCatalog();
            timer.Tick += async (s,e) => await RefreshCatalog();
            Shown += async (s,e) => { await RefreshCatalog(); timer.Start(); };
            FormClosed += (s,e) => { timer.Dispose(); tips.Dispose(); };
        }

        async Task<string> Agent(string verb) {
            var start = new ProcessStartInfo(Path.Combine(root, "openworks-agent.exe"),
                "\"" + Path.Combine(root, "agent.json") + "\" " + verb) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            using (var proc = Process.Start(start)) {
                var output = proc.StandardOutput.ReadToEndAsync();
                var error = proc.StandardError.ReadToEndAsync();
                await Task.Run(() => proc.WaitForExit());
                var message = await error;
                if (proc.ExitCode != 0) throw new IOException(message.Trim());
                return await output;
            }
        }

        async Task RefreshCatalog() {
            if (busy) return;
            busy = true; reload.Enabled = false; status.Text = "Katalog wird abgerufen …";
            try {
                var next = json.Deserialize<Catalog>(await Agent("catalog"));
                if (next == null || next.policy == null || next.apps == null) throw new IOException("Ungültiger Katalog.");
                catalog = next;
                var p = catalog.policy;
                Text = banner.Text = p.title; canvas.Theme = p.theme; accent = ColorTranslator.FromHtml(p.accent);
                ink = p.theme == "light" ? Color.FromArgb(26,47,67) : Color.White;
                if (p.layout != previousLayout) { list = p.layout == "list"; previousLayout = p.layout; }
                favorites.Visible = p.favorites; if (!p.favorites) onlyPinned = false;
                search.Visible = searchLabel.Visible = p.search; if (!p.search) search.Clear();
                identity.Text = catalog.principal; DrawCatalog(); canvas.Invalidate();
                status.Text = catalog.apps.Length + " Anwendungen  ·  Letzte Aktualisierung " +
                    new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddSeconds(catalog.updated).ToLocalTime().ToString("g");
            } catch (Exception ex) { status.Text = "Abruf fehlgeschlagen: " + ex.Message; }
            finally { busy = false; reload.Enabled = true; }
        }

        void Pin(Entry app) {
            if (!pinned.Remove(app.bundle)) pinned.Add(app.bundle);
            try {
                File.WriteAllLines(Path.Combine(root,"favorites.txt"),pinned.Select(i=>i.ToString()));
            } catch (IOException ex) { status.Text = ex.Message; }
            DrawCatalog();
        }

        async Task Launch(Entry app) {
            if (busy) return;
            if (app.unavailable) { status.Text = "Systemanforderungen nicht erfüllt."; return; }
            if (!app.launch.HasValue) {
                status.Text = "Die Ausführung dieser Anwendung wird durch ihre Zuweisung gesteuert."; return;
            }
            busy = true; reload.Enabled = false; status.Text = app.name + " wird gestartet …";
            try { await Agent("launch " + app.launch.Value); status.Text = app.name + " gestartet."; }
            catch (Exception ex) { status.Text = "Start fehlgeschlagen: " + ex.Message; }
            finally { busy = false; reload.Enabled = true; }
        }

        static string Glyph(string key) {
            switch (key) {
                case "folder":return "▰"; case "code":return "〈〉"; case "document":return "▤";
                case "tools":return "⚙"; case "web":return "◎"; case "office":return "▦"; default:return "◆";
            }
        }

        Bitmap AppIcon(Entry entry) {
            if (entry.symbol == "app" && !String.IsNullOrEmpty(entry.icon_path) && !Path.IsPathRooted(entry.icon_path)) {
                var programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + Path.DirectorySeparatorChar;
                try {
                    var path = Path.GetFullPath(Path.Combine(programs,entry.icon_path));
                    if (path.StartsWith(programs,StringComparison.OrdinalIgnoreCase) &&
                        String.Equals(Path.GetExtension(path),".exe",StringComparison.OrdinalIgnoreCase) && File.Exists(path))
                        using (var icon = Icon.ExtractAssociatedIcon(path)) { if (icon != null) return icon.ToBitmap(); }
                } catch (IOException) {} catch (ArgumentException) {} catch (UnauthorizedAccessException) {}
            }
            var colors = new[] { Color.SteelBlue,Color.Teal,Color.DarkSlateBlue,Color.Sienna,Color.SeaGreen };
            var image = new Bitmap(34,34);
            using (var g = Graphics.FromImage(image))
            using (var fill = new SolidBrush(colors[entry.bundle % colors.Length]))
            using (var font = new Font("Segoe UI Symbol",15)) {
                g.SmoothingMode = SmoothingMode.AntiAlias; g.FillEllipse(fill,1,1,32,32);
                TextRenderer.DrawText(g,Glyph(entry.symbol),font,new Rectangle(0,0,34,34),Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            }
            return image;
        }

        void DrawCatalog() {
            if (catalog == null) return;
            canvas.SuspendLayout();
            tips.RemoveAll();
            while (canvas.Controls.Count != 0) canvas.Controls[0].Dispose();
            canvas.FlowDirection = list ? FlowDirection.TopDown : FlowDirection.LeftToRight;
            canvas.WrapContents = !list;
            favorites.Text = onlyPinned ? "★ Favoriten" : "☆ Favoriten";
            layout.Text = list ? "Kachelansicht" : "Listenansicht";
            foreach (var app in catalog.apps.Where(a => (!onlyPinned || pinned.Contains(a.bundle))
                    && a.name.IndexOf(search.Text,StringComparison.CurrentCultureIgnoreCase)>=0)) {
                var tile = new Panel { Size = list ? new Size(410,45) : new Size(128,100),
                    Margin = new Padding(4), BackColor = Color.Transparent };
                var button = new Button { Text = app.name, Image = AppIcon(app),
                    TextImageRelation = list ? TextImageRelation.ImageBeforeText : TextImageRelation.ImageAboveText,
                    AccessibleName = app.name, Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, ForeColor = ink,
                    TextAlign = list ? ContentAlignment.MiddleLeft : ContentAlignment.MiddleCenter,
                    BackColor = canvas.Theme == "light" ? Color.FromArgb(227,239,246) : Color.FromArgb(30,49,72) };
                button.FlatAppearance.BorderColor = accent;
                button.Disposed += (s,e) => { if (button.Image != null) button.Image.Dispose(); };
                tips.SetToolTip(button, app.description + (app.unavailable ? "  ·  Systemanforderungen nicht erfüllt" : app.launch.HasValue ? "  ·  Starten" : "  ·  Regelgesteuert"));
                button.Click += async (s,e) => await Launch(app);
                tile.Controls.Add(button);
                if (catalog.policy.favorites) {
                    var pin = new Button { Text = pinned.Contains(app.bundle) ? "★" : "☆", Size = new Size(23,23),
                        Location = new Point(tile.Width-24,1), FlatStyle = FlatStyle.Flat, BackColor = button.BackColor,
                        ForeColor = ink, AccessibleName = "Favorit: " + app.name, TabStop = true };
                    pin.FlatAppearance.BorderSize=0; pin.Click += (s,e) => Pin(app);
                    tile.Controls.Add(pin); pin.BringToFront();
                }
                canvas.Controls.Add(tile);
            }
            if (canvas.Controls.Count == 0) canvas.Controls.Add(new Label { AutoSize = true, ForeColor = ink,
                BackColor = Color.Transparent, Margin = new Padding(12),
                Text = catalog.apps.Length == 0 ? "Diesem Benutzer sind noch keine Anwendungen zugewiesen." : "Keine passenden Anwendungen." });
            canvas.ResumeLayout(true);
        }
    }

    class Program {
        [STAThread] static void Main() {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Window());
        }
    }
}
