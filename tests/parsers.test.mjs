import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseCopilotUsage,
  parseGlmUsage,
  parseKimiUsage,
  parseOpenCodeUsage,
} from "../src/providers/parsers.ts";

const cases = [
  [
    "Codex",
    parseCodexUsage,
    { rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000 } } },
    "fiveHour",
  ],
  ["Claude", parseClaudeUsage, { seven_day: { utilization: 42 } }, "weekly"],
  ["OpenCode", parseOpenCodeUsage, { usage: { monthly: { percent: 42 } } }, "monthly"],
  ["GLM", parseGlmUsage, { data: { limits: [{ unit: 6, number: 7, usage: "100", currentValue: "42" }] } }, "weekly"],
  ["Kimi", parseKimiUsage, { usage: { limit: "100", used: "42" }, limit7d: { usedRatio: 0 } }, "weekly"],
  [
    "Copilot",
    parseCopilotUsage,
    { quota_snapshots: { code: { unlimited: true }, premium_interactions: { percent_remaining: 58 } } },
    "monthly",
  ],
];

for (const [name, parse, payload, window] of cases) {
  test(`normalizes ${name} quota windows and ignores unrelated responses`, () => {
    const snapshot = parse(payload);
    assert.equal(snapshot[window].usedPercent, 42);
    assert.equal(parse({}), undefined);
  });
}
