#!/usr/bin/env bash
# Stabilises the dev binary's code-signing identity so macOS TCC (screen
# recording and other privacy grants) survives rebuilds instead of re-prompting
# every time the ad-hoc cdhash changes. Dev only — Tauri does not sign in
# `tauri dev`, and the release bundle is signed by the Tauri bundler.
#
# Cargo invokes this as the target runner with the freshly built binary as $1.
# Set SHIREI_DEV_IDENTITY to a codesigning identity listed by
#   security find-identity -v -p codesigning
# (your "Apple Development" or "Developer ID Application" cert). When it is
# unset the binary runs unsigned, so CI, `cargo test` and contributors without a
# certificate are unaffected.
set -euo pipefail

bin="$1"
shift

if [[ -n "${SHIREI_DEV_IDENTITY:-}" ]]; then
  # Match the production bundle id so TCC keys on a consistent identity across
  # dev and release.
  identifier="$(/usr/bin/plutil -extract identifier raw -o - tauri.conf.json 2>/dev/null || true)"
  args=(--force --sign "$SHIREI_DEV_IDENTITY")
  [[ -n "$identifier" ]] && args+=(--identifier "$identifier")
  codesign "${args[@]}" "$bin" >/dev/null 2>&1 ||
    echo "sign-and-run: codesign failed; recording permission may re-prompt" >&2
fi

exec "$bin" "$@"
