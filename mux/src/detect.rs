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

/// How sure the state read is. High = a ground-truth or authoritative signal
/// (exit code, an OSC notify, a matched prompt, a per-CLI "action required").
/// Tentative = a long silence with no other signal — the session *might* be
/// waiting, surfaced as a soft hint, never a hard alert. Low = a short idle
/// guess, treated as calm. Drives both the render and whether a notification
/// (High only) is raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    High,
    Tentative,
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

    /// Feed a chunk of pty output. Non-echo output means the agent is producing;
    /// a notify escape is a high-confidence "look at me". `is_echo` is true when
    /// the chunk was provoked by the user's own keystrokes (the CLI repainting its
    /// input line right after typing) — that is the user composing a prompt, not
    /// the agent working, so it must not flip the state to Working or reset idle.
    pub fn on_output(&mut self, bytes: &[u8], is_echo: bool) -> Option<StateChange> {
        if self.settled {
            return None;
        }
        let signals = self.scanner.feed(bytes);
        if let Some(text) = signals.iter().rev().find_map(|s| match s {
            Signal::Notify { text, .. } => Some(text.clone()),
            _ => None,
        }) {
            self.idle_ticks = 0;
            let payload = (!text.is_empty()).then_some(text);
            return self.transition(
                AgentState::Waiting(WaitKind::Unknown),
                Confidence::High,
                payload,
            );
        }
        // A CLI that spells "action required" into the window title (Codex) is
        // telling us it is blocked on the user — a first-party needs-you cue,
        // authoritative even while the pane keeps repainting.
        if signals.iter().rev().any(|s| match s {
            Signal::Title(title) => title_needs_you(title),
            _ => false,
        }) {
            self.idle_ticks = 0;
            return self.transition(AgentState::Waiting(WaitKind::Approval), Confidence::High, None);
        }
        if is_echo {
            return None;
        }
        self.idle_ticks = 0;
        // A selector's own hint in the output is a reliable "needs you to pick",
        // even while the menu repaints and would otherwise read as busy work.
        if has_select_cue(&String::from_utf8_lossy(bytes).to_ascii_lowercase()) {
            return self.transition(
                AgentState::Waiting(WaitKind::Approval),
                Confidence::High,
                None,
            );
        }
        self.transition(AgentState::Working, Confidence::High, None)
    }

    /// The user sent input (typing at the prompt). Whatever the agent was doing,
    /// it is now taking input, not working autonomously — drop out of Working so
    /// the Atom stops while the user composes. No-op once the state is already calm.
    pub fn on_input(&mut self) -> Option<StateChange> {
        if self.settled || self.state != AgentState::Working {
            return None;
        }
        self.idle_ticks = 0;
        self.transition(
            AgentState::Waiting(WaitKind::Unknown),
            Confidence::Low,
            None,
        )
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

    /// Periodic re-evaluation. `idle` = output has been silent past the short
    /// threshold; `long_idle` = silent past the longer tentative threshold;
    /// `cpu_idle` = the process is not burning CPU (the second vote); `tail` =
    /// recent de-escaped output for prompt matching.
    pub fn tick(
        &mut self,
        idle: bool,
        long_idle: bool,
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
        // Re-evaluate while working, or while sitting in a bare idle guess: a
        // Low idle-Waiting can ripen into a Tentative one after a long silence.
        // A High Waiting (a matched prompt, an OSC notify) is authoritative and
        // must not be downgraded by mere silence.
        let idle_guess = self.state == AgentState::Working
            || (matches!(self.state, AgentState::Waiting(_)) && self.confidence != Confidence::High);
        if !idle_guess {
            return None;
        }
        if idle && cpu_idle {
            self.idle_ticks = self.idle_ticks.saturating_add(1);
            if self.idle_ticks >= self.hysteresis {
                // A matched prompt on screen is a real "needs you" signal, not a
                // bare idle guess — confident enough to interrupt. Pure silence
                // stays a soft hint: Low at first, ripening to Tentative once the
                // session has been quiet long enough to plausibly be stuck waiting,
                // yet never confident enough to raise a notification.
                return match classify_prompt(tail) {
                    Some(kind) => {
                        self.transition(AgentState::Waiting(kind), Confidence::High, None)
                    }
                    None => {
                        let confidence = if long_idle {
                            Confidence::Tentative
                        } else {
                            Confidence::Low
                        };
                        self.transition(AgentState::Waiting(WaitKind::Unknown), confidence, None)
                    }
                };
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

// Cues that appear only in an interactive prompt waiting for the user to pick or
// approve (Claude's numbered menus and plan/approval box, inquirer-style
// prompts) — never in an agent's plain numbered output. Their presence is a
// reliable "needs you to choose", caught the instant the prompt paints.
const SELECT_CUE: [&str; 7] = [
    "esc to cancel",
    "enter to select",
    "to navigate",
    "use arrow keys",
    "↑/↓",
    "shift+tab to approve",
    "would you like to proceed",
];

fn has_select_cue(lower: &str) -> bool {
    SELECT_CUE.iter().any(|c| lower.contains(c))
}

// Window-title phrases a CLI writes only when it is blocked on the user. Kept to
// unambiguous "come back" wording so a working title (a spinner glyph, the cwd,
// a task name) never reads as needs-you.
const TITLE_ATTN: [&str; 3] = ["action required", "needs your input", "waiting for input"];

fn title_needs_you(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    TITLE_ATTN.iter().any(|c| lower.contains(c))
}

/// Layer 3: reads whether the tail of the output is an input prompt awaiting the
/// user. Explicit y/n text, an interactive selector's own hint, or a spelled-out
/// yes/no menu — kept tight so plain numbered output never trips it.
pub fn classify_prompt(tail: &str) -> Option<WaitKind> {
    // Only shapes explicit enough that they never occur in an agent's normal
    // output. The earlier loose rules — a line starting with `>` (Claude's own
    // input prompt), any numbered line (its tool output), any trailing `?` —
    // fired a false "waiting for approval" on nearly every repaint, which is
    // what produced the notification spam.
    const APPROVAL: [&str; 7] = [
        "(y/n)",
        "[y/n]",
        "(y/n/a)",
        "(yes/no)",
        "do you want to proceed",
        "do you want to continue",
        "would you like to proceed",
    ];
    let last = tail
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())?
        .to_ascii_lowercase();
    if APPROVAL.iter().any(|p| last.contains(p)) {
        return Some(WaitKind::Approval);
    }
    let recent: String = tail
        .to_ascii_lowercase()
        .lines()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .join("\n");
    // The selector's own hints (footer, arrow legend, the plan-prompt question)
    // often sit several rows above the input, so they are scanned across the
    // recent tail, not just the last line.
    if has_select_cue(&recent) {
        return Some(WaitKind::Approval);
    }
    // An interactive numbered menu (Claude's plan/approval list, inquirer-style
    // choosers): the pointer glyph marks the highlighted option and at least one
    // more numbered row sits below it. Requiring the pointer *and* a second
    // option keeps ordinary numbered output (a step list, a table) from tripping.
    if is_selection_menu(&recent) {
        return Some(WaitKind::Approval);
    }
    let yes_no_menu = (recent.contains("1. yes") || recent.contains("1) yes"))
        && (recent.contains("2. no") || recent.contains("2) no"));
    yes_no_menu.then_some(WaitKind::Approval)
}

// A row like `❯ 1.` or `2)` — a numbered option, optionally led by a selector
// pointer. Only a digit run terminated by `.`/`)` counts, so a prompt line such
// as `❯ 1 plus one` (a user typing at the input) never reads as an option.
fn numbered_option(line: &str) -> Option<bool> {
    let body = line.trim_start();
    let (body, pointed) = match body.strip_prefix('❯').or_else(|| body.strip_prefix('>')) {
        Some(rest) => (rest.trim_start(), true),
        None => (body, false),
    };
    let mut digits = 0;
    for c in body.chars() {
        if c.is_ascii_digit() {
            digits += 1;
        } else {
            return (digits > 0 && (c == '.' || c == ')')).then_some(pointed);
        }
    }
    None
}

fn is_selection_menu(lower: &str) -> bool {
    let mut pointed = false;
    let mut options = 0;
    for line in lower.lines() {
        if let Some(is_pointer) = numbered_option(line) {
            options += 1;
            pointed |= is_pointer;
        }
    }
    pointed && options >= 2
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
            d.on_output(b"thinking...", false),
            Some(StateChange {
                state: AgentState::Working,
                confidence: Confidence::High,
                payload: None,
            })
        );
    }

    #[test]
    fn echo_output_does_not_read_as_working() {
        let mut d = Detector::new(2);
        d.on_output(b"agent output", false);
        d.on_input(); // user starts typing at the prompt -> calm
        assert!(matches!(d.state(), AgentState::Waiting(_)));
        // The echo of the user's keystrokes must not flip it back to Working.
        assert_eq!(d.on_output(b"git commit -m ", true), None);
        assert!(matches!(d.state(), AgentState::Waiting(_)));
    }

    #[test]
    fn user_input_drops_a_working_session_out_of_working() {
        let mut d = Detector::new(2);
        d.on_output(b"tool output", false); // agent working
        assert_eq!(d.state(), AgentState::Working);
        let change = d.on_input().expect("input should move out of working");
        assert!(matches!(change.state, AgentState::Waiting(_)));
        assert_eq!(change.confidence, Confidence::Low);
        // A second keystroke while already calm is a no-op.
        assert_eq!(d.on_input(), None);
    }

    #[test]
    fn a_notify_is_high_confidence_waiting_with_payload() {
        let mut d = Detector::new(2);
        d.on_output(b"working", false);
        assert_eq!(
            d.on_output(b"\x1b]9;needs approval\x07", false),
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
        d.on_output(b"go", false);
        assert_eq!(d.tick(true, false, ProcStatus::Sleeping, true, ""), None);
        assert_eq!(
            d.tick(true, false, ProcStatus::Sleeping, true, ""),
            Some(StateChange {
                state: AgentState::Waiting(WaitKind::Unknown),
                confidence: Confidence::Low,
                payload: None,
            })
        );
    }

    #[test]
    fn a_matched_prompt_is_high_confidence_waiting() {
        let mut d = Detector::new(1);
        d.on_output(b"run rm -rf? (y/n)", false);
        let change = d
            .tick(true, false, ProcStatus::Sleeping, true, "run rm -rf? (y/n)")
            .unwrap();
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Approval));
        assert_eq!(change.confidence, Confidence::High);
    }

    #[test]
    fn bare_idle_without_a_prompt_stays_low_confidence() {
        let mut d = Detector::new(1);
        d.on_output(b"thinking", false);
        let change = d
            .tick(true, false, ProcStatus::Sleeping, true, "still thinking")
            .unwrap();
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Unknown));
        assert_eq!(change.confidence, Confidence::Low);
    }

    #[test]
    fn a_long_silence_ripens_a_low_wait_into_tentative() {
        let mut d = Detector::new(1);
        d.on_output(b"thinking", false);
        let low = d.tick(true, false, ProcStatus::Sleeping, true, "").unwrap();
        assert_eq!(low.confidence, Confidence::Low);
        // The same bare-idle state, now past the longer threshold, ripens into a
        // soft tentative hint without ever becoming a hard, notifiable Waiting.
        let tentative = d.tick(true, true, ProcStatus::Sleeping, true, "").unwrap();
        assert_eq!(tentative.state, AgentState::Waiting(WaitKind::Unknown));
        assert_eq!(tentative.confidence, Confidence::Tentative);
    }

    #[test]
    fn a_matched_prompt_overrides_a_tentative_wait() {
        let mut d = Detector::new(1);
        d.on_output(b"thinking", false);
        d.tick(true, true, ProcStatus::Sleeping, true, "").unwrap();
        // A real prompt appearing after the tentative hint must upgrade it to a
        // confident, notifiable needs-you — the ring gives way to the bell.
        let change = d
            .tick(true, true, ProcStatus::Sleeping, true, "proceed? (y/n)")
            .unwrap();
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Approval));
        assert_eq!(change.confidence, Confidence::High);
    }

    #[test]
    fn an_action_required_title_is_high_confidence_waiting() {
        let mut d = Detector::new(2);
        let change = d
            .on_output(b"\x1b]0;Codex \xe2\x9c\xb3 Action Required\x07", false)
            .unwrap();
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Approval));
        assert_eq!(change.confidence, Confidence::High);
    }

    #[test]
    fn an_ordinary_title_stays_working() {
        let mut d = Detector::new(2);
        let change = d
            .on_output(b"\x1b]0;~/code/shirei\x07building", false)
            .unwrap();
        assert_eq!(change.state, AgentState::Working);
    }

    #[test]
    fn a_spinner_never_flips_to_idle() {
        let mut d = Detector::new(2);
        for _ in 0..10 {
            d.on_output(b".", false); // output resets the idle counter each frame
            assert_eq!(d.tick(false, false, ProcStatus::Running, false, ""), None);
        }
        assert_eq!(d.state(), AgentState::Working);
    }

    #[test]
    fn cpu_busy_blocks_the_idle_flip_even_on_output_silence() {
        let mut d = Detector::new(1);
        d.on_output(b"go", false);
        assert_eq!(d.tick(true, false, ProcStatus::Running, false, ""), None);
    }

    #[test]
    fn once_exited_further_events_are_ignored() {
        let mut d = Detector::new(1);
        d.on_exit(0);
        assert_eq!(d.on_output(b"late", false), None);
        assert_eq!(d.tick(true, false, ProcStatus::Gone, true, ""), None);
    }

    #[test]
    fn a_vanished_process_settles_as_done() {
        let mut d = Detector::new(2);
        d.on_output(b"go", false);
        assert_eq!(
            d.tick(true, false, ProcStatus::Zombie, true, "").unwrap().state,
            AgentState::Done { code: 0 }
        );
    }

    #[test]
    fn prompt_classifier_only_fires_on_explicit_approvals() {
        assert_eq!(classify_prompt("proceed? (y/n)"), Some(WaitKind::Approval));
        assert_eq!(
            classify_prompt("do you want to proceed?"),
            Some(WaitKind::Approval)
        );
        assert_eq!(
            classify_prompt("❯ 1. Yes\n  2. No"),
            Some(WaitKind::Approval)
        );
        // Claude's own input prompt and normal output must never read as a prompt
        // — these were the false-positive notification spam.
        assert_eq!(classify_prompt("> "), None);
        assert_eq!(classify_prompt("> tell me about the parser"), None);
        assert_eq!(classify_prompt("Migrate rows or drop?"), None);
        assert_eq!(classify_prompt("1. First, refactor the parser"), None);
        assert_eq!(
            classify_prompt("the docs mention (y/n) prompts\nrunning tests now"),
            None
        );
        assert_eq!(classify_prompt("just building the thing"), None);
    }

    #[test]
    fn a_selection_menu_is_high_confidence_waiting() {
        let menu = "Which focus?\n1. Ratings\n2. Motor\n3. Localia\n  Enter to select · ↑/↓ to navigate · Esc to cancel";
        // Layer-3 (idle-tick) path.
        assert_eq!(classify_prompt(menu), Some(WaitKind::Approval));
        // Instant path: on_output flags it even while the menu keeps repainting.
        let mut d = Detector::new(2);
        let change = d
            .on_output(menu.as_bytes(), false)
            .expect("selection menu should transition");
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Approval));
        assert_eq!(change.confidence, Confidence::High);
        // A plain numbered list with no selector cue is not a prompt — it reads
        // as ordinary working output, not needs-you.
        let list = "Here is the plan:\n1. Refactor the parser\n2. Add tests\n3. Ship it";
        assert_eq!(classify_prompt(list), None);
        assert_eq!(
            d.on_output(list.as_bytes(), false).map(|c| c.state),
            Some(AgentState::Working)
        );
    }

    #[test]
    fn claude_plan_approval_prompt_is_needs_you() {
        // The exact shape that only the tentative fallback used to catch: a plan
        // menu whose question sits above the options and whose footer is the
        // shift+tab hint, with no arrow legend or y/n text anywhere.
        let prompt = "Claude has written up a plan and is ready to execute. Would you like to proceed?\n\
             ❯ 1. Yes, and use auto mode\n\
               2. Yes, manually approve edits\n\
               3. No, refine on the web\n\
               4. Tell Claude what to change\n\
                 shift+tab to approve with this feedback";
        assert_eq!(classify_prompt(prompt), Some(WaitKind::Approval));
        let mut d = Detector::new(2);
        let change = d
            .on_output(prompt.as_bytes(), false)
            .expect("plan prompt should transition");
        assert_eq!(change.state, AgentState::Waiting(WaitKind::Approval));
        assert_eq!(change.confidence, Confidence::High);
    }

    #[test]
    fn a_numbered_menu_needs_its_pointer_to_count() {
        // Two numbered options but no selector pointer and no cue: still just
        // output, never a prompt (this is what keeps step lists quiet).
        assert_eq!(classify_prompt("1. build\n2. deploy"), None);
        // The pointer on an option is the signal a real chooser is up.
        assert_eq!(
            classify_prompt("pick one\n❯ 1. build\n  2. deploy"),
            Some(WaitKind::Approval)
        );
    }
}
