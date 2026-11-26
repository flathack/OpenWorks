mod runner;
mod sync;

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
        args.len() == 3,
        "Usage: openworks-agent <config.json> <poll|boot|login>"
    );
    let event = args[2].to_str().unwrap_or("");
    ensure!(
        matches!(event, "poll" | "boot" | "login"),
        "Unknown trigger"
    );
    // Windows Installer accepts ordinary drive and UNC paths to cached packages.
    let path = std::path::absolute(Path::new(&args[1])).context("Invalid config path")?;
    let dir = path.parent().context("Config needs a parent directory")?;
    let text = fs::read_to_string(&path)?;
    let config: Config = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    config.validate()?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("agent.lock"))?;
    lock.lock()?;
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()?;
    sync::sync(&config, dir, &client, event)
}
