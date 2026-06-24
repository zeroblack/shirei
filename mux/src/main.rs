use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(shirei_mux::paths::socket_path);
    eprintln!("shirei-mux: listening on {path:?}");
    shirei_mux::server::run(&path)
}
