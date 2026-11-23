import { readNumber, readRecord, type Snapshot, type UsageWindow, type WindowKind, windowKinds } from "../usage.ts";

/**
 * Normalizes the Codex quota response.
 * @param payload Parsed response body.
 * @returns Reported five-hour or weekly windows, or undefined if neither is recognized.
 */
export function parseCodexUsage(payload: unknown): Snapshot | undefined {
  const rateLimit = readRecord(readRecord(payload)?.rate_limit);
  const windows = [readRecord(rateLimit?.primary_window), readRecord(rateLimit?.secondary_window)];
  const result: Snapshot = { fetchedAt: Date.now() };
  for (const window of windows) {
    const usedPercent = readNumber(window?.used_percent);
    const seconds = readNumber(window?.limit_window_seconds);
    if (usedPercent === undefined || seconds === undefined) {
      continue;
    }
    const resetAt = readNumber(window?.reset_at);
    const resetAfter = readNumber(window?.reset_after_seconds);
    const normalizedReset = resetAt
      ? resetAt > 100_000_000_000
        ? resetAt
        : resetAt * 1000
      : resetAfter !== undefined
        ? Date.now() + resetAfter * 1000
        : undefined;
    if (Math.abs(seconds - 5 * 60 * 60) < 120) {
      result.fiveHour = { usedPercent, resetAt: normalizedReset };
    }
    if (Math.abs(seconds - 7 * 24 * 60 * 60) < 120) {
      result.weekly = { usedPercent, resetAt: normalizedReset };
    }
  }
  return _finishSnapshot(result);
}

/**
 * Normalizes quota data from the Claude OAuth endpoint.
 * @param payload Parsed response body.
 * @returns Reported five-hour or weekly windows, or undefined if neither is recognized.
 */
export function parseClaudeUsage(payload: unknown): Snapshot | undefined {
  const source = readRecord(payload);
  const result: Snapshot = { fetchedAt: Date.now() };
  if (Array.isArray(source?.limits)) {
    for (const limit of source.limits) {
      const item = readRecord(limit);
      const usedPercent = readNumber(item?.percent);
      if (usedPercent === undefined) {
        continue;
      }
      const resetAt = _parseDate(item?.resets_at);
      if (item?.kind === "session") {
        result.fiveHour = { usedPercent, resetAt };
      }
      if (item?.kind === "weekly_all") {
        result.weekly = { usedPercent, resetAt };
      }
    }
  }
  for (const [key, target] of [
    ["five_hour", "fiveHour"],
    ["seven_day", "weekly"],
  ] as const) {
    const window = readRecord(source?.[key]);
    const usedPercent = readNumber(window?.utilization);
    if (usedPercent !== undefined) {
      result[target] = { usedPercent, resetAt: _parseDate(window?.resets_at) };
    }
  }
  return _finishSnapshot(result);
}

/**
 * Normalizes rolling and calendar windows from OpenCode Go.
 * @param payload Parsed response body.
 * @returns Reported quota windows, or undefined if none are recognized.
 */
export function parseOpenCodeUsage(payload: unknown): Snapshot | undefined {
  const usage = readRecord(readRecord(payload)?.usage);
  const result: Snapshot = { fetchedAt: Date.now() };
  for (const [key, kind] of [
    ["rolling", "fiveHour"],
    ["weekly", "weekly"],
    ["monthly", "monthly"],
  ] as const) {
    const window = readRecord(usage?.[key]);
    const usedPercent = readNumber(window?.percent);
    if (usedPercent === undefined) {
      continue;
    }
    result[kind] = { usedPercent, resetAt: _parseDate(window?.resetsAt) };
  }
  return _finishSnapshot(result);
}

/**
 * Normalizes GLM limits and derives used percentages from counts when available.
 * @param payload Parsed response body.
 * @returns Reported quota windows, or undefined if none are recognized.
 */
export function parseGlmUsage(payload: unknown): Snapshot | undefined {
  const limits = readRecord(readRecord(payload)?.data)?.limits;
  const result: Snapshot = { fetchedAt: Date.now() };
  if (Array.isArray(limits)) {
    for (const limit of limits) {
      const item = readRecord(limit);
      if (!item) {
        continue;
      }
      const usedPercent = _readGlmPercent(item);
      const kind = _readGlmWindowKind(item);
      if (usedPercent === undefined || kind === undefined) {
        continue;
      }
      result[kind] = { usedPercent, resetAt: readNumber(item.nextResetTime) };
    }
  }
  return _finishSnapshot(result);
}

/**
 * Normalizes Kimi quota counts and fills missing windows from ratio pools.
 * @param payload Parsed response body.
 * @returns Reported quota windows, or undefined if none are recognized.
 */
export function parseKimiUsage(payload: unknown): Snapshot | undefined {
  const source = readRecord(payload);
  if (!source) {
    return undefined;
  }
  const result: Snapshot = { fetchedAt: Date.now() };
  if (Array.isArray(source.limits)) {
    for (const limit of source.limits) {
      const item = readRecord(limit);
      const usage = _readKimiCountWindow(item?.detail);
      if (!usage) {
        continue;
      }
      const minutes = _readKimiDurationMinutes(item?.window);
      if (minutes === 300) {
        result.fiveHour ??= usage;
      }
      if (minutes === 7 * 24 * 60) {
        result.weekly ??= usage;
      }
    }
  }
  result.weekly ??= _readKimiCountWindow(source.usage);
  result.monthly ??= _readKimiCountWindow(source.usage_monthly);
  // Ratio pools can incorrectly report zero, so use them only when counts are absent.
  result.fiveHour ??= _readKimiRatioWindow(source.limit5h);
  result.weekly ??= _readKimiRatioWindow(source.limit7d);
  result.monthly ??= _readKimiRatioWindow(source.usage_monthly);
  return _finishSnapshot(result);
}

