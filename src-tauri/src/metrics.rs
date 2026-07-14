use rusqlite::Connection;
use serde::Deserialize;
use shirei_mux::lock::MutexExt;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

use crate::error::Result;

const SCHEMA_VERSION: i64 = 1;

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE event (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_utc        INTEGER NOT NULL,
                tz_offset_min INTEGER NOT NULL,
                kind          TEXT    NOT NULL,
                session_id    TEXT,
                project_id    TEXT,
                tab_id        TEXT,
                cli_name      TEXT,
                payload       TEXT
            );
            CREATE INDEX idx_event_ts      ON event(ts_utc);
            CREATE INDEX idx_event_kind    ON event(kind);
            CREATE INDEX idx_event_project ON event(project_id);
            CREATE TABLE reflection_event (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_utc     INTEGER NOT NULL,
                session_id TEXT,
                focus      INTEGER,
                energy     INTEGER,
                note       TEXT
            );",
        )?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
    }
    Ok(())
}

#[derive(Default)]
pub struct MetricsStore {
    conn: Mutex<Option<Connection>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventIn {
    pub ts_utc: i64,
    pub tz_offset_min: i32,
    pub kind: String,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub tab_id: Option<String>,
    pub cli_name: Option<String>,
    pub payload: Option<String>,
}

impl MetricsStore {
    pub fn open(&self, path: &Path) -> rusqlite::Result<()> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&conn)?;
        *self.conn.lock_ignore_poison() = Some(conn);
        Ok(())
    }

    fn append(&self, events: &[EventIn]) -> rusqlite::Result<()> {
        let guard = self.conn.lock_ignore_poison();
        let conn = guard.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO event
                   (ts_utc, tz_offset_min, kind, session_id, project_id, tab_id, cli_name, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for e in events {
                stmt.execute(rusqlite::params![
                    e.ts_utc,
                    e.tz_offset_min,
                    e.kind,
                    e.session_id,
                    e.project_id,
                    e.tab_id,
                    e.cli_name,
                    e.payload,
                ])?;
            }
        }
        tx.commit()
    }
}

#[tauri::command]
pub fn metrics_log(store: State<'_, MetricsStore>, events: Vec<EventIn>) -> Result<()> {
    Ok(store.append(&events)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("shirei-metrics-{}-{}.db", std::process::id(), name))
    }

    fn ev(kind: &str, project: Option<&str>) -> EventIn {
        EventIn {
            ts_utc: 1,
            tz_offset_min: -180,
            kind: kind.into(),
            session_id: Some("s1".into()),
            project_id: project.map(Into::into),
            tab_id: Some("t1".into()),
            cli_name: None,
            payload: None,
        }
    }

    #[test]
    fn append_persists_events_including_null_project() {
        let path = tmp_path("append");
        let _ = std::fs::remove_file(&path);
        let store = MetricsStore::default();
        store.open(&path).unwrap();
        store
            .append(&[ev("session_start", Some("p1")), ev("input_activity", None)])
            .unwrap();

        let conn = rusqlite::Connection::open(&path).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM event", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        let nulls: i64 = conn
            .query_row("SELECT COUNT(*) FROM event WHERE project_id IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(nulls, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn migrate_is_idempotent_and_creates_reflection_table() {
        let path = tmp_path("migrate");
        let _ = std::fs::remove_file(&path);
        let store = MetricsStore::default();
        store.open(&path).unwrap();
        // open again → migrate must not error on an already-migrated db
        store.open(&path).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        let has_reflection: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='reflection_event'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_reflection, 1);
        let _ = std::fs::remove_file(&path);
    }
}
