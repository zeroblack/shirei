//! Layer 2 of the agent-state detector: a byte-fed scanner that pulls the
//! attention signals some CLIs emit — OSC 9/777/99 notifications, the bell, a
//! dynamic title, alt-screen entry/exit — straight out of the pty stream. It
//! runs in the read loop next to `ModeTracker`, so it stays allocation-free per
//! byte (only a completed sequence allocates) and survives sequences split
//! across reads. Gemini and friends wrap their notifies in tmux passthrough
//! (`ESC P tmux; … ESC \`), so the scanner unwraps that too.

use serde::{Deserialize, Serialize};

use crate::proc::ProcStatus;

/// A signal a CLI emitted, surfaced to the detector as a high-confidence hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// A desktop-notification escape (OSC 9 / 777 / 99). `text` is the payload
    /// with the protocol prefix stripped.
    Notify {
        osc: u16,
        text: String,
    },
    Bell,
    Title(String),
    AltScreen(bool),
}

#[derive(Default, PartialEq)]
enum State {
    #[default]
    Ground,
    Esc,
    Csi,
    Osc,
    Dcs,
}

/// A title or notify body is well under this; an unterminated string must not
/// grow the buffer without bound.
const MAX_STRING_LEN: usize = 8 * 1024;

/// Alt-screen private modes (`?1049`, `?47`, `?1047`).
const ALT_SCREEN_MODES: [u16; 3] = [1049, 47, 1047];

#[derive(Default)]
pub struct EscScanner {
    state: State,
    private: bool,
    param: Option<u16>,
    params: Vec<u16>,
    buf: Vec<u8>,
    esc_pending: bool,
}

impl EscScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Signal> {
        let mut out = Vec::new();
        for &b in bytes {
            self.step(b, &mut out);
        }
        out
    }

    fn step(&mut self, b: u8, out: &mut Vec<Signal>) {
        match self.state {
            State::Osc => return self.osc_byte(b, out),
            State::Dcs => return self.dcs_byte(b, out),
            _ => {}
        }
        // ESC restarts a sequence from any of the non-string states, so a
        // truncated CSI never swallows the escape that follows it.
        if b == 0x1b {
            self.reset_csi();
            self.state = State::Esc;
            return;
        }
        match self.state {
            State::Ground => {
                if b == 0x07 {
                    out.push(Signal::Bell);
                }
            }
            State::Esc => {
                self.state = match b {
                    b'[' => State::Csi,
                    b']' => {
                        self.buf.clear();
                        State::Osc
                    }
                    b'P' => {
                        self.buf.clear();
                        State::Dcs
                    }
                    _ => State::Ground,
                };
            }
            State::Csi => self.csi_byte(b, out),
            State::Osc | State::Dcs => unreachable!(),
        }
    }

    fn csi_byte(&mut self, b: u8, out: &mut Vec<Signal>) {
        match b {
            b'0'..=b'9' => {
                let d = u16::from(b - b'0');
                self.param = Some(self.param.unwrap_or(0).saturating_mul(10).saturating_add(d));
            }
            b';' => self.params.push(self.param.take().unwrap_or(0)),
            b'?' => self.private = true,
            b'h' | b'l' => {
                if let Some(p) = self.param.take() {
                    self.params.push(p);
                }
                if self.private && self.params.iter().any(|m| ALT_SCREEN_MODES.contains(m)) {
                    out.push(Signal::AltScreen(b == b'h'));
                }
                self.reset_csi();
            }
            0x40..=0x7e => self.reset_csi(),
            _ => {}
        }
    }

    fn osc_byte(&mut self, b: u8, out: &mut Vec<Signal>) {
        if self.esc_pending {
            self.esc_pending = false;
            if b == b'\\' {
                self.finish_osc(out);
            } else {
                // The OSC never terminated; abandon it and let ESC start anew.
                self.buf.clear();
                self.state = State::Esc;
                self.step(b, out);
            }
            return;
        }
        match b {
            0x07 => self.finish_osc(out),
            0x1b => self.esc_pending = true,
            _ => self.push_string(b),
        }
    }

    fn finish_osc(&mut self, out: &mut Vec<Signal>) {
        let payload = std::mem::take(&mut self.buf);
        self.reset_string();
        let s = String::from_utf8_lossy(&payload);
        let (ps, rest) = s.split_once(';').unwrap_or((s.as_ref(), ""));
        match ps {
            "9" => out.push(Signal::Notify {
                osc: 9,
                text: rest.to_string(),
            }),
            "99" => out.push(Signal::Notify {
                osc: 99,
                text: rest.to_string(),
            }),
            "777" => out.push(Signal::Notify {
                osc: 777,
                text: rest.strip_prefix("notify;").unwrap_or(rest).to_string(),
            }),
            "0" | "2" => out.push(Signal::Title(rest.to_string())),
            _ => {}
        }
    }

    fn dcs_byte(&mut self, b: u8, out: &mut Vec<Signal>) {
        if self.esc_pending {
            self.esc_pending = false;
            match b {
                b'\\' => self.finish_dcs(out),
                // tmux passthrough encodes a literal ESC in its payload as ESC ESC.
                0x1b => self.push_string(0x1b),
                _ => {
                    self.push_string(0x1b);
                    self.push_string(b);
                }
            }
            return;
        }
        if b == 0x1b {
            self.esc_pending = true;
        } else {
            self.push_string(b);
        }
    }

    fn finish_dcs(&mut self, out: &mut Vec<Signal>) {
        let payload = std::mem::take(&mut self.buf);
        self.reset_string();
        // Only tmux passthrough carries escapes worth re-scanning; the unwrapped
        // inner bytes are a real OSC/CSI, so feed them back through the machine.
        if let Some(inner) = payload.strip_prefix(b"tmux;".as_slice()) {
            for &ib in inner {
                self.step(ib, out);
            }
        }
    }

    fn push_string(&mut self, b: u8) {
        if self.buf.len() < MAX_STRING_LEN {
            self.buf.push(b);
        } else {
            // Overlong / unterminated: give up rather than buffer forever.
            self.reset_string();
        }
    }

    fn reset_string(&mut self) {
        self.state = State::Ground;
        self.esc_pending = false;
        self.buf.clear();
    }

    fn reset_csi(&mut self) {
        self.state = State::Ground;
        self.private = false;
        self.param = None;
        self.params.clear();
    }
}

