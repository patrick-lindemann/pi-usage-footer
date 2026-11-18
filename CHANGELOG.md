# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Footer status text from other extensions appears after subscription usage when space permits.
- Override quota endpoints per provider or add a provider through a normalized JSON endpoint.
- Publish releases to npm as `@patrick-lindemann/pi-usage-footer`.

### Removed

- Unused `footerPosition` and `standardFooter` options, and migration of `chatgpt-limit.json`, `quotaWindow` and `displayMode`.

## [0.1.0] - 2026-11-18

### Added

- Subscription usage in the pi footer with the 5-hour, weekly and monthly
  quota windows and reset countdowns.
- Providers: OpenAI Codex, Claude Code, Anthropic (pi `/login` OAuth), OpenCode
  Go, GLM Coding Plan, Kimi Code and GitHub Copilot, matched by pi provider id.
- A failed or unparseable fetch keeps the last good snapshot, so transient
  endpoint errors never blank the footer.
- Configurable window selection: a global `windows` list with per-provider
  `windowOverrides`, filtered by what each provider reports.
- Configurable formatting via the `format` template with `{percent}`,
  `{remaining}`, `{label}` and `{reset}` placeholders.
- `/usage-footer` command to force a refresh and show every reported window.
- Migrates the legacy `chatgpt-limit.json` configuration and the old
  `quotaWindow`/`displayMode` keys automatically.

[Unreleased]: https://github.com/patrick-lindemann/pi-usage-footer/compare/v0.1.0...develop
[0.1.0]: https://github.com/patrick-lindemann/pi-usage-footer/releases/tag/v0.1.0
