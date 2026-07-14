import { describe, expect, test } from "bun:test";
import { fetchClaudeUsage } from "./usage.ts";

describe("Claude usage", () => {
  test("converts provider utilization fractions into percentages", async () => {
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

  test("rejects percentages masquerading as utilization fractions", async () => {
    await expect(
      fetchClaudeUsage({
        accountId: "00000000-0000-4000-8000-000000000001",
        accessToken: "secret",
        fetchImplementation: async () =>
          new Response(JSON.stringify({ five_hour: { utilization: 27 } }), { status: 200 }),
      }),
    ).rejects.toThrow();
  });
});
