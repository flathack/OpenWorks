using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OpenWorks {
    public class Activity {
        public int bundle, step, total, pid;
        public string name, phase, action, state;
        public long done, updated;
        public long? bytes;
        public int? msi_percent;
        public bool Active { get { return state == "working" || state == "download" || state=="msi"; } }
        public int Percent { get {
            if (state=="msi" && msi_percent.HasValue) return msi_percent.Value;
            if (state == "complete") return 100;
            if (state == "download" && bytes.GetValueOrDefault() > 0)
                return (int)Math.Min(100, 100.0 * done / bytes.Value);
            return total > 0 ? Math.Min(100, 100 * Math.Max(0, step-1) / total) : 0;
        }}
        static string Caption(string key) {
            switch(key) {
                case "install":return "Installieren"; case "repair":return "Reparieren"; case "uninstall":return "Deinstallieren";
                case "start": case "launch": return "Starten"; case "terminate":return "Beenden"; case "distribute":case "cache":return "Verteilen";
                case "uncache":return "Cache bereinigen";case "delay":return "Warten";case "mkdir":return "Verzeichnis erstellen";
                case "rmdir":return "Verzeichnis entfernen";case "write_text":return "Textdatei installieren";case "copy_file":return "Datei kopieren";
                case "remove_file":return "Datei entfernen";default:return key;
            }
        }
        public string Detail {get {
            if(state=="error") return "Fehler · "+action;
            if(state=="complete") return "Abgeschlossen";
            if(state=="interrupted") return "Unterbrochen";
            string stepText=Caption(phase)+" · Schritt "+step+" von "+total+" · "+Caption(action);
            if(state=="msi")return stepText+" · Windows Installer "+Percent+" %";
            if(state!="download")return stepText;
            return stepText+" · Herunterladen "+done.ToString("N0")+" Byte"+
                (bytes.HasValue?" von "+bytes.Value.ToString("N0")+" Byte ("+Percent+" %)":"");
        }}
    }

    class ActivityWindow : Form {
        readonly FlowLayoutPanel rows=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(12)};
        string previous;
        public ActivityWindow(){
            Text="OpenWorks · Fortschritt";Size=new Size(540,300);MinimumSize=new Size(450,200);
            Font=new Font("Segoe UI",9);Controls.Add(rows);
        }
        public void UpdateRows(IEnumerable<Activity> activities){
            var list=activities.ToArray();
            var key=String.Join("\n",list.Select(a=>a.name+" "+a.Detail+" "+a.Percent));
            if(key==previous)return;previous=key;rows.SuspendLayout();
            while(rows.Controls.Count>0)rows.Controls[0].Dispose();
            foreach(var a in list){
                rows.Controls.Add(new Label{Text=a.name,AutoSize=true});
                rows.Controls.Add(new Label{Text=a.Detail,AutoSize=true,MaximumSize=new Size(440,0)});
                var bar=new ProgressBar{Width=380,Height=12,Value=a.Percent,Margin=new Padding(3,2,3,13)};
                if(a.Active && a.state!="msi" && !(a.state=="download" && a.bytes.HasValue))bar.Style=ProgressBarStyle.Marquee;
                rows.Controls.Add(bar);
            }
            if(list.Length==0)rows.Controls.Add(new Label{Text="Keine laufenden Vorgänge.",AutoSize=true});
            rows.ResumeLayout();
        }
    }

    static class ActivityFiles {
        public static Activity Read(string path,JavaScriptSerializer json) {
            try{
                using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
                using(var r=new StreamReader(f,Encoding.UTF8)){
                    var a=json.Deserialize<Activity>(r.ReadToEnd());
                    if(a!=null && a.Active){
                        try{using(var p=Process.GetProcessById(a.pid)){if(p.HasExited || p.ProcessName!="openworks-agent")a.state="interrupted";}}
                        catch(ArgumentException){a.state="interrupted";}
                    }
                    return a;
                }
            } catch(IOException){} catch(UnauthorizedAccessException){} catch(InvalidOperationException){} catch(ArgumentException){}
            return null;
        }
    }
}
