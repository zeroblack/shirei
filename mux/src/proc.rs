use libproc::proc_pid::{PIDInfo, PidInfoFlavor, pidinfo};
use libproc::processes::{ProcFilter, pids_by_type};
use serde::{Deserialize, Serialize};

/// What a shell session is doing right now: its cwd and the command in the
/// foreground. Shared by the in-process PTY manager and the daemon probe.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub cwd: Option<String>,
    pub command: Option<String>,
}

pub fn snapshot_of(shell_pid: u32) -> Snapshot {
    Snapshot {
        cwd: cwd_of_pid(shell_pid),
        command: foreground_command(shell_pid),
    }
}

#[repr(C)]
struct VnodePathInfo {
    pvi_cdir: VnodeInfoPath,
    pvi_rdir: VnodeInfoPath,
}

#[repr(C)]
struct VnodeInfoPath {
    vip_vi: [u8; 152],
    vip_path: [i8; 1024],
}

impl PIDInfo for VnodePathInfo {
    fn flavor() -> PidInfoFlavor {
        PidInfoFlavor::VNodePathInfo
    }
}

pub fn cwd_of_pid(pid: u32) -> Option<String> {
    let info = pidinfo::<VnodePathInfo>(pid as i32, 0).ok()?;
    let raw = &info.pvi_cdir.vip_path;
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    let path = String::from_utf8_lossy(&bytes).into_owned();
    if path.is_empty() { None } else { Some(path) }
}

fn parse_procargs(buf: &[u8]) -> Option<String> {
    if buf.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc <= 0 {
        return None;
    }
    let rest = &buf[4..];
    let mut i = 0;
    while i < rest.len() && rest[i] != 0 {
        i += 1;
    }
    while i < rest.len() && rest[i] == 0 {
        i += 1;
    }
    let mut args = Vec::new();
    for _ in 0..argc {
        let start = i;
        while i < rest.len() && rest[i] != 0 {
            i += 1;
        }
        if start >= rest.len() {
            break;
        }
        args.push(String::from_utf8_lossy(&rest[start..i]).into_owned());
        i += 1;
    }
    if args.is_empty() {
        None
    } else {
        Some(args.join(" "))
    }
}

fn argv_of(pid: u32) -> Option<String> {
    // KERN_PROCARGS2: buffer starts with argc (i32), then exec path (null-terminated),
    // then null padding, then argc argv strings (null-terminated).
    let mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut buf = vec![0u8; 16384];
    let mut len = buf.len();
    let ret = unsafe {
        libc::sysctl(
            mib.as_ptr() as *mut libc::c_int,
            3,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret != 0 {
        return None;
    }
    buf.truncate(len);
    parse_procargs(&buf)
}

pub fn foreground_command(shell_pid: u32) -> Option<String> {
    let filter = ProcFilter::ByParentProcess { ppid: shell_pid };
    pids_by_type(filter)
        .unwrap_or_default()
        .into_iter()
        .find_map(argv_of)
}

#[cfg(test)]
mod tests {
    use super::{cwd_of_pid, parse_procargs};
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::{Read, Write};
    use std::time::Duration;

    #[test]
    fn cwd_of_current_process_matches() {
        let got = cwd_of_pid(std::process::id()).expect("cwd_of_pid returned None");
        let expected = std::env::current_dir().unwrap();
        assert_eq!(
            std::fs::canonicalize(got).unwrap(),
            std::fs::canonicalize(expected).unwrap()
        );
    }

    #[test]
    fn cwd_of_spawned_shell_tracks_cd() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.arg("-l");
        cmd.cwd("/");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let pid = child.process_id().expect("child has no pid");

        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while reader.read(&mut buf).unwrap_or(0) > 0 {}
        });
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"cd /tmp\n").unwrap();
        writer.flush().unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        let got = cwd_of_pid(pid);
        let _ = child.kill();
        let _ = child.wait();
        let got = got.expect("cwd_of_pid returned None for the child shell");
        assert_eq!(
            std::fs::canonicalize(got).unwrap(),
            std::fs::canonicalize("/tmp").unwrap(),
            "cwd_of_pid did not track the shell's cd"
        );
    }

    #[test]
    fn parse_procargs_extracts_argv() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&2i32.to_ne_bytes());
        buf.extend_from_slice(b"/usr/bin/claude\0");
        buf.push(0);
        buf.extend_from_slice(b"claude\0");
        buf.extend_from_slice(b"--foo\0");
        assert_eq!(parse_procargs(&buf).as_deref(), Some("claude --foo"));
    }
}
