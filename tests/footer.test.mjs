import assert from "node:assert/strict";
import { test } from "node:test";
import { rgbColor } from "@earendil-works/pi-tui";
import { formatQuota } from "../src/footer.ts";

const theme = {
  fg(color, text) {
    return `${color}:${text}`;
  },
  style(text, { fg }) {
    return `${JSON.stringify(fg)}:${text}`;
  },
};
const display = {
  windows: ["fiveHour"],
  format: "{percent}%",
  quotaColors: {
    normal: "lightgray",
    warning: { at: 70, color: "#fe9800" },
    critical: { at: 85, color: "accent" },
  },
};

test("applies named, hex and Pi theme colors at the configured thresholds", () => {
  assert.equal(
    formatQuota({ fiveHour: { usedPercent: 69 } }, display, theme),
    `${JSON.stringify(rgbColor(211, 211, 211))}:69%`,
  );
  assert.equal(
    formatQuota({ fiveHour: { usedPercent: 70 } }, display, theme),
    `${JSON.stringify(rgbColor(254, 152, 0))}:70%`,
  );
  assert.equal(formatQuota({ fiveHour: { usedPercent: 85 } }, display, theme), "accent:85%");
});

test("renders quota text without coloring when colors are disabled", () => {
  assert.equal(formatQuota({ fiveHour: { usedPercent: 95 } }, { ...display, quotaColors: false }, theme), "95%");
});
