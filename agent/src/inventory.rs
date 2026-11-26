use crate::Config;
use anyhow::{Context, Result, ensure};
use reqwest::blocking::Client;
use std::{env, fs, path::Path, process::Command, time::Duration};

pub fn due(dir: &Path) -> bool {
    fs::metadata(dir.join("inventory.sent"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age >= Duration::from_secs(900))
}

pub fn send(config: &Config, dir: &Path, client: &Client) -> Result<()> {
    ensure!(
        config.scope == "device",
        "Inventory requires device enrollment"
    );
    let system = env::var_os("SystemRoot").context("Windows directory missing")?;
    let shell = Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = Command::new(shell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("inventory.ps1"),
        ])
        .output()?;
    ensure!(
        output.status.success(),
        "Windows inventory collection failed"
    );
    let mut inventory: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    inventory["version"] = env!("CARGO_PKG_VERSION").into();
    client
        .post(config.url("inventory"))
        .bearer_auth(&config.token)
        .json(&inventory)
        .send()?
        .error_for_status()?;
    fs::write(dir.join("inventory.sent"), [])?;
    Ok(())
}
