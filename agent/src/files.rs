use crate::sync::Step;
use anyhow::{Context, Result, ensure};
use std::os::windows::fs::MetadataExt;
use std::{
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
};
use tempfile::NamedTempFile;

// Bundle files live in the protected enrollment directory, independently per bundle.
fn checked_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut result = root.to_path_buf();
    ensure!(
        !relative.is_empty() && !relative.contains([':', '/', '\0']),
        "Ungültiger Dateipfad"
    );
    for part in Path::new(relative).components() {
        let Component::Normal(name) = part else {
            anyhow::bail!("Relativer Pfad erforderlich");
        };
        let name = name.to_str().context("Ungültiger Dateiname")?;
        ensure!(
            !name.ends_with([' ', '.'])
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || " .()_-".contains(c)),
            "Ungültiger Dateiname"
        );
        let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        ensure!(
            !matches!(base.as_str(), "NUL" | "CON" | "PRN" | "AUX")
                && !((base.starts_with("COM") || base.starts_with("LPT"))
                    && base.len() == 4
                    && base.as_bytes()[3].is_ascii_digit()),
            "Reservierter Dateiname"
        );
        result.push(name);
        match fs::symlink_metadata(&result) {
            Ok(m) => ensure!(
                m.file_attributes() & 0x400 == 0,
                "Verknüpfung im Bundle-Arbeitsverzeichnis"
            ),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(result)
}

pub fn apply(dir: &Path, bundle: u64, step: &Step) -> Result<()> {
    let root = checked_path(dir, &format!("bundles\\{bundle}"))?;
    fs::create_dir_all(&root)?;
    let target = checked_path(&root, &step.value)?;
    match step.kind.as_str() {
        "mkdir" => fs::create_dir_all(target)?,
        "rmdir" | "remove_file" => {
            let result = if step.kind == "rmdir" {
                fs::remove_dir(target)
            } else {
                fs::remove_file(target)
            };
            if let Err(e) = result {
                if e.kind() != io::ErrorKind::NotFound {
                    return Err(e.into());
                }
            }
        }
        "write_text" | "copy_file" => {
            let parent = target.parent().context("Zielordner fehlt")?;
            let mut temp = NamedTempFile::new_in(parent)?;
            if step.kind == "write_text" {
                let content = step.text.as_ref().context("Dateiinhalt fehlt")?;
                ensure!(content.len() <= 65536, "Datei zu groß");
                temp.write_all(content.as_bytes())?;
            } else {
                let source =
                    checked_path(&root, step.source.as_ref().context("Quelldatei fehlt")?)?;
                io::copy(&mut fs::File::open(source)?, &mut temp)?;
            }
            temp.as_file().sync_all()?;
            temp.persist(target)?;
        }
        _ => anyhow::bail!("Unbekannte Dateiaktion"),
    }
    Ok(())
}
