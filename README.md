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
- **Open files in tabs.** A light editor (CodeMirror — syntax highlighting, save with
  `Cmd+S`, a readable line width for prose), an image viewer, and a video/audio player.
  File tabs reopen on restart.
- **Command palette (`Cmd+P`).** Launch a project or jump to a file in the active
  directory, without cluttering the screen with pinned tabs.

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

<details>
<summary>Distribution (signed + notarized)</summary>

<br>

For a `.dmg` that opens on any Mac without Gatekeeper warnings, the bundle must be
notarized with Apple. Copy `.env.release.example` to `.env.release`, fill in your App
Store Connect API key credentials, and run:

```bash
pnpm release
```

The script validates the credentials and delegates to `pnpm tauri build`, which signs
with your Developer ID, notarizes, and staples the ticket to the bundle. `.env.release`
is gitignored and the `.p8` stays outside the repo.

</details>

## Stack

Tauri 2 · Rust · TypeScript + Vite · xterm.js (WebGL) · CodeMirror. The system WebView —
no bundled Chromium.

## Scope

A personal tool, macOS-only. A terminal with panels, projects, a file explorer and a
light editor, built to host external AI CLIs. No LSP, debugger, extension marketplace,
git GUI, SSH, or built-in AI. The editor exists to read and touch what the session
produces, not to write features by hand.

## Sponsor

Shirei is free and open source. If it helps you and you'd like to see it grow, you can
sponsor it on [GitHub Sponsors](https://github.com/sponsors/zeroblack).

## License

MIT — built by [Dioni](https://dioni.dev/).
