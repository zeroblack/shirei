use nucleo::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo::{Config, Utf32Str};
use rayon::prelude::*;

use crate::config::SearchConfig;
use crate::fs::IndexEntry;
use crate::search::MatchItem;
use crate::search::frecency::Frecency;

const TIER_IDENTITY: u64 = 1 << 19;
const TIER_FILENAME_PREFIX: u64 = 1 << 18;
const TIER_PRIMARY: u64 = 1 << 17;
const TIER_DIRECTORY: u64 = 1 << 16;

// Zed-style smart case: never a hard reject, just a downrank per query
// character whose case the haystack didn't match verbatim. Nucleo's raw
// scores stay well under 1 << 16, so this can never cross a tier boundary.
const SMART_CASE_MISMATCH_PENALTY: u32 = 8;

// Phase 1 scores every entry cheaply (score only, no match indices) and
// keeps this many times `limit` candidates. Phase 2 then computes indices
// and the smart-case penalty only for that shortlist before the final
// sort/truncate, keeping the expensive part bounded regardless of index size.
const OVER_FETCH_FACTOR: usize = 3;

// Below this, a single thread clears the frame budget with room to spare and
// handing the batch to rayon's pool would only add scheduling overhead; above
// it (unoptimized debug builds on a 200k-entry index in particular) phase 1
// needs the split.
const PARALLEL_SCORE_THRESHOLD: usize = 4096;

// Nucleo's raw scores stay well under 1 << 16 (see the tier constants above).
// Clamping a frecency-boosted score to that ceiling means the bounded
// multiplier can nudge ranking within a tier but can never lift a candidate
// into the next one up.
const MAX_TIER_LOCAL_SCORE: u64 = (1 << 16) - 1;

pub struct Matcher {
    matcher: nucleo::Matcher,
}

#[derive(Clone, Copy)]
enum Column {
    Name,
    Rel,
}

struct Candidate {
    entry: usize,
    tier: u64,
    raw_score: u32,
    column: Column,
}

impl Candidate {
    fn score(&self) -> u64 {
        self.tier + self.raw_score as u64
    }
}

struct Ranked {
    entry: usize,
    column: Column,
    score: u64,
    positions: Vec<u32>,
}

impl Matcher {
    pub fn new(_config: &SearchConfig) -> Matcher {
        Matcher {
            matcher: nucleo::Matcher::new(Config::DEFAULT.match_paths()),
        }
    }

    pub fn query(
        &mut self,
        index: &[IndexEntry],
        query: &str,
        limit: usize,
        frecency: Option<&Frecency>,
    ) -> Vec<MatchItem> {
        if query.is_empty() || limit == 0 {
            return Vec::new();
        }

        let has_slash = query.contains('/');
        let pattern = Pattern::new(
            query,
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        let query_has_uppercase = query.chars().any(char::is_uppercase);

        let candidates = self.shortlist(index, &pattern, query, has_slash, limit, frecency);
        let ranked = self.refine(
            index,
            &pattern,
            query,
            query_has_uppercase,
            candidates,
            frecency,
        );

        ranked
            .into_iter()
            .take(limit)
            .map(|r| {
                let entry = &index[r.entry];
                MatchItem {
                    rel: entry.rel.clone(),
                    name: entry.name.clone(),
                    is_dir: entry.is_dir,
                    positions: translate_positions(entry, r.column, r.positions),
                }
            })
            .collect()
    }

    fn shortlist(
        &mut self,
        index: &[IndexEntry],
        pattern: &Pattern,
        query: &str,
        has_slash: bool,
        limit: usize,
        frecency: Option<&Frecency>,
    ) -> Vec<Candidate> {
        let mut candidates = if index.len() < PARALLEL_SCORE_THRESHOLD {
            score_chunk(&mut self.matcher, index, 0, pattern, query, has_slash)
        } else {
            score_parallel(index, pattern, query, has_slash)
        };

        if let Some(frecency) = frecency {
            for candidate in &mut candidates {
                let path = index[candidate.entry].rel.as_str();
                candidate.raw_score = apply_frecency(candidate.raw_score, path, frecency);
            }
        }

        candidates.sort_unstable_by_key(|b| std::cmp::Reverse(b.score()));
        candidates.truncate(limit.saturating_mul(OVER_FETCH_FACTOR));
        candidates
    }

    fn refine(
        &mut self,
        index: &[IndexEntry],
        pattern: &Pattern,
        query: &str,
        query_has_uppercase: bool,
        candidates: Vec<Candidate>,
        frecency: Option<&Frecency>,
    ) -> Vec<Ranked> {
        let mut positions_buf = Vec::new();
        let mut ranked = Vec::with_capacity(candidates.len());

        for candidate in &candidates {
            let entry = &index[candidate.entry];
            let haystack = match candidate.column {
                Column::Name => entry.name.as_str(),
                Column::Rel => entry.rel.as_str(),
            };

            positions_buf.clear();
            let Some(raw_score) =
                indices_column(pattern, haystack, &mut self.matcher, &mut positions_buf)
            else {
                continue;
            };

            let raw_score = match frecency {
                Some(frecency) => apply_frecency(raw_score, entry.rel.as_str(), frecency),
                None => raw_score,
            };

            let penalty = if query_has_uppercase {
                smart_case_penalty(query, haystack, &positions_buf)
            } else {
                0
            };

            ranked.push(Ranked {
                entry: candidate.entry,
                column: candidate.column,
                score: candidate.tier + raw_score.saturating_sub(penalty) as u64,
                positions: positions_buf.clone(),
            });
        }

        ranked.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| {
                    index[a.entry]
                        .name
                        .chars()
                        .count()
                        .cmp(&index[b.entry].name.chars().count())
                })
                .then_with(|| index[a.entry].rel.cmp(&index[b.entry].rel))
        });
        ranked
    }
}