/// What kind of input a waiting session is blocked on. `Approval` and
/// `Question` come from Layer 3 prompt matching; `Unknown` is a bare notify or
/// an idle guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaitKind {
    Approval,
    Question,
    Unknown,
}

/// The four surfaced states. `Done`/`Errored` carry the process exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentState {
    Working,
    Waiting(WaitKind),
    Done { code: i32 },
    Errored { code: i32 },
}

/// High = a ground-truth or escape signal (exit code, an OSC notify). Low = a
/// heuristic guess (output idle, a matched prompt). Drives both the
/// confidence-honest rendering and whether a notification is ever raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    High,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateChange {
    pub state: AgentState,
    pub confidence: Confidence,
    pub payload: Option<String>,
}

/// Fuses the layers into one state per session. Deliberately clock-free: the
/// caller (which owns the pty read instant and the configured threshold) decides
/// whether output has gone idle and passes that in, so the machine is fully
/// deterministic and replay-testable.
pub struct Detector {
    scanner: EscScanner,
    state: AgentState,
    confidence: Confidence,
    idle_ticks: u32,
    hysteresis: u32,
    settled: bool,
}

impl Detector {
    /// `hysteresis` = consecutive idle ticks required before Working flips to a
    /// low-confidence Waiting, so a spinner's gaps or a mid-stream pause don't
    /// flicker the state.
    pub fn new(hysteresis: u32) -> Self {
        Self {
            scanner: EscScanner::default(),
            state: AgentState::Working,
            confidence: Confidence::Low,
            idle_ticks: 0,
            hysteresis: hysteresis.max(1),
            settled: false,
        }
    }

    /// Feed a chunk of pty output. Output means the agent is producing, unless
    /// the chunk carried a notify escape, which is a high-confidence "look at me".
    pub fn on_output(&mut self, bytes: &[u8]) -> Option<StateChange> {
        if self.settled {
            return None;
        }
        let signals = self.scanner.feed(bytes);
        self.idle_ticks = 0;
        if let Some(text) = signals.iter().rev().find_map(|s| match s {
            Signal::Notify { text, .. } => Some(text.clone()),
            _ => None,
        }) {
            let payload = (!text.is_empty()).then_some(text);
            return self.transition(
                AgentState::Waiting(WaitKind::Unknown),
                Confidence::High,
                payload,
            );
        }
        self.transition(AgentState::Working, Confidence::High, None)
    }

    /// The process ended: the one authoritative Done/Errored, by exit code.
    pub fn on_exit(&mut self, code: i32) -> Option<StateChange> {
        self.settled = true;
        let state = if code == 0 {
            AgentState::Done { code }
        } else {
            AgentState::Errored { code }
        };
        self.transition(state, Confidence::High, None)
    }

