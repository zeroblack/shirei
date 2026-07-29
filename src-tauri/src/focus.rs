use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::ConfigManager;
use crate::error::Result;
use crate::metrics::MetricsStore;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FocusStatus {
    Running,
    Paused,
    Completed,
    Skipped,
    Abandoned,
    Crashed,
}

impl FocusStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FocusStatus::Running => "running",
            FocusStatus::Paused => "paused",
            FocusStatus::Completed => "completed",
            FocusStatus::Skipped => "skipped",
            FocusStatus::Abandoned => "abandoned",
            FocusStatus::Crashed => "crashed",
        }
    }
}

fn clamp_rating(rating: Option<i32>) -> Option<i32> {
    rating.filter(|v| (1..=5).contains(v))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionStart {
    pub uuid: String,
    pub preset_id: Option<String>,
    pub method: String,
    pub phase: String,
    pub planned_duration_s: i64,
    pub start_ts: i64,
    pub project_id: Option<String>,
    pub shirei_session_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionPatch {
    pub phase: Option<String>,
    pub status: Option<FocusStatus>,
    pub paused_duration_s: Option<i64>,
    pub pause_count: Option<i64>,
    pub interruption_count: Option<i64>,
    pub interruption_kind: Option<Option<String>>,
    pub energy_rating: Option<Option<i32>>,
    pub focus_rating: Option<Option<i32>>,
    pub note: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionEnd {
    pub end_ts: i64,
    pub actual_duration_s: i64,
    pub status: FocusStatus,
    pub energy_rating: Option<i32>,
    pub focus_rating: Option<i32>,
    pub note: Option<String>,
}

pub(crate) fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// `column` is only ever one of the fixed literals below, never caller/user
// input, so interpolating it into the statement carries no injection risk.
fn set_focus_session_column<T: rusqlite::ToSql>(
    tx: &rusqlite::Transaction<'_>,
    uuid: &str,
    column: &str,
    value: T,
) -> rusqlite::Result<()> {
    tx.execute(
        &format!("UPDATE focus_session SET {column} = ?2 WHERE uuid = ?1"),
        rusqlite::params![uuid, value],
    )
    .map(|_| ())
}

impl MetricsStore {
    fn insert_focus_session(&self, session: &FocusSessionStart) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO focus_session
                   (uuid, preset_id, method, phase, planned_duration_s, start_ts,
                    paused_duration_s, status, pause_count, interruption_count,
                    project_id, shirei_session_id, agent_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 0, 0, ?8, ?9, ?10, ?6, ?6)",
                rusqlite::params![
                    session.uuid,
                    session.preset_id,
                    session.method,
                    session.phase,
                    session.planned_duration_s,
                    session.start_ts,
                    FocusStatus::Running.as_str(),
                    session.project_id,
                    session.shirei_session_id,
                    session.agent_id,
                ],
            )
            .map(|_| ())
        })
    }

    fn update_focus_session(
        &self,
        uuid: &str,
        patch: &FocusSessionPatch,
        now: i64,
    ) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(phase) = &patch.phase {
                set_focus_session_column(&tx, uuid, "phase", phase)?;
            }
            if let Some(status) = patch.status {
                set_focus_session_column(&tx, uuid, "status", status.as_str())?;
            }
            if let Some(paused) = patch.paused_duration_s {
                set_focus_session_column(&tx, uuid, "paused_duration_s", paused)?;
            }
            if let Some(count) = patch.pause_count {
                set_focus_session_column(&tx, uuid, "pause_count", count)?;
            }
            if let Some(count) = patch.interruption_count {
                set_focus_session_column(&tx, uuid, "interruption_count", count)?;
            }
            if let Some(kind) = &patch.interruption_kind {
                set_focus_session_column(&tx, uuid, "interruption_kind", kind)?;
            }
            if let Some(rating) = patch.energy_rating {
                set_focus_session_column(&tx, uuid, "energy_rating", clamp_rating(rating))?;
            }
            if let Some(rating) = patch.focus_rating {
                set_focus_session_column(&tx, uuid, "focus_rating", clamp_rating(rating))?;
            }
            if let Some(note) = &patch.note {
                set_focus_session_column(&tx, uuid, "note", note)?;
            }
            set_focus_session_column(&tx, uuid, "updated_at", now)?;
            tx.commit()
        })
    }

    fn end_focus_session(
        &self,
        uuid: &str,
        end: &FocusSessionEnd,
        now: i64,
    ) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE focus_session
                    SET end_ts = ?2, actual_duration_s = ?3, status = ?4,
                        energy_rating = ?5, focus_rating = ?6, note = ?7, updated_at = ?8
                  WHERE uuid = ?1",
                rusqlite::params![
                    uuid,
                    end.end_ts,
                    end.actual_duration_s,
                    end.status.as_str(),
                    clamp_rating(end.energy_rating),
                    clamp_rating(end.focus_rating),
                    end.note,
                    now,
                ],
            )
            .map(|_| ())
        })
    }
}

