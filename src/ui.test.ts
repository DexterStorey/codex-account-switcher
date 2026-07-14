import { describe, expect, test } from "bun:test";
import { DashboardSnapshotSchema } from "./domain.ts";
import { renderDashboard } from "./ui.ts";

describe("dashboard", () => {
  test("renders every window, marks stale telemetry, and bounds long identities", () => {
    const sampledAt = "2026-07-10T12:00:00.000Z";
    const snapshot = DashboardSnapshotSchema.parse({
      accounts: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          provider: "openai",
          label: "an-excessively-long-account-email-address-for-dashboard@example.test",
          identity: "an-excessively-long-account-email-address-for-dashboard@example.test",
          externalAccountId: "account-1",
          externalUserId: "user-1",
          secretReference: "keychain:account-1",
          profilePath: null,
          health: "loginExpiring",
          enabled: true,
          createdAt: sampledAt,
          updatedAt: sampledAt,
        },
      ],
      usage: [
        {
          accountId: "00000000-0000-4000-8000-000000000001",
          provider: "openai",
          observedAt: "2026-07-10T11:55:00.000Z",
          source: "codexUsageEndpoint",
          windows: [
            {
              id: "codex:primary",
              label: "5 hour",
              usedPercent: 94.6,
              resetAt: null,
              kind: "hard",
            },
            {
              id: "codex:secondary",
              label: "7 day",
              usedPercent: 12,
              resetAt: null,
              kind: "hard",
            },
            {
              id: "reviews:primary",
              label: "Code review",
              usedPercent: 3,
              resetAt: null,
              kind: "hard",
            },
          ],
          hardLimitReached: false,
        },
      ],
      providers: [
        {
          provider: "openai",
          activeAccountId: "00000000-0000-4000-8000-000000000001",
          generation: 2,
          switchedAt: sampledAt,
          policy: {
            provider: "openai",
            enabled: true,
            thresholdPercent: 95,
            hysteresisPercent: 5,
            minimumDwellMilliseconds: 300_000,
            maximumSnapshotAgeMilliseconds: 120_000,
            authorization: "confirmed",
          },
        },
        {
          provider: "anthropic",
          activeAccountId: null,
          generation: 0,
          switchedAt: null,
          policy: {
            provider: "anthropic",
            enabled: false,
            thresholdPercent: 95,
            hysteresisPercent: 5,
            minimumDwellMilliseconds: 300_000,
            maximumSnapshotAgeMilliseconds: 120_000,
            authorization: "notConfirmed",
          },
        },
      ],
      sessions: [],
      sampledAt,
    });

    const rendered = renderDashboard(snapshot, new Date(sampledAt));
    expect(rendered).toContain("CODEX · CLAUDE · PI LIMIT CONTROL");
    expect(rendered).toContain("94.6%");
    expect(rendered).toContain("Code review");
    expect(rendered).toContain("STALE");
    expect(rendered).toContain("login expiring");
    expect(rendered).not.toContain(
      "an-excessively-long-account-email-address-for-dashboard@example.test",
    );
    expect(rendered.match(/an-excessively/g)).toHaveLength(1);
  });
});