    /// Periodic re-evaluation. `idle` = output has been silent past the
    /// configured threshold; `cpu_idle` = the process is not burning CPU (the
    /// second vote); `tail` = recent de-escaped output for prompt matching.
    pub fn tick(
        &mut self,
        idle: bool,
        status: ProcStatus,
        cpu_idle: bool,
        tail: &str,
    ) -> Option<StateChange> {
        if self.settled {
            return None;
        }
        if matches!(status, ProcStatus::Zombie | ProcStatus::Gone) {
            self.settled = true;
            return self.transition(AgentState::Done { code: 0 }, Confidence::High, None);
        }
        if self.state != AgentState::Working {
            return None;
        }
        if idle && cpu_idle {
            self.idle_ticks = self.idle_ticks.saturating_add(1);
            if self.idle_ticks >= self.hysteresis {
                let kind = classify_prompt(tail).unwrap_or(WaitKind::Unknown);
                return self.transition(AgentState::Waiting(kind), Confidence::Low, None);
            }
        } else {
            self.idle_ticks = 0;
        }
        None
    }

    pub fn state(&self) -> AgentState {
        self.state
    }

    fn transition(
        &mut self,
        state: AgentState,
        confidence: Confidence,
        payload: Option<String>,
    ) -> Option<StateChange> {
        if self.state == state && self.confidence == confidence {
            return None;
        }
        self.state = state;
        self.confidence = confidence;
        Some(StateChange {
            state,
            confidence,
            payload,
        })
    }
}

/// Layer 3: a coarse, low-confidence read of whether the tail of the output is
/// an input prompt. Anchored to the last non-empty line so a `(y/n)` quoted mid
/// output does not trip it. A nudge, never authoritative.
pub fn classify_prompt(tail: &str) -> Option<WaitKind> {
    const APPROVAL: [&str; 8] = [
        "(y/n)",
        "[y/n]",
        "(y/n/a)",
        "do you want to proceed",
        "proceed?",
        "allow?",
        "continue?",
        "overwrite?",
    ];
    let last = tail.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    let lower = last.to_ascii_lowercase();
    if APPROVAL.iter().any(|p| lower.contains(p)) {
        return Some(WaitKind::Approval);
    }
    let numbered = lower.starts_with(|c: char| c.is_ascii_digit())
        && (lower.contains(". ") || lower.contains(") "));
    if numbered || lower.starts_with(['❯', '>', '*']) {
        return Some(WaitKind::Approval);
    }
    if lower.ends_with('?') && last.len() <= 200 {
        return Some(WaitKind::Question);
    }
    None
}

#[cfg(test)]
mod scanner_tests {
    use super::*;

    fn scan(input: &[u8]) -> Vec<Signal> {
        EscScanner::default().feed(input)
    }

    #[test]
    fn osc9_notification() {
        assert_eq!(
            scan(b"\x1b]9;turn complete\x07"),
            vec![Signal::Notify {
                osc: 9,
                text: "turn complete".into()
            }]
        );
    }

    #[test]
    fn osc777_strips_the_notify_prefix() {
        assert_eq!(
            scan(b"\x1b]777;notify;Shirei;waiting\x07"),
            vec![Signal::Notify {
                osc: 777,
                text: "Shirei;waiting".into()
            }]
        );
    }

    #[test]
    fn osc99_notification() {
        assert_eq!(
            scan(b"\x1b]99;;body\x07"),
            vec![Signal::Notify {
                osc: 99,
                text: ";body".into()
            }]
        );
    }

    #[test]
    fn osc_terminated_by_st_not_bel() {
        assert_eq!(
            scan(b"\x1b]2;my title\x1b\\"),
            vec![Signal::Title("my title".into())]
        );
    }

    #[test]
    fn window_title() {
        assert_eq!(
            scan(b"\x1b]0;shell\x07"),
            vec![Signal::Title("shell".into())]
        );
    }

    #[test]
    fn bare_bell() {
        assert_eq!(scan(b"ping\x07"), vec![Signal::Bell]);
    }

    #[test]
    fn alt_screen_enter_and_exit() {
        assert_eq!(scan(b"\x1b[?1049h"), vec![Signal::AltScreen(true)]);
        assert_eq!(scan(b"\x1b[?1049l"), vec![Signal::AltScreen(false)]);
    }

    #[test]
    fn sequence_split_across_feeds() {
        let mut s = EscScanner::default();
        assert!(s.feed(b"\x1b]9;partial ").is_empty());
        assert_eq!(
            s.feed(b"done\x07"),
            vec![Signal::Notify {
                osc: 9,
                text: "partial done".into()
            }]
        );
    }

    #[test]
    fn tmux_passthrough_osc9_is_unwrapped() {
        // ESC P tmux; <ESC-doubled OSC 9> ESC \
        assert_eq!(
            scan(b"\x1bPtmux;\x1b\x1b]9;wrapped\x07\x1b\\"),
            vec![Signal::Notify {
                osc: 9,
                text: "wrapped".into()
            }]
        );
    }