fn apply_frecency(raw_score: u32, path: &str, frecency: &Frecency) -> u32 {
    let multiplier = frecency.multiplier_for(path);
    if multiplier == 1.0 {
        return raw_score;
    }
    let boosted = (raw_score as f64 * multiplier as f64).round();
    boosted.clamp(0.0, MAX_TIER_LOCAL_SCORE as f64) as u32
}

fn score_parallel(
    index: &[IndexEntry],
    pattern: &Pattern,
    query: &str,
    has_slash: bool,
) -> Vec<Candidate> {
    // rayon's global pool is already warm (nucleo itself depends on it), so
    // handing chunks to `par_chunks` avoids paying OS thread spawn cost on
    // every keystroke the way a fresh `std::thread::scope` per call would.
    let chunk_size = index.len().div_ceil(rayon::current_num_threads().max(1));

    index
        .par_chunks(chunk_size.max(1))
        .enumerate()
        .flat_map_iter(|(chunk_index, chunk)| {
            let base = chunk_index * chunk_size;
            let mut matcher = nucleo::Matcher::new(Config::DEFAULT.match_paths());
            score_chunk(&mut matcher, chunk, base, pattern, query, has_slash)
        })
        .collect()
}

fn score_chunk(
    matcher: &mut nucleo::Matcher,
    chunk: &[IndexEntry],
    base: usize,
    pattern: &Pattern,
    query: &str,
    has_slash: bool,
) -> Vec<Candidate> {
    let mut buf = Vec::new();
    let mut candidates = Vec::new();

    for (local_i, entry) in chunk.iter().enumerate() {
        let i = base + local_i;

        if entry.rel == query {
            if let Some(raw_score) = score_column(pattern, &entry.rel, matcher, &mut buf) {
                candidates.push(Candidate {
                    entry: i,
                    tier: TIER_IDENTITY,
                    raw_score,
                    column: Column::Rel,
                });
            }
            continue;
        }

        if has_slash {
            if let Some(raw_score) = score_column(pattern, &entry.rel, matcher, &mut buf) {
                candidates.push(Candidate {
                    entry: i,
                    tier: TIER_PRIMARY,
                    raw_score,
                    column: Column::Rel,
                });
            }
            continue;
        }

        if let Some(raw_score) = score_column(pattern, &entry.name, matcher, &mut buf) {
            let tier = if case_insensitive_prefix(&entry.name, query) {
                TIER_FILENAME_PREFIX
            } else {
                TIER_PRIMARY
            };
            candidates.push(Candidate {
                entry: i,
                tier,
                raw_score,
                column: Column::Name,
            });
        } else if let Some(raw_score) = score_column(pattern, &entry.rel, matcher, &mut buf) {
            candidates.push(Candidate {
                entry: i,
                tier: TIER_DIRECTORY,
                raw_score,
                column: Column::Rel,
            });
        }
    }

    candidates
}

fn score_column(
    pattern: &Pattern,
    haystack: &str,
    matcher: &mut nucleo::Matcher,
    buf: &mut Vec<char>,
) -> Option<u32> {
    let haystack = Utf32Str::new(haystack, buf);
    pattern.score(haystack, matcher)
}

fn indices_column(
    pattern: &Pattern,
    haystack: &str,
    matcher: &mut nucleo::Matcher,
    positions: &mut Vec<u32>,
) -> Option<u32> {
    let mut buf = Vec::new();
    let haystack = Utf32Str::new(haystack, &mut buf);
    pattern.indices(haystack, matcher, positions)
}

fn case_insensitive_prefix(haystack: &str, needle: &str) -> bool {
    let mut haystack_chars = haystack.chars();
    for n in needle.chars() {
        match haystack_chars.next() {
            Some(h) if h.eq_ignore_ascii_case(&n) => {}
            _ => return false,
        }
    }
    true
}

fn smart_case_penalty(query: &str, haystack: &str, positions: &[u32]) -> u32 {
    let haystack_chars: Vec<char> = haystack.chars().collect();
    query
        .chars()
        .filter(|c| !c.is_whitespace())
        .zip(positions.iter())
        .filter(|(qc, pos)| {
            qc.is_uppercase()
                && haystack_chars
                    .get(**pos as usize)
                    .is_some_and(|hc| *hc != *qc)
        })
        .count() as u32
        * SMART_CASE_MISMATCH_PENALTY
}

