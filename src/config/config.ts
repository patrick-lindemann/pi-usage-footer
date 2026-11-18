import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readRecord, type WindowKind, windowKinds } from "../usage.ts";

export interface FooterConfig {
  windows: WindowKind[];
  windowOverrides: ReadonlyMap<string, WindowKind[]>;
  format: string;
  endpoints: ReadonlyMap<string, readonly string[]>;
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

function _parseConfig(value: unknown): FooterConfig {
  const source = readRecord(value);
  const windowOverrides = new Map<string, WindowKind[]>();
  for (const [id, kinds] of Object.entries(readRecord(source?.windowOverrides) ?? {})) {
    const windows = _readWindows(kinds);
    if (windows) {
      windowOverrides.set(id, windows);
    }
  }
  const endpoints = new Map<string, readonly string[]>();
  for (const [id, value] of Object.entries(readRecord(source?.endpoints) ?? {})) {
    const urls = (Array.isArray(value) ? value : [value]).map(_readEndpoint).filter((url) => url !== undefined);
    if (urls.length) {
      endpoints.set(id, urls);
    }
  }
  return {
    windows: _readWindows(source?.windows) ?? ["fiveHour"],
    windowOverrides,
    format: typeof source?.format === "string" && source.format ? source.format : "{percent}%/{label} ↺{reset}",
    endpoints,
  };
}
