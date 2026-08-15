use std::path::PathBuf;

/// Bump on any ClientMsg/ServerMsg shape change: postcard frames are not
/// self-describing and a daemon from a previous app version can outlive an
/// update. Embedding the version in the socket name keeps incompatible peers
/// from ever exchanging frames; the build-id handshake (protocol.rs
/// `Hello`/`Welcome`) then catches a same-version daemon left over from an
/// earlier build so the client can replace it before spawning any session.
pub const PROTOCOL_VERSION: u32 = 3;

/// App-support dir shared by app and daemon; mirrors the bundle `identifier`
/// in tauri.conf.json. Falls back to /tmp when HOME is unset.
pub fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/dev.dioni.shirei")
}

/// `debug_assertions` reflects the profile of whoever links this crate: the
/// app binary (dev build vs `tauri build`), correctly, since Cargo applies one
/// profile to a build's whole dependency graph; the standalone `shirei-mux`
/// binary always compiles `--release` (`scripts/build-sidecar.mjs`), so this is
/// always false there and it falls back to the production path — harmless,
/// since the app always passes an explicit path when it spawns the daemon.
/// Without this split, running a dev build's `tauri dev` collides with an
/// already-running installed release on the same socket: the build-id
/// mismatch tears down the release daemon and kills every session attached to
/// it, dev instance or not.
pub fn socket_path() -> PathBuf {
    let suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
    app_support_dir().join(format!("mux-v{PROTOCOL_VERSION}{suffix}.sock"))
}
