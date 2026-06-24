---
last-verified: 2026-06-22
stack: Tauri 2 + Rust + TypeScript (Vite, vanilla) + xterm.js
versions:
  tauri: "2"
  rust: "1.95"
  node: "22"
  vite: "6"
  typescript: "5.6"
  xterm: "6"
  xterm-addons: addon-fit 0.11, addon-webgl 0.19, addon-unicode11 0.9
docs:
  tauri: https://v2.tauri.app/
  xterm: https://xtermjs.org/docs/
  portable-pty: https://docs.rs/portable-pty/
---

# Conventions — Shirei

Project rules. Code must read like professional human work, indistinguishable from a senior developer.

## General

- **Package manager: pnpm always.** Never npm or yarn.
- **Zero unnecessary comments.** No section comments, banners, or comments that restate the name of the thing. Only comment a non-derivable *why* (hidden invariant, specific workaround). Code reads on its own: descriptive names do the work.
- **DRY without over-engineering.** A pattern in 2+ places → shared helper/module. A single instance → inline, don't invent an abstraction.
- **No dead code.** Whatever is replaced gets deleted; backups live in a git branch.
- **Code language: English.** Identifiers, comments, and technical strings (logs, internal error messages) in English. User-facing UI strings go through the i18n layer (English default, Spanish available), never hardcoded. No AI footprint in code, commits, or files.

## TypeScript / Frontend

- **TS strict** always (don't relax `tsconfig`).
- **Lint/format: Biome**, a single tool. `pnpm lint` before commit.
- Imports with alias or short relative paths; no `../../../`.
- Direct DOM, no framework. Each frontend module has a single purpose:
  - `terminal.ts` = one xterm session ↔ its PTY. **WebGL** renderer (`@xterm/addon-webgl`) with fallback to DOM on context loss and (debounced) recreation on DPR change; `@xterm/addon-unicode11` (`unicode.activeVersion = "11"`) for correct widths. Render options come from `config.render`, never hardcoded.
  - `tabbar.ts` = tab bar render and interaction.
  - `app.ts` = orchestration and state; applies `config` live and the padding/smoothing CSS. Tab mutations (create/open/close) are serialized through a queue so their `await`s don't interleave.
  - `store.ts` = persistence (per-window session: the `localStorage` key includes the label, so each `win-N` restores its own).
  - `panetree.ts` / `panegrid.ts` = pane tree (ratio splits) and its grid. **Layout templates** (`LayoutTemplate`) and per-project layouts are instantiated with `instantiate()`. A new tab is born with `config.layout.default_template` (empty = plain terminal); if the template declares a command that isn't installed, it falls back to a plain terminal (`resolveDefaultTemplate`). Command availability is checked with `binary_on_path` (resolves via `$SHELL -ilc`, seeing the pane's real PATH).
