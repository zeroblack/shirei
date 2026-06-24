use std::path::PathBuf;

/// Bump on any ClientMsg/ServerMsg shape change: postcard frames are not
/// self-describing and a daemon from a previous app version can outlive an
/// update. Embedding the version in the socket name keeps incompatible peers
/// from ever exchanging frames.
pub const PROTOCOL_VERSION: u32 = 1;

/// App-support dir shared by app and daemon; mirrors the bundle `identifier`
/// in tauri.conf.json. Falls back to /tmp when HOME is unset.
pub fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/dev.dioni.shirei")
}

pub fn socket_path() -> PathBuf {
    app_support_dir().join(format!("mux-v{PROTOCOL_VERSION}.sock"))
}
