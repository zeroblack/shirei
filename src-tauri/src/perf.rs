use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use libproc::libproc::bsd_info::BSDInfo;
use libproc::libproc::pid_rusage::{RUsageInfoV2, pidrusage};
use libproc::libproc::proc_pid::name as proc_name;
use libproc::libproc::proc_pid::pidinfo;
use libproc::libproc::proc_pid::pidpath;
use libproc::libproc::task_info::TaskInfo;
use libproc::processes::{ProcFilter, pids_by_type};
use serde::Serialize;
use shirei_mux::lock::MutexExt;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::ConfigManager;

#[derive(PartialEq, Debug, Clone, Copy)]
pub enum Level {
    Ok,
    Warn,
    Crit,
}

pub fn level(pct: f64, (warn, crit): (u8, u8)) -> Level {
    if pct >= crit as f64 {
        Level::Crit
    } else if pct >= warn as f64 {
        Level::Warn
    } else {
        Level::Ok
    }
}

pub fn fmt_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    format!("{v:.1} {}", UNITS[u])
}

pub fn cpu_percent(delta_cpu_ns: u64, delta_wall_ns: u64) -> f64 {
    if delta_wall_ns == 0 {
        return 0.0;
    }
    (delta_cpu_ns as f64 / delta_wall_ns as f64) * 100.0
}

/// Splits the shared WebContent footprint across tabs proportionally to their
/// live scrollback weight. Without a total weight there is nothing to prorate.
pub fn prorate(shared_footprint: u64, tab_weight: f64, total_weight: f64) -> u64 {
    if total_weight <= 0.0 || tab_weight <= 0.0 {
        return 0;
    }
    let ratio = (tab_weight / total_weight).clamp(0.0, 1.0);
    (shared_footprint as f64 * ratio) as u64
}

unsafe extern "C" {
    // Apple SPI without a libproc wrapper; how macOS attributes the WebKit XPC
    // helpers (WebContent/GPU/Networking) to the app that owns them.
    fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
}

fn ppid_of(pid: i32) -> Option<i32> {
    pidinfo::<BSDInfo>(pid, 0).ok().map(|b| b.pbi_ppid as i32)
}

/// One sweep of the system process table per sampling cycle. Building the
/// ppid→children map costs a pidinfo syscall per process, so callers share a
/// single snapshot instead of rebuilding it per lookup.
struct PidTable {
    pids: Vec<i32>,
    children: HashMap<i32, Vec<i32>>,
}

impl PidTable {
    fn snapshot() -> PidTable {
        let pids = all_pids();
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        for &pid in &pids {
            if let Some(pp) = ppid_of(pid) {
                children.entry(pp).or_default().push(pid);
            }
        }
        PidTable { pids, children }
    }

