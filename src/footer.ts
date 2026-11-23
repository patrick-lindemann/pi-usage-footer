import { homedir } from "node:os";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { parseColor, rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import namedColors from "color-name";
import type { QuotaDisplay, StatusPlacement } from "./config/config.ts";
import { type Snapshot, type UsageWindow, type WindowKind, windowKinds } from "./usage.ts";

const labels: Record<WindowKind, string> = { fiveHour: "5h", weekly: "W", monthly: "M" };
const commandLabels: Record<WindowKind, string> = { fiveHour: "5-hour", weekly: "Weekly", monthly: "Monthly" };
type FooterContext = Pick<ExtensionContext, "model" | "sessionManager" | "getContextUsage">;
type FooterTheme = Pick<Theme, "fg">;

/**
 * Formats the selected quota windows for display beside the model.
 * @param snapshot The last successful provider response, if available.
 * @param display Resolved window order, template, and color rules.
 * @param theme Pi's color formatter.
 * @returns Quota text with warning colors, or undefined when no selected window is available.
 */
export function formatQuota(
  snapshot: Snapshot | undefined,
  display: QuotaDisplay,
  theme: Pick<Theme, "fg" | "style">,
): string | undefined {
  const parts: string[] = [];
  for (const kind of display.windows) {
    const window = snapshot?.[kind];
    if (!window) {
      continue;
    }
    const text = _formatWindow(display.format, kind, window);
    const colors = display.quotaColors;
    if (!colors) {
      parts.push(text);
      continue;
    }
    const used = Math.round(window.usedPercent);
    if (used >= colors.critical.at) {
      parts.push(_applyColor(theme, text, colors.critical.color, "error"));
    } else if (used >= colors.warning.at) {
      parts.push(_applyColor(theme, text, colors.warning.color, "warning"));
    } else {
      parts.push(_applyColor(theme, text, colors.normal, "dim"));
    }
  }
  return parts.length ? parts.join(theme.fg("dim", " • ")) : undefined;
}

/**
 * Formats a quota summary for the refresh command.
 * @param name The provider's display name.
 * @param snapshot The provider's most recent successful response.
 * @returns The name followed by every reported window and its reset time when known.
 */
export function formatQuotaSummary(name: string, snapshot: Snapshot): string {
  const lines = [name];
  for (const kind of windowKinds) {
    const window = snapshot[kind];
    if (!window) {
      continue;
    }
    const reset = _formatReset(window);
    lines.push(`${commandLabels[kind]}: ${Math.round(window.usedPercent)}% used${reset ? `, resets in ${reset}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Renders the model, shared extension statuses, and quota at the current terminal width.
 * @param ctx Active model and session data from Pi.
 * @param footerData Git branch and status strings from Pi.
 * @param theme Pi's color formatter.
 * @param width Number of terminal columns.
 * @param thinkingLevel Active thinking level.
 * @param statusPlacement Whether to keep statuses inline, use a separate row, or choose based on width.
 * @param quota Formatted quota text, if available.
 * @returns Footer lines with statuses placed according to the selected mode.
 */
export function renderFooter(
  ctx: FooterContext,
  footerData: Pick<ReadonlyFooterDataProvider, "getGitBranch" | "getExtensionStatuses">,
  theme: FooterTheme,
  width: number,
  thinkingLevel: string,
  statusPlacement: StatusPlacement,
  quota?: string,
): string[] {
  const stats = _formatSessionStats(ctx, theme);
  const modelName = ctx.model?.id ?? "no-model";
  const model = ctx.model?.reasoning
    ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
    : modelName;
  const separator = theme.fg("dim", " • ");
  const dimModel = theme.fg("dim", model);
  const modelAndQuota = [dimModel, quota].filter(Boolean).join(separator);
  const statuses = [...footerData.getExtensionStatuses()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(separator);
  const rightWithStatuses = [dimModel, statuses, quota].filter(Boolean).join(separator);
  const showInline =
    statusPlacement === "inline" ||
    (statusPlacement === "auto" && visibleWidth(stats) + 2 + visibleWidth(rightWithStatuses) <= width);
  const right = truncateToWidth(showInline ? rightWithStatuses : modelAndQuota, width, "");
  const clippedStats = truncateToWidth(stats, Math.max(0, width - visibleWidth(right) - 2), "...");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clippedStats) - visibleWidth(right)));
  const branch = footerData.getGitBranch();
  const location = `${ctx.sessionManager.getCwd().replace(homedir(), "~")}${branch ? ` (${branch})` : ""}`;
  const lines = [
    truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
    truncateToWidth(theme.fg("dim", clippedStats) + padding + right, width, ""),
  ];
  if (statuses && !showInline) {
    lines.push(truncateToWidth(statuses, width, "..."));
  }
  return lines;
}

function _applyColor(theme: Pick<Theme, "fg" | "style">, text: string, color: string, fallback: ThemeColor): string {
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) {
    return theme.style(text, { fg: parseColor(color) });
  }
  const name = color.toLowerCase() as keyof typeof namedColors;
  if (Object.hasOwn(namedColors, name)) {
    return theme.style(text, { fg: rgbColor(...namedColors[name]) });
  }
  try {
    return theme.fg(color as ThemeColor, text);
  } catch {
    return theme.fg(fallback, text);
  }
}

function _formatSessionStats(ctx: FooterContext, theme: FooterTheme): string {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    const source = entry.type === "message" ? entry.message : entry;
    const usage = "usage" in source ? source.usage : undefined;
    if (!usage) {
      continue;
    }
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
    }
  }
  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = contextUsage?.percent ?? undefined;
  const stats =
    percent === undefined
      ? `?/${_formatTokens(contextWindow)}`
      : `${percent.toFixed(1)}%/${_formatTokens(contextWindow)}`;
  return [
    input ? `↑${_formatTokens(input)}` : undefined,
    output ? `↓${_formatTokens(output)}` : undefined,
    cacheRead ? `R${_formatTokens(cacheRead)}` : undefined,
    cacheWrite ? `W${_formatTokens(cacheWrite)}` : undefined,
    (cacheRead || cacheWrite) && latestCacheHitRate !== undefined ? `CH${latestCacheHitRate.toFixed(1)}%` : undefined,
    percent !== undefined && percent > 90
      ? theme.fg("error", stats)
      : percent !== undefined && percent > 70
        ? theme.fg("warning", stats)
        : stats,
  ]
    .filter(Boolean)
    .join(" ");
}

function _formatTokens(value: number): string {
  if (value < 1_000) {
    return String(value);
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  if (value < 10_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(value / 1_000_000)}M`;
}

function _formatReset(window: UsageWindow): string | undefined {
  if (!window.resetAt || !Number.isFinite(window.resetAt)) {
    return undefined;
  }
  const seconds = Math.max(0, Math.round((window.resetAt - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days ? `${days}d${hours}h` : hours ? `${hours}h${minutes}m` : `${minutes}m`;
}

function _formatWindow(template: string, kind: WindowKind, window: UsageWindow): string {
  const used = Math.round(window.usedPercent);
  const reset = _formatReset(window);
  return template
    .replaceAll("{percent}", String(used))
    .replaceAll("{remaining}", String(Math.max(0, 100 - used)))
    .replaceAll("{label}", labels[kind])
    .replace(/([^\w\s]*)\s*\{reset\}/u, (_match, decoration: string) => (reset ? `${decoration}${reset}` : ""))
    .trimEnd();
}
