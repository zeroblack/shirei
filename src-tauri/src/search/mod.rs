pub mod frecency;
pub mod matcher;
pub mod session;
pub mod walk;
pub mod watch;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Project,
    Home,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MatchItem {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub positions: Vec<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchEvent {
    Indexing {
        count: usize,
    },
    Results {
        generation: u64,
        items: Vec<MatchItem>,
        partial: bool,
    },
    Done {
        total: usize,
        partial: bool,
    },
}
