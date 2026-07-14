import { describe, expect, test } from "bun:test";
import { fetchClaudeUsage } from "./usage.ts";

// Captured verbatim (values included) from api.anthropic.com/api/oauth/usage on
// 2026-07-14. utilization is a whole percentage here, not a fraction, and the
// authoritative readings live in the limits array.
const liveResponse = {
  five_hour: {
    utilization: 9.0,
    resets_at: "2026-07-15T02:00:00.315796+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 3.0,
    resets_at: "2026-07-21T18:00:00.315820+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  tangelo: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 9,
      severity: "normal",
      resets_at: "2026-07-15T02:00:00.315796+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 3,
      severity: "normal",
      resets_at: "2026-07-21T18:00:00.315820+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 4,
      severity: "normal",
      resets_at: "2026-07-21T18:00:00.316175+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: null,
    percent: 0,
    severity: "normal",
    enabled: false,
  },
  member_dashboard_available: false,
};

describe("Claude usage", () => {
  test("parses the live percent-scale response through the limits array", async () => {
    const snapshot = await fetchClaudeUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      accessToken: "secret",
      fetchImplementation: async () => new Response(JSON.stringify(liveResponse), { status: 200 }),
    });
    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["session", 9],
      ["weekly_all", 3],
      ["weekly_scoped:fable", 4],
    ]);
    expect(snapshot.windows.map((window) => window.label)).toEqual([
      "5h session",
      "7 day · all models",
      "7 day · Fable",
    ]);
    expect(snapshot.windows.every((window) => window.kind === "hard")).toBe(true);
    expect(snapshot.hardLimitReached).toBe(false);
    // The legacy five_hour/seven_day objects must not duplicate limit windows.
    expect(snapshot.windows).toHaveLength(3);
  });

  test("still converts legacy fraction responses without a limits array", async () => {
    const snapshot = await fetchClaudeUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      accessToken: "secret",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 0.27, resets_at: "2026-07-10T15:00:00Z" },
            seven_day: { utilization: 0.05, resets_at: "2026-07-17T00:00:00Z" },
            seven_day_new_model: { utilization: 0.12 },
            experimental_addition: { value: true },
          }),
          { status: 200 },
        ),
    });
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([27, 5, 12]);
  });

  test("treats utilization above one as a percentage, capped at 100", async () => {
    const snapshot = await fetchClaudeUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      accessToken: "secret",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({ five_hour: { utilization: 104.2 }, seven_day: { utilization: 42 } }),
          { status: 200 },
        ),
    });
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([100, 42]);
    expect(snapshot.hardLimitReached).toBe(true);
  });

  test("marks exhausted severities as a hard limit even below 100 percent", async () => {
    const snapshot = await fetchClaudeUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      accessToken: "secret",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            limits: [{ kind: "session", percent: 97, severity: "exceeded", scope: null }],
          }),
          { status: 200 },
        ),
    });
    expect(snapshot.hardLimitReached).toBe(true);
  });
});
