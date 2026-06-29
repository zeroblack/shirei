<h1 align="center">Shirei&nbsp;指令</h1>

<p align="center"><strong>A keyboard-first terminal cockpit for AI coding sessions on macOS.</strong></p>

<p align="center">
  <a href="https://github.com/zeroblack/shirei/releases/latest"><img src="https://img.shields.io/github/v/release/zeroblack/shirei?color=000&label=release" alt="Latest release"></a>
  <a href="https://github.com/zeroblack/shirei/actions"><img src="https://img.shields.io/github/actions/workflow/status/zeroblack/shirei/ci.yml?branch=main&color=000&label=CI" alt="CI status"></a>
  <a href="#download"><img src="https://img.shields.io/badge/macOS-signed%20%26%20notarized-000.svg" alt="Signed and notarized"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-000.svg" alt="License: MIT"></a>
  <a href="#download"><img src="https://img.shields.io/badge/platform-macOS-000.svg" alt="Platform: macOS"></a>
</p>

<p align="center">
  <img src=".github/assets/hero.png" alt="Shirei — a keyboard-first terminal cockpit for AI coding sessions on macOS" width="100%">
</p>

## What is Shirei?

Shirei is the inverse of an IDE. Where editors keep your files at the center and
bolt AI on the side, Shirei puts the **AI CLI session at the center** and keeps the
editor, files, and search as satellites — instruments arranged around the session so
you never have to leave it.

It's built for long sessions with CLIs like Claude Code: see, open, edit, search, and
review everything the session produces, all without touching the mouse. The friction
in a long session is never the model — it's switching to an editor, hunting for a file,
losing the thread. Shirei keeps you in the cockpit, with everything you need to act on
the session's output one keystroke away.

> It's not an editor with a terminal. It's a terminal where the editor exists only to
> keep the session flowing.

Shirei does **not** embed its own AI — it's the optimal environment to *run* external AI
CLIs. **Bring your own CLI:** Shirei never sees, stores, or proxies your API keys. Each
CLI signs in with your own account, so there are no keys to hand over, nothing billed
through Shirei, and no lock-in.

## Features

#### The session at the center

- **Keyboard-first.** Every frequent action has a shortcut, following the conventions
  you already know from your terminal and editor. No mouse required.
- **Per-project layouts.** Each project recreates its layout — panels plus the programs
  they run — on launch. Edit them from Settings.
- **Session snapshots.** On reopen, every pane returns to its folder and, by your
  preference, relaunches what it was running (all / templates only / none).
- **The window survives close.** Closing hides it; it returns from the dock with the
  session intact.

#### Tabs and panels

- **Renameable, color-coded tabs.** Double-click to rename, click the dot (or
  right-click) to color. Name and color survive restarts, so you know which project
  you're in at a glance.
- **Splittable panels.** Split right or down, move between panes, zoom into one.

#### Files and navigation

- **File tree (`Cmd+B`).** The active terminal's directory, with type icons, fully
  keyboard-navigable.
- **Open files in tabs.** The editor (below), an image viewer, and a video/audio
  player. File tabs reopen on restart.
- **Command palette (`Cmd+P`).** Launch a project or jump to a file in the active
  directory, without cluttering the screen with pinned tabs.

#### The editor, for specs and review &nbsp;<sub>· new in this release</sub>

- **Palette-derived theming.** Syntax colors are built from your terminal palette and
  contrast-clamped (APCA), so code stays legible on pure black or any theme — no
  separate editor theme to keep in sync.
- **Markdown live preview.** Headings, callouts, checkboxes, code blocks, tables and
  more render inline as you write, with raw syntax revealed on the cursor's line — built
  for writing the specs a session will act on.
- **Code craft.** Find and replace (`Cmd+F`) with match counts and case/regex/whole-word
  toggles, code folding, indentation guides, and a readable measure for prose.
- **Broad language support**, with first-class Astro (frontmatter, template, expressions).

#### Git, where the console falls short &nbsp;<sub>· new in this release</sub>

