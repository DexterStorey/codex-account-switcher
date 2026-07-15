import { describe, expect, test } from "bun:test";
import type { Account } from "../domain.ts";
import {
  brailleLine,
  bucketSeries,
  darkTheme,
  detectThemeName,
  healthBadge,
  mergedPressureSeries,
  meter,
  percentLabel,
  planLabel,
  relativeAge,
  resetCountdown,
  shortWindow,
} from "./format.ts";

const base: Account = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "openai",
  label: "a@b.com",
  identity: "a@b.com",
  externalAccountId: "x",
  externalUserId: "y",
  secretReference: "codex:x",
  profilePath: null,
  health: "ready",
  enabled: true,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
};

describe("tui format", () => {
  test("meter fills proportionally and null renders as dots", () => {
    expect(meter(50, 10)).toBe("█████░░░░░");
    expect(meter(0, 4)).toBe("░░░░");
    expect(meter(100, 4)).toBe("████");
    expect(meter(null, 4)).toBe("····");
  });

  test("percent label right-pads and marks unknown", () => {
    expect(percentLabel(7)).toBe("  7%");
    expect(percentLabel(null)).toBe("  ?%");
  });

  test("health badge only surfaces non-healthy states", () => {
    expect(healthBadge(darkTheme, base)).toBeNull();
    // Healthy-ish transient states stay quiet; only actionable ones show.
    expect(healthBadge(darkTheme, { ...base, health: "refreshing" })).toBeNull();
    expect(healthBadge(darkTheme, { ...base, health: "reauthenticationRequired" })?.text).toBe(
      "⚠ login",
    );
  });

  test("window labels compress to a distinctive token", () => {
    expect(shortWindow("5 hour")).toBe("5h");
    expect(shortWindow("7 day · all models")).toBe("7d");
    expect(shortWindow("GPT-5.3-Codex-Spark")).toBe("Spark");
  });

  test("theme detection honors override, then COLORFGBG, then defaults dark", () => {
    expect(detectThemeName({ TOKMAX_THEME: "light" })).toBe("light");
    expect(detectThemeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectThemeName({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectThemeName({})).toBe("dark");
  });

  test("relative age compresses to the largest unit", () => {
    const now = 1_000_000_000;
    expect(relativeAge(now - 3_000, now)).toBe("3s");
    expect(relativeAge(now - 90_000, now)).toBe("1m");
    expect(relativeAge(now - 7_200_000, now)).toBe("2h");
  });

  test("bucketSeries resamples onto the window and carries readings forward", () => {
    const now = 100_000;
    // One sample per 10s over the last 100s, bucketed into 5 columns of 20s.
    const series = [
      { at: now - 90_000, usedPercent: 10 },
      { at: now - 50_000, usedPercent: 50 },
      { at: now - 10_000, usedPercent: 90 },
    ];
    const buckets = bucketSeries(series, 100_000, now, 5);
    expect(buckets).toHaveLength(5);
    // Last column holds the most recent reading; gaps carry the prior value.
    expect(buckets[4]).toBe(90);
    expect(buckets.every((value) => value !== null)).toBe(true);
  });

  test("bucketSeries leaves columns before the first sample empty", () => {
    const now = 100_000;
    const buckets = bucketSeries([{ at: now - 5_000, usedPercent: 40 }], 100_000, now, 4);
    expect(buckets[0]).toBeNull();
    expect(buckets[3]).toBe(40);
  });

  test("mergedPressureSeries takes the max across windows per timestamp", () => {
    const merged = mergedPressureSeries([
      {
        points: [
          { at: 1, usedPercent: 20 },
          { at: 2, usedPercent: 30 },
        ],
      },
      {
        points: [
          { at: 1, usedPercent: 80 },
          { at: 2, usedPercent: 10 },
        ],
      },
    ]);
    expect(merged).toEqual([
      { at: 1, usedPercent: 80 },
      { at: 2, usedPercent: 30 },
    ]);
  });

  test("brailleLine returns a sized grid of braille glyphs", () => {
    const rows = brailleLine([0, 25, 50, 75, 100, 100], 3, 2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveLength(3);
    }
    // A rising series must light the top row on its right and leave the far
    // left of the top row blank.
    expect(rows[0]?.[2]).not.toBe(" ");
    expect(rows[0]?.[0]).toBe(" ");
  });

  test("resetCountdown compresses to the largest unit and floors at now", () => {
    const now = 1_000_000_000;
    expect(resetCountdown(null, now)).toBeNull();
    expect(resetCountdown(new Date(now - 1000).toISOString(), now)).toBe("now");
    expect(resetCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toBe("25m");
    expect(resetCountdown(new Date(now + 134 * 60_000).toISOString(), now)).toBe("2h 14m");
    expect(resetCountdown(new Date(now + 27 * 3_600_000).toISOString(), now)).toBe("1d 3h");
  });

  test("planLabel prettifies tiers including claude multipliers", () => {
    expect(planLabel(null)).toBeNull();
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("claude_max_20x")).toBe("Max 20×");
    expect(planLabel("max")).toBe("Max");
  });
});
