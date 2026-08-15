use crate::frontmatter::{self, FrontMatter};
use crate::root::memory_dir;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime};

pub const OVERVIEW_SKELETON: &str =
    "# Project overview\n\n## Purpose\n\n## Stack\n\n## Run and test\n\n## Conventions\n\n## Gotchas\n";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("project memory is not initialised")]
    NotInitialised,
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub front: Option<FrontMatter>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct WriteOutcome {
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub updated: String,
    pub cli: String,
    pub branch: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SessionInput {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub dead_ends: Vec<String>,
    #[serde(default)]
    pub next: Vec<String>,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(root: &Path, dir_name: &str) -> Self {
        Self {
            dir: memory_dir(root, dir_name),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn exists(&self) -> bool {
        self.dir.join("overview.md").is_file()
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn ensure(&self) -> Result<()> {
        if self.exists() {
            Ok(())
        } else {
            Err(StoreError::NotInitialised)
        }
    }

    fn read_doc(&self, name: &str) -> Result<Doc> {
        self.ensure()?;
        let text = match fs::read_to_string(self.path(name)) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let (front, body) = frontmatter::parse(&text);
        Ok(Doc {
            front,
            body: body.to_string(),
        })
    }

    fn write_atomic(&self, name: &str, fm: &FrontMatter, body: &str) -> Result<()> {
        let target = self.path(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = target.with_extension("md.tmp");
        fs::write(&tmp, frontmatter::render(fm, body))?;
        fs::rename(&tmp, &target)?;
        Ok(())
    }

    pub fn init(&self, by: &str) -> Result<()> {
        if self.exists() {
            return Ok(());
        }
        fs::create_dir_all(self.dir.join("sessions"))?;
        self.write_atomic("overview.md", &FrontMatter::now(by), OVERVIEW_SKELETON)?;
        self.write_atomic("decisions.md", &FrontMatter::now(by), "# Decisions\n")?;
        self.write_atomic("resume.md", &FrontMatter::now(by), "")
    }

    pub fn overview(&self) -> Result<Doc> {
        self.read_doc("overview.md")
    }

    pub fn write_overview(&self, body: &str, by: &str, max_bytes: usize) -> Result<WriteOutcome> {
        self.ensure()?;
        self.write_atomic("overview.md", &FrontMatter::now(by), body)?;
        let warning = (body.len() > max_bytes).then(|| {
            format!(
                "overview is {} bytes, above the {} byte cap; keep it to one screen",
                body.len(),
                max_bytes
            )
        });
        Ok(WriteOutcome { warning })
    }

    pub fn decisions(&self, since: Option<Date>, query: Option<&str>) -> Result<String> {
        let doc = self.read_doc("decisions.md")?;
        let needle = query.map(str::to_lowercase);
        let kept: Vec<&str> = split_entries(&doc.body)
            .into_iter()
            .filter(|e| since.is_none_or(|d| entry_date(e).is_some_and(|ed| ed >= d)))
            .filter(|e| needle.as_ref().is_none_or(|q| e.to_lowercase().contains(q)))
            .collect();
        Ok(kept.join("\n"))
    }

    pub fn record_decision(
        &self,
        title: &str,
        body: &str,
        alternatives: Option<&str>,
        by: &str,
    ) -> Result<()> {
        if title.trim().is_empty() {
            return Err(StoreError::InvalidArgs("title is required".into()));
        }
        let doc = self.read_doc("decisions.md")?;
        let today = OffsetDateTime::now_utc().date();
        let mut text = doc.body;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!(
            "\n## {today} · {}\n\n{}\n",
            title.trim(),
            body.trim()
        ));
        if let Some(alt) = alternatives.filter(|a| !a.trim().is_empty()) {
            text.push_str(&format!("\nAlternatives: {}\n", alt.trim()));
        }
        self.write_atomic("decisions.md", &FrontMatter::now(by), &text)
    }

    pub fn resume(&self) -> Result<Doc> {
        self.read_doc("resume.md")
    }

    pub fn set_resume(&self, body: &str, by: &str) -> Result<()> {
        self.ensure()?;
        self.write_atomic("resume.md", &FrontMatter::now(by), body)
    }

    pub fn sessions(&self, limit: usize) -> Result<Vec<SessionMeta>> {
        self.ensure()?;
        let mut ids: Vec<String> = match fs::read_dir(self.dir.join("sessions")) {
            Ok(rd) => rd
                .flatten()
                .filter_map(|e| {
                    e.file_name()
                        .to_str()
                        .and_then(|n| n.strip_suffix(".md"))
                        .map(str::to_string)
                })
                .collect(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        ids.sort_unstable_by(|a, b| b.cmp(a));
        ids.truncate(limit);
        ids.into_iter()
            .map(|id| {
                let fm = self.session(&id)?.front;
                let get = |k: &str| {
                    fm.as_ref()
                        .and_then(|f| f.extra.get(k).cloned())
                        .unwrap_or_default()
                };
                Ok(SessionMeta {
                    title: get("title"),
                    cli: get("cli"),
                    branch: get("branch"),
                    updated: fm
                        .as_ref()
                        .and_then(|f| f.updated.format(&Rfc3339).ok())
                        .unwrap_or_default(),
                    id,
                })
            })
            .collect()
    }

    pub fn session(&self, id: &str) -> Result<Doc> {
        if id.is_empty() || id.contains('/') || id.contains("..") {
            return Err(StoreError::InvalidArgs("invalid session id".into()));
        }
        self.read_doc(&format!("sessions/{id}.md"))
    }

    pub fn save_session(
        &self,
        input: &SessionInput,
        by: &str,
        cli: &str,
        branch: Option<&str>,
        cwd: &Path,
    ) -> Result<String> {
        self.ensure()?;
        let title = input.title.trim();
        if title.is_empty() {
            return Err(StoreError::InvalidArgs("title is required".into()));
        }
        let now = OffsetDateTime::now_utc();
        let stamp = format!(
            "{:04}-{:02}-{:02}-{:02}{:02}",
            now.year(),
            now.month() as u8,
            now.day(),
            now.hour(),
            now.minute()
        );
        let id = format!("{stamp}-{}-{}", slug(cli), slug(title));
        let mut body = format!("# {title}\n\n{}\n", input.summary.trim());
        let sections = [
            ("Changes", &input.changes),
            ("Decisions", &input.decisions),
            ("Dead ends", &input.dead_ends),
            ("Next", &input.next),
        ];
        for (heading, items) in sections {
            if items.is_empty() {
                continue;
            }
            body.push_str(&format!("\n## {heading}\n"));
            for it in items {
                body.push_str(&format!("- {}\n", it.trim()));
            }
        }
        let fm = FrontMatter::now(by)
            .with("title", title)
            .with("cli", cli)
            .with("branch", branch.unwrap_or(""))
            .with("cwd", &cwd.to_string_lossy());
        self.write_atomic(&format!("sessions/{id}.md"), &fm, &body)?;
        Ok(id)
    }
}

fn split_entries(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, _) in body.match_indices("\n## ") {
        if let Some(s) = start {
            out.push(&body[s..i]);
        }
        start = Some(i + 1);
    }
    if let Some(s) = start {
        out.push(&body[s..]);
    }
    out
}

fn entry_date(entry: &str) -> Option<Date> {
    let head = entry.strip_prefix("## ")?.get(..10)?;
    let fmt = time::macros::format_description!("[year]-[month]-[day]");
    Date::parse(head, &fmt).ok()
}

pub fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').chars().take(48).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, Store) {
        let tmp = TempDir::new().unwrap();
        let s = Store::new(tmp.path(), crate::DEFAULT_DIR_NAME);
        (tmp, s)
    }

    #[test]
    fn init_is_idempotent_and_writes_skeleton() {
        let (_t, s) = store();
        assert!(!s.exists());
        s.init("claude-code").unwrap();
        assert!(s.exists());
        let doc = s.overview().unwrap();
        assert_eq!(doc.body, OVERVIEW_SKELETON);
        assert_eq!(doc.front.unwrap().by, "claude-code");
        s.write_overview("custom", "codex", 4096).unwrap();
        s.init("claude-code").unwrap();
        assert_eq!(s.overview().unwrap().body, "custom");
    }

    #[test]
    fn reads_before_init_report_not_initialised() {
        let (_t, s) = store();
        assert!(matches!(s.overview(), Err(StoreError::NotInitialised)));
        assert!(matches!(s.resume(), Err(StoreError::NotInitialised)));
    }

    #[test]
    fn overview_cap_warns_but_writes() {
        let (_t, s) = store();
        s.init("x").unwrap();
        let big = "a".repeat(5000);
        let out = s.write_overview(&big, "x", 4096).unwrap();
        assert!(out.warning.unwrap().contains("4096"));
        assert_eq!(s.overview().unwrap().body, big);
    }

    #[test]
    fn decisions_append_and_filter() {
        let (_t, s) = store();
        s.init("x").unwrap();
        s.record_decision(
            "Use rmcp",
            "Official SDK.",
            Some("hand-rolled JSON-RPC"),
            "claude-code",
        )
        .unwrap();
        s.record_decision("Keep sha2 0.10", "Tauri pins digest.", None, "codex")
            .unwrap();
        let all = s.decisions(None, None).unwrap();
        assert!(
            all.contains("## ")
                && all.contains("Use rmcp")
                && all.contains("Alternatives: hand-rolled JSON-RPC"),
            "{all}"
        );
        let only = s.decisions(None, Some("sha2")).unwrap();
        assert!(only.contains("Keep sha2") && !only.contains("Use rmcp"));
        let future = Date::from_calendar_date(2999, time::Month::January, 1).unwrap();
        assert_eq!(s.decisions(Some(future), None).unwrap().trim(), "");
    }

    #[test]
    fn resume_overwrites() {
        let (_t, s) = store();
        s.init("x").unwrap();
        s.set_resume("first", "a").unwrap();
        s.set_resume("second", "b").unwrap();
        let doc = s.resume().unwrap();
        assert_eq!(doc.body, "second");
        assert_eq!(doc.front.unwrap().by, "b");
    }

    #[test]
    fn sessions_are_listed_newest_first_and_readable() {
        let (_t, s) = store();
        s.init("x").unwrap();
        let input = SessionInput {
            title: "Fix caret jump".into(),
            summary: "moved cap to cm-content".into(),
            changes: vec!["editor.ts".into()],
            ..Default::default()
        };
        let id = s
            .save_session(
                &input,
                "claude-code",
                "claude-code",
                Some("main"),
                Path::new("/p"),
            )
            .unwrap();
        assert!(id.ends_with("-claude-code-fix-caret-jump"), "{id}");
        let list = s.sessions(20).unwrap();
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].branch, "main");
        let doc = s.session(&id).unwrap();
        assert!(doc.body.contains("## Changes") && doc.body.contains("editor.ts"));
        assert_eq!(doc.front.unwrap().extra["cwd"], "/p");
    }

    #[test]
    fn save_session_rejects_empty_title_and_bad_ids() {
        let (_t, s) = store();
        s.init("x").unwrap();
        let bad = SessionInput {
            title: "  ".into(),
            ..Default::default()
        };
        assert!(matches!(
            s.save_session(&bad, "c", "c", None, Path::new("/")),
            Err(StoreError::InvalidArgs(_))
        ));
        assert!(matches!(
            s.session("../overview"),
            Err(StoreError::InvalidArgs(_))
        ));
    }

    #[test]
    fn slug_is_kebab_ascii_and_bounded() {
        assert_eq!(slug("Fix: Caret Jump!!"), "fix-caret-jump");
        assert_eq!(slug("Claude Code"), "claude-code");
        assert!(slug(&"x".repeat(100)).len() <= 48);
    }
}
