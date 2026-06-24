use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use shirei_mux::lock::MutexExt;
use std::path::Path;
use std::sync::Mutex;

use crate::error::{Error, Result};
use tauri::State;

const SCHEMA_VERSION: i64 = 1;

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                position REAL NOT NULL,
                priority INTEGER,
                due_date TEXT,
                note TEXT,
                created_at INTEGER NOT NULL,
                completed_at INTEGER
            );
            CREATE INDEX idx_todos_project ON todos(project_id);",
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

#[derive(Default)]
pub struct TodoStore {
    conn: Mutex<Option<Connection>>,
}

impl TodoStore {
    pub fn open(&self, path: &Path) -> rusqlite::Result<()> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        *self.conn.lock_ignore_poison() = Some(conn);
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub project_id: String,
    pub text: String,
    pub done: bool,
    pub position: f64,
    pub priority: Option<i64>,
    pub due_date: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    pub text: Option<String>,
    pub priority: Option<Option<i64>>,
    pub due_date: Option<Option<String>>,
    pub note: Option<Option<String>>,
}

const COLS: &str =
    "id, project_id, text, done, position, priority, due_date, note, created_at, completed_at";

fn row_to_todo(r: &rusqlite::Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get(0)?,
        project_id: r.get(1)?,
        text: r.get(2)?,
        done: r.get::<_, i64>(3)? != 0,
        position: r.get(4)?,
        priority: r.get(5)?,
        due_date: r.get(6)?,
        note: r.get(7)?,
        created_at: r.get(8)?,
        completed_at: r.get(9)?,
    })
}

impl TodoStore {
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let guard = self.conn.lock_ignore_poison();
        let conn = guard.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
        f(conn)
    }

    pub fn list(&self, project_id: &str) -> rusqlite::Result<Vec<Todo>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {COLS} FROM todos WHERE project_id = ?1 ORDER BY done ASC, position ASC"
            ))?;
            let rows = stmt.query_map([project_id], row_to_todo)?;
            rows.collect()
        })
    }

    pub fn add(&self, project_id: &str, text: &str, now_ms: i64) -> rusqlite::Result<Todo> {
        self.with_conn(|c| {
            let next: f64 = c.query_row(
                "SELECT COALESCE(MAX(position), 0.0) + 1.0 FROM todos WHERE project_id = ?1 AND done = 0",
                [project_id],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO todos (project_id, text, done, position, created_at) VALUES (?1, ?2, 0, ?3, ?4)",
                rusqlite::params![project_id, text, next, now_ms],
            )?;
            let id = c.last_insert_rowid();
            c.query_row(&format!("SELECT {COLS} FROM todos WHERE id = ?1"), [id], row_to_todo)
        })
    }

    pub fn toggle(&self, id: i64, now_ms: i64) -> rusqlite::Result<Todo> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE todos SET done = 1 - done,
                    completed_at = CASE WHEN done = 0 THEN ?2 ELSE NULL END
                 WHERE id = ?1",
                rusqlite::params![id, now_ms],
            )?;
            c.query_row(
                &format!("SELECT {COLS} FROM todos WHERE id = ?1"),
                [id],
                row_to_todo,
            )
        })
    }

    pub fn delete(&self, id: i64) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM todos WHERE id = ?1", [id])
                .map(|_| ())
        })
    }

    pub fn reorder(&self, id: i64, new_position: f64) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE todos SET position = ?2 WHERE id = ?1",
                rusqlite::params![id, new_position],
            )
            .map(|_| ())
        })
    }

    pub fn update(&self, id: i64, patch: TodoPatch) -> rusqlite::Result<Todo> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(text) = patch.text {
                tx.execute(
                    "UPDATE todos SET text = ?2 WHERE id = ?1",
                    rusqlite::params![id, text],
                )?;
            }
            if let Some(priority) = patch.priority {
                tx.execute(
                    "UPDATE todos SET priority = ?2 WHERE id = ?1",
                    rusqlite::params![id, priority],
                )?;
            }
            if let Some(due) = patch.due_date {
                tx.execute(
                    "UPDATE todos SET due_date = ?2 WHERE id = ?1",
                    rusqlite::params![id, due],
                )?;
            }
            if let Some(note) = patch.note {
                tx.execute(
                    "UPDATE todos SET note = ?2 WHERE id = ?1",
                    rusqlite::params![id, note],
                )?;
            }
            let todo = tx.query_row(
                &format!("SELECT {COLS} FROM todos WHERE id = ?1"),
                [id],
                row_to_todo,
            )?;
            tx.commit()?;
            Ok(todo)
        })
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e.to_string())
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn todo_list(store: State<'_, TodoStore>, project_id: String) -> Result<Vec<Todo>> {
    Ok(store.list(&project_id)?)
}

