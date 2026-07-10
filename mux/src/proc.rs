use libproc::bsd_info::BSDInfo;
use libproc::proc_pid::{PIDInfo, PidInfoFlavor, pidinfo};
use libproc::processes::{ProcFilter, pids_by_type};
use libproc::task_info::TaskInfo;
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

/// Coarse run state of a process, the authoritative lifecycle ground truth the
/// agent-state detector fuses on top of the output heuristics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcStatus {
    Running,
    Sleeping,
    Stopped,
    Zombie,
    Gone,
}

/// XNU `proc.h` p_stat values carried in `proc_bsdinfo.pbi_status`.
const SSLEEP: u32 = 3;
const SSTOP: u32 = 4;
const SZOMB: u32 = 5;

pub fn proc_status(pid: u32) -> ProcStatus {
    match pidinfo::<BSDInfo>(pid as i32, 0) {
        Ok(info) => match info.pbi_status {
            SZOMB => ProcStatus::Zombie,
            SSTOP => ProcStatus::Stopped,
            SSLEEP => ProcStatus::Sleeping,
            _ => ProcStatus::Running,
        },
        Err(_) => ProcStatus::Gone,
    }
}

/// Total CPU time (user+system, nanoseconds) charged to the process so far.
/// Monotonic while the process lives; a flat delta between ticks is the second
/// vote (besides output silence) that a session is genuinely idle, not just
/// quiet on the pty.
pub fn cpu_ticks(pid: u32) -> Option<u64> {
    let info = pidinfo::<TaskInfo>(pid as i32, 0).ok()?;
    Some(info.pti_total_user.saturating_add(info.pti_total_system))
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
    use super::{ProcStatus, cpu_ticks, cwd_of_pid, parse_procargs, proc_status};
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

    #[test]
    fn proc_status_of_self_is_alive() {
        assert!(matches!(
            proc_status(std::process::id()),
            ProcStatus::Running | ProcStatus::Sleeping
        ));
    }

    #[test]
    fn proc_status_of_absent_pid_is_gone() {
        assert_eq!(proc_status(u32::MAX - 1), ProcStatus::Gone);
    }

    #[test]
    fn proc_status_tracks_a_sleeping_child() {
        let mut child = std::process::Command::new("sleep")
            .arg("3")
            .spawn()
            .expect("spawn sleep");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let got = proc_status(child.id());
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            matches!(got, ProcStatus::Sleeping | ProcStatus::Running),
            "a live `sleep` child read as {got:?}"
        );
    }

    #[test]
    fn cpu_ticks_are_monotonic() {
        let before = cpu_ticks(std::process::id()).expect("cpu_ticks returned None");
        let mut acc = 0u64;
        for i in 0..5_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        let after = cpu_ticks(std::process::id()).expect("cpu_ticks returned None");
        assert!(
            after >= before,
            "cpu ticks went backwards: {before} -> {after}"
        );
    }
}
