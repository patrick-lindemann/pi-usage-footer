/** Quota windows understood by the footer. */
export const windowKinds = ["fiveHour", "weekly", "monthly"] as const;

export type WindowKind = (typeof windowKinds)[number];

export interface UsageWindow {
  usedPercent: number;
  /** Unix timestamp in milliseconds. */
  resetAt?: number;
}

export type Snapshot = { fetchedAt: number } & Partial<Record<WindowKind, UsageWindow>>;

/**
 * Reads an object from untrusted JSON.
 *
 * @param value The parsed value to inspect.
 * @returns The object, or undefined for arrays, null and primitives.
 */
export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads a finite number from an untrusted field.
 *
 * @param value The value to inspect.
 * @returns The number if finite, otherwise undefined.
 */
export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