#[tauri::command]
pub fn todo_add(store: State<'_, TodoStore>, project_id: String, text: String) -> Result<Todo> {
    Ok(store.add(&project_id, &text, now_ms())?)
}

#[tauri::command]
pub fn todo_toggle(store: State<'_, TodoStore>, id: i64) -> Result<Todo> {
    Ok(store.toggle(id, now_ms())?)
}

#[tauri::command]
pub fn todo_delete(store: State<'_, TodoStore>, id: i64) -> Result<()> {
    Ok(store.delete(id)?)
}

#[tauri::command]
pub fn todo_reorder(store: State<'_, TodoStore>, id: i64, position: f64) -> Result<()> {
    Ok(store.reorder(id, position)?)
}

#[tauri::command]
pub fn todo_update(store: State<'_, TodoStore>, id: i64, patch: TodoPatch) -> Result<Todo> {
    Ok(store.update(id, patch)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    fn store_mem() -> TodoStore {
        let s = TodoStore::default();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        *s.conn.lock_ignore_poison() = Some(conn);
        s
    }

    #[test]
    fn add_and_list_scoped_by_project() {
        let s = store_mem();
        s.add("proj-a", "task 1", 1000).unwrap();
        s.add("proj-a", "task 2", 1001).unwrap();
        s.add("proj-b", "otra", 1002).unwrap();
        let a = s.list("proj-a").unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].text, "task 1");
        assert!(a[1].position > a[0].position);
        assert_eq!(s.list("proj-b").unwrap().len(), 1);
    }

    #[test]
    fn toggle_moves_done_to_bottom_and_stamps_completed() {
        let s = store_mem();
        let t1 = s.add("p", "uno", 1).unwrap();
        s.add("p", "dos", 2).unwrap();
        let toggled = s.toggle(t1.id, 5000).unwrap();
        assert!(toggled.done);
        assert_eq!(toggled.completed_at, Some(5000));
        let list = s.list("p").unwrap();
        assert_eq!(list[0].text, "dos");
        assert_eq!(list[1].text, "uno");
    }

    #[test]
    fn delete_removes_only_target() {
        let s = store_mem();
        let t = s.add("p", "x", 1).unwrap();
        s.add("p", "y", 2).unwrap();
        s.delete(t.id).unwrap();
        let list = s.list("p").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text, "y");
    }

    #[test]
    fn reorder_and_update_persist() {
        let s = store_mem();
        let a = s.add("p", "a", 1).unwrap();
        let b = s.add("p", "b", 2).unwrap();
        s.reorder(b.id, 0.5).unwrap();
        let list = s.list("p").unwrap();
        assert_eq!(list[0].text, "b");
        let patch = TodoPatch {
            text: Some("a-edit".into()),
            priority: Some(Some(2)),
            due_date: Some(Some("2026-07-01".into())),
            note: None,
        };
        let updated = s.update(a.id, patch).unwrap();
        assert_eq!(updated.text, "a-edit");
        assert_eq!(updated.priority, Some(2));
        assert_eq!(updated.due_date.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn migration_creates_table_and_sets_version() {
        let c = mem();
        let v: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        let count: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='todos'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_is_idempotent() {
        let c = mem();
        migrate(&c).unwrap();
        migrate(&c).unwrap();
        let v: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }
}
