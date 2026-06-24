# Security Policy

## Supported versions

Only the latest released version of Shirei receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately through GitHub's [security advisories](https://github.com/zeroblack/shirei/security/advisories/new) (Security tab → "Report a vulnerability"). Include a description, reproduction steps, and the impact you observed.

You can expect an initial response within 7 days. Once a fix is available, we will coordinate disclosure with you.

## Distribution and integrity

Shirei is a macOS desktop app. Official builds are signed with an Apple Developer ID and notarized by Apple, so they pass Gatekeeper without manual steps.

- Only run official notarized releases from the [Releases](https://github.com/zeroblack/shirei/releases) page.
- Never disable Gatekeeper or strip the quarantine attribute to run an unofficial build you did not compile yourself.

## Threat model notes

- **Editor file access.** By design, the editor reads and writes arbitrary paths the user can access — Shirei edits the files the AI session produces. The trust boundary protecting that is the locked-down Content Security Policy (`script-src 'self'`, no remote script) plus terminal output rendered in a canvas, not the DOM. A successful script injection in the webview would therefore reach the local filesystem with the user's privileges; there is no sandbox behind the CSP. Contributions that introduce untrusted HTML sinks should be reviewed with this in mind.
- **Downloaded fonts.** Optional fonts are fetched from the pinned Nerd Fonts release over TLS, verified against a SHA-256 digest pinned in the default config before being written to disk, and the inflate step is size-capped against decompression bombs.