    #[test]
    fn plain_text_and_csi_noise_yield_nothing() {
        assert!(scan(b"hello\nworld $ ls\x1b[2J\x1b[1;1H\x1b[0m").is_empty());
    }

    #[test]
    fn non_alt_private_mode_is_ignored() {
        assert!(scan(b"\x1b[?25l").is_empty());
    }

    #[test]
    fn interleaved_signals_arrive_in_order() {
        assert_eq!(
            scan(b"\x1b]0;t\x07text\x07\x1b[?1049h"),
            vec![
                Signal::Title("t".into()),
                Signal::Bell,
                Signal::AltScreen(true),
            ]
        );
    }
}

#[cfg(test)]
mod detector_tests {
    use super::*;
    use crate::proc::ProcStatus;

    #[test]
    fn output_reads_as_working_high() {
        let mut d = Detector::new(2);
        assert_eq!(
            d.on_output(b"thinking..."),
            Some(StateChange {
                state: AgentState::Working,
                confidence: Confidence::High,
                payload: None,
            })
        );
    }

    #[test]
    fn a_notify_is_high_confidence_waiting_with_payload() {
        let mut d = Detector::new(2);
        d.on_output(b"working");
        assert_eq!(
            d.on_output(b"\x1b]9;needs approval\x07"),
            Some(StateChange {
                state: AgentState::Waiting(WaitKind::Unknown),
                confidence: Confidence::High,
                payload: Some("needs approval".into()),
            })
        );
    }

    #[test]
    fn exit_code_splits_done_from_errored() {
        let mut a = Detector::new(2);
        assert_eq!(a.on_exit(0).unwrap().state, AgentState::Done { code: 0 });
        let mut b = Detector::new(2);
        assert_eq!(b.on_exit(1).unwrap().state, AgentState::Errored { code: 1 });
    }

    #[test]
    fn idle_needs_hysteresis_before_flipping_to_waiting() {
        let mut d = Detector::new(2);
        d.on_output(b"go");
        assert_eq!(d.tick(true, ProcStatus::Sleeping, true, ""), None);
        assert_eq!(
            d.tick(true, ProcStatus::Sleeping, true, ""),
            Some(StateChange {
                state: AgentState::Waiting(WaitKind::Unknown),
                confidence: Confidence::Low,
                payload: None,
            })
        );
    }

    #[test]
    fn a_matched_prompt_sets_the_wait_kind() {
        let mut d = Detector::new(1);
        d.on_output(b"run rm -rf? (y/n)");
        assert_eq!(
            d.tick(true, ProcStatus::Sleeping, true, "run rm -rf? (y/n)")
                .unwrap()
                .state,
            AgentState::Waiting(WaitKind::Approval)
        );
    }

    #[test]
    fn a_spinner_never_flips_to_idle() {
        let mut d = Detector::new(2);
        for _ in 0..10 {
            d.on_output(b"."); // output resets the idle counter each frame
            assert_eq!(d.tick(false, ProcStatus::Running, false, ""), None);
        }
        assert_eq!(d.state(), AgentState::Working);
    }

    #[test]
    fn cpu_busy_blocks_the_idle_flip_even_on_output_silence() {
        let mut d = Detector::new(1);
        d.on_output(b"go");
        assert_eq!(d.tick(true, ProcStatus::Running, false, ""), None);
    }

    #[test]
    fn once_exited_further_events_are_ignored() {
        let mut d = Detector::new(1);
        d.on_exit(0);
        assert_eq!(d.on_output(b"late"), None);
        assert_eq!(d.tick(true, ProcStatus::Gone, true, ""), None);
    }

    #[test]
    fn a_vanished_process_settles_as_done() {
        let mut d = Detector::new(2);
        d.on_output(b"go");
        assert_eq!(
            d.tick(true, ProcStatus::Zombie, true, "").unwrap().state,
            AgentState::Done { code: 0 }
        );
    }

    #[test]
    fn prompt_classifier_anchors_to_the_last_line() {
        assert_eq!(classify_prompt("proceed? (y/n)"), Some(WaitKind::Approval));
        assert_eq!(
            classify_prompt("Migrate rows or drop?"),
            Some(WaitKind::Question)
        );
        assert_eq!(
            classify_prompt("❯ 1. Yes\n  2. No"),
            Some(WaitKind::Approval)
        );
        // A `(y/n)` quoted mid-output is not the prompt line.
        assert_eq!(
            classify_prompt("the docs mention (y/n) prompts\nrunning tests now"),
            None
        );
        assert_eq!(classify_prompt("just building the thing"), None);
    }
}
