#!/usr/bin/env bash
# Builds the signed + notarized macOS release. Tauri notarizes automatically
# once it sees the App Store Connect API credentials alongside the Developer ID
# identity from tauri.conf.json. Credentials live in an untracked .env.release
# (never committed); see .env.release.example for the template.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

env_file="$root/.env.release"
if [[ -f "$env_file" ]]; then
  set -a
  source "$env_file"
  set +a
fi

missing=()
for var in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} )); then
  echo "release: missing notarization credentials: ${missing[*]}" >&2
  echo "release: copy .env.release.example to .env.release and fill it in (or export the vars)." >&2
  exit 1
fi

key_path="${APPLE_API_KEY_PATH/#\~/$HOME}"
if [[ ! -f "$key_path" ]]; then
  echo "release: APPLE_API_KEY_PATH points to a missing file: $key_path" >&2
  exit 1
fi
export APPLE_API_KEY_PATH="$key_path"

exec pnpm tauri build "$@"
