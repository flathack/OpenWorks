#[cfg(windows)]
mod files;
mod inventory;
#[cfg(windows)]
mod msi;
mod progress;
mod requirements;
mod runner;
#[cfg(windows)]
mod service;
mod sync;
#[cfg(windows)]
mod windows_filters;

use anyhow::{Context, Result, ensure};
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde::Deserialize;
use std::{env, fs, path::Path, time::Duration};

#[derive(Deserialize)]
pub struct Config {
    server: String,
    token: String,
    scope: String,
}

impl Config {
    fn validate(&self) -> Result<()> {
        let url = Url::parse(&self.server)?;
        let local = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
        ensure!(
            url.scheme() == "https" || (local && url.scheme() == "http"),
            "HTTPS required for remote servers"
        );
        ensure!(
            url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none(),
            "Expected a server origin without path or credentials"
        );
        ensure!(
            matches!(self.scope.as_str(), "device" | "user") && !self.token.is_empty(),
            "Invalid enrollment"
        );
        Ok(())
    }
    fn url(&self, suffix: &str) -> String {
        format!("{}/api/agent/{suffix}", self.server.trim_end_matches('/'))
    }
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().collect();
    ensure!(
        (3..=4).contains(&args.len()),
        "Usage: openworks-agent <config.json> <poll|boot|login|catalog|inventory|launch ID>"
    );
    let event = args[2].to_str().unwrap_or("");
    #[cfg(windows)]
    if event == "service" && args.len() == 3 {
        return service::dispatch();
    }
    ensure!(
        matches!(
            event,
            "poll" | "boot" | "login" | "catalog" | "inventory" | "launch"
        ) && (event == "launch") == (args.len() == 4),
        "Unknown trigger"
    );
    // Windows Installer accepts ordinary drive and UNC paths to cached packages.
    let path = std::path::absolute(Path::new(&args[1])).context("Invalid config path")?;
    let dir = path.parent().context("Config needs a parent directory")?;
    let text = fs::read_to_string(&path)?;
    let config: Config = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    config.validate()?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-openworks-protocol",
        reqwest::header::HeaderValue::from_static("2"),
    );
    let client = Client::builder()
        .default_headers(headers)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()?;
    if event == "catalog" {
        ensure!(config.scope == "user", "Catalog requires user enrollment");
        let mut result: serde_json::Value = client
            .get(config.url("catalog"))
            .bearer_auth(&config.token)
            .send()?
            .error_for_status()?
            .json()?;
        requirements::filter_catalog(&mut result)?;
        sync::installed_catalog(dir, &mut result)?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("agent.lock"))?;
    lock.lock()?;
    if event == "inventory" {
        return inventory::send(&config, dir, &client);
    }
    let manual = if event == "launch" {
        ensure!(config.scope == "user", "Launch requires user enrollment");
        Some(
            args[3]
                .to_str()
                .context("Invalid assignment")?
                .parse::<u64>()?,
        )
    } else {
        None
    };
    let result = sync::sync(&config, dir, &client, event, manual);
    if config.scope == "device"
        && inventory::due(dir)
        && let Err(error) = inventory::send(&config, dir, &client)
    {
        eprintln!("Inventory: {error}");
    }
    result
}
