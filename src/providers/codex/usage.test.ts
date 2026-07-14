import { describe, expect, test } from "bun:test";
import type { CodexAuth } from "./auth.ts";
import { fetchCodexUsage } from "./usage.ts";

function token(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const credential: CodexAuth = {
  tokens: {
    id_token: token({ email: "a@b.com", chatgpt_account_id: "upstream" }),
    access_token: token({ exp: 2_000_000_000 }),
    refresh_token: "refresh",
  },
};

describe("Codex usage", () => {
  test("normalizes every primary, secondary, and additional window", async () => {
    let requests = 0;
    const snapshot = await fetchCodexUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      credential,
      fetchImplementation: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 50,
                reset_at: 2_000_000_000,
                limit_window_seconds: 18_000,
              },
              secondary_window: { used_percent: 70, limit_window_seconds: 604_800 },
            },
            additional_rate_limits: [
              {
                limit_name: "Review",
                metered_feature: "review",
                rate_limit: { primary_window: { used_percent: 20 } },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    expect(requests).toBe(3);
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([50, 70, 20]);
    expect(snapshot.windows.map((window) => window.label)).toEqual([
      "5 hour",
      "7 day",
      "Review · primary",
    ]);
    expect(snapshot.hardLimitReached).toBe(false);
  });

  test("rejects an anomalous reset bucket with majority sampling", async () => {
    let request = 0;
    const snapshot = await fetchCodexUsage({
      accountId: "00000000-0000-4000-8000-000000000001",
      credential,
      fetchImplementation: async () => {
        request += 1;
        const anomalous = request === 1;
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: anomalous ? 4 : 96,
                reset_at: anomalous ? 2_100_000_000 : 2_000_000_000,
                limit_window_seconds: 18_000,
              },
            },
          }),
          { status: 200 },
        );
      },
    });
    expect(snapshot.windows[0]?.usedPercent).toBe(96);
    expect(snapshot.windows[0]?.resetAt).toBe(new Date(2_000_000_000 * 1000).toISOString());
  });
});