fn translate_positions(entry: &IndexEntry, column: Column, mut positions: Vec<u32>) -> Vec<u32> {
    if let Column::Name = column {
        let offset = entry
            .rel
            .chars()
            .count()
            .saturating_sub(entry.name.chars().count()) as u32;
        for p in positions.iter_mut() {
            *p += offset;
        }
    }
    positions
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn entry_from_rel(rel: &str) -> IndexEntry {
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        IndexEntry {
            rel: rel.to_string(),
            name,
            is_dir: false,
        }
    }

    fn rank(query: &str, paths: &[&str]) -> Vec<String> {
        let entries: Vec<IndexEntry> = paths.iter().map(|p| entry_from_rel(p)).collect();
        let mut m = Matcher::new(&SearchConfig::default());
        m.query(&entries, query, 50, None)
            .into_iter()
            .map(|item| item.rel)
            .collect()
    }

    #[test]
    fn exact_path_identity_wins() {
        let r = rank("src/app.ts", &["src/app.ts", "src/apple.ts", "app.ts"]);
        assert_eq!(r.first().map(String::as_str), Some("src/app.ts"));
    }

    #[test]
    fn filename_beats_directory_on_bare_query() {
        let r = rank(
            "window",
            &["window.ts", "windowActions.ts", "ui/window/index.ts"],
        );
        assert_eq!(r.first().map(String::as_str), Some("window.ts"));
    }

    #[test]
    fn path_query_engages_directory_matching() {
        let r = rank(
            "ui/win",
            &["ui/window/index.ts", "window.ts", "utils/winter.ts"],
        );
        assert_eq!(r.first().map(String::as_str), Some("ui/window/index.ts"));
    }

    #[test]
    fn camel_case_boundary_beats_scatter() {
        let r = rank("wa", &["windowActions.ts", "wxyzabc.ts"]);
        assert_eq!(r.first().map(String::as_str), Some("windowActions.ts"));
    }

    #[test]
    fn smart_case_downranks_but_never_rejects() {
        let r = rank("Window", &["window.ts", "Window.ts"]);
        assert_eq!(r.len(), 2);
        assert_eq!(r.first().map(String::as_str), Some("Window.ts"));
    }

    #[test]
    fn consecutive_run_beats_scatter() {
        let r = rank("win", &["window.ts", "w_i_n_dow.ts"]);
        assert_eq!(r.first().map(String::as_str), Some("window.ts"));
    }

    #[test]
    fn frecency_promotes_a_near_tie_past_the_shortlist_cut_without_flipping_a_clear_win() {
        let limit = 5;
        let clear_winner = "af".to_string();
        let target = "xa_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzf.ts".to_string();

        let mut paths: Vec<String> = (0..40).map(|i| format!("xaf{i:03}.ts")).collect();
        paths.push(clear_winner.clone());
        paths.push(target.clone());
        let entries: Vec<IndexEntry> = paths.iter().map(|p| entry_from_rel(p)).collect();

        let mut m = Matcher::new(&SearchConfig::default());
        let without_frecency = m.query(&entries, "af", limit, None);
        assert!(
            !without_frecency.iter().any(|item| item.rel == target),
            "a weak match well outside the top results should not survive the shortlist cut"
        );

        let mut opens = HashMap::new();
        opens.insert(target.clone(), (50u32, 1_000i64));
        let frecency = Frecency::new(opens, 1_000, 4.0);
        let with_frecency = m.query(&entries, "af", limit, Some(&frecency));
        assert!(
            with_frecency.iter().any(|item| item.rel == target),
            "a recently opened near-tie should be promoted past the shortlist cut"
        );
        assert_eq!(
            with_frecency.first().map(|item| item.rel.as_str()),
            Some(clear_winner.as_str()),
            "an exact identity match must still rank first despite the frecency boost elsewhere"
        );
    }

    // Perf gate; run explicitly: cargo test --release matcher_query_p95 -- --ignored --nocapture
    // Needs --release: unoptimized debug scoring is roughly 30x slower and isn't
    // representative of the shipped `cargo tauri build` binary this budget targets.
    #[test]
    #[ignore]
    fn matcher_query_p95_under_16ms() {
        let entries: Vec<IndexEntry> = (0..200_000)
            .map(|i| entry_from_rel(&format!("src/mod{i}/file{i}.ts")))
            .collect();
        let mut m = Matcher::new(&SearchConfig::default());
        let mut samples = Vec::with_capacity(200);
        for q in 0..200 {
            let t = std::time::Instant::now();
            let _ = m.query(&entries, &format!("file{q}"), 50, None);
            samples.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = samples[(0.95 * samples.len() as f64) as usize];
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        let max = *samples.last().unwrap();
        println!("query ms — mean {mean:.2} p95 {p95:.2} max {max:.2}");
        assert!(p95 <= 16.0, "p95 {p95:.2}ms over frame budget");
    }
}
