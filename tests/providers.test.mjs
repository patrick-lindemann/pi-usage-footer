import assert from "node:assert/strict";
import { test } from "node:test";
import { bundledEndpoints } from "../src/config/defaults.ts";
import { fetchUsage, resolveProvider } from "../src/providers/providers.ts";

const context = {
  model: { provider: "custom" },
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer test" } }) },
};

test("prefers exact endpoint overrides to family overrides and bundled URLs", () => {
  const exact = ["https://quota.example/codex-account"];
  const family = ["https://quota.example/codex"];
  const overrides = new Map([
    ["openai-codex-2", exact],
    ["openai-codex", family],
  ]);
  assert.equal(resolveProvider("openai-codex-2", overrides).urls, exact);
  assert.equal(resolveProvider("openai-codex-2", overrides).cacheKey, "openai-codex-2");
  assert.equal(resolveProvider("openai-codex-3", overrides).urls, family);
  assert.equal(resolveProvider("openai-codex-3", new Map()).urls, bundledEndpoints["openai-codex"]);
  assert.equal(resolveProvider("missing", overrides), undefined);
});

test("fetches normalized windows for a configured provider and tries fallback URLs", async (t) => {
  const urls = ["https://quota.example/first", "https://quota.example/second"];
  const fetch = t.mock.method(globalThis, "fetch", async (url) =>
    url === urls[0]
      ? new Response(null, { status: 503 })
      : Response.json({ fiveHour: { usedPercent: 0, resetAt: 1_900_000_000_000 }, weekly: { usedPercent: 101 } }),
  );
  const provider = resolveProvider("custom", new Map([["custom", urls]]));
  const snapshot = await fetchUsage(provider, context);
  assert.deepEqual(snapshot.fiveHour, { usedPercent: 0, resetAt: 1_900_000_000_000 });
  assert.equal(snapshot.weekly, undefined);
  assert.deepEqual(
    fetch.mock.calls.map(({ arguments: args }) => args[0]),
    urls,
  );
  for (const {
    arguments: [, options],
  } of fetch.mock.calls) {
    assert.equal(options.headers.Authorization, "Bearer test");
    assert.equal(options.redirect, "error");
  }
});