pub fn reconcile_orphans(store: &MetricsStore, now: i64, stale_after_s: i64) -> Result<usize> {
    let threshold = now - stale_after_s;
    let affected = store.with_conn(|c| {
        c.execute(
            "UPDATE focus_session
                SET status = 'crashed', updated_at = ?1
              WHERE status IN ('running', 'paused') AND updated_at < ?2",
            rusqlite::params![now, threshold],
        )
    })?;
    Ok(affected)
}

fn metrics_enabled(config: &State<'_, ConfigManager>) -> bool {
    config.current().metrics.enabled
}

#[tauri::command]
pub fn focus_session_start(
    metrics: State<'_, MetricsStore>,
    config: State<'_, ConfigManager>,
    session: FocusSessionStart,
) -> Result<()> {
    if !metrics_enabled(&config) {
        return Ok(());
    }
    metrics.insert_focus_session(&session)?;
    Ok(())
}

#[tauri::command]
pub fn focus_session_update(
    metrics: State<'_, MetricsStore>,
    config: State<'_, ConfigManager>,
    uuid: String,
    patch: FocusSessionPatch,
) -> Result<()> {
    if !metrics_enabled(&config) {
        return Ok(());
    }
    metrics.update_focus_session(&uuid, &patch, now_secs())?;
    Ok(())
}

