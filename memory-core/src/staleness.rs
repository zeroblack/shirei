use crate::gitinfo;
use crate::store::Store;
use std::path::Path;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    pub stale_after_days: u64,
    pub stale_after_commits: usize,
    pub resume_stale_hours: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Status {
    pub exists: bool,
    pub overview_updated: Option<String>,
    pub stale: bool,
    pub stale_reason: Option<String>,
    pub sessions_count: usize,
    pub resume_age_hours: Option<u64>,
}

pub fn status(store: &Store, root: &Path, th: &Thresholds, now: OffsetDateTime) -> Status {
    let mut st = Status {
        exists: store.exists(),
        overview_updated: None,
        stale: false,
        stale_reason: None,
        sessions_count: 0,
        resume_age_hours: None,
    };
    if !st.exists {
        return st;
    }
    st.sessions_count = store.sessions(usize::MAX).map(|v| v.len()).unwrap_or(0);
    if let Some(fm) = store.resume().ok().and_then(|d| d.front) {
        st.resume_age_hours = Some((now - fm.updated).whole_hours().max(0) as u64);
    }
    let Some(fm) = store.overview().ok().and_then(|d| d.front) else {
        return st;
    };
    st.overview_updated = fm.updated.format(&Rfc3339).ok();
    let reference = gitinfo::head_commit_time(root).unwrap_or(now);
    let age_days = (reference - fm.updated).whole_days().max(0) as u64;
    if age_days > th.stale_after_days {
        st.stale = true;
        st.stale_reason = Some(format!(
            "overview is {age_days} days older than the latest commit"
        ));
        return st;
    }
    if let Some(n) = gitinfo::commits_since(root, fm.updated) {
        if n > th.stale_after_commits {
            st.stale = true;
            st.stale_reason = Some(format!("{n} commits landed since the overview was updated"));
        }
    }
    st
}

pub fn overview_status_line(s: &Status) -> String {
    match (&s.stale_reason, &s.overview_updated) {
        (Some(reason), _) => {
            format!("Note: overview is stale ({reason}); refresh it with memory_update_overview.")
        }
        (None, Some(when)) => format!("Overview updated {when}."),
        _ => "Overview has no timestamp.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::{self, FrontMatter};
    use std::fs;
    use tempfile::TempDir;
    use time::Duration;

    const TH: Thresholds = Thresholds {
        stale_after_days: 14,
        stale_after_commits: 20,
        resume_stale_hours: 72,
    };

    fn store_with_overview_age(days: i64) -> (TempDir, Store) {
        let tmp = TempDir::new().unwrap();
        let s = Store::new(tmp.path(), crate::DEFAULT_DIR_NAME);
        s.init("x").unwrap();
        let mut fm = FrontMatter::now("x");
        fm.updated = OffsetDateTime::now_utc() - Duration::days(days);
        fs::write(
            s.dir().join("overview.md"),
            frontmatter::render(&fm, "body"),
        )
        .unwrap();
        (tmp, s)
    }

    fn commit_n(repo: &git2::Repository, n: i64) {
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let mut parent: Option<git2::Oid> = None;
        for i in 0..n {
            let parents: Vec<git2::Commit> = parent
                .into_iter()
                .map(|p| repo.find_commit(p).unwrap())
                .collect();
            let refs: Vec<&git2::Commit> = parents.iter().collect();
            let when = git2::Time::new(OffsetDateTime::now_utc().unix_timestamp() + i, 0);
            let sig = git2::Signature::new("t", "t@t", &when).unwrap();
            parent = Some(
                repo.commit(Some("HEAD"), &sig, &sig, &format!("c{i}"), &tree, &refs)
                    .unwrap(),
            );
        }
    }

    #[test]
    fn missing_memory_is_neither_existing_nor_stale() {
        let tmp = TempDir::new().unwrap();
        let s = Store::new(tmp.path(), crate::DEFAULT_DIR_NAME);
        let st = status(&s, tmp.path(), &TH, OffsetDateTime::now_utc());
        assert!(!st.exists && !st.stale);
    }

    #[test]
    fn day_rule_applies_outside_git() {
        let (tmp, s) = store_with_overview_age(30);
        let st = status(&s, tmp.path(), &TH, OffsetDateTime::now_utc());
        assert!(st.stale);
        assert!(st.stale_reason.unwrap().contains("30 days"));
        let (tmp2, s2) = store_with_overview_age(2);
        assert!(!status(&s2, tmp2.path(), &TH, OffsetDateTime::now_utc()).stale);
    }

    #[test]
    fn commit_rule_applies_inside_git() {
        let (tmp, s) = store_with_overview_age(1);
        let repo = git2::Repository::init(tmp.path()).unwrap();
        commit_n(&repo, 25);
        let st = status(
            &s,
            tmp.path(),
            &TH,
            OffsetDateTime::now_utc() + Duration::minutes(1),
        );
        assert!(st.stale, "{st:?}");
        assert!(st.stale_reason.unwrap().contains("commits"));
    }

    #[test]
    fn few_commits_inside_git_is_fresh() {
        let (tmp, s) = store_with_overview_age(1);
        let repo = git2::Repository::init(tmp.path()).unwrap();
        commit_n(&repo, 3);
        assert!(
            !status(
                &s,
                tmp.path(),
                &TH,
                OffsetDateTime::now_utc() + Duration::minutes(1)
            )
            .stale
        );
    }

    #[test]
    fn resume_age_and_status_line() {
        let (tmp, s) = store_with_overview_age(0);
        s.set_resume("wip", "x").unwrap();
        let st = status(&s, tmp.path(), &TH, OffsetDateTime::now_utc());
        assert_eq!(st.resume_age_hours, Some(0));
        assert!(overview_status_line(&st).starts_with("Overview updated"));
        let (tmp2, s2) = store_with_overview_age(40);
        let stale = status(&s2, tmp2.path(), &TH, OffsetDateTime::now_utc());
        assert!(overview_status_line(&stale).contains("stale"));
    }
}
