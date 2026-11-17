import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GLM_USAGE_URLS = ["https://api.z.ai/api/monitor/usage/quota/limit", "https://open.bigmodel.cn/api/monitor/usage/quota/limit"];
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const REFRESH_INTERVAL_MS = 60_000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`;
const CONFIG_PATH = `${AGENT_DIR}/usage-footer.json`;
const LEGACY_CONFIG_PATH = `${AGENT_DIR}/chatgpt-limit.json`;

const WINDOW_KINDS = ["fiveHour", "weekly", "monthly"] as const;
type WindowKind = (typeof WINDOW_KINDS)[number];
const WINDOW_LABELS: Record<WindowKind, string> = { fiveHour: "5h", weekly: "W", monthly: "M" };
const COMMAND_LABELS: Record<WindowKind, string> = { fiveHour: "5-hour", weekly: "Weekly", monthly: "Monthly" };

type Window = { usedPercent: number; resetAt?: number };
type Snapshot = { fetchedAt: number } & Partial<Record<WindowKind, Window>>;

type FooterConfig = {
  windows: WindowKind[];
  windowOverrides: Record<string, WindowKind[]>;
  format: string;
  footerPosition: "first" | "second" | "third";
  standardFooter: {
    workingDirectory: boolean;
    gitBranch: boolean;
    sessionName: boolean;
    inputTokens: boolean;
    outputTokens: boolean;
    totalTokens: boolean;
    cacheReadTokens: boolean;
    cacheWriteTokens: boolean;
    cost: boolean;
    subscriptionMarker: boolean;
    contextUsage: boolean;
    provider: boolean;
    model: boolean;
    thinkingLevel: boolean;
  };
};

type State = {
  config: FooterConfig;
  snapshots: Record<string, Snapshot>;
  requestRender: () => void;
  timer?: ReturnType<typeof setInterval>;
  updating?: Promise<void>;
};

const defaults: FooterConfig = {
  windows: ["fiveHour"],
  windowOverrides: {},
  format: "{percent}%/{label} ↺{reset}",
  footerPosition: "second",
  standardFooter: {
    workingDirectory: false,
    gitBranch: false,
    sessionName: true,
    inputTokens: true,
    outputTokens: true,
    totalTokens: false,
    cacheReadTokens: true,
    cacheWriteTokens: true,
    cost: false,
    subscriptionMarker: false,
    contextUsage: true,
    provider: false,
    model: true,
    thinkingLevel: true,
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function bearerToken(auth: { apiKey?: string; headers?: Record<string, string | null> }): string | undefined {
  if (auth.apiKey) return auth.apiKey;
  const header = auth.headers?.Authorization ?? auth.headers?.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function windowKindsFrom(value: unknown): WindowKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((kind) => (WINDOW_KINDS as readonly string[]).includes(String(kind)) ? (kind as WindowKind) : undefined)
    .filter((kind): kind is WindowKind => kind !== undefined);
}

function windowOverridesFrom(value: unknown): Record<string, WindowKind[]> {
  const source = record(value);
  if (!source) return {};
  const result: Record<string, WindowKind[]> = {};
  for (const [id, kinds] of Object.entries(source)) {
    const windows = windowKindsFrom(kinds);
    if (windows) result[id] = windows;
  }
  return result;
}

function legacyWindows(quotaWindow: unknown): WindowKind[] {
  if (quotaWindow === "weekly") return ["weekly"];
  if (quotaWindow === "both") return ["fiveHour", "weekly"];
  if (quotaWindow === "hidden") return [];
  return ["fiveHour"];
}

function legacyFormat(displayMode: unknown): string {
  return displayMode === "used" || displayMode === "remaining"
    ? "{percent}%/{label}"
    : "{percent}%/{label} ↺{reset}";
}

function configFrom(value: unknown): { config: FooterConfig; migrated: boolean } {
  const source = record(value);
  const standard = record(source?.standardFooter);
  const footerPosition = source?.footerPosition;
  return {
    migrated:
      source?.windows === undefined &&
      (source?.quotaWindow !== undefined || source?.displayMode !== undefined),
    config: {
      windows: windowKindsFrom(source?.windows) ?? legacyWindows(source?.quotaWindow),
      windowOverrides: windowOverridesFrom(source?.windowOverrides),
      format: typeof source?.format === "string" && source.format ? source.format : legacyFormat(source?.displayMode),
      footerPosition: ["first", "second", "third"].includes(String(footerPosition))
        ? (footerPosition as FooterConfig["footerPosition"])
        : defaults.footerPosition,
      standardFooter: Object.fromEntries(
        Object.entries(defaults.standardFooter).map(([key, fallback]) => [
          key,
          typeof standard?.[key] === "boolean" ? standard[key] : fallback,
        ]),
      ) as FooterConfig["standardFooter"],
    },
  };
}

async function loadConfig(): Promise<FooterConfig> {
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      const parsed = configFrom(JSON.parse(await readFile(path, "utf8")));
      if (path === LEGACY_CONFIG_PATH || parsed.migrated) await saveConfig(parsed.config);
      return parsed.config;
    } catch {
      // Try the next source.
    }
  }
  return defaults;
}

async function saveConfig(config: FooterConfig): Promise<void> {
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temporaryPath, CONFIG_PATH);
}

function parseCodexUsage(payload: unknown): Snapshot | undefined {
  const rateLimit = record(record(payload)?.rate_limit);
  const windows = [record(rateLimit?.primary_window), record(rateLimit?.secondary_window)];
  const result: Snapshot = { fetchedAt: Date.now() };
  for (const window of windows) {
    const usedPercent = number(window?.used_percent);
    const seconds = number(window?.limit_window_seconds);
    if (usedPercent === undefined || seconds === undefined) continue;
    const resetAt = number(window?.reset_at);
    const resetAfter = number(window?.reset_after_seconds);
    const normalizedReset = resetAt
      ? (resetAt > 100_000_000_000 ? resetAt : resetAt * 1000)
      : resetAfter !== undefined
        ? Date.now() + resetAfter * 1000
        : undefined;
    if (Math.abs(seconds - 5 * 60 * 60) < 120) result.fiveHour = { usedPercent, resetAt: normalizedReset };
    if (Math.abs(seconds - 7 * 24 * 60 * 60) < 120) result.weekly = { usedPercent, resetAt: normalizedReset };
  }
  return result.fiveHour || result.weekly ? result : undefined;
}

function parseClaudeUsage(payload: unknown): Snapshot | undefined {
  const source = record(payload);
  const result: Snapshot = { fetchedAt: Date.now() };
  const limits = source?.limits;
  if (Array.isArray(limits)) {
    for (const limit of limits) {
      const item = record(limit);
      const usedPercent = number(item?.percent);
      const resetAt = typeof item?.resets_at === "string" ? Date.parse(item.resets_at) : undefined;
      if (usedPercent === undefined) continue;
      if (item?.kind === "session") result.fiveHour = { usedPercent, resetAt };
      if (item?.kind === "weekly_all") result.weekly = { usedPercent, resetAt };
    }
  }
  for (const [key, target] of [["five_hour", "fiveHour"], ["seven_day", "weekly"]] as const) {
    const window = record(source?.[key]);
    const usedPercent = number(window?.utilization);
    if (usedPercent !== undefined) {
      result[target] = {
        usedPercent,
        resetAt: typeof window?.resets_at === "string" ? Date.parse(window.resets_at) : undefined,
      };
    }
  }
  return result.fiveHour || result.weekly ? result : undefined;
}

function parseOpenCodeUsage(payload: unknown): Snapshot | undefined {
  const usage = record(record(payload)?.usage);
  const result: Snapshot = { fetchedAt: Date.now() };
  for (const [key, kind] of [["rolling", "fiveHour"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
    const window = record(usage?.[key]);
    const usedPercent = number(window?.percent);
    if (usedPercent === undefined) continue;
    result[kind] = {
      usedPercent,
      resetAt: typeof window?.resetsAt === "string" ? Date.parse(window.resetsAt) : undefined,
    };
  }
  return result.fiveHour || result.weekly || result.monthly ? result : undefined;
}

function glmWindowKind(item: Record<string, unknown>): WindowKind | undefined {
  const type = typeof item.type === "string" ? item.type : "";
  const unit = number(item.unit);
  const amount = number(item.number);
  const duration = unit === 3 && amount !== undefined
    ? amount * 3_600
    : unit === 6 && amount !== undefined
      ? amount * 86_400
      : undefined;
  if (duration !== undefined) {
    if (Math.abs(duration - 5 * 3_600) < 600) return "fiveHour";
    if (Math.abs(duration - 7 * 86_400) < 3_600) return "weekly";
    if (duration >= 25 * 86_400) return "monthly";
  }
  // Older payloads omit `number`; `unit` alone identifies the window (3 = 5-hour, 6 = weekly).
  if (unit === 3) return "fiveHour";
  if (unit === 6) return "weekly";
  if (type === "TIME_LIMIT") return "monthly";
  if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") return "fiveHour";
  return undefined;
}

function glmPercent(item: Record<string, unknown>): number | undefined {
  const total = count(item.usage);
  const current = count(item.currentValue);
  const remaining = count(item.remaining);
  if (total !== undefined && total > 0) {
    const used = current !== undefined ? current : remaining !== undefined ? total - remaining : undefined;
    if (used !== undefined) return clampPercent((used / total) * 100);
  }
  const percentage = count(item.percentage);
  return percentage !== undefined ? clampPercent(percentage) : undefined;
}

function parseGlmUsage(payload: unknown): Snapshot | undefined {
  const data = record(record(payload)?.data);
  const limits = data?.limits;
  const result: Snapshot = { fetchedAt: Date.now() };
  if (Array.isArray(limits)) {
    for (const limit of limits) {
      const item = record(limit);
      if (!item) continue;
      const usedPercent = glmPercent(item);
      const kind = glmWindowKind(item);
      if (usedPercent === undefined || kind === undefined) continue;
      result[kind] = { usedPercent, resetAt: number(item.nextResetTime) };
    }
  }
  return result.fiveHour || result.weekly || result.monthly ? result : undefined;
}

function parseKimiUsage(payload: unknown): Snapshot | undefined {
  const source = record(payload);
  if (!source) return undefined;
  const result: Snapshot = { fetchedAt: Date.now() };
  const toWindow = (detail: unknown): Window | undefined => {
    const item = record(detail);
    const limit = count(item?.limit);
    const used = count(item?.used);
    if (limit === undefined || limit <= 0 || used === undefined) return undefined;
    return {
      usedPercent: clampPercent((used / limit) * 100),
      resetAt: typeof item?.resetTime === "string" ? Date.parse(item.resetTime) : undefined,
    };
  };
  const durationMinutes = (window: unknown): number | undefined => {
    const item = record(window);
    const duration = count(item?.duration);
    if (duration === undefined || duration <= 0) return undefined;
    if (item?.timeUnit === "TIME_UNIT_MINUTE") return duration;
    if (item?.timeUnit === "TIME_UNIT_HOUR") return duration * 60;
    if (item?.timeUnit === "TIME_UNIT_DAY") return duration * 24 * 60;
    return undefined;
  };
  const toRatioWindow = (detail: unknown): Window | undefined => {
    const item = record(detail);
    const ratio = number(item?.usedRatio);
    if (ratio === undefined) return undefined;
    const resetAt = typeof item?.resetTime === "string"
      ? Date.parse(item.resetTime)
      : typeof item?.resetsAt === "string"
        ? Date.parse(item.resetsAt)
        : undefined;
    return { usedPercent: clampPercent(ratio <= 1 ? ratio * 100 : ratio), resetAt };
  };
  if (Array.isArray(source.limits)) {
    for (const limit of source.limits) {
      const item = record(limit);
      const usage = toWindow(item?.detail);
      if (!usage) continue;
      const minutes = durationMinutes(item?.window);
      if (minutes === 300) result.fiveHour ??= usage;
      if (minutes === 7 * 24 * 60) result.weekly ??= usage;
    }
  }
  result.weekly ??= toWindow(source.usage);
  result.monthly ??= toWindow(source.usage_monthly);
  // Newer accounts answer with ratio pools instead of counts; a reported bug can zero them,
  // so they only fill windows the count-based response did not supply.
  result.fiveHour ??= toRatioWindow(source.limit5h);
  result.weekly ??= toRatioWindow(source.limit7d);
  result.monthly ??= toRatioWindow(source.usage_monthly);
  return result.fiveHour || result.weekly || result.monthly ? result : undefined;
}

function parseCopilotUsage(payload: unknown): Snapshot | undefined {
  const source = record(payload);
  const snapshots = record(source?.quota_snapshots);
  if (!snapshots) return undefined;
  const resetAt = typeof source?.quota_reset_date === "string" ? Date.parse(source.quota_reset_date) : undefined;
  for (const key of ["code", "premium_interactions", "completions", "chat"] as const) {
    const quota = record(snapshots[key]);
    if (!quota || quota.unlimited === true) continue;
    const entitlement = count(quota.entitlement);
    const remaining = count(quota.remaining);
    const usedPercent = entitlement !== undefined && entitlement > 0 && remaining !== undefined
      ? clampPercent(((entitlement - remaining) / entitlement) * 100)
      : count(quota.percent_remaining) !== undefined
        ? clampPercent(100 - count(quota.percent_remaining)!)
        : undefined;
    if (usedPercent === undefined) continue;
    return { fetchedAt: Date.now(), monthly: { usedPercent, resetAt: Number.isFinite(resetAt) ? resetAt : undefined } };
  }
  return undefined;
}

function accountId(token: string): string | undefined {
  try {
    const payload = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const auth = record(payload?.["https://api.openai.com/auth"]);
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

async function refreshCodex(ctx: ExtensionContext): Promise<Snapshot | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;
  const token = bearerToken(auth);
  if (!token) return undefined;
  const id = accountId(token);
  const response = await fetch(CODEX_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, ...(id ? { "chatgpt-account-id": id } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseCodexUsage(await response.json()) : undefined;
}

async function claudeToken(): Promise<string | undefined> {
  const configDirectory = resolve(process.env.PI_CLAUDE_CODE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude`);
  if (process.platform === "darwin") {
    const suffix = configDirectory === `${homedir()}/.claude`
      ? ""
      : `-${(await import("node:crypto")).createHash("sha256").update(configDirectory).digest("hex").slice(0, 8)}`;
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", `Claude Code-credentials${suffix}`, "-w"]);
      const oauth = record(record(JSON.parse(stdout))?.claudeAiOauth);
      return typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const oauth = record(record(JSON.parse(await readFile(`${configDirectory}/.credentials.json`, "utf8")))?.claudeAiOauth);
    return typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

async function refreshClaude(): Promise<Snapshot | undefined> {
  const token = await claudeToken();
  if (!token) return undefined;
  const response = await fetch(CLAUDE_USAGE_URL, {
    // The endpoint answers 429 unless the request identifies as Claude Code.
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseClaudeUsage(await response.json()) : undefined;
}

async function refreshOpenCode(ctx: ExtensionContext): Promise<Snapshot | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;
  const token = bearerToken(auth);
  if (!token) return undefined;
  const response = await fetch(OPENCODE_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseOpenCodeUsage(await response.json()) : undefined;
}

async function refreshGlm(ctx: ExtensionContext): Promise<Snapshot | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;
  const token = bearerToken(auth);
  if (!token) return undefined;
  // The key is issued for exactly one region; the other host rejects it, so both are tried.
  for (const url of GLM_USAGE_URLS) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) continue;
    const snapshot = parseGlmUsage(await response.json());
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function refreshKimi(ctx: ExtensionContext): Promise<Snapshot | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;
  const token = bearerToken(auth);
  if (!token) return undefined;
  const response = await fetch(KIMI_USAGE_URL, {
    // The endpoint identifies clients by user agent; match the official CLI.
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "KimiCLI/1.5" },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseKimiUsage(await response.json()) : undefined;
}

async function refreshCopilot(ctx: ExtensionContext): Promise<Snapshot | undefined> {
  if (!ctx.model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return undefined;
  const token = bearerToken(auth);
  if (!token) return undefined;
  const response = await fetch(COPILOT_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? parseCopilotUsage(await response.json()) : undefined;
}

type UsageProvider = {
  id: string;
  name: string;
  matches(provider: string): boolean;
  refresh(ctx: ExtensionContext): Promise<Snapshot | undefined>;
};

const providers: UsageProvider[] = [
  {
    id: "openai-codex",
    name: "Codex",
    matches: (provider) => /^openai-codex(?:-\d+)?$/u.test(provider),
    refresh: refreshCodex,
  },
  {
    id: "claude-code",
    name: "Claude",
    matches: (provider) => provider === "claude-code",
    refresh: refreshClaude,
  },
  {
    id: "opencode",
    name: "OpenCode",
    matches: (provider) => provider === "opencode" || provider === "opencode-go",
    refresh: refreshOpenCode,
  },
  {
    id: "zai",
    name: "GLM Coding Plan",
    matches: (provider) => /^zai/u.test(provider) || /^glm/u.test(provider),
    refresh: refreshGlm,
  },
  {
    id: "kimi",
    name: "Kimi",
    matches: (provider) => /^kimi/u.test(provider),
    refresh: refreshKimi,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    matches: (provider) => provider === "copilot" || provider === "github-copilot" || /^copilot-/u.test(provider),
    refresh: refreshCopilot,
  },
];

function activeProvider(ctx: ExtensionContext): UsageProvider | undefined {
  return providers.find((provider) => provider.matches(ctx.model?.provider ?? ""));
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function resetDuration(window: Window): string | undefined {
  if (!window.resetAt || !Number.isFinite(window.resetAt)) return undefined;
  const seconds = Math.max(0, Math.round((window.resetAt - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days ? `${days}d${hours}h` : hours ? `${hours}h${minutes}m` : `${minutes}m`;
}

function formatWindow(template: string, kind: WindowKind, window: Window): string {
  const used = Math.round(window.usedPercent);
  const reset = resetDuration(window);
  return template
    .replaceAll("{percent}", String(used))
    .replaceAll("{remaining}", String(Math.max(0, 100 - used)))
    .replaceAll("{label}", WINDOW_LABELS[kind])
    .replace(/([^\w\s]*)\s*\{reset\}/u, (_match, decoration: string) => (reset ? `${decoration}${reset}` : ""))
    .trimEnd();
}

function usagePart(kind: WindowKind, window: Window, config: FooterConfig, theme: { fg: (color: string, text: string) => string }): string {
  const used = Math.round(window.usedPercent);
  const color = used >= 90 ? "error" : used >= 80 ? "warning" : "dim";
  return theme.fg(color, formatWindow(config.format, kind, window));
}

function usage(
  snapshot: Snapshot | undefined,
  provider: UsageProvider,
  config: FooterConfig,
  theme: { fg: (color: string, text: string) => string },
): string | undefined {
  if (!snapshot) return undefined;
  const kinds = (config.windowOverrides[provider.id] ?? config.windows).filter((kind) => snapshot[kind]);
  const parts = kinds.map((kind) => usagePart(kind, snapshot[kind]!, config, theme));
  return parts.length ? parts.join(theme.fg("dim", " • ")) : undefined;
}

function footerLines(pi: ExtensionAPI, ctx: ExtensionContext, state: State, footerData: { getGitBranch: () => string | undefined }, theme: { fg: (color: string, text: string) => string }, width: number): string[] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    const entryUsage = entry.type === "message" ? entry.message.usage : "usage" in entry ? entry.usage : undefined;
    if (!entryUsage) continue;
    input += entryUsage.input ?? 0;
    output += entryUsage.output ?? 0;
    cacheRead += entryUsage.cacheRead ?? 0;
    cacheWrite += entryUsage.cacheWrite ?? 0;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const promptTokens = entryUsage.input + entryUsage.cacheRead + entryUsage.cacheWrite;
      latestCacheHitRate = promptTokens > 0 ? (entryUsage.cacheRead / promptTokens) * 100 : undefined;
    }
  }
  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercent = contextUsage?.percent;
  const context = contextPercent === undefined || contextPercent === null
    ? `?/${formatTokens(contextWindow)}`
    : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
  const stats = [
    input ? `↑${formatTokens(input)}` : undefined,
    output ? `↓${formatTokens(output)}` : undefined,
    cacheRead ? `R${formatTokens(cacheRead)}` : undefined,
    cacheWrite ? `W${formatTokens(cacheWrite)}` : undefined,
    (cacheRead || cacheWrite) && latestCacheHitRate !== undefined ? `CH${latestCacheHitRate.toFixed(1)}%` : undefined,
    contextPercent !== undefined && contextPercent !== null && contextPercent > 90
      ? theme.fg("error", context)
      : contextPercent !== undefined && contextPercent !== null && contextPercent > 70
        ? theme.fg("warning", context)
        : context,
  ].filter(Boolean).join(" ");
  const modelName = ctx.model?.id ?? "no-model";
  const model = ctx.model?.reasoning
    ? `${modelName} • ${pi.getThinkingLevel() === "off" ? "thinking off" : pi.getThinkingLevel()}`
    : modelName;
  const provider = activeProvider(ctx);
  const quota = provider ? usage(state.snapshots[provider.id], provider, state.config, theme) : undefined;
  const right = [model, quota].filter(Boolean).join(theme.fg("dim", " • "));
  const clippedRight = truncateToWidth(right, width, "");
  const availableForStats = Math.max(0, width - visibleWidth(clippedRight) - 2);
  const clippedStats = truncateToWidth(stats, availableForStats, "...");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clippedStats) - visibleWidth(clippedRight)));
  const branch = footerData.getGitBranch();
  const location = `${ctx.sessionManager.getCwd().replace(homedir(), "~")}${branch ? ` (${branch})` : ""}`;
  return [
    truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
    truncateToWidth(theme.fg("dim", clippedStats) + theme.fg("dim", `${padding}${clippedRight}`), width, ""),
  ];
}

export default function (pi: ExtensionAPI): void {
  const state: State = { config: defaults, snapshots: {}, requestRender: () => {} };
  const refresh = async (ctx: ExtensionContext, force = false) => {
    if (state.updating && !force) return state.updating;
    state.updating = (async () => {
      try {
        const provider = activeProvider(ctx);
        if (provider) {
          const snapshot = await provider.refresh(ctx);
          // A failed or unparseable fetch keeps the last good snapshot, so a transient
          // endpoint error never blanks the footer.
          if (snapshot) state.snapshots[provider.id] = snapshot;
        }
      } catch {
        // A footer must never interrupt a model run when an undocumented usage endpoint changes.
      } finally {
        state.requestRender();
        state.updating = undefined;
      }
    })();
    return state.updating;
  };

  const install = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      state.requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return { dispose: unsubscribe, invalidate() {}, render: (width) => footerLines(pi, ctx, state, footerData, theme, width) };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    state.config = await loadConfig();
    install(ctx);
    await refresh(ctx);
    state.timer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
    state.timer.unref?.();
  });
  pi.on("model_select", async (_event, ctx) => { install(ctx); await refresh(ctx, true); });
  pi.on("agent_settled", (_event, ctx) => void refresh(ctx));
  pi.on("session_shutdown", () => { if (state.timer) clearInterval(state.timer); state.timer = undefined; state.requestRender = () => {}; });
  pi.registerCommand("usage-footer", {
    description: "Refresh and show subscription usage for the active provider",
    handler: async (_args, ctx) => {
      await refresh(ctx, true);
      const provider = activeProvider(ctx);
      const snapshot = provider ? state.snapshots[provider.id] : undefined;
      if (!provider || !snapshot) { ctx.ui.notify("Usage is unavailable for the active provider.", "warning"); return; }
      const lines = WINDOW_KINDS
        .filter((kind) => snapshot[kind])
        .map((kind) => {
          const window = snapshot[kind]!;
          const reset = resetDuration(window);
          return `${COMMAND_LABELS[kind]}: ${Math.round(window.usedPercent)}% used${reset ? `, resets in ${reset}` : ""}`;
        });
      ctx.ui.notify(`${provider.name}\n${lines.join("\n")}`, "info");
    },
  });
}
