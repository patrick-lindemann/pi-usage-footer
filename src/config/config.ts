import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readNumber, readRecord, type WindowKind, windowKinds } from "../usage.ts";

const defaultDisplay = {
  windows: ["fiveHour"],
  format: "{percent}%/{label} ↺{reset}",
  quotaColors: {
    normal: "dim",
    warning: { at: 80, color: "warning" },
    critical: { at: 90, color: "error" },
  },
} satisfies QuotaDisplay;

export interface FooterConfig extends QuotaDisplay {
  refreshIntervalSeconds: number;
  statusPlacement: StatusPlacement;
  providers: ReadonlyMap<string, ProviderSettings>;
}

export type StatusPlacement = "auto" | "inline" | "separate";

export interface QuotaDisplay {
  windows: readonly WindowKind[];
  format: string;
  quotaColors: false | QuotaColors;
}

interface QuotaColors {
  normal: string;
  warning: ThresholdColor;
  critical: ThresholdColor;
}

interface ThresholdColor {
  at: number;
  color: string;
}

type ColorOverrides = Partial<Pick<QuotaColors, "normal">> & {
  warning?: Partial<ThresholdColor>;
  critical?: Partial<ThresholdColor>;
};

interface DisplayOverrides extends Partial<Omit<QuotaDisplay, "quotaColors">> {
  quotaColors?: false | ColorOverrides;
}

interface ProviderSettings extends DisplayOverrides {
  endpoints?: readonly string[];
}

/**
 * Reads the optional configuration without writing or migrating it.
 *
 * @param path Path to the JSON file. Defaults to `usage-footer.json` in Pi's agent directory.
 * @returns Validated settings. Unreadable or invalid JSON uses defaults.
 */
export async function loadConfig(
  path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "usage-footer.json"),
): Promise<FooterConfig> {
  try {
    return _parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return _parseConfig(undefined);
  }
}

/**
 * Resolves display settings by applying family overrides before exact provider overrides.
 * @param config Loaded footer configuration.
 * @param id The exact Pi provider ID.
 * @param family The built-in provider family, if it differs from the exact ID.
 * @returns The windows, template and colors to use for this provider.
 */
export function resolveDisplay(config: FooterConfig, id: string, family: string): QuotaDisplay {
  const familyDisplay = _mergeDisplay(config, config.providers.get(family));
  return id === family ? familyDisplay : _mergeDisplay(familyDisplay, config.providers.get(id));
}

function _readWindows(value: unknown): WindowKind[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((kind): kind is WindowKind => windowKinds.some((known) => known === kind));
}

function _readEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password) {
    return url.href;
  }
  return undefined;
}

function _readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function _readThreshold(value: unknown): Partial<ThresholdColor> {
  const source = readRecord(value);
  const at = readNumber(source?.at);
  return { at: at !== undefined && at >= 0 && at <= 100 ? at : undefined, color: _readText(source?.color)?.trim() };
}

function _readDisplay(source: Record<string, unknown> | undefined): DisplayOverrides {
  const colors = readRecord(source?.quotaColors);
  return {
    windows: _readWindows(source?.windows),
    format: _readText(source?.format),
    quotaColors:
      source?.quotaColors === false
        ? false
        : colors && {
            normal: _readText(colors.normal)?.trim(),
            warning: _readThreshold(colors.warning),
            critical: _readThreshold(colors.critical),
          },
  };
}

function _mergeDisplay(base: QuotaDisplay, override: DisplayOverrides | undefined): QuotaDisplay {
  const colors = override?.quotaColors;
  let quotaColors = base.quotaColors;
  if (colors === false) {
    quotaColors = false;
  } else if (colors) {
    const fallback = base.quotaColors || defaultDisplay.quotaColors;
    quotaColors = {
      normal: colors.normal ?? fallback.normal,
      warning: {
        at: colors.warning?.at ?? fallback.warning.at,
        color: colors.warning?.color ?? fallback.warning.color,
      },
      critical: {
        at: colors.critical?.at ?? fallback.critical.at,
        color: colors.critical?.color ?? fallback.critical.color,
      },
    };
  }
  return { windows: override?.windows ?? base.windows, format: override?.format ?? base.format, quotaColors };
}

function _parseConfig(value: unknown): FooterConfig {
  const source = readRecord(value);
  const providers = new Map<string, ProviderSettings>();
  for (const [id, value] of Object.entries(readRecord(source?.providers) ?? {})) {
    const provider = readRecord(value);
    if (!provider) {
      continue;
    }
    const raw = provider.endpoints;
    const urls = (Array.isArray(raw) ? raw : [raw]).map(_readEndpoint).filter((url) => url !== undefined);
    providers.set(id, { ..._readDisplay(provider), endpoints: urls.length ? urls : undefined });
  }
  const interval = readNumber(source?.refreshIntervalSeconds);
  const refreshIntervalSeconds =
    interval !== undefined && Number.isInteger(interval) && interval >= 0 && interval * 1000 <= 2 ** 31 - 1
      ? interval
      : 60;
  const placement = source?.statusPlacement;
  const statusPlacement = placement === "inline" || placement === "separate" ? placement : "auto";
  return { ..._mergeDisplay(defaultDisplay, _readDisplay(source)), refreshIntervalSeconds, statusPlacement, providers };
}