/**
 * Selects the first recognized metered Copilot quota.
 * @param payload Parsed response body.
 * @returns A monthly window, or undefined if no metered quota is recognized.
 */
export function parseCopilotUsage(payload: unknown): Snapshot | undefined {
  const source = readRecord(payload);
  const snapshots = readRecord(source?.quota_snapshots);
  if (!snapshots) {
    return undefined;
  }
  const resetAt = _parseDate(source?.quota_reset_date);
  for (const key of ["code", "premium_interactions", "completions", "chat"] as const) {
    const quota = readRecord(snapshots[key]);
    if (!quota || quota.unlimited === true) {
      continue;
    }
    const entitlement = _readCount(quota.entitlement);
    const remaining = _readCount(quota.remaining);
    const percentRemaining = _readCount(quota.percent_remaining);
    const usedPercent =
      entitlement !== undefined && entitlement > 0 && remaining !== undefined
        ? _clampPercent(((entitlement - remaining) / entitlement) * 100)
        : percentRemaining !== undefined
          ? _clampPercent(100 - percentRemaining)
          : undefined;
    if (usedPercent !== undefined) {
      return {
        fetchedAt: Date.now(),
        monthly: { usedPercent, resetAt: Number.isFinite(resetAt) ? resetAt : undefined },
      };
    }
  }
  return undefined;
}

/**
 * Reads quota windows from an endpoint for a provider without a built-in adapter.
 * @param payload Parsed response body keyed by window, with a used percentage and optional reset time in milliseconds.
 * @returns Valid quota windows, or undefined if none have a percentage between 0 and 100.
 */
export function parseCustomUsage(payload: unknown): Snapshot | undefined {
  const source = readRecord(payload);
  const result: Snapshot = { fetchedAt: Date.now() };
  for (const kind of windowKinds) {
    const window = readRecord(source?.[kind]);
    const usedPercent = readNumber(window?.usedPercent);
    if (usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100) {
      result[kind] = { usedPercent, resetAt: readNumber(window?.resetAt) };
    }
  }
  return _finishSnapshot(result);
}

function _readCount(value: unknown): number | undefined {
  return readNumber(typeof value === "string" && value.trim() !== "" ? Number(value) : value);
}

function _clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function _parseDate(value: unknown): number | undefined {
  return typeof value === "string" ? Date.parse(value) : undefined;
}

function _finishSnapshot(snapshot: Snapshot): Snapshot | undefined {
  return windowKinds.some((kind) => snapshot[kind]) ? snapshot : undefined;
}

function _readGlmWindowKind(item: Record<string, unknown>): WindowKind | undefined {
  const unit = readNumber(item.unit);
  const amount = readNumber(item.number);
  const duration =
    unit === 3 && amount !== undefined
      ? amount * 3_600
      : unit === 6 && amount !== undefined
        ? amount * 86_400
        : undefined;
  if (duration !== undefined) {
    if (Math.abs(duration - 5 * 3_600) < 600) {
      return "fiveHour";
    }
    if (Math.abs(duration - 7 * 86_400) < 3_600) {
      return "weekly";
    }
    if (duration >= 25 * 86_400) {
      return "monthly";
    }
  }
  // Older payloads omit `number`, so `unit` alone identifies the window.
  if (unit === 3) {
    return "fiveHour";
  }
  if (unit === 6) {
    return "weekly";
  }
  if (item.type === "TIME_LIMIT") {
    return "monthly";
  }
  if (item.type === "TOKENS_LIMIT" || item.type === "CREDIT_LIMIT") {
    return "fiveHour";
  }
  return undefined;
}

function _readGlmPercent(item: Record<string, unknown>): number | undefined {
  const total = _readCount(item.usage);
  const current = _readCount(item.currentValue);
  const remaining = _readCount(item.remaining);
  if (total !== undefined && total > 0) {
    const used = current ?? (remaining !== undefined ? total - remaining : undefined);
    if (used !== undefined) {
      return _clampPercent((used / total) * 100);
    }
  }
  const percentage = _readCount(item.percentage);
  return percentage !== undefined ? _clampPercent(percentage) : undefined;
}

function _readKimiCountWindow(detail: unknown): UsageWindow | undefined {
  const item = readRecord(detail);
  const limit = _readCount(item?.limit);
  const used = _readCount(item?.used);
  if (limit === undefined || limit <= 0 || used === undefined) {
    return undefined;
  }
  return { usedPercent: _clampPercent((used / limit) * 100), resetAt: _parseDate(item?.resetTime) };
}

function _readKimiDurationMinutes(window: unknown): number | undefined {
  const item = readRecord(window);
  const duration = _readCount(item?.duration);
  if (duration === undefined || duration <= 0) {
    return undefined;
  }
  switch (item?.timeUnit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 24 * 60;
    default:
      return undefined;
  }
}

function _readKimiRatioWindow(detail: unknown): UsageWindow | undefined {
  const item = readRecord(detail);
  const ratio = readNumber(item?.usedRatio);
  if (ratio === undefined) {
    return undefined;
  }
  return {
    usedPercent: _clampPercent(ratio <= 1 ? ratio * 100 : ratio),
    resetAt: _parseDate(item?.resetTime) ?? _parseDate(item?.resetsAt),
  };
}
