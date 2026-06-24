use std::io::{Read, Write};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

const FALLBACK_SHELL: &str = "/bin/zsh";
const TERM_VALUE: &str = "xterm-256color";

/// Read size for PTY output loops; large enough to drain bursts (e.g. Claude
/// streaming) with few wakeups while keeping per-chunk copies cheap.
pub const READ_BUFFER_LEN: usize = 32 * 1024;

pub fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub struct ShellPty {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

/// Opens a login shell ($SHELL, falling back to zsh) on a fresh PTY.
/// The slave end is dropped right after spawn: keeping it open would prevent
/// the reader from ever seeing EOF when the shell exits.
pub fn open_login_shell(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    extra_env: &[(&str, String)],
) -> anyhow::Result<ShellPty> {
    let pair = native_pty_system().openpty(pty_size(cols, rows))?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| FALLBACK_SHELL.into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", TERM_VALUE);
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    if let Some(dir) = cwd.or_else(|| std::env::var("HOME").ok()) {
        cmd.cwd(dir);
    }
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    Ok(ShellPty {
        master: pair.master,
        child,
        reader,
        writer,
    })
}
