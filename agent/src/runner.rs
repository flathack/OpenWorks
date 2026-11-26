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

fn package(
    config: &Config,
    dir: &Path,
    client: &Client,
    digest: &str,
    progress: &mut crate::progress::Progress,
) -> Result<PathBuf> {
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
    let response = client
        .get(config.url(&format!("packages/{digest}")))
        .bearer_auth(&config.token)
        .send()?
        .error_for_status()?;
    let total = response.content_length();
    let mut response = response.take(MAX_PACKAGE + 1);
    progress.download(0, total);
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
        progress.download(size, total);
    }
    ensure!(
        hex::encode(hash.finalize()) == digest,
        "Package checksum mismatch"
    );
    temp.as_file().sync_all()?;
    temp.persist(&path)?;
    progress.state = "working";
    progress.bytes = None;
    progress.done = 0;
    progress.emit();
    Ok(path)
}

fn under_program_files(relative: &str) -> Result<PathBuf> {
    let exe = Path::new(relative);
    ensure!(
        !relative.contains(':') && exe.components().all(|c| matches!(c, Component::Normal(_))),
        "Invalid application path"
    );
    let base = fs::canonicalize(env::var_os("ProgramFiles").context("ProgramFiles missing")?)?;
    let target =
        fs::canonicalize(base.join(exe)).context("Application missing from Program Files")?;
    ensure!(
        target.starts_with(&base),
        "Application outside Program Files"
    );
    Ok(target)
}

fn start(step: &Step) -> Result<()> {
    let target = if step
        .value
        .eq_ignore_ascii_case(r"%SystemRoot%\explorer.exe")
    {
        PathBuf::from(env::var_os("SystemRoot").context("SystemRoot missing")?).join("explorer.exe")
    } else {
        ensure!(
            step.value.to_ascii_lowercase().ends_with(".exe"),
            "EXE erforderlich"
        );
        under_program_files(&step.value)?
    };
    let mut cmd = Command::new(target);
    cmd.envs(&step.environment);
    if let Some(cwd) = &step.cwd {
        cmd.current_dir(under_program_files(cwd)?);
    }
    use std::process::Stdio;
    let mut child = cmd
        .args(&step.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let status = match step.wait.as_deref() {
        None | Some("none") => return Ok(()),
        Some("exit") => child.wait()?,
        Some("timeout") => {
            use std::time::{Duration, Instant};
            let deadline =
                Instant::now() + Duration::from_secs(step.seconds.unwrap_or(60).min(86400));
            loop {
                if let Some(status) = child.try_wait()? {
                    break status;
                }
                if Instant::now() >= deadline {
                    if step.kill_timeout {
                        child.kill()?;
                        child.wait()?;
                    }
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        _ => bail!("Ungültige Warteoption"),
    };
    let code = status.code().context("Prozess ohne Rückgabecode beendet")?;
    ensure!(
        step.codes.as_deref().unwrap_or(&[0]).contains(&code),
        "Rückgabecode {code}"
    );
    Ok(())
}

pub fn execute(
    config: &Config,
    dir: &Path,
    client: &Client,
    bundle: u64,
    step: &Step,
    progress: &mut crate::progress::Progress,
) -> Result<bool> {
    ensure!(cfg!(windows), "This agent executes Windows actions only");
    if step.kind == "launch" {
        ensure!(
            config.scope == "user",
            "Launch requires an interactive user"
        );
        start(step)?;
        return Ok(false);
    }
    if matches!(
        step.kind.as_str(),
        "mkdir" | "rmdir" | "copy_file" | "remove_file" | "write_text"
    ) {
        #[cfg(not(windows))]
        bail!("Windows erforderlich: {bundle}");
        #[cfg(windows)]
        return crate::files::apply(dir, bundle, step).map(|_| false);
    }
    if step.kind == "delay" {
        let seconds = step.value.parse::<u64>()?;
        ensure!((1..=300).contains(&seconds), "Ungültige Verzögerung");
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        return Ok(false);
    }
    if step.kind == "uncache" {
        ensure!(
            step.value.len() == 64 && step.value.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid content hash"
        );
        let cached = dir.join("cache").join(format!("{}.msi", step.value));
        match fs::remove_file(cached) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        return Ok(false);
    }
    let switch = match step.kind.as_str() {
        "install" => "/i",
        "uninstall" => "/x",
        "repair" => "/fomus",
        "cache" => {
            package(config, dir, client, &step.value, progress)?;
            return Ok(false);
        }
        _ => bail!("Unknown action type"),
    };

    let file = package(config, dir, client, &step.value, progress)?;
    #[cfg(windows)]
    if step.kind == "install" {
        return match crate::msi::install(&file, config.scope == "user", progress)? {
            0 => Ok(false),
            3010 | 1641 => Ok(true),
            code => bail!("Windows Installer exit code {code}"),
        };
    }
    let root = env::var_os("SystemRoot").context("SystemRoot missing")?;
    let mut cmd = Command::new(Path::new(&root).join("System32/msiexec.exe"));
    cmd.arg(switch).arg(file).args(["/qn", "/norestart"]);
    match cmd.status()?.code() {
        Some(0) => Ok(false),
        Some(3010) | Some(1641) => Ok(true),
        Some(1605) if step.kind == "uninstall" => Ok(false),
        code => bail!("Windows Installer exit code {code:?}"),
    }
}
