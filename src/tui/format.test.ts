import { describe, expect, test } from "bun:test";
import type { Account } from "../domain.ts";
import {
  darkTheme,
  detectThemeName,
  healthBadge,
  meter,
  percentLabel,
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
});
