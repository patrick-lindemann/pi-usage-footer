# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `anthropic` provider as a second Claude source: usage for Claude Pro/Max
  plans signed in through pi's `/login`, next to the existing `claude-code`
  credentials path.

## [1.0.0] - 2026-11-18

### Added

- Subscription usage in the pi footer with the 5-hour, weekly and monthly
  quota windows and reset countdowns.
- Providers: OpenAI Codex, Claude Code, OpenCode Go, GLM Coding Plan, Kimi Code
  and GitHub Copilot, matched by pi provider id.
- A failed or unparseable fetch keeps the last good snapshot, so transient
  endpoint errors never blank the footer.
- Configurable window selection: a global `windows` list with per-provider
  `windowOverrides`, filtered by what each provider reports.
- Configurable formatting via the `format` template with `{percent}`,
  `{remaining}`, `{label}` and `{reset}` placeholders.
- `/usage-footer` command to force a refresh and show every reported window.

[Unreleased]: https://github.com/patrick-lindemann/pi-usage-footer/compare/v1.0.0...develop
[1.0.0]: https://github.com/patrick-lindemann/pi-usage-footer/releases/tag/v1.0.0