- **Cross-cutting helpers** (DRY): `overlay.ts` (dialog scaffold: ARIA role, focus-trap, dismiss on Escape/click-outside), `drag.ts` (`attachDrag` with per-frame coalescing), `errors.ts` (reads the backend's stable error discriminant), `settings/widgets.ts` (config-bound controls: `boolField`/`numField`/`selectField`/`colorField`/`swatchRow`). Before writing a dialog, a drag, or a settings control by hand, use these.
- Low-level logic (PTY, ANSI parsing, rendering) is provided by `xterm.js` and `portable-pty`; do not reimplement.
- **Styles over tokens.** `src/tokens.css` defines the design scales (typography, spacing, surface/text/accent colors); `styles.css` and `settings.css` build on those variables. Each entry (`main.ts`, `settings.ts`) imports `tokens.css`. Chrome colors are also injected as CSS vars from `app.ts` (`applyChrome`).

### Render and fonts

- **WebGL renderer by default.** xterm's DOM renderer clips box-drawing and block-elements between cells (breaks the prompt box, the tool-call tree, and Claude Code's bars). WebGL draws them continuous. If WebGL fails or loses context, it falls back to DOM alone.
- **Quality options** (mirroring VS Code): `customGlyphs`, `rescaleOverlappingGlyphs`, `drawBoldTextInBrightColors`, `minimumContrastRatio` (4.5 default). `minimumContrastRatio` does not touch the chosen pure black/white, it only lifts faint ANSI colors.
- **Bundled Nerd fonts** in `src/assets/fonts/` (Meslo, JetBrains Mono, Hack). Non-obvious fact: only **Meslo** ships the Dingbats block (✻ ✳ ✶ ✽… used by Claude Code's spinner/mark); JetBrains and Hack don't. That's why `FONT_STACK` puts **Menlo** before SF Mono (Menlo does have them) to rescue the glyph without breaking the grid, and **Meslo is the default**.
- **Mirrored Rust↔TS config:** every config block lives in `src-tauri/src/config.rs` (each field with `#[serde(default)]` for backward compatibility) and its interface in `src/config.ts`. Adding a field means touching both and, if adjustable, its control in the matching `src/settings/` section. Names in `snake_case`. **Nothing hardcoded:** limits (font, sidebar), intervals (snapshot, refresh), sizes (WebGL pool cap), and policies (`restore_commands`) come from config, not from constants in the code.

## Rust / Tauri

- **Shared crate `shirei-mux` (`mux/`).** PTY, socket, process inspection, and lock logic live there once; the app (`src-tauri`) consumes it — do not duplicate PTY management across crates. Key helpers: `paths::socket_path`, `shell::open_login_shell`, `proc::snapshot_of`, `lock::MutexExt`.
- Shared state via `tauri::State` with `Mutex`, taken with `lock_ignore_poison()` (recovers from poison instead of tearing down the process). Never `unwrap()`/`expect()` on recoverable errors — commands return `Result<_, Error>`.
- **Errors with a stable discriminant:** the `Error` enum (`error.rs`) serializes `{ code, message }`. The frontend branches on `code` (via `errors.ts`), never on the message text (which can be rewritten or translated).
- Commands with single-word parameter names (`id`, `cols`, `data`) to avoid JS↔Rust casing friction.
- **Per-window permissions** in `capabilities/`: `default.json` covers `main` **and runtime-opened windows** (`open_window` → labels `win-1`, `win-2`…; that's why it lists the `"win-*"` glob); `settings.json` and `hud.json` are scoped capabilities for those windows. Gotcha: a window in no capability starts **blank** — Tauri denies it `event.listen` and its listeners blow up with `unhandled rejection`. When adding a new window type, add its label (or glob) to the matching capability.
- **`shirei-mux` daemon:** framing (postcard) bounds frame size (anti-OOM), the socket is versioned per protocol and validates the peer-uid, per-client queues are bounded (slow-client drop), and children are reaped (kill+wait). Disk writes are atomic (tmp+rename) and with `0600`/`0700` permissions.
- `cargo fmt` and `cargo clippy` clean.

### macOS signing

- **Dev:** macOS ties TCC permissions (screen recording, etc.) to the signature's *designated requirement*. The debug binary is ad-hoc signed (its DR is the cdhash, which changes on every build), so the permission is re-prompted in a loop. A *cargo runner* (`.cargo/config.toml` → `sign-and-run.sh`) signs the binary on every `tauri dev` with an Apple identity, giving it a stable DR (team + identifier) that persists across rebuilds. Export your identity in `SHIREI_DEV_IDENTITY` (`security find-identity -v -p codesigning`); without it the binary runs unsigned (CI/tests/contributors unaffected). After setting it up: `tccutil reset ScreenCapture dev.dioni.shirei` and grant the permission once.
- **Build:** `bundle.macOS.signingIdentity` (`Developer ID Application`, not `Apple Distribution`) + `bundle.macOS.entitlements` (`Entitlements.plist`: hardened runtime for WebKit/WRY, no sandbox). `NSScreenCaptureUsageDescription` goes in `Info.plist` (auto-merged in dev and build). ScreenCaptureKit uses no entitlement, it's pure TCC. Notarization runs by itself on `tauri build` if the env vars `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH` are present (credentials outside the repo).

## Migrations / data

- Not applicable today (local persistence in `localStorage`). If structured storage is added, version the schema.

## Git

- GitHub Flow: `main` always deployable, short-lived branches, Conventional Commits in English.
- Never commit or push without explicit permission.
