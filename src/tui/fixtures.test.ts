import { describe, expect, test } from "bun:test";
import { AnalyticsSnapshotSchema } from "../domain.ts";
import { buildScenario, FIXTURE_NOW, SCENARIO_NAMES } from "./fixtures.ts";

describe("tui fixtures", () => {
  test("every scenario is a schema-valid AnalyticsSnapshot", () => {
    expect(SCENARIO_NAMES.length).toBeGreaterThan(0);
    for (const name of SCENARIO_NAMES) {
      expect(() => AnalyticsSnapshotSchema.parse(buildScenario(name))).not.toThrow();
    }
  });

  test("building a scenario is deterministic for a fixed clock", () => {
    expect(buildScenario("cruising", FIXTURE_NOW)).toEqual(buildScenario("cruising", FIXTURE_NOW));
  });

  test("history has one entry per account, mirroring account ids and order", () => {
    const { snapshot, history } = buildScenario("cruising");
    expect(history.map((entry) => entry.accountId)).toEqual(
      snapshot.accounts.map((account) => account.id),
    );
  });

  test("the active account can draw a chart: its history covers its hard windows within 24h", () => {
    const analytics = buildScenario("oneHot");
    const active = analytics.snapshot.providers.find(
      (state) => state.provider === "openai",
    )?.activeAccountId;
    expect(active).toBeTruthy();
    const usage = analytics.snapshot.usage.find((entry) => entry.accountId === active);
    const hardIds = new Set(
      (usage?.windows ?? []).filter((window) => window.kind === "hard").map((window) => window.id),
    );
    expect(hardIds.size).toBeGreaterThan(0);
    const series = analytics.history.find((entry) => entry.accountId === active)?.windows ?? [];
    // Every hard window has a matching history series (the chart filters by id).
    for (const id of hardIds) {
      expect(series.some((window) => window.windowId === id)).toBe(true);
    }
    // At least one point falls inside the default 24h timeframe so a line draws.
    const dayAgo = FIXTURE_NOW - 24 * 3_600_000;
    const recent = series.flatMap((window) => window.points).filter((point) => point.at >= dayAgo);
    expect(recent.length).toBeGreaterThan(0);
  });

  test("onboarding is empty with no active accounts", () => {
    const analytics = buildScenario("onboarding");
    expect(analytics.snapshot.accounts).toHaveLength(0);
    expect(analytics.snapshot.providers.every((state) => state.activeAccountId === null)).toBe(
      true,
    );
  });

  test("unknown scenarios fail loudly", () => {
    expect(() => buildScenario("nope")).toThrow(/Unknown fixture scenario/);
  });
});
