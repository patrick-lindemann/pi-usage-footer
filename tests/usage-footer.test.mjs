import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

test("renders live status entries without changing quota placement or migrating config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-footer-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
    await rm(dir, { recursive: true });
  });
  const configPath = join(dir, "usage-footer.json");
  const config = JSON.stringify({ quotaWindow: "hidden", displayMode: "used", refreshIntervalSeconds: 45 });
  const schedule = t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  const cancel = t.mock.method(globalThis, "clearInterval", () => {});
  await writeFile(configPath, config);

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } },
    }),
  );
  const { default: registerExtension } = await import("../src/index.ts");
  const handlers = new Map();
  registerExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    getThinkingLevel: () => "high",
  });

  const statuses = new Map();
  const theme = { fg: (_, text) => text };
  const footerData = {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => statuses,
    onBranchChange: () => () => {},
  };
  let footer;
  const ctx = {
    model: { id: "example-model", provider: "openai-codex", reasoning: true, contextWindow: 1000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
    sessionManager: { getEntries: () => [], getCwd: () => dir },
    getContextUsage: () => ({ contextWindow: 1000, percent: 1 }),
    ui: {
      setFooter: (factory) => {
        footer = factory({ requestRender() {} }, theme, footerData);
      },
    },
  };
  t.after(() => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);

  const baseline = footer.render(120);
  assert.equal(baseline.length, 2);
  assert.match(baseline[1], /example-model • high • 42%\/5h$/);
  assert.equal(await readFile(configPath, "utf8"), config);

  const speed = "\x1b[32m52.5 tok/s\x1b[39m";
  statuses.set("token-speed", speed);
  statuses.set("clock", "Ready\nnow");
  const wide = footer.render(120);
  assert.equal(wide.length, 2);
  assert.ok(wide[1].endsWith(`example-model • high • Ready now • ${speed} • 42%/5h`));

  const narrow = footer.render(44);
  assert.equal(narrow.length, 3);
  assert.match(narrow[1], /example-model • high • 42%\/5h$/);
  assert.equal(narrow[2], `Ready now • ${speed}`);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 44));

  statuses.set("token-speed", "61.0 tok/s");
  assert.match(footer.render(120)[1], /61\.0 tok\/s • 42%\/5h$/);

  statuses.clear();
  assert.deepEqual(footer.render(120), baseline);
  assert.equal(schedule.mock.calls[0].arguments[1], 45_000);
  handlers.get("session_shutdown")();
  assert.equal(cancel.mock.calls[0].arguments[0], schedule.mock.calls[0].result);

  await writeFile(configPath, JSON.stringify({ refreshIntervalSeconds: 0, statusPlacement: "separate" }));
  await handlers.get("session_start")({}, ctx);
  assert.equal(schedule.mock.callCount(), 1);

  statuses.set("token-speed", speed);
  statuses.set("clock", "Ready\nnow");
  const separated = footer.render(120);
  assert.equal(separated.length, 3);
  assert.equal(separated[2], `Ready now • ${speed}`);
  assert.match(separated[1], /example-model • high • 42%\/5h$/);
});
