import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/config.ts";

test("loads allowed endpoint overrides and retains defaults for invalid entries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-footer-config-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "usage-footer.json");
  assert.deepEqual((await loadConfig(path)).windows, ["fiveHour"]);
  await writeFile(
    path,
    JSON.stringify({
      windows: ["weekly", "unknown"],
      windowOverrides: { custom: ["monthly"] },
      endpoints: {
        custom: "https://quota.example/windows",
        zai: ["http://quota.example/invalid", "https://quota.example/valid"],
        kimi: "https://user:password@quota.example/windows",
        copilot: ["not a URL"],
      },
    }),
  );
  const config = await loadConfig(path);
  assert.deepEqual(config.windows, ["weekly"]);
  assert.deepEqual(config.windowOverrides.get("custom"), ["monthly"]);
  assert.deepEqual(
    [...config.endpoints],
    [
      ["custom", ["https://quota.example/windows"]],
      ["zai", ["https://quota.example/valid"]],
    ],
  );
});
