use std::collections::HashMap;

use crate::error::Result;
use crate::metrics::MetricsStore;

const HOUR_SECS: i64 = 3_600;
const DAY_SECS: i64 = 86_400;
const WEEK_SECS: i64 = 604_800;

const RECENCY_HOUR: f32 = 4.0;
const RECENCY_DAY: f32 = 2.0;
const RECENCY_WEEK: f32 = 0.5;
const RECENCY_STALE: f32 = 0.25;

// zoxide-style aging: once the summed open count across all rows crosses this
// cap, halve every row and drop whatever rounds down to zero. Keeps the table
// (and the in-memory lookup built from it) bounded regardless of how long the
// user has been running Shirei, while preserving relative frecency.
const AGING_TOTAL_CAP: i64 = 10_000;

pub struct Frecency {
    opens: HashMap<String, (u32, i64)>,
    now: i64,
    max: f32,
}

impl Frecency {
    pub fn new(opens: HashMap<String, (u32, i64)>, now: i64, max: f32) -> Frecency {
        Frecency { opens, now, max }
    }

    pub fn multiplier_for(&self, path: &str) -> f32 {
        match self.opens.get(path) {
            Some(&(count, last_opened)) => multiplier(count, last_opened, self.now, self.max),
            None => 1.0,
        }
    }
}

pub fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn multiplier(count: u32, last_opened: i64, now: i64, max: f32) -> f32 {
    let max = max.max(1.0);
    let age = (now - last_opened).max(0);
    let recency_factor = if age <= HOUR_SECS {
        RECENCY_HOUR
    } else if age <= DAY_SECS {
        RECENCY_DAY
    } else if age <= WEEK_SECS {
        RECENCY_WEEK
    } else {
        RECENCY_STALE
    };

    let count_factor = 1.0 + (count.saturating_sub(1) as f32).sqrt();
    let raw = recency_factor * count_factor;
    raw.clamp(1.0 / max, max)
}

pub fn record_open(store: &MetricsStore, path: &str, now: i64) -> Result<()> {
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO file_opens (path, count, last_opened) VALUES (?1, 1, ?2)
             ON CONFLICT(path) DO UPDATE SET
                count = count + 1,
                last_opened = excluded.last_opened",
            rusqlite::params![path, now],
        )?;

        let total: i64 =
            conn.query_row("SELECT COALESCE(SUM(count), 0) FROM file_opens", [], |r| {
                r.get(0)
            })?;
        if total > AGING_TOTAL_CAP {
            conn.execute("UPDATE file_opens SET count = count / 2", [])?;
            conn.execute("DELETE FROM file_opens WHERE count <= 0", [])?;
        }
        Ok(())
    })?;
    Ok(())
}

pub fn lookup(store: &MetricsStore, paths: &[&str]) -> HashMap<String, (u32, i64)> {
    store
        .with_conn(|conn| {
            let mut table: HashMap<String, (u32, i64)> = HashMap::new();
            let mut stmt = conn.prepare("SELECT path, count, last_opened FROM file_opens")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (path, count, last_opened) = row?;
                table.insert(path, (count, last_opened));
            }

            let mut result = HashMap::with_capacity(paths.len().min(table.len()));
            for &path in paths {
                if let Some(&entry) = table.get(path) {
                    result.insert(path.to_string(), entry);
                }
            }
            Ok(result)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "shirei-frecency-{}-{}.db",
            std::process::id(),
            name
        ))
    }

    fn open_store(name: &str) -> (MetricsStore, std::path::PathBuf) {
        let path = tmp_path(name);
        let _ = std::fs::remove_file(&path);
        let store = MetricsStore::default();
        store.open(&path).unwrap();
        (store, path)
    }

    #[test]
    fn multiplier_is_clamped() {
        let max = 4.0_f32;
        for &(count, age_secs) in &[(1, 10), (100, 10), (1, 10_000_000)] {
            let m = multiplier(count, 0, age_secs, max);
            assert!(
                m >= 1.0 / max - 1e-6 && m <= max + 1e-6,
                "m={m} out of band"
            );
        }
    }

    #[test]
    fn frecency_never_flips_a_clear_fuzzy_win() {
        // gap > band => order preserved regardless of frecency. The band for a
        // bounded multiplier is max^2 (worst case for the loser vs best case
        // for the winner), so the fuzzy gap here (100x) is chosen well above
        // that ceiling (4.0^2 = 16x) to prove the property.
        let max = 4.0_f32;
        let now = 1_000_000_i64;

        let m_hot = multiplier(50, now, now, max);
        let m_cold = multiplier(1, 0, now, max);
        assert!(
            m_hot <= max + 1e-6,
            "m_hot {m_hot} should be clamped to max"
        );
        assert!(
            m_cold >= 1.0 / max - 1e-6,
            "m_cold {m_cold} should be clamped to 1/max"
        );

        let cold_fuzzy = 1000.0_f32;
        let hot_fuzzy = 10.0_f32;
        let cold_score = cold_fuzzy * m_cold;
        let hot_score = hot_fuzzy * m_hot;
        assert!(
            cold_score > hot_score,
            "cold_score {cold_score} should stay above hot_score {hot_score}"
        );
    }

    #[test]
    fn record_open_bumps_count_and_last_opened() {
        let (store, path) = open_store("bump");
        record_open(&store, "src/app.ts", 1_000).unwrap();
        record_open(&store, "src/app.ts", 2_000).unwrap();

        let looked_up = lookup(&store, &["src/app.ts"]);
        let &(count, last_opened) = looked_up.get("src/app.ts").unwrap();
        assert_eq!(count, 2);
        assert_eq!(last_opened, 2_000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_open_ages_hot_entries_and_prunes_cold_ones_past_the_cap() {
        let (store, path) = open_store("aging");
        store
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO file_opens (path, count, last_opened) VALUES ('hot.ts', 10000, 0)",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO file_opens (path, count, last_opened) VALUES ('cold.ts', 1, 0)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        record_open(&store, "hot.ts", 1_000).unwrap();

        let conn = rusqlite::Connection::open(&path).unwrap();
        let total: i64 = conn
            .query_row("SELECT COALESCE(SUM(count), 0) FROM file_opens", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            total <= AGING_TOTAL_CAP,
            "total {total} should have been aged back under the cap"
        );

        let hot_count: i64 = conn
            .query_row(
                "SELECT count FROM file_opens WHERE path = 'hot.ts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            hot_count > 0,
            "a hot entry should survive aging with a halved count"
        );

        let cold_survived: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM file_opens WHERE path = 'cold.ts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            cold_survived, 0,
            "a count-1 entry should be pruned once it halves to zero"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn lookup_only_returns_requested_paths() {
        let (store, path) = open_store("lookup-filter");
        record_open(&store, "src/app.ts", 1_000).unwrap();
        record_open(&store, "src/other.ts", 1_000).unwrap();

        let looked_up = lookup(&store, &["src/app.ts"]);
        assert_eq!(looked_up.len(), 1);
        assert!(looked_up.contains_key("src/app.ts"));
        let _ = std::fs::remove_file(&path);
    }
}