#[tauri::command]
pub fn focus_session_end(
    metrics: State<'_, MetricsStore>,
    config: State<'_, ConfigManager>,
    uuid: String,
    end: FocusSessionEnd,
) -> Result<()> {
    if !metrics_enabled(&config) {
        return Ok(());
    }
    metrics.end_focus_session(&uuid, &end, now_secs())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::MetricsStore;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("shirei-focus-{}-{}.db", std::process::id(), name))
    }

    fn open_store(name: &str) -> (MetricsStore, std::path::PathBuf) {
        let path = tmp_path(name);
        let _ = std::fs::remove_file(&path);
        let store = MetricsStore::default();
        store.open(&path).unwrap();
        (store, path)
    }

    fn start(uuid: &str) -> FocusSessionStart {
        FocusSessionStart {
            uuid: uuid.into(),
            preset_id: Some("pomodoro-25-5".into()),
            method: "pomodoro".into(),
            phase: "focus".into(),
            planned_duration_s: 1500,
            start_ts: 1_000,
            project_id: Some("proj-1".into()),
            shirei_session_id: Some("sess-1".into()),
            agent_id: Some("claude".into()),
        }
    }

    #[test]
    fn migrate_creates_focus_session_table() {
        let (store, path) = open_store("migrate");
        store
            .with_conn(|c| {
                let count: i64 = c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='focus_session'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(count)
            })
            .map(|count| assert_eq!(count, 1))
            .unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_orphans_marks_stale_running_as_crashed() {
        let (store, path) = open_store("reconcile-stale-running");
        store.insert_focus_session(&start("stale-running")).unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE focus_session SET updated_at = 1000 WHERE uuid = 'stale-running'",
                    [],
                )
            })
            .unwrap();

        let now = 1000 + 43_200 + 1;
        let affected = reconcile_orphans(&store, now, 43_200).unwrap();
        assert_eq!(affected, 1);

        let status: String = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT status FROM focus_session WHERE uuid = 'stale-running'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(status, "crashed");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_orphans_marks_stale_paused_as_crashed() {
        let (store, path) = open_store("reconcile-stale-paused");
        store.insert_focus_session(&start("stale-paused")).unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE focus_session SET status = 'paused', updated_at = 1000 WHERE uuid = 'stale-paused'",
                    [],
                )
            })
            .unwrap();

        let now = 1000 + 43_200 + 1;
        let affected = reconcile_orphans(&store, now, 43_200).unwrap();
        assert_eq!(affected, 1);

        let status: String = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT status FROM focus_session WHERE uuid = 'stale-paused'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(status, "crashed");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_orphans_leaves_recent_running_untouched() {
        let (store, path) = open_store("reconcile-recent-running");
        store
            .insert_focus_session(&start("recent-running"))
            .unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE focus_session SET updated_at = 1000 WHERE uuid = 'recent-running'",
                    [],
                )
            })
            .unwrap();

        let now = 1000 + 43_200 - 1;
        let affected = reconcile_orphans(&store, now, 43_200).unwrap();
        assert_eq!(affected, 0);

        let status: String = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT status FROM focus_session WHERE uuid = 'recent-running'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(status, "running");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_orphans_leaves_completed_untouched() {
        let (store, path) = open_store("reconcile-completed");
        store.insert_focus_session(&start("done")).unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE focus_session SET status = 'completed', updated_at = 1000 WHERE uuid = 'done'",
                    [],
                )
            })
            .unwrap();

        let now = 1000 + 43_200 + 1;
        let affected = reconcile_orphans(&store, now, 43_200).unwrap();
        assert_eq!(affected, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_orphans_leaves_skipped_untouched() {
        let (store, path) = open_store("reconcile-skipped");
        store.insert_focus_session(&start("skipped-one")).unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE focus_session SET status = 'skipped', updated_at = 1000 WHERE uuid = 'skipped-one'",
                    [],
                )
            })
            .unwrap();

        let now = 1000 + 43_200 + 1;
        let affected = reconcile_orphans(&store, now, 43_200).unwrap();
        assert_eq!(affected, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn focus_status_deserializes_each_valid_snake_case_string() {
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"running\"").unwrap(),
            FocusStatus::Running
        );
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"paused\"").unwrap(),
            FocusStatus::Paused
        );
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"completed\"").unwrap(),
            FocusStatus::Completed
        );
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"skipped\"").unwrap(),
            FocusStatus::Skipped
        );
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"abandoned\"").unwrap(),
            FocusStatus::Abandoned
        );
        assert_eq!(
            serde_json::from_str::<FocusStatus>("\"crashed\"").unwrap(),
            FocusStatus::Crashed
        );
    }

    #[test]
    fn focus_status_rejects_invalid_string() {
        assert!(serde_json::from_str::<FocusStatus>("\"runing\"").is_err());
    }

    #[test]
    fn clamp_rating_drops_out_of_range_values() {
        assert_eq!(clamp_rating(Some(0)), None);
        assert_eq!(clamp_rating(Some(6)), None);
        assert_eq!(clamp_rating(Some(3)), Some(3));
        assert_eq!(clamp_rating(None), None);
    }

    #[test]
    fn update_focus_session_updates_every_patched_column() {
        let (store, path) = open_store("update-all-columns");
        store.insert_focus_session(&start("update-me")).unwrap();

        let patch = FocusSessionPatch {
            phase: Some("break".into()),
            status: Some(FocusStatus::Paused),
            paused_duration_s: Some(42),
            pause_count: Some(2),
            interruption_count: Some(1),
            interruption_kind: Some(Some("external".into())),
            energy_rating: Some(Some(4)),
            focus_rating: Some(Some(9)),
            note: Some(Some("checked email".into())),
        };
        store
            .update_focus_session("update-me", &patch, 5_000)
            .unwrap();

        let row = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT phase, status, paused_duration_s, pause_count, interruption_count,
                            interruption_kind, energy_rating, focus_rating, note, updated_at
                       FROM focus_session WHERE uuid = 'update-me'",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, Option<i32>>(6)?,
                            r.get::<_, Option<i32>>(7)?,
                            r.get::<_, Option<String>>(8)?,
                            r.get::<_, i64>(9)?,
                        ))
                    },
                )
            })
            .unwrap();

        assert_eq!(row.0, "break");
        assert_eq!(row.1, "paused");
        assert_eq!(row.2, 42);
        assert_eq!(row.3, 2);
        assert_eq!(row.4, 1);
        assert_eq!(row.5, Some("external".to_string()));
        assert_eq!(row.6, Some(4));
        assert_eq!(row.7, None, "an out-of-range rating must clamp to NULL");
        assert_eq!(row.8, Some("checked email".to_string()));
        assert_eq!(row.9, 5_000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_focus_session_leaves_unpatched_columns_untouched() {
        let (store, path) = open_store("update-partial");
        store.insert_focus_session(&start("partial")).unwrap();

        let patch = FocusSessionPatch {
            pause_count: Some(3),
            ..Default::default()
        };
        store
            .update_focus_session("partial", &patch, 9_000)
            .unwrap();

        let (phase, status, pause_count): (String, String, i64) = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT phase, status, pause_count FROM focus_session WHERE uuid = 'partial'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(phase, "focus");
        assert_eq!(status, "running");
        assert_eq!(pause_count, 3);
        let _ = std::fs::remove_file(&path);
    }
}
