use crate::Config;
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;

pub fn status_dir(config: &Config, dir: &Path) -> PathBuf {
    if config.scope == "device" {
        if let Some(parent) = dir.parent().filter(|_| {
            dir.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("DeviceAgent"))
        }) {
            return parent.join("Status");
        }
    }
    dir.to_owned()
}
pub fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    let mut temp = NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer(&mut temp, value)?;
    temp.persist(path)?;
    Ok(())
}
#[derive(Serialize)]
pub struct Progress<'a> {
    pub bundle: u64,
    pub name: &'a str,
    pub phase: String,
    pub action: String,
    pub step: usize,
    pub total: usize,
    pub done: u64,
    pub bytes: Option<u64>,
    pub msi_percent: Option<u8>,
    pub state: &'static str,
    pub pid: u32,
    pub updated: u64,
    #[serde(skip)]
    path: PathBuf,
    #[serde(skip)]
    last: Instant,
}
impl<'a> Progress<'a> {
    pub fn new(config: &Config, dir: &Path, bundle: u64, name: &'a str) -> Self {
        Self {
            bundle,
            name,
            phase: String::new(),
            action: String::new(),
            step: 0,
            total: 0,
            done: 0,
            bytes: None,
            msi_percent: None,
            state: "working",
            pid: std::process::id(),
            updated: 0,
            path: status_dir(config, dir).join("progress.json"),
            last: Instant::now(),
        }
    }
    pub fn emit(&mut self) {
        self.updated = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if let Err(e) = write_json(&self.path, self) {
            eprintln!("Fortschrittsanzeige: {e}");
        }
        self.last = Instant::now();
    }
    pub fn msi(&mut self, pct: u8) {
        if self.state != "msi"
            || (self.msi_percent != Some(pct)
                && (pct == 100 || self.last.elapsed() >= Duration::from_millis(150)))
        {
            self.state = "msi";
            self.msi_percent = Some(pct);
            self.emit();
        }
    }
    pub fn download(&mut self, done: u64, bytes: Option<u64>) {
        if done == 0 || Some(done) == bytes || self.last.elapsed() >= Duration::from_millis(200) {
            self.state = "download";
            self.bytes = bytes;
            self.done = done;
            self.emit();
        }
    }
}

pub fn machine_state() -> Option<PathBuf> {
    let base = env::var_os("ProgramW6432").or_else(|| env::var_os("ProgramFiles"))?;
    Some(PathBuf::from(base).join("OpenWorks/Status/installed.json"))
}
