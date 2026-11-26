use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use std::{env, path::PathBuf};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Condition {
    Group {
        mode: String,
        rules: Vec<Condition>,
    },
    Filter {
        kind: String,
        value: String,
        expected: bool,
    },
}

impl Condition {
    pub fn matches(&self) -> Result<bool> {
        match self {
            Self::Group { mode, rules } => {
                ensure!(
                    mode == "all" || mode == "any",
                    "Unbekannte Filterkombination"
                );
                if rules.is_empty() {
                    return Ok(true);
                }
                for rule in rules {
                    let matched = rule.matches()?;
                    if mode == "all" && !matched {
                        return Ok(false);
                    }
                    if mode == "any" && matched {
                        return Ok(true);
                    }
                }
                Ok(mode == "all")
            }
            Self::Filter {
                kind,
                value,
                expected,
            } => {
                let actual = match kind.as_str() {
                    "windows" => cfg!(windows) && value.eq_ignore_ascii_case("Windows"),
                    "hostname" => env::var("COMPUTERNAME")?.eq_ignore_ascii_case(value),
                    "file" => local_path(value)?.try_exists()?,
                    #[cfg(windows)]
                    "architecture" | "memory" | "free_disk" | "service" | "running"
                    | "registry" => crate::windows_filters::matches(kind, value)?,
                    _ => bail!("Unbekannter Filter"),
                };
                Ok(actual == *expected)
            }
        }
    }
}

fn local_path(value: &str) -> Result<PathBuf> {
    for key in ["ProgramFiles", "SystemRoot"] {
        let prefix = format!("%{key}%\\");
        if value
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
        {
            let suffix = std::path::Path::new(&value[prefix.len()..]);
            ensure!(
                suffix
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "Ungültiger Pfad"
            );
            return Ok(PathBuf::from(env::var_os(key).context("Windows-Pfad fehlt")?).join(suffix));
        }
    }
    let path = PathBuf::from(value);
    ensure!(
        path.is_absolute()
            && matches!(path.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_))),
        "Lokalen absoluten Dateipfad angeben"
    );
    Ok(path)
}

pub fn filter_catalog(result: &mut serde_json::Value) -> Result<()> {
    let apps = result["apps"]
        .as_array_mut()
        .context("Ungültiger Katalog")?;
    apps.retain_mut(|app| {
        let Some(raw) = app.get("requires") else {
            return true;
        };
        if serde_json::from_value::<Condition>(raw.clone())
            .ok()
            .and_then(|c| c.matches().ok())
            == Some(true)
        {
            return true;
        }
        app["launch"] = serde_json::Value::Null;
        app["unavailable"] = true.into();
        app["show_unmet"].as_bool() == Some(true)
    });
    Ok(())
}
