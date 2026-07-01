//! Tracks the sticky DEC private modes a full-screen TUI turns on (cursor
//! visibility, mouse reporting, bracketed paste, ...). A reattaching client
//! replays the raw byte ring, which cannot reconstruct these once the original
//! set/reset has scrolled out of the ring — that left, for instance, the cursor
//! visible after reconnecting, drawn as a stray block that chased the redraw.
//! On attach the session re-asserts the tracked state so the client re-syncs.

use std::collections::BTreeMap;

// Re-asserting these does not clear or switch the screen buffer, so it is safe
// to replay on every attach. Alt-screen (?47/?1047/?1049) is deliberately left
// out: the client forces a full TUI repaint (SIGWINCH) on reattach, and
// re-sending the enter sequence would blank the buffer.
const RESTORABLE: &[u16] = &[
    1, 7, 9, 12, 25, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 2004,
];

#[derive(Default, PartialEq)]
enum State {
    #[default]
    Ground,
    Esc,
    Csi,
}

#[derive(Default)]
pub struct ModeTracker {
    state: State,
    private: bool,
    param: Option<u16>,
    params: Vec<u16>,
    set: BTreeMap<u16, bool>,
}

impl ModeTracker {
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            // ESC restarts a sequence from any state, so a truncated CSI never
            // swallows the escape that follows it.
            if b == 0x1b {
                self.reset_csi();
                self.state = State::Esc;
                continue;
            }
            match self.state {
                State::Ground => {}
                State::Esc => {
                    self.state = if b == b'[' {
                        State::Csi
                    } else {
                        // OSC, charset selection, ...: mode sequences are CSI-only.
                        State::Ground
                    };
                }
                State::Csi => self.csi_byte(b),
            }
        }
    }

    fn csi_byte(&mut self, b: u8) {
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
                if self.private {
                    let on = b == b'h';
                    for &m in &self.params {
                        if RESTORABLE.contains(&m) {
                            self.set.insert(m, on);
                        }
                    }
                }
                self.reset_csi();
            }
            0x40..=0x7e => self.reset_csi(),
            _ => {}
        }
    }

    fn reset_csi(&mut self) {
        self.state = State::Ground;
        self.private = false;
        self.param = None;
        self.params.clear();
    }

    /// Canonical re-assertion of every tracked mode, e.g. `\e[?25l\e[?2004h`.
    /// Empty when nothing was set, so a plain shell adds no bytes on attach.
    pub fn restore_seq(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (mode, &on) in &self.set {
            out.extend_from_slice(b"\x1b[?");
            out.extend_from_slice(mode.to_string().as_bytes());
            out.push(if on { b'h' } else { b'l' });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restored(input: &[u8]) -> Vec<u8> {
        let mut m = ModeTracker::default();
        m.feed(input);
        m.restore_seq()
    }

    #[test]
    fn hidden_cursor_is_re_asserted() {
        assert_eq!(restored(b"\x1b[?25l"), b"\x1b[?25l");
    }

    #[test]
    fn latest_state_wins() {
        assert_eq!(restored(b"\x1b[?25l\x1b[?25h"), b"\x1b[?25h");
    }

    #[test]
    fn sequence_split_across_feeds_is_tracked() {
        let mut m = ModeTracker::default();
        m.feed(b"\x1b[?2");
        m.feed(b"5l");
        assert_eq!(m.restore_seq(), b"\x1b[?25l");
    }

    #[test]
    fn alt_screen_is_not_restored() {
        assert!(restored(b"\x1b[?1049h").is_empty());
        assert!(restored(b"\x1b[?47h").is_empty());
    }

    #[test]
    fn alt_screen_combined_with_cursor_keeps_only_cursor() {
        assert_eq!(restored(b"\x1b[?1049;25l"), b"\x1b[?25l");
    }

    #[test]
    fn multiple_modes_emit_ascending() {
        assert_eq!(
            restored(b"\x1b[?1006h\x1b[?1000h"),
            b"\x1b[?1000h\x1b[?1006h"
        );
    }

    #[test]
    fn plain_text_tracks_nothing() {
        assert!(restored(b"hello\nworld $ ls").is_empty());
    }

    #[test]
    fn unrelated_csi_does_not_confuse_the_parser() {
        assert_eq!(restored(b"\x1b[2J\x1b[1;1H\x1b[?25l"), b"\x1b[?25l");
    }

    #[test]
    fn modes_interleaved_with_output() {
        assert_eq!(
            restored(b"text\x1b[?25lmore\x1b[?2004hdone"),
            b"\x1b[?25l\x1b[?2004h",
        );
    }

    #[test]
    fn non_private_mode_is_ignored() {
        // `\e[25l` (no '?') is not a DEC private mode and must not be tracked.
        assert!(restored(b"\x1b[25l").is_empty());
    }
}
