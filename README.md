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
pi install git:github.com/patrick-lindemann/pi-usage-footer
```

Pin a release tag instead of tracking the default branch:

```bash
pi install git:github.com/patrick-lindemann/pi-usage-footer@v1.0.0
```

## Usage

The usage appears on the right side of the footer, next to the model name. The
`/usage-footer` command forces a refresh and shows every window the active
provider reports, including ones not selected for the footer.

## Configuration

`~/.pi/agent/usage-footer.json` (created and migrated automatically; the legacy
`chatgpt-limit.json` is read once and rewritten to the new location):

```json
{
  "windows": ["fiveHour"],
  "windowOverrides": {
    "opencode": ["fiveHour", "weekly", "monthly"],
    "copilot": ["monthly"]
  },
  "format": "{percent}%/{label} ↺{reset}",
  "footerPosition": "second",
  "standardFooter": {
    "workingDirectory": false,
    "gitBranch": false,
    "sessionName": true,
    "inputTokens": true,
    "outputTokens": true,
    "totalTokens": false,
    "cacheReadTokens": true,
    "cacheWriteTokens": true,
    "cost": false,
    "subscriptionMarker": false,
    "contextUsage": true,
    "provider": false,
    "model": true,
    "thinkingLevel": true
  }
}
```

### `windows`

Which windows to display, in this order: `"fiveHour"`, `"weekly"`, `"monthly"`.
Each provider shows whichever of the selected windows it actually reports, so
`"monthly"` is silently skipped on providers without a monthly quota. An empty
list hides the usage. Default: `["fiveHour"]`.

### `windowOverrides`

Per-provider window lists keyed by `openai-codex`, `claude-code`, `anthropic`,
`opencode`, `zai`, `kimi` or `copilot`, used instead of the global `windows` for
that provider. Default: none.

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

Older configurations using `quotaWindow` (`fiveHour` / `weekly` / `both` /
`hidden`) and `displayMode` are migrated to `windows` and `format` on first load.

## Caveats

All usage endpoints except `copilot_internal/user` are undocumented; expect
occasional shape drift. The extension is read-only: it never writes
credentials and never triggers OAuth refreshes — Kimi Code and Gemini-style
short-lived CLI tokens therefore go stale until the owning CLI renews them.
