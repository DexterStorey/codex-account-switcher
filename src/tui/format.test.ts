import { describe, expect, test } from "bun:test";
import type { Account, UsageHistoryPoint } from "../domain.ts";
import {
  areaChart,
  darkTheme,
  detectThemeName,
  healthBadge,
  historyStats,
  meter,
  percentLabel,
  shortWindow,
  sparkline,
} from "./format.ts";

const points = (pcts: number[]): UsageHistoryPoint[] =>
  pcts.map((usedPercent, at) => ({ at, usedPercent }));

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

  test("sparkline is fixed-scale and right-aligns a short series", () => {
    expect(sparkline(points([0]), 4)).toBe("   ▁");
    expect(sparkline(points([100]), 4)).toBe("   █");
    expect(sparkline([], 4)).toBe("····");
    expect(sparkline(points([95, 95, 95]), 4)).toBe(" ███");
  });

  test("area chart is fixed-scale, top row first, and right-sized", () => {
    const chart = areaChart(points([0, 50, 100]), 3, 2);
    expect(chart).toHaveLength(2);
    for (const row of chart) {
      expect(row).toHaveLength(3);
    }
    expect(chart[0]?.[2]).toBe("█");
    expect(chart[0]?.[0]).toBe(" ");
    expect(areaChart([], 4, 3).every((row) => row === "    ")).toBe(true);
  });

  test("history stats report now, peak, and average", () => {
    expect(historyStats(points([10, 90, 50]))).toEqual({ now: 50, peak: 90, average: 50 });
    expect(historyStats([])).toEqual({ now: null, peak: null, average: null });
  });
});
