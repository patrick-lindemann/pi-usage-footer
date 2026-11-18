/*
 * Quota endpoints used when the user does not override a provider.
 */

export const bundledEndpoints: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "openai-codex": ["https://chatgpt.com/backend-api/wham/usage"],
  "claude-code": ["https://api.anthropic.com/api/oauth/usage"],
  anthropic: ["https://api.anthropic.com/api/oauth/usage"],
  opencode: ["https://opencode.ai/zen/go/v1/usage"],
  zai: ["https://api.z.ai/api/monitor/usage/quota/limit", "https://open.bigmodel.cn/api/monitor/usage/quota/limit"],
  kimi: ["https://api.kimi.com/coding/v1/usages"],
  copilot: ["https://api.github.com/copilot_internal/user"],
});