The session runs git in the console; the editor adds the views a console does poorly, so
you read changes without leaving the cockpit. No commit GUI — diffs, conflicts, history,
and blame.

- **Inline diff against HEAD (`Cmd+Alt+D`).** Your uncommitted changes in place, with a
  `+`/`−` gutter and per-hunk revert.
- **Graphical conflict resolution.** Merge conflicts render as blocks — current, base,
  incoming — with one-key accept, a compare view, and highlighting that survives the
  conflict markers.
- **File history (`Cmd+Shift+H`).** A keyboard-first overlay of every commit that touched
  the file, each shown as the change it introduced or against your working copy.
- **Inline blame (`Cmd+Shift+B`).** Per-line authorship, folded by commit, with a hover
  card. Off by default.

#### Built for the long haul

- **Impeccable rendering.** xterm.js on a WebGL renderer, so box-drawing, tool-call
  trees, and full-screen TUIs render exactly right. Pure-black theme by default.
- **Built-in screen recording (`Ctrl+Cmd+R`).** Capture a pane, the app window, or a
  selected region to MP4 or GIF — keyboard-triggered, with a live indicator.
- **Customizable to the core.** Fonts, theme, colors, shortcuts, limits, and projects
  all bend to how you work, editable from Settings (`Cmd+,`) — tune the cockpit until it
  fits you, not the other way around.

## Keyboard shortcuts

| Tabs and panes | |
| --- | --- |
| New tab | `Cmd+T` |
| Close pane (or tab) | `Cmd+W` |
| Jump to tab | `Cmd+1–9` |
| Cycle tabs | `Cmd+←` / `Cmd+→` |
| Font size | `Cmd +` / `Cmd -` / `Cmd 0` |
| Split right / down | `Cmd+D` / `Cmd+Shift+D` |
| Move between panes | `Cmd+Shift+←/→/↑/↓` |
| Zoom pane | `Cmd+Shift+Enter` |
| Save project layout | `Cmd+Shift+G` |
| Save session as template | `Cmd+Shift+L` |

| Files and more | |
| --- | --- |
| File tree | `Cmd+B` |
| Refresh tree | `Cmd+R` |
| Command palette | `Cmd+P` |
| Save file | `Cmd+S` |
| Record screen | `Ctrl+Cmd+R` |
| Settings | `Cmd+,` |

| Editor and git | |
| --- | --- |
| Find / replace | `Cmd+F` |
| Inline diff vs HEAD | `Cmd+Alt+D` |
| File history | `Cmd+Shift+H` |
| Toggle blame | `Cmd+Shift+B` |

## Download

**[→ Download the latest release](https://github.com/zeroblack/shirei/releases/latest)** —
a signed and notarized `.dmg`. Requires macOS 12.3 or later on Apple Silicon.

Open the `.dmg`, drag Shirei to your Applications folder, and launch it. No Gatekeeper
warnings, nothing to allow by hand.

## Build from source

**Prerequisites:** macOS, [Rust](https://rustup.rs), [pnpm](https://pnpm.io), and the
Xcode command line tools (`xcode-select --install`).

```bash
pnpm install
pnpm tauri dev      # run the app
pnpm tauri build    # produce a release bundle
```

## Stack

Tauri 2 · Rust · TypeScript + Vite · xterm.js (WebGL) · CodeMirror. The system WebView —
no bundled Chromium.

## Scope

A personal tool, macOS-only. A terminal with panels, projects, a file explorer and an
editor, built to host external AI CLIs. No LSP, debugger, extension marketplace, SSH, or
built-in AI. Git stays in the console; the editor only adds the visual layer a console
does poorly (diffs, conflict resolution, history, blame), not a commit GUI. The editor
exists to read, review, and shape what the session produces, not to write features by hand.

## Sponsor

Shirei is free and open source. If it helps you and you'd like to see it grow, you can
sponsor it on [GitHub Sponsors](https://github.com/sponsors/zeroblack).

## License

MIT — built by [Dioni](https://dioni.dev/).
