import { describe, expect, test } from "bun:test";
import type { Account, UsageHistoryPoint } from "../domain.ts";
import {
  darkTheme,
  detectThemeName,
  healthBadge,
  meter,
  percentLabel,
  resetLabel,
  shortWindow,
  sparkline,
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

  test("sparkline uses a fixed 0..100 scale and right-aligns short series", () => {
    const points = (pcts: number[]): UsageHistoryPoint[] =>
      pcts.map((usedPercent, i) => ({ at: i, usedPercent }));
    expect(sparkline(points([0]), 4)).toBe("   ▁");
    expect(sparkline(points([100]), 4)).toBe("   █");
    expect(sparkline([], 4)).toBe("····");
    // A high-but-flat window reads high, not as mid-scale noise.
    expect(sparkline(points([95, 95, 95]), 4)).toBe(" ███");
  });

  test("percent label right-pads and marks unknown", () => {
    expect(percentLabel(7)).toBe("  7%");
    expect(percentLabel(null)).toBe("  ?%");
  });

  test("reset label compresses to the largest unit", () => {
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    expect(resetLabel("2026-07-10T12:30:00.000Z", now)).toBe("30m");
    expect(resetLabel("2026-07-10T15:30:00.000Z", now)).toBe("3h 30m");
    expect(resetLabel("2026-07-16T12:00:00.000Z", now)).toBe("6d");
    expect(resetLabel(null, now)).toBe("");
  });

  test("health badge only surfaces non-healthy states", () => {
    expect(healthBadge(darkTheme, base)).toBeNull();
    expect(healthBadge(darkTheme, { ...base, health: "reauthenticationRequired" })?.text).toBe(
      "login required",
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
});
