# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.10] - 2026-07-06

### Fixed
- The file search and tree no longer descend into `~/Library`, which made macOS
  repeatedly ask for access to other apps' data during a home-scope search.

## [0.14.9] - 2026-07-05

### Added
- A built-in "Shirei Template" layout: a full Claude pane on the left, a
  files-over-commands split in the middle, and a full Yagura pane on the right.
  The middle file pane opens on the file chooser, ready for the next file.

## [0.14.8] - 2026-07-04

### Added
- A "recording is live" highlight: a glowing frame hugs the surface being
  recorded. It is drawn in a separate always-on-top window, so it never appears
  in the video. Configurable under Settings via the recording color, and it can
  be turned off.
- Redesigned recording overlays and HUD: the target/format picker, countdown,
  and finish prompt share one look and motion, and the recording indicator is a
  frosted capsule with a live pulse.

### Fixed
- MP4 recording produced an empty file when the captured area had an odd pixel
  width or height, which the H.264 encoder rejects. Capture dimensions are now
  rounded to even, so app, panel, and region recordings all work.
- The countdown no longer appears in the first frames of the recording.
- A failed recording now reports the error and resets instead of leaving the
  feature stuck with no feedback.

## [0.14.7] - 2026-07-04

### Fixed
- Cmd+E and Cmd+J now close the sidebar on a second press instead of only
  moving focus back to the terminal, so each is a full open/close toggle.

## [0.14.6] - 2026-07-04

### Added
- Autosave for the editor: the file saves on its own a short while after you
  stop typing, with a "Saved" indicator in the top-left corner. Configurable in
  Settings under Editor, on by default with a one-second delay.

### Fixed
- Cmd+S now saves a file opened over a terminal pane. It previously only saved
  a file in a full editor tab and did nothing over a pane.

## [0.14.5] - 2026-07-03

### Fixed
- Copy, paste, and scroll now work in a file opened over a terminal pane. They
  were bound to terminal actions, so Cmd+C copied the terminal line instead of
  the editor selection.
- Reopening the app no longer leaves mouse-report escape sequences printing as
  text in a terminal: re-attaching a persistent session resets stale input
  modes before restoring the live ones.
- A terminal no longer goes silently unresponsive when the session daemon drops
  (idle exit, replacement, or crash); the app re-attaches every pane
  automatically instead of waiting for a manual redraw.

## [0.14.4] - 2026-07-03

### Added
- A dedicated Updates section in Settings: turn automatic update checks on or
  off, check for updates now, and see the current version and status.

## [0.14.3] - 2026-07-03

### Added
- In-app auto-update: a dismissible modal detects a newer published release and,
  on your click, downloads, verifies its signature, and relaunches. Detection
  stays quiet (a titlebar indicator and a one-time notice); automatic versus
  manual checking is a Settings toggle.
- Quick open can search your whole home folder, not just the current project,
  toggled with Tab in the palette.
- Files open into a pane's stack layered over the terminal: keep several open,
  switch with the cluster pill or ⌘⌥1/2/3, and drop back to the session without
  losing them. A contextual shortcut legend in the status bar (toggle in
  Settings) shows what the focused surface can do.

### Changed
- Opening a file adds it to the file pane instead of replacing the one already
  there; a full pane opens the next file in a new tab. Shift-click in the tree,
  or Shift+Enter in quick open, promotes a file to its own tab.
- ⌘W closes the focused file and reveals the terminal, leaving the tab in place;
  unsaved changes are confirmed before the file is dropped.

### Fixed
- New panes no longer open black after updating the app with keep-alive sessions
  on. A session daemon left over from a previous build could keep owning the
  socket and fail to start any new session; the app now verifies the daemon's
  build identity when it connects and replaces a stale one before spawning.
- Killing a keep-alive session now removes its persisted scrollback buffer from
  disk instead of leaving the file behind.
- Shortcuts that combine Cmd and Option with a letter (⌘⌥T to open a file pane,
  ⌘⌥W, and others) fire again on macOS instead of being swallowed by Option's
  character remapping.

## [0.13.4] - 2026-06-30

### Fixed
- Keep-alive sessions no longer leave a stray cursor flashing across full-screen
  TUIs (Yagura, the AI CLI, vim). The daemon now re-asserts the terminal modes a
  reattach can't rebuild from the raw scrollback — cursor visibility, mouse
  reporting, bracketed paste — so a reconnected TUI stays clean.
- The status bar's per-tab CPU/memory/disk again reports usage for keep-alive
  tabs. Process resolution is unified across in-process and daemon sessions, so
  a tab's footprint is found whether or not persistence is on.

