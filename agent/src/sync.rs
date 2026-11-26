use anyhow::{Context, Result, ensure};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use tempfile::NamedTempFile;

use crate::{Config, runner};

#[derive(Debug, Deserialize)]
pub struct Step {
    pub kind: String,
    pub value: String,
    pub requires: Option<crate::requirements::Condition>,
    #[serde(default)]
    pub fail_unmet: bool,
    #[serde(default)]
    pub continue_error: bool,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub text: Option<String>,
    pub source: Option<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub wait: Option<String>,
    pub seconds: Option<u64>,
    #[serde(default)]
    pub kill_timeout: bool,
    pub codes: Option<Vec<i32>>,
}

#[derive(Deserialize)]
struct Rule {
    id: u64,
    bundle: u64,
    version: String,
    install_version: String,
    phase: String,
    trigger: String,
    due: Option<u64>,
    requires: Option<crate::requirements::Condition>,
    steps: Vec<Step>,
    install: Vec<Step>,
}

#[derive(Deserialize)]
struct Manifest {
    agent: u64,
    scope: String,
    now: u64,
    assignments: Vec<Rule>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    agent: Option<u64>,
    events: BTreeSet<String>,
    installed: BTreeMap<u64, String>,
    jobs: BTreeMap<u64, Job>,
}

#[derive(Default, Serialize, Deserialize)]
struct Job {
    version: String,
    cursor: usize,
    prepared: bool,
    completed: bool,
    reboot: bool,
    #[serde(default)]
    warnings: usize,
    report: Option<(String, String)>,
}

