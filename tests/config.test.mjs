import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, resolveDisplay } from "../src/config/config.ts";

test("inherits each display field through the exact ID, family, root, and defaults", async (t) => {
  const path = await _writeConfig(t, {
    windows: ["weekly", "unknown"],
    format: "{remaining}% left",
    quotaColors: { warning: { at: 75, color: "orange" } },
    providers: {
      "openai-codex": { windows: ["monthly"], quotaColors: { warning: { color: "#ffaa00" } } },
      "openai-codex-2": { format: "{percent}%", quotaColors: { critical: { at: 95 } } },
      "openai-codex-3": { windows: [], quotaColors: false },
    },
  });
  const config = await loadConfig(path);
  assert.deepEqual(resolveDisplay(config, "openai-codex-2", "openai-codex"), {
    windows: ["monthly"],
    format: "{percent}%",
    quotaColors: { normal: "dim", warning: { at: 75, color: "#ffaa00" }, critical: { at: 95, color: "error" } },
  });
  assert.deepEqual(resolveDisplay(config, "openai-codex-3", "openai-codex"), {
    windows: [],
    format: "{remaining}% left",
    quotaColors: false,
  });
  assert.deepEqual(resolveDisplay(config, "copilot", "copilot").windows, ["weekly"]);
});

test("only reads HTTPS endpoints without credentials from provider settings", async (t) => {
  const path = await _writeConfig(t, {
    providers: {
      custom: { endpoints: "https://quota.example/windows" },
      zai: { endpoints: ["http://quota.example/invalid", "https://quota.example/valid"] },
      kimi: { endpoints: "https://user:password@quota.example/windows" },
      copilot: { endpoints: ["not a URL"] },
    },
  });
  assert.deepEqual((await loadConfig(`${path}.missing`)).windows, ["fiveHour"]);
  const { providers } = await loadConfig(path);
  assert.deepEqual(providers.get("custom").endpoints, ["https://quota.example/windows"]);
  assert.deepEqual(providers.get("zai").endpoints, ["https://quota.example/valid"]);
  assert.equal(providers.get("kimi").endpoints, undefined);
  assert.equal(providers.get("copilot").endpoints, undefined);
});

async function _writeConfig(t, config) {
  const dir = await mkdtemp(join(tmpdir(), "pi-footer-config-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "usage-footer.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}
