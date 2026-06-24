# Shirei

**CLI-first cockpit for AI coding** — the workflow of using AI CLIs (Claude Code) at its fullest. Keyboard-first terminal on Tauri 2 + Rust + xterm.js + TS, macOS-only. For personal use and CLI-native developers.

## Product — north star and scope

The AI CLI session is the center; the editor, the files, and search are satellites that exist so you never leave it. **It's not an editor with a terminal — it's a terminal where the editor exists only so it doesn't break the flow of the session.**

- **What it is:** the inverse of an IDE. VS Code/Cursor are editor-first (files at the center, AI grafted on); Shirei is CLI-first. They aren't rivals: they're opposite categories.
- **Thesis:** sustain long sessions with Claude without leaving the window or touching the mouse — see, open, edit, search, and review everything the session produces inside Shirei.
- **Shirei ships no AI of its own** — it's the optimal environment to run external AI CLIs. The tab identity (persistent name/color) is support for telling projects apart, not the main course.

**Pillars (cathedral).** Shipped: per-project layouts · command palette (`Cmd+P`). Roadmap, not built yet: output→file loop · "what Claude touched" panel · cross-session output search.

**Master pillar / next up:** *output→file loop* — from a `file:line` in Claude's output you jump to the editor (with diff) and back to the session, pure keyboard. Not built yet; everything else hangs off it.

**The fence (what is NOT built, so it doesn't degenerate into an IDE):** no LSP/IntelliSense, debugger, extension marketplace, git GUI, test-runner UI, SSH, or profiles. The editor serves to read and touch what the AI produces, not to write features by hand. (Splits/panes and per-project layouts did ship: they're support for the CLI session, not an IDE.)

**Notifications / "which session is waiting for you":** outside the core — Claude Code's native hooks (`Notification`/`Stop`) solve it trivially when wanted; it's retention, not core.

## High-impact rules

- **Keyboard-first.** Every frequent action needs its shortcut, following standard terminal/editor conventions (`Cmd+T`/`Cmd+W` tabs, `Cmd+1-9` jump, `Cmd+←/→` cycle, `Cmd +/-/0` font). A feature isn't complete without a shortcut.
- **Nothing hardcoded — everything via config/setup.** Fonts, colors, shortcuts, paths, limits, themes, etc. are configurable and persistable, not embedded in the code. Before hardcoding any value, ask: hardcode it or make it configurable? By default, configurable.
- **Impeccable terminal render.** Rendering is part of the product. xterm.js with the **WebGL** renderer and automatic fallback to DOM. The DOM renderer clips box-drawing and breaks Claude's UI (prompt box, tool-call tree, progress bars) — that's why WebGL is the default. Glyphs, contrast, cursor, line height, scrollback, smoothing, and padding live in `config.render`, configurable and persistable. The default theme is **Pure black** (#000/#fff) by the user's choice; there's also a theme catalog (`src/settings/themes.ts`: Tokyo Night, Catppuccin Mocha/Latte, Dracula, Nord, Gruvbox, One Dark, Rosé Pine, Kanagawa, and the in-house neon **Japan Night**) that on selection applies `theme.preset` + `theme.terminal` and **tints the chrome** by deriving it from the palette (`src/colors.ts` + `applyChrome` in `app.ts`).
- **Premium UI, bounded screens.** The UI uses the **Geist** typeface (self-hosted OFL in `src/assets/fonts`, `--font-ui` + semantic `--type-*` tokens in `tokens.css`). No Settings screen should grow infinitely downward: it's bounded with per-category sub-tabs and/or a 2-column grid (`.section-fields`, with a center divider), and the content panel is fixed-height with internal scroll. Hierarchical order, grouping by function, a single accent per screen. Premium through restraint + consistency, no AI footprint (no em-dash, no generic copy).
- **Per-surface focus model.** The active surface (terminal/tree/TODO) is exposed in `#main[data-focus]` (derived from real DOM focus): the active one highlights and the rest dim. Dedicated shortcuts: tree `⌘E` (`tree.focus`), TODO `⌘J` (`todo.focus`). Configurable via `config.chrome` (dim inactive ones, active pane accent, color bar under the tabs, active tab highlight) — opt-out with `no-*` classes on the root.
- **pnpm always.** Never npm/yarn.
- **TS strict**, lint/format with **Biome** (`pnpm lint`).
- **Zero unnecessary comments**; only a non-derivable *why*.
- **Code in English** — identifiers, comments, and technical strings (logs, internal errors). The repo is open source; user-facing UI strings go through the i18n layer (English default, Spanish available).
- **No dead code.** English in docs/commits. No AI footprint.
- **Never commit/push without explicit permission.**

## Commands

- `pnpm tauri dev` — development (opens the window).
- `pnpm build` — compiles the frontend (tsc + vite).
- `pnpm lint` — Biome.

## Architecture

Three layers:

- **`src/` frontend** — `terminal.ts` = xterm session + WebGL/unicode11 render, `tabbar.ts`, `app.ts`, `store.ts`. `panetree.ts`/`panegrid.ts` = pane tree and grid; layout templates + `config.layout.default_template` decide what each tab is born with (falls back to a plain terminal if the template asks for a missing command). `tokens.css` = design scales (typography/spacing/color) the rest is built on. Cross-cutting helpers: `overlay.ts` (dialogs: role, focus-trap, dismiss), `drag.ts` (drag with per-frame coalescing), `errors.ts` (reads the backend's error discriminant), `colors.ts` (color mix/alpha to tint the chrome from the theme). **Settings** (`settings/`): screens registered in `registry.ts` (sidebar order + groups), each one in `section-*.ts` built with `widgets.ts` (`section`/`field`/`groupLabel`/`boolField`/`colorField`…; `section()` wraps the fields in the 2-column `.section-fields` grid); `themes.ts` = palette catalog; `shell.ts` mounts sidebar + content with global search.
- **`src-tauri/src/` Tauri layer** — IPC commands, `config.rs`, `error.rs` (enum that serializes `{ code, message }`). Delegates PTY management to the shared crate. Multi-window app: the main one is `main` and new ones are `win-N`; **every window must be in a capability** under `capabilities/` (the `win-*` glob covers runtime ones) or it starts blank from denied permissions.
- **`mux/` crate `shirei-mux`** — PTY logic, persistent-session daemon socket, process inspection, and locks; lives once here and the app consumes it (don't duplicate PTY across crates).

Mirrored Rust↔TS config (`config.rs` ↔ `config.ts`), nothing hardcoded.

> Full conventions: see `CONVENTIONS.md`.
