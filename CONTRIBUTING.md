# Contributing to Shirei

Thanks for your interest in Shirei. This is a focused, opinionated project, so before you start, please read the **Scope** section — it will save us both time.

## Scope

Shirei is a CLI-first terminal cockpit for AI coding on macOS. It is deliberately **not** an IDE. Before proposing a feature, read the "fence" in the [README](README.md) and [AGENTS.md](AGENTS.md): no LSP/IntelliSense, debugger, extension marketplace, git GUI, test-runner UI, SSH, or profiles. Contributions that pull the project toward an IDE will be declined, no matter how well built.

Good contributions: bug fixes, render quality, keyboard ergonomics, performance, the output→file loop, layouts, search, and anything that keeps you inside the AI CLI session.

## Prerequisites

- macOS (the app is macOS-only)
- Rust stable toolchain
- Node 22+ and [pnpm](https://pnpm.io) (never npm or yarn)

```bash
pnpm install
```

## Development

```bash
pnpm tauri dev    # run the app in development
pnpm build        # compile the frontend (tsc + vite)
pnpm lint         # Biome check
pnpm test         # vitest
```

## Branching and pull requests

We follow GitHub Flow:

1. Branch off `main` with a short-lived branch named `type/short-kebab-desc` (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`).
2. Make focused, atomic commits.
3. Open a pull request. Keep it small and scoped to one concern.
4. CI must be green.
5. PRs are squash-merged; the branch is deleted after merge.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), in English:

```
type(scope): short imperative summary
```

- Imperative mood, lowercase, no trailing period, ≤ 50 characters in the subject.
- The body explains **why**, not how.
- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `ci`.

## Code style

- TypeScript strict; lint and format with Biome (`pnpm lint`).
- Code, comments, and identifiers in English. User-facing UI strings go through the i18n layer, never hardcoded.
- No unnecessary comments — only a non-derivable *why*. See [CONVENTIONS.md](CONVENTIONS.md) for the full standard.

## Pull request checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm build` passes
- [ ] Change is focused on a single concern
- [ ] Description covers what, why, and how to test
- [ ] Respects the project scope (the "fence")
