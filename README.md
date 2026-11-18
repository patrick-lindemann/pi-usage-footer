# pi-usage-footer

A [pi](https://github.com/earendil-works/pi-coding-agent) footer extension that shows
subscription usage next to the model name — the 5-hour, weekly and monthly quota
windows of coding-plan subscriptions, with reset countdowns and warning colors.

## Supported providers

| Provider | pi provider ids | Windows | Source |
| --- | --- | --- | --- |
| OpenAI Codex | `openai-codex`, `openai-codex-<n>` | 5-hour, weekly | `chatgpt.com/backend-api/wham/usage` |
| Claude Code | `claude-code` | 5-hour, weekly | `api.anthropic.com/api/oauth/usage` |
| Anthropic (pi OAuth) | `anthropic` | 5-hour, weekly | `api.anthropic.com/api/oauth/usage` |
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
such as `pi-token-speed` appears after usage, or on a separate line if it does
not fit. Extensions that replace the entire footer cannot share this layout.

The `/usage-footer` command forces a refresh and shows every window the active
provider reports, including ones not selected for the footer.

## Configuration

Create `~/.pi/agent/usage-footer.json` to override the defaults:

```json
{
  "windows": ["fiveHour"],
  "windowOverrides": {
    "opencode": ["fiveHour", "weekly", "monthly"],
    "copilot": ["monthly"]
  },
  "format": "{percent}%/{label} ↺{reset}",
  "endpoints": {
    "my-provider": "https://quota.example.com/usage"
  }
}
```

### `windows`

Which windows to display, in this order: `"fiveHour"`, `"weekly"`, `"monthly"`.
Each provider shows whichever of the selected windows it actually reports, so
`"monthly"` is silently skipped on providers without a monthly quota. An empty
list hides the usage. Default: `["fiveHour"]`.

### `windowOverrides`

Per-provider window lists used instead of the global `windows`. Use the IDs in
[`src/config/defaults.ts`](src/config/defaults.ts), an ID with its own endpoint
override, or a custom provider ID. Default: none.

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

Colors are automatic: dim below 80% used, warning from 80%, error from 90%.

### `endpoints`

Set a provider ID to one HTTPS URL or an ordered list of fallback URLs. Exact
IDs take precedence over family IDs. Built-in providers keep their existing
response format and authentication. Missing or invalid URL entries use the
[bundled defaults](src/config/defaults.ts), when available.

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

For the first publish, set the GitHub Actions secret `NPM_TOKEN` to a granular npm token with publish access and 2FA bypass. Once the package exists, configure an npm trusted publisher for `patrick-lindemann/pi-usage-footer` and `release.yml`, allow `npm publish`, and remove the secret.

## Caveats

All usage endpoints except `copilot_internal/user` are undocumented; expect
occasional shape drift. The extension is read-only: it never writes
credentials and never triggers OAuth refreshes — Kimi Code and Gemini-style
short-lived CLI tokens therefore go stale until the owning CLI renews them.
