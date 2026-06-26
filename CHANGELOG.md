# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zeroblack/shirei/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/zeroblack/shirei/releases/tag/v0.12.0
