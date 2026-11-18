import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bundledEndpoints } from "../config/defaults.ts";
import { readRecord, type Snapshot } from "../usage.ts";
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseCopilotUsage,
  parseCustomUsage,
  parseGlmUsage,
  parseKimiUsage,
  parseOpenCodeUsage,
} from "./parsers.ts";

const execFileAsync = promisify(execFile);

export type ProviderContext = Pick<ExtensionContext, "model" | "modelRegistry">;

export interface UsageProvider {
  id: string;
  /** The exact provider ID for its own endpoint override, otherwise the family ID. */
  cacheKey: string;
  name: string;
  urls: readonly string[];
  parse(payload: unknown): Snapshot | undefined;
  headers?(token: string): Record<string, string>;
  readToken?(ctx: ProviderContext): Promise<string | undefined>;
}

type BuiltinProvider = Omit<UsageProvider, "urls" | "cacheKey"> & { matches(provider: string): boolean };

const providers: BuiltinProvider[] = [
  {
    id: "openai-codex",
    name: "Codex",
    matches: (provider) => /^openai-codex(?:-\d+)?$/u.test(provider),
    parse: parseCodexUsage,
    headers: (token): Record<string, string> => {
      const account = _readCodexAccount(token);
      return account ? { "chatgpt-account-id": account } : {};
    },
  },
  {
    id: "claude-code",
    name: "Claude",
    matches: (id) => id === "claude-code",
    parse: parseClaudeUsage,
    headers: _createClaudeHeaders,
    readToken: _readClaudeToken,
  },
  {
    id: "anthropic",
    name: "Claude",
    matches: (id) => id === "anthropic",
    parse: parseClaudeUsage,
    headers: _createClaudeHeaders,
  },
  {
    id: "opencode",
    name: "OpenCode",
    matches: (id) => id === "opencode" || id === "opencode-go",
    parse: parseOpenCodeUsage,
  },
  {
    id: "zai",
    name: "GLM Coding Plan",
    matches: (id) => /^(zai|glm)/u.test(id),
    parse: parseGlmUsage,
    headers: () => ({ Accept: "application/json" }),
  },
  {
    id: "kimi",
    name: "Kimi",
    matches: (id) => id.startsWith("kimi"),
    parse: parseKimiUsage,
    // The endpoint uses the user agent to identify its official CLI.
    headers: () => ({ "User-Agent": "KimiCLI/1.5" }),
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    matches: (id) => id === "copilot" || id === "github-copilot" || id.startsWith("copilot-"),
    parse: parseCopilotUsage,
    headers: () => ({ Accept: "application/vnd.github+json" }),
  },
];

/**
 * Selects a built-in adapter or a configured custom quota provider.
 * @param id Active Pi provider ID, if any.
 * @param overrides Validated endpoint URLs keyed by provider ID.
 * @returns An adapter with exact overrides preferred over family overrides and bundled defaults, or undefined when unsupported.
 */
export function resolveProvider(
  id: string | undefined,
  overrides: ReadonlyMap<string, readonly string[]>,
): UsageProvider | undefined {
  if (!id) {
    return undefined;
  }
  const exact = overrides.get(id);
  const builtin = providers.find((provider) => provider.matches(id));
  if (builtin) {
    const urls = exact ?? overrides.get(builtin.id) ?? bundledEndpoints[builtin.id];
    return { ...builtin, cacheKey: exact ? id : builtin.id, urls };
  }
  if (exact) {
    return { id, cacheKey: id, name: id, urls: exact, parse: parseCustomUsage };
  }
  return undefined;
}

/**
 * Reads quota data from the first endpoint that returns a recognized response.
 * @param provider Resolved provider and trusted HTTPS endpoints.
 * @param ctx Pi context for the active model's credentials.
 * @returns A normalized snapshot, or undefined if credentials or usable responses are unavailable.
 * @throws Rejects if credential lookup fails or the last endpoint fails at the network or JSON layer.
 */
export async function fetchUsage(provider: UsageProvider, ctx: ProviderContext): Promise<Snapshot | undefined> {
  const token = await (provider.readToken ?? _readModelToken)(ctx);
  if (!token) {
    return undefined;
  }
  for (const [index, url] of provider.urls.entries()) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, ...provider.headers?.(token) },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        continue;
      }
      const snapshot = provider.parse(await response.json());
      if (snapshot) {
        return snapshot;
      }
    } catch (error) {
      if (index === provider.urls.length - 1) {
        throw error;
      }
    }
  }
  return undefined;
}

async function _readModelToken(ctx: ProviderContext): Promise<string | undefined> {
  if (!ctx.model) {
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    return undefined;
  }
  if (auth.apiKey) {
    return auth.apiKey;
  }
  const header = auth.headers?.Authorization ?? auth.headers?.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function _readCodexAccount(token: string): string | undefined {
  try {
    const payload = readRecord(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const auth = readRecord(payload?.["https://api.openai.com/auth"]);
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

async function _readClaudeToken(): Promise<string | undefined> {
  const standardDir = `${homedir()}/.claude`;
  const configDir = resolve(process.env.PI_CLAUDE_CODE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? standardDir);
  try {
    let contents: string;
    if (process.platform === "darwin") {
      const suffix =
        configDir === standardDir ? "" : `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        `Claude Code-credentials${suffix}`,
        "-w",
      ]);
      contents = stdout;
    } else {
      contents = await readFile(`${configDir}/.credentials.json`, "utf8");
    }
    const oauth = readRecord(readRecord(JSON.parse(contents))?.claudeAiOauth);
    return typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

function _createClaudeHeaders(): Record<string, string> {
  // The endpoint answers 429 unless the request identifies as Claude Code.
  return { "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" };
}