    /// Root plus every transitive child, walked via ppid. `proc_listchildpids`
    /// is useless here: it reports 0 children for shells whose CLIs
    /// (claude/node) live in another session, so only the first level was
    /// visible and the rest got misattributed to "Shirei".
    fn descendants(&self, root: i32) -> Vec<i32> {
        let mut seen = HashSet::from([root]);
        let mut out = vec![root];
        let mut i = 0;
        while i < out.len() {
            if let Some(kids) = self.children.get(&out[i]) {
                for &k in kids {
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            i += 1;
        }
        out
    }
}

fn all_pids() -> Vec<i32> {
    pids_by_type(ProcFilter::All)
        .unwrap_or_default()
        .into_iter()
        .filter(|&p| p > 0)
        .map(|p| p as i32)
        .collect()
}

/// The app "chrome": Shirei's Rust process, the WebKit XPC helpers
/// (WebContent/GPU/Networking, attributed via "responsibility" rather than the
/// PID tree) and the `shirei-mux` daemon when present. This is the app's own
/// overhead, kept apart from whatever the user runs inside the terminals.
#[derive(Clone, Default)]
struct ChromeSet {
    pids: Vec<i32>,
    webcontent: Option<i32>,
    daemon: Option<i32>,
    reparented: Vec<i32>,
}

/// A process that responsibility attributes to Shirei but that the ppid walk
/// did not reach is app chrome only when it is a system WebKit/Safari XPC
/// helper. Anything else (a dev server, gitstatusd, a shell) was spawned inside
/// a terminal and reparented to launchd — user workload, not app overhead.
/// Matched by executable path because proc_name truncates past the helper name.
fn is_app_chrome_helper(pid: i32) -> bool {
    pidpath(pid)
        .map(|p| p.contains("WebKit.framework") || p.contains("SafariPlatformSupport"))
        .unwrap_or(false)
}

/// The expensive sweep: asks every PID for its "responsible" process. Cached
/// and revalidated every few cycles (the WebKit helpers are stable) so each
/// sample does not pay for it.
fn scan_chrome(shirei: i32, table: &PidTable) -> ChromeSet {
    let descendants: HashSet<i32> = table.descendants(shirei).into_iter().collect();
    let mut pids = vec![shirei];
    let mut webcontent = None;
    let mut daemon = None;
    let mut reparented = Vec::new();
    for &pid in &table.pids {
        if pid == shirei {
            continue;
        }
        if daemon.is_none() && matches!(proc_name(pid).as_deref(), Ok("shirei-mux")) {
            daemon = Some(pid);
            pids.push(pid);
            continue;
        }
        if descendants.contains(&pid) {
            continue;
        }
        if unsafe { responsibility_get_pid_responsible_for_pid(pid) } != shirei {
            continue;
        }
        if is_app_chrome_helper(pid) {
            pids.push(pid);
            if webcontent.is_none()
                && matches!(proc_name(pid).as_deref(), Ok(n) if n.contains("WebContent"))
            {
                webcontent = Some(pid);
            }
        } else {
            reparented.push(pid);
        }
    }
    ChromeSet {
        pids,
        webcontent,
        daemon,
        reparented,
    }
}

/// What the user runs inside the terminals: descendants of Shirei's process
/// (shells + CLIs) plus, with persistent sessions, the daemon's. The daemon
/// itself stays out — it belongs to the chrome set.
fn workload_pids(
    shirei: i32,
    daemon: Option<i32>,
    reparented: &[i32],
    table: &PidTable,
) -> Vec<i32> {
    let mut seen: HashSet<i32> = HashSet::from([shirei]);
    if let Some(d) = daemon {
        seen.insert(d);
    }
    let mut out: Vec<i32> = Vec::new();
    for root in std::iter::once(shirei).chain(daemon) {
        for p in table.descendants(root) {
            if seen.insert(p) {
                out.push(p);
            }
        }
    }
    for &p in reparented {
        if seen.insert(p) {
            out.push(p);
        }
    }
    out
}

struct ProcSample {
    cpu_ns: u64,
    footprint: u64,
    disk: u64,
}

fn sample_pid(pid: i32) -> Option<ProcSample> {
    let ti = pidinfo::<TaskInfo>(pid, 0).ok()?;
    let (footprint, disk) = pidrusage::<RUsageInfoV2>(pid)
        .map(|r| {
            (
                r.ri_phys_footprint,
                r.ri_diskio_bytesread + r.ri_diskio_byteswritten,
            )
        })
        .unwrap_or((0, 0));
    Some(ProcSample {
        cpu_ns: ti.pti_total_user + ti.pti_total_system,
        footprint,
        disk,
    })
}

fn footprint_of(pid: i32) -> u64 {
    sample_pid(pid).map(|s| s.footprint).unwrap_or(0)
}

#[derive(Default)]
struct UsageState {
    last_cpu_ns: u64,
    last_disk: u64,
    last_at: Option<Instant>,
}

struct Usage {
    cpu_pct: f64,
    footprint: u64,
    disk_bps: u64,
}

fn usage(pids: &[i32], state: &mut UsageState) -> Usage {
    let mut cpu_ns = 0u64;
    let mut footprint = 0u64;
    let mut disk = 0u64;
    for &pid in pids {
        if let Some(s) = sample_pid(pid) {
            cpu_ns += s.cpu_ns;
            footprint += s.footprint;
            disk += s.disk;
        }
    }
    let now = Instant::now();
    let (cpu_pct, disk_bps) = match state.last_at {
        Some(at) => {
            let dt = now.duration_since(at).as_nanos() as u64;
            let secs = (dt as f64 / 1e9).max(0.001);
            (
                cpu_percent(cpu_ns.saturating_sub(state.last_cpu_ns), dt),
                (disk.saturating_sub(state.last_disk) as f64 / secs) as u64,
            )
        }
        None => (0.0, 0),
    };
    state.last_cpu_ns = cpu_ns;
    state.last_disk = disk;
    state.last_at = Some(now);
    Usage {
        cpu_pct,
        footprint,
        disk_bps,
    }
}

/// Cumulative (in, out) bytes per PID via nettop. Expensive — it shells out
/// and blocks the sampling thread — so it only runs when a net toggle is on.
fn nettop_sample() -> HashMap<i32, (u64, u64)> {
    let mut map = HashMap::new();
    let out = match std::process::Command::new("nettop")
        .args(["-P", "-x", "-l", "1", "-J", "bytes_in,bytes_out"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return map,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 3 {
            continue;
        }
        let Some(pid) = cols[0]
            .rsplit('.')
            .next()
            .and_then(|s| s.trim().parse::<i32>().ok())
        else {
            continue;
        };
        let bin = cols[1].trim().parse::<u64>().unwrap_or(0);
        let bout = cols[2].trim().parse::<u64>().unwrap_or(0);
        map.insert(pid, (bin, bout));
    }
    map
}

#[derive(Default)]
struct NetState {
    last_in: u64,
    last_out: u64,
    last_at: Option<Instant>,
}

fn net_throughput(
    pids: &HashSet<i32>,
    sample: &HashMap<i32, (u64, u64)>,
    state: &mut NetState,
) -> (String, String) {
    let (mut cin, mut cout) = (0u64, 0u64);
    for (pid, (bin, bout)) in sample {
        if pids.contains(pid) {
            cin += bin;
            cout += bout;
        }
    }
    let now = Instant::now();
    let res = match state.last_at {
        Some(at) => {
            let secs = now.duration_since(at).as_secs_f64().max(0.001);
            (
                format!(
                    "{}/s",
                    fmt_bytes((cin.saturating_sub(state.last_in) as f64 / secs) as u64)
                ),
                format!(
                    "{}/s",
                    fmt_bytes((cout.saturating_sub(state.last_out) as f64 / secs) as u64)
                ),
            )
        }
        None => (String::new(), String::new()),
    };
    state.last_in = cin;
    state.last_out = cout;
    state.last_at = Some(now);
    res
}

#[derive(Serialize, Clone, Default)]
pub struct Val {
    pub text: String,
    pub level: u8,
    pub pct: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approx: bool,
}

fn cpu_val(pct: f64, thr: (u8, u8)) -> Val {
    Val {
        text: format!("{pct:.0}%"),
        level: level(pct, thr) as u8,
        pct,
        approx: false,
    }
}

fn mem_val(bytes: u64, approx: bool) -> Val {
    Val {
        text: fmt_bytes(bytes),
        level: 0,
        pct: 0.0,
        approx,
    }
}

fn disk_val(bps: u64) -> Val {
    Val {
        text: format!("{}/s", fmt_bytes(bps)),
        level: 0,
        pct: 0.0,
        approx: false,
    }
}

fn net_val(text: String) -> Option<Val> {
    if text.is_empty() {
        return None;
    }
    Some(Val {
        text,
        level: 0,
        pct: 0.0,
        approx: false,
    })
}

/// One zone of the bar (tab or app). Every metric splits into `shirei` (the
/// app's own cost) and `apps` (what runs inside). Empty fields are omitted.
#[derive(Serialize, Clone, Default)]
pub struct Zone {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_shirei: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_apps: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_shirei: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_apps: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_shirei: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_apps: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_down_shirei: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_up_shirei: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_down_apps: Option<Val>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_up_apps: Option<Val>,
}

#[derive(Serialize, Clone, Default)]
pub struct PerfPayload {
    pub tab: Zone,
    pub app: Zone,
}

#[derive(Default, Clone, PartialEq)]
pub struct ActiveTab {
    pub pids: Vec<i32>,
    pub tab_weight: f64,
    pub total_weight: f64,
}

#[derive(Default)]
pub struct PerfActiveTab(pub Mutex<ActiveTab>);

#[tauri::command]
pub fn perf_set_active_tab(
    pids: Vec<i32>,
    tab_weight: f64,
    total_weight: f64,
    state: tauri::State<'_, PerfActiveTab>,
) {
    *state.0.lock_ignore_poison() = ActiveTab {
        pids,
        tab_weight,
        total_weight,
    };
}

const CHROME_REVALIDATE_CYCLES: u32 = 15;

#[derive(Default)]
struct States {
    app_shirei: UsageState,
    app_apps: UsageState,
    tab_apps: UsageState,
    app_shirei_net: NetState,
    app_apps_net: NetState,
    tab_net: NetState,
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let shirei = std::process::id() as i32;
        let mut st = States::default();
        let mut chrome: ChromeSet = ChromeSet::default();
        let mut chrome_age = CHROME_REVALIDATE_CYCLES;
        let mut last_tab: ActiveTab = ActiveTab::default();
        loop {
            let cfg = app.state::<ConfigManager>().performance();
            if !cfg.enabled {
                st = States::default();
                chrome = ChromeSet::default();
                chrome_age = CHROME_REVALIDATE_CYCLES;
                last_tab = ActiveTab::default();
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let refresh = cfg.refresh_secs.max(1) as u64;
            let thr = (cfg.thresholds.warn, cfg.thresholds.crit);
            let m = &cfg.metrics;

            let table = PidTable::snapshot();

            if chrome_age >= CHROME_REVALIDATE_CYCLES
                || chrome.pids.is_empty()
                || chrome.webcontent.map(footprint_of) == Some(0)
            {
                chrome = scan_chrome(shirei, &table);
                chrome_age = 0;
            } else {
                chrome_age += 1;
            }

            let active = app.state::<PerfActiveTab>().0.lock_ignore_poison().clone();
            if active.pids != last_tab.pids {
                st.tab_apps = UsageState::default();
                st.tab_net = NetState::default();
            }
            last_tab = active.clone();

            let net_sample = if m.net_tab || m.net_app {
                nettop_sample()
            } else {
                HashMap::new()
            };

            let mut p = PerfPayload::default();

            if m.cpu_app || m.mem_app || m.disk_app || m.net_app {
                let apps = workload_pids(shirei, chrome.daemon, &chrome.reparented, &table);
                if m.cpu_app || m.mem_app || m.disk_app {
                    let cu = usage(&chrome.pids, &mut st.app_shirei);
                    let au = usage(&apps, &mut st.app_apps);
                    if m.cpu_app {
                        p.app.cpu_shirei = Some(cpu_val(cu.cpu_pct, thr));
                        p.app.cpu_apps = Some(cpu_val(au.cpu_pct, thr));
                    }
                    if m.mem_app {
                        p.app.mem_shirei = Some(mem_val(cu.footprint, false));
                        p.app.mem_apps = Some(mem_val(au.footprint, false));
                    }
                    if m.disk_app {
                        p.app.disk_shirei = Some(disk_val(cu.disk_bps));
                        p.app.disk_apps = Some(disk_val(au.disk_bps));
                    }
                }
                if m.net_app {
                    let cset: HashSet<i32> = chrome.pids.iter().copied().collect();
                    let aset: HashSet<i32> = apps.iter().copied().collect();
                    let (cd, cu) = net_throughput(&cset, &net_sample, &mut st.app_shirei_net);
                    let (ad, au) = net_throughput(&aset, &net_sample, &mut st.app_apps_net);
                    p.app.net_down_shirei = net_val(cd);
                    p.app.net_up_shirei = net_val(cu);
                    p.app.net_down_apps = net_val(ad);
                    p.app.net_up_apps = net_val(au);
                }
            }

            if !active.pids.is_empty() && (m.cpu_tab || m.mem_tab || m.disk_tab || m.net_tab) {
                let mut seen: HashSet<i32> = HashSet::new();
                let mut tab_pids: Vec<i32> = Vec::new();
                for &pid in &active.pids {
                    for d in table.descendants(pid) {
                        if seen.insert(d) {
                            tab_pids.push(d);
                        }
                    }
                }
                if m.cpu_tab || m.mem_tab || m.disk_tab {
                    let tu = usage(&tab_pids, &mut st.tab_apps);
                    if m.cpu_tab {
                        p.tab.cpu_apps = Some(cpu_val(tu.cpu_pct, thr));
                    }
                    if m.mem_tab {
                        p.tab.mem_apps = Some(mem_val(tu.footprint, false));
                        if let Some(wc) = chrome.webcontent {
                            let est =
                                prorate(footprint_of(wc), active.tab_weight, active.total_weight);
                            if est > 0 {
                                p.tab.mem_shirei = Some(mem_val(est, true));
                            }
                        }
                    }
                    if m.disk_tab {
                        p.tab.disk_apps = Some(disk_val(tu.disk_bps));
                    }
                }
                if m.net_tab {
                    let tset: HashSet<i32> = tab_pids.into_iter().collect();
                    let (d, up) = net_throughput(&tset, &net_sample, &mut st.tab_net);
                    p.tab.net_down_apps = net_val(d);
                    p.tab.net_up_apps = net_val(up);
                }
            }

            let _ = app.emit("perf", p);
            std::thread::sleep(Duration::from_secs(refresh));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_bytes_uses_binary_units() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_bytes(1_288_490_188), "1.2 GB");
    }

    #[test]
    fn level_follows_thresholds() {
        let t = (70u8, 90u8);
        assert_eq!(level(10.0, t), Level::Ok);
        assert_eq!(level(75.0, t), Level::Warn);
        assert_eq!(level(95.0, t), Level::Crit);
    }

    #[test]
    fn cpu_percent_from_deltas() {
        let pct = cpu_percent(500_000_000, 1_000_000_000);
        assert!((pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn prorate_splits_by_weight() {
        assert_eq!(prorate(400, 25.0, 100.0), 100);
        assert_eq!(prorate(400, 100.0, 100.0), 400);
    }

    #[test]
    fn prorate_without_weight_is_zero() {
        assert_eq!(prorate(400, 0.0, 0.0), 0);
        assert_eq!(prorate(400, 10.0, 0.0), 0);
    }

    #[test]
    fn prorate_saturates_at_the_total() {
        assert_eq!(prorate(400, 200.0, 100.0), 400);
    }

    #[test]
    fn descendants_walk_shared_children_and_cycles_once() {
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        children.insert(1, vec![2, 3]);
        children.insert(2, vec![4]);
        children.insert(3, vec![4]);
        children.insert(4, vec![1]);
        let table = PidTable {
            pids: vec![1, 2, 3, 4],
            children,
        };
        let mut got = table.descendants(1);
        got.sort_unstable();
        assert_eq!(got, vec![1, 2, 3, 4]);
    }

    #[test]
    fn workload_excludes_app_and_daemon_roots() {
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        children.insert(10, vec![11, 20]);
        children.insert(20, vec![21]);
        let table = PidTable {
            pids: vec![10, 11, 20, 21],
            children,
        };
        let mut got = workload_pids(10, Some(20), &[], &table);
        got.sort_unstable();
        assert_eq!(got, vec![11, 21]);
    }

    #[test]
    fn workload_includes_reparented_without_duplicating_descendants() {
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        children.insert(10, vec![11]);
        let table = PidTable {
            pids: vec![10, 11, 99],
            children,
        };
        let mut got = workload_pids(10, None, &[99, 11], &table);
        got.sort_unstable();
        assert_eq!(got, vec![11, 99]);
    }
}
