# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zeroblack/shirei/compare/v0.12.1...HEAD
[0.12.1]: https://github.com/zeroblack/shirei/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/zeroblack/shirei/releases/tag/v0.12.0