impl State {
    pub fn load(dir: &Path) -> Result<Self> {
        match fs::File::open(dir.join("state.json")) {
            Ok(file) => Ok(serde_json::from_reader(file).context("Invalid agent state")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, dir: &Path) -> Result<()> {
        let mut file = NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut file, self)?;
        file.as_file().sync_all()?;
        file.persist(dir.join("state.json"))?;
        Ok(())
    }

    fn schedule(&mut self, rule: &Rule, now: u64) {
        let event = self.events.contains(&rule.trigger);
        let due = match rule.trigger.as_str() {
            "now" => true,
            "at" => rule.due.is_some_and(|t| t <= now),
            "boot" | "login" => event,
            _ => false,
        };
        if self
            .jobs
            .get(&rule.id)
            .is_some_and(|job| job.version != rule.version)
        {
            self.jobs.remove(&rule.id);
        }
        let previous = self.jobs.get(&rule.id);
        if due && (previous.is_none() || (event && previous.is_some_and(|job| job.completed))) {
            self.jobs.insert(
                rule.id,
                Job {
                    version: rule.version.clone(),
                    ..Job::default()
                },
            );
        }
    }
}

pub fn sync(
    config: &Config,
    dir: &Path,
    client: &Client,
    event: &str,
    manual: Option<u64>,
) -> Result<()> {
    let mut state = State::load(dir)?;
    if matches!(event, "login" | "boot") {
        state.events.insert(event.to_owned());
        state.save(dir)?;
    }
    let manifest: Manifest = client
        .get(config.url("manifest"))
        .bearer_auth(&config.token)
        .send()?
        .error_for_status()?
        .json()?;
    ensure!(
        manifest.scope == config.scope,
        "Credential belongs to a different execution context"
    );
    ensure!(
        state.agent.is_none_or(|id| id == manifest.agent),
        "State belongs to a different enrollment"
    );
    state.agent = Some(manifest.agent);
    state
        .jobs
        .retain(|id, _| manifest.assignments.iter().any(|rule| rule.id == *id));
    if let Some(id) = manual {
        let rule = manifest
            .assignments
            .iter()
            .find(|r| r.id == id && r.trigger == "manual" && r.phase == "start")
            .context("Diese Anwendung ist nicht mehr zum manuellen Start zugewiesen.")?;
        let job = state.jobs.entry(id).or_default();
        if job.completed || job.version != rule.version {
            *job = Job {
                version: rule.version.clone(),
                ..Job::default()
            };
        }
    } else {
        for rule in &manifest.assignments {
            state.schedule(rule, manifest.now);
        }
        state.events.clear();
    }
    state.save(dir)?;
    let mut failed = false;
    for rule in &manifest.assignments {
        if manual.is_some_and(|id| id != rule.id) {
            continue;
        }
        let Some(job) = state.jobs.get(&rule.id) else {
            continue;
        };
        if !job.completed && (rule.trigger != "manual" || manual.is_some()) {
            if let Some(condition) = &rule.requires {
                match condition.matches() {
                    Ok(true) => {}
                    Ok(false) if manual.is_none() => continue,
                    Ok(false) => anyhow::bail!(
                        "Die Systemanforderungen für diese Anwendung sind nicht erfüllt."
                    ),
                    Err(e) => {
                        eprintln!("Bundle {}: {e}", rule.bundle);
                        failed = true;
                        continue;
                    }
                }
            }
            let result = run_steps(config, dir, client, &mut state, rule);
            let job = state.jobs.get_mut(&rule.id).unwrap();
            match result {
                Ok(()) => {
                    job.completed = true;
                    let msg = if job.reboot {
                        "Erfolgreich. Neustart erforderlich."
                    } else {
                        "Erfolgreich"
                    };
                    job.report = Some((
                        "ok".into(),
                        if job.warnings > 0 {
                            format!("{msg}. {} Aktionsfehler übersprungen.", job.warnings)
                        } else {
                            msg.into()
                        },
                    ));
                }
                Err(error) => {
                    failed = true;
                    let msg: String = format!("Aktion {}: {error:#}", job.cursor + 1)
                        .chars()
                        .take(900)
                        .collect();
                    eprintln!("Assignment {}: {msg}", rule.id);
                    job.report = Some(("error".into(), msg));
                }
            }
            state.save(dir)?;
        }
        if let Some((status, detail)) = &state.jobs[&rule.id].report {
            let result = client
                .post(config.url("report"))
                .bearer_auth(&config.token)
                .json(
                    &serde_json::json!({"assignment": rule.id, "version": rule.version,
                    "status": status, "detail": detail}),
                )
                .send()
                .and_then(|r| r.error_for_status());
            match result {
                Ok(_) => {
                    state.jobs.get_mut(&rule.id).unwrap().report = None;
                    state.save(dir)?;
                }
                Err(error) => {
                    failed = true;
                    eprintln!("Status: {error}");
                }
            }
        }
    }
    ensure!(!failed, "Pending work will be retried on the next sync");
    Ok(())
}

fn run_steps(
    config: &Config,
    dir: &Path,
    client: &Client,
    state: &mut State,
    rule: &Rule,
) -> Result<()> {
    if !state.jobs[&rule.id].prepared {
        if rule.phase == "start" && state.installed.get(&rule.bundle) != Some(&rule.install_version)
        {
            run_list(config, dir, client, state, rule, &rule.install)?;
            state
                .installed
                .insert(rule.bundle, rule.install_version.clone());
        }
        let job = state.jobs.get_mut(&rule.id).unwrap();
        job.prepared = true;
        job.cursor = 0;
        state.save(dir)?;
    }
    run_list(config, dir, client, state, rule, &rule.steps)?;
    match rule.phase.as_str() {
        "install" => {
            state
                .installed
                .insert(rule.bundle, rule.install_version.clone());
        }
        "uninstall" => {
            state.installed.remove(&rule.bundle);
        }
        _ => {}
    }
    Ok(())
}

fn run_list(
    config: &Config,
    dir: &Path,
    client: &Client,
    state: &mut State,
    rule: &Rule,
    steps: &[Step],
) -> Result<()> {
    let id = rule.id;
    for step in steps.iter().skip(state.jobs[&id].cursor) {
        let result = (|| -> Result<bool> {
            if let Some(condition) = &step.requires {
                if !condition.matches()? {
                    ensure!(!step.fail_unmet, "Aktionsanforderungen nicht erfüllt");
                    return Ok(false);
                }
            }
            runner::execute(config, dir, client, rule.bundle, step)
        })();
        let reboot = match result {
            Err(e) if step.continue_error => {
                state.jobs.get_mut(&id).unwrap().warnings += 1;
                eprintln!("Zuweisung {id}: {e:#}");
                false
            }
            other => other?,
        };
        let job = state.jobs.get_mut(&id).unwrap();
        job.cursor += 1;
        job.reboot |= reboot;
        state.save(dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(trigger: &str) -> Rule {
        Rule {
            id: 1,
            bundle: 2,
            version: "v1".into(),
            install_version: "content".into(),
            phase: "install".into(),
            trigger: trigger.into(),
            due: Some(100),
            requires: None,
            steps: vec![],
            install: vec![],
        }
    }

    #[test]
    fn scheduled_assignment_catches_up_once_per_version() {
        let mut state = State::default();
        let mut rule = rule("at");
        state.schedule(&rule, 99);
        assert!(state.jobs.is_empty());
        state.schedule(&rule, 200);
        state.jobs.get_mut(&1).unwrap().completed = true;
        state.schedule(&rule, 201);
        assert!(state.jobs[&1].completed);
        rule.version = "v2".into();
        state.schedule(&rule, 202);
        assert!(!state.jobs[&1].completed);
    }

    #[test]
    fn boot_waits_for_event_and_preserves_unfinished_steps() {
        let mut state = State::default();
        let rule = rule("boot");
        state.events.insert("login".into());
        state.schedule(&rule, 100);
        assert!(state.jobs.is_empty());
        state.events.insert("boot".into());
        state.schedule(&rule, 101);
        state.jobs.get_mut(&1).unwrap().cursor = 2;
        let dir = tempfile::tempdir().unwrap();
        state.save(dir.path()).unwrap();
        let mut state = State::load(dir.path()).unwrap();
        state.schedule(&rule, 102);
        assert_eq!(state.jobs[&1].cursor, 2);
        state.jobs.get_mut(&1).unwrap().completed = true;
        state.schedule(&rule, 103);
        assert_eq!(state.jobs[&1].cursor, 0);
        assert!(!state.jobs[&1].completed);
    }
}
