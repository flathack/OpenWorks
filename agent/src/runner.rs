use crate::{Config, sync::Step};
use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
};
use tempfile::NamedTempFile;

const MAX_PACKAGE: u64 = 512 * 1024 * 1024;

fn package(config: &Config, dir: &Path, client: &Client, digest: &str) -> Result<PathBuf> {
    ensure!(
        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid content hash"
    );
    let cache = dir.join("cache");
    fs::create_dir_all(&cache)?;
    let path = cache.join(format!("{digest}.msi"));
    if path.exists() {
        let mut hash = Sha256::new();
        io::copy(&mut fs::File::open(&path)?, &mut hash)?;
        if hex::encode(hash.finalize()) == digest {
            return Ok(path);
        }
    }
    let mut response = client
        .get(config.url(&format!("packages/{digest}")))
        .bearer_auth(&config.token)
        .send()?
        .error_for_status()?
        .take(MAX_PACKAGE + 1);
    let mut temp = NamedTempFile::new_in(cache)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0;
    loop {
        let n = response.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        ensure!(size <= MAX_PACKAGE, "Package exceeds size limit");
        temp.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
    }
    ensure!(
        hex::encode(hash.finalize()) == digest,
        "Package checksum mismatch"
    );
    temp.as_file().sync_all()?;
    temp.persist(&path)?;
    Ok(path)
}

fn start(relative: &str) -> Result<()> {
    if relative.eq_ignore_ascii_case(r"%SystemRoot%\explorer.exe") {
        let root = env::var_os("SystemRoot").context("SystemRoot missing")?;
        Command::new(Path::new(&root).join("explorer.exe"))
            .spawn()
            .context("Windows Explorer launch failed")?;
        return Ok(());
    }
    let exe = Path::new(relative);
    ensure!(
        exe.extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("exe"))
            && !relative.contains(':')
            && exe.components().all(|c| matches!(c, Component::Normal(_))),
        "Invalid application path"
    );
    let base = fs::canonicalize(env::var_os("ProgramFiles").context("ProgramFiles missing")?)?;
    let target =
        fs::canonicalize(base.join(exe)).context("Application missing from Program Files")?;
    ensure!(
        target.starts_with(&base),
        "Application outside Program Files"
    );
    Command::new(target).spawn().context("Launch failed")?;
    Ok(())
}

pub fn execute(config: &Config, dir: &Path, client: &Client, step: &Step) -> Result<bool> {
    ensure!(cfg!(windows), "This agent executes Windows actions only");
    if step.kind == "launch" {
        ensure!(
            config.scope == "user",
            "Launch requires an interactive user"
        );
        start(&step.value)?;
        return Ok(false);
    }
    let install = match step.kind.as_str() {
        "install" => true,
        "uninstall" => false,
        _ => bail!("Unknown action type"),
    };
    let file = package(config, dir, client, &step.value)?;
    let root = env::var_os("SystemRoot").context("SystemRoot missing")?;
    let mut cmd = Command::new(Path::new(&root).join("System32/msiexec.exe"));
    cmd.arg(if install { "/i" } else { "/x" })
        .arg(file)
        .args(["/qn", "/norestart"]);
    if install && config.scope == "user" {
        cmd.args(["ALLUSERS=2", "MSIINSTALLPERUSER=1"]);
    } else if install {
        cmd.arg("ALLUSERS=1");
    }
    match cmd.status()?.code() {
        Some(0) => Ok(false),
        Some(3010) | Some(1641) => Ok(true),
        Some(1605) if !install => Ok(false),
        code => bail!("Windows Installer exit code {code:?}"),
    }
}
