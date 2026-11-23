# pi-usage-footer

A [pi](https://github.com/earendil-works/pi-coding-agent) footer extension that shows
subscription usage next to the model name — the 5-hour, weekly and monthly quota
windows of coding-plan subscriptions, with reset countdowns and warning colors.

## Supported providers

| Provider | pi provider ids | Windows | Source |
| --- | --- | --- | --- |
| OpenAI Codex | `openai-codex`, `openai-codex-<n>` | 5-hour, weekly | `chatgpt.com/backend-api/wham/usage` |
| Claude Code / Anthropic | `claude-code`, `anthropic` | 5-hour, weekly | `api.anthropic.com/api/oauth/usage` |
| OpenCode Go | `opencode`, `opencode-go` | rolling 5-hour, weekly, monthly | `opencode.ai/zen/go/v1/usage` |
| GLM Coding Plan | `zai*`, `glm*` | 5-hour, weekly, monthly (MCP) | `api.z.ai` / `open.bigmodel.cn` `api/monitor/usage/quota/limit` |
| Kimi Code | `kimi*` | 5-hour, weekly, monthly | `api.kimi.com/coding/v1/usages` |
| GitHub Copilot | `copilot`, `github-copilot`, `copilot-*` | monthly | `api.github.com/copilot_internal/user` |

Credentials are read through pi's model registry (`getApiKeyAndHeaders`), so the
extension works with whatever auth the provider already has configured — API keys
as well as headers-only OAuth bearer tokens. The `anthropic` provider uses the
Claude Pro/Max OAuth login from pi's `/login`; the `claude-code` provider reads
the credentials your Claude Code login stored (macOS Keychain or
`~/.claude/.credentials.json`).

A failed or unparseable fetch keeps the last good snapshot, so a transient
endpoint error or an undocumented API change never blanks the footer.

## Install

```bash
pi install npm:@patrick-lindemann/pi-usage-footer
```

To install a specific release from GitHub:

```bash
pi install git:github.com/patrick-lindemann/pi-usage-footer@v0.1.0
```

## Usage

Usage appears after the model and thinking level. Status text from extensions
such as `pi-token-speed` appears before usage, or on a separate line if it does
not fit. Extensions that replace the entire footer cannot share this layout.

The `/usage-footer` command forces a refresh and shows every window the active
provider reports, including ones not selected for the footer.

## Configuration

Create `~/.pi/agent/usage-footer.json` to override the defaults:

```json
{
  "windows": ["fiveHour"],
  "format": "{percent}%/{label} ↺{reset}",
  "quotaColors": {
    "normal": "lightgray",
    "warning": { "at": 75, "color": "warning" },
    "critical": { "at": 95, "color": "#ff5555" }
  },
  "providers": {
    "opencode": { "windows": ["fiveHour", "weekly", "monthly"] },
    "copilot": { "windows": ["monthly"], "format": "{remaining}% left", "quotaColors": false },
    "my-provider": { "endpoints": "https://quota.example.com/usage" }
  }
}
```

### `refreshIntervalSeconds`

Seconds between periodic quota refreshes. The default is `60`. Set it to `0`
to stop polling. Startup, model changes, completed runs, and `/usage-footer`
still refresh usage.

### `statusPlacement`

Controls where other extensions’ status text appears. `"auto"` (default) puts it
beside the model when it fits and on a separate row otherwise. `"inline"` keeps
it on the model row and clips overflow. `"separate"` always uses a separate row
when status text is present.

### `windows`

Which windows to display, in this order: `"fiveHour"`, `"weekly"`, `"monthly"`.
Each provider shows whichever of the selected windows it actually reports, so
`"monthly"` is silently skipped on providers without a monthly quota. An empty
list hides the usage. Default: `["fiveHour"]`.

### `format`

A template rendered once per displayed window:

| Placeholder | Expands to | Example |
| --- | --- | --- |
| `{percent}` | used percent, rounded | `42` |
| `{remaining}` | 100 minus used percent | `58` |
| `{label}` | window label: `5h`, `W`, `M` | `5h` |
| `{reset}` | time until reset: `1h12m`, `3d4h` | `1h12m` |

When the reset time is unknown, `{reset}` together with any decoration directly
before it (like `↺`) is removed. Default: `"{percent}%/{label} ↺{reset}"`.

### `quotaColors`

By default, quota text uses `dim` below 80% used, `warning` from 80%, and
`error` from 90%. Set `quotaColors` to `false` for plain quota text. Use Pi theme
names, CSS color names such as `lightgray`, or hex values such as `#ff5555`.
Set `warning.at` and `critical.at` to change the thresholds. They use the
rounded used percentage, and `critical` takes priority.

### `providers`

Each provider can override `windows`, `format`, and `quotaColors`. Fields inherit
independently: exact Pi provider ID, then family ID, then root settings, then
bundled defaults. A color object re-enables colors after `false`, starting from
the bundled palette. Use the [bundled endpoint IDs](src/config/defaults.ts) for
family overrides.

Set `endpoints` inside a provider to one HTTPS URL or an ordered list of fallback
URLs. If neither the exact nor the family override has a valid URL, built-in
providers use their bundled endpoints. Built-in providers keep their response
format and authentication.

To add a provider, use its exact Pi provider ID and point it at an endpoint that
returns quota windows in this format:

```json
{"fiveHour": {"usedPercent": 42, "resetAt": 1900000000000}}
```

Use `fiveHour`, `weekly`, or `monthly`. `usedPercent` must be between 0 and 100.
`resetAt` is optional and uses Unix milliseconds. If the provider returns a
different JSON format, use an adapter endpoint that converts it to this format.

Pi must already have credentials for the model. The extension sends the
provider credential as a bearer token, so configure only URLs you trust.
Requests do not follow redirects. Run `/reload` after changing the config.

## Releases

Raise the version in `package.json` and update `package-lock.json` before merging a release PR into `main`. GitHub Actions checks the code and tests, publishes to npm, then creates the matching GitHub release and tag. It skips versions that already have a GitHub release.

## Caveats

All usage endpoints except `copilot_internal/user` are undocumented; expect
occasional shape drift. The extension is read-only: it never writes
credentials and never triggers OAuth refreshes — Kimi Code and Gemini-style
short-lived CLI tokens therefore go stale until the owning CLI renews them.