### Added
- `render.cursor_inactive_style` (Settings → Terminal): the cursor shape on
  unfocused panes, defaulting to none so idle panes never show a stray cursor.

## [0.13.2] - 2026-06-29

### Fixed
- Keep-alive sessions now work in release builds. The session daemon ships with
  the app instead of being missing, so panes no longer open black when the
  feature is enabled. If the daemon can't be reached, panes fall back to
  in-process terminals instead of hanging.

## [0.13.1] - 2026-06-29

### Changed
- File history now defaults to showing each commit's own change — the diff
  against the previous version of the file, matching `git log -p` — instead of
  the diff against the working tree. Adds a "Working tree" view for the old
  behavior and a "File" view, cycled with `d` and selectable in Settings.

## [0.13.0] - 2026-06-28

### Added
- Graphical merge-conflict resolver in the editor: current / base / incoming
  blocks with accept current/incoming/both, a compare toggle that word-diffs the
  two sides, and a parser that keeps syntax highlighting alive across live
  conflict markers.
- Inline diff against the committed version (HEAD): palette-themed additions and
  deletions with a +/− gutter, per-hunk revert, and localized collapsed regions.
- File history viewer: a keyboard-first overlay listing the commits that touched
  a file, with a themed read-only diff or full-file view per commit, resizable.
- Inline git blame: role-colored end-of-line annotations collapsed per commit
  run, with a commit hover-card. Off by default; configurable.
- Editor buttons for history, diff, and blame, and a Git settings section
  (inline blame on open, hover delay, default history view).
- Create a new file from the file-tree header, backed by a clobber-safe command.
- Editor theming now derives from the active palette: syntax colors are built
  from the terminal ANSI colors and clamped for contrast (APCA) so nothing turns
  illegible on pure black or on light themes. Replaces the hardcoded one-dark
  styling.
- Code-editing craft: indentation guides, active line, bracket matching, drawn
  selection, rectangular selection, and scroll-past-end.
- Premium find/replace panel with an "N of M" match counter and case / regex /
  whole-word toggles.
- Code folding with a hover chevron and a summary placeholder ("N lines" or
  "done/total tasks").
- Inline Markdown live preview: headings, bold/italic/strikethrough, inline
  code, links, callouts (with icons), interactive checkboxes, blockquotes,
  fenced code blocks (language label + copy), rendered tables, images, and
  rules. Raw syntax reveals on the cursor's line. Toggle in Settings.
- A coherent block system shared by callouts, code blocks, quotes, and tables
  (radius, hairline, tint, vertical rhythm) for an editorial, premium feel.
- Markdown editing keys: bold/italic/link shortcuts and list/quote continuation
  on Enter.
- First-class Astro highlighting: TypeScript frontmatter, HTML template with
  nested script (TS) and style (CSS), expressions, components, and directives.
- New "Editor" section in Settings to toggle editor features, search defaults,
  and prose/code width, applied live.

### Changed
- Syntax colors aligned with modern (2026) conventions: types in cyan, escape
  sequences and attribute values as strings, `this`/`self` italic.
- Crisper terminal rendering: block elements are pixel-snapped and the WebGL
  glyph atlas uses nearest-neighbor sampling (no bilinear blur on edges).
- Terminal selection and cursor colors now derive from the active theme
  (selection from the theme foreground, so it stays visible on light themes;
  cursor text uses the background color under a block cursor).

## [0.12.1] - 2026-06-26

### Added
- Keyboard navigation in Settings: arrow keys (and j/k) switch sections instantly
  with roving focus, Home/End jump to first/last, and `/` focuses the search.

### Changed
- Updated the build toolchain and dependencies: Rust 1.96, Tauri 2.11.3,
  Vite 8 (Rolldown bundler), TypeScript 6, Biome 2.5.1, reqwest 0.13 and
  notify 8. No user-facing behavior changes.

## [0.12.0] - 2026-06-24

First public release.

### Added
- Signed and notarized macOS build distributed via GitHub Releases.
- Internationalization with English as the default language and Spanish available.

[Unreleased]: https://github.com/zeroblack/shirei/compare/v0.14.5...HEAD
[0.14.5]: https://github.com/zeroblack/shirei/compare/v0.14.4...v0.14.5
[0.14.4]: https://github.com/zeroblack/shirei/compare/v0.14.3...v0.14.4
[0.14.3]: https://github.com/zeroblack/shirei/compare/v0.13.4...v0.14.3
[0.12.1]: https://github.com/zeroblack/shirei/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/zeroblack/shirei/releases/tag/v0.12.0
