import { describe, expect, test } from "bun:test";
import type { Account, ProviderState, UsageSnapshot } from "./domain.ts";
import { pickDefaultAccount, selectRotation } from "./selection.ts";

const activeId = "00000000-0000-4000-8000-000000000001";
const lowerId = "00000000-0000-4000-8000-000000000002";
const lowestId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-07-10T12:00:00.000Z");

function account(id: string, health: Account["health"] = "ready"): Account {
  const email = `account-${id.slice(-1)}@example.com`;
  return {
    id,
    provider: "openai",
    label: email,
    identity: email,
    externalAccountId: id,
    externalUserId: id,
    secretReference: `secret:${id}`,
    profilePath: null,
    health,
    enabled: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function usage(id: string, usedPercent: number, observedAt = now.toISOString()): UsageSnapshot {
  return {
    accountId: id,
    provider: "openai",
    observedAt,
    source: "codexUsageEndpoint",
    windows: [{ id: "five-hour", label: "5 hour", usedPercent, resetAt: null, kind: "hard" }],
    hardLimitReached: false,
  };
}

function state(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    provider: "openai",
    activeAccountId: activeId,
    generation: 1,
    switchedAt: "2026-07-10T11:00:00.000Z",
    policy: {
      provider: "openai",
      enabled: true,
      thresholdPercent: 95,
      hysteresisPercent: 5,
      minimumDwellMilliseconds: 300_000,
      maximumSnapshotAgeMilliseconds: 120_000,
      authorization: "confirmed",
    },
    ...overrides,
  };
}

describe("selectRotation", () => {
  test("chooses the fresh eligible account with the lowest worst-window pressure", () => {
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId), account(lowestId)],
        usage: [usage(activeId, 95), usage(lowerId, 30), usage(lowestId, 10)],
        state: state(),
        now,
      }),
    ).toEqual({
      rotate: true,
      sourceAccountId: activeId,
      targetAccountId: lowestId,
      sourcePressure: 95,
      targetPressure: 10,
      reason: "threshold",
    });
  });

  test("never treats missing or stale usage as zero", () => {
    const stale = "2026-07-10T11:00:00.000Z";
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId), account(lowestId)],
        usage: [usage(activeId, 99), usage(lowerId, 1, stale)],
        state: state(),
        now,
      }),
    ).toEqual({ rotate: false, reason: "noEligibleCandidate" });
  });

  test("gates automation on explicit provider authorization", () => {
    const unauthorized = state({ policy: { ...state().policy, authorization: "notConfirmed" } });
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId)],
        usage: [usage(activeId, 99), usage(lowerId, 1)],
        state: unauthorized,
        now,
      }),
    ).toEqual({ rotate: false, reason: "authorizationRequired" });
  });

  test("uses the worst hard window, not only the five-hour window", () => {
    const weeklyLimited = usage(lowerId, 5);
    weeklyLimited.windows.push({
      id: "weekly",
      label: "Weekly",
      usedPercent: 94,
      resetAt: null,
      kind: "hard",
    });
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId), account(lowestId)],
        usage: [usage(activeId, 96), weeklyLimited, usage(lowestId, 20)],
        state: state(),
        now,
      }),
    ).toMatchObject({ rotate: true, targetAccountId: lowestId });
  });

  test("rotates immediately for an authoritative hard limit", () => {
    const limited = usage(activeId, 40);
    limited.hardLimitReached = true;
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId)],
        usage: [limited, usage(lowerId, 10)],
        state: state(),
        now,
      }),
    ).toMatchObject({ rotate: true, targetAccountId: lowerId, reason: "hardLimit" });
  });

  test("honors minimum dwell time to prevent oscillation", () => {
    expect(
      selectRotation({
        accounts: [account(activeId), account(lowerId)],
        usage: [usage(activeId, 99), usage(lowerId, 10)],
        state: state({ switchedAt: "2026-07-10T11:59:00.000Z" }),
        now,
      }),
    ).toEqual({ rotate: false, reason: "minimumDwell" });
  });
});

describe("pickDefaultAccount", () => {
  test("prefers healthy accounts with the lowest measured pressure, then stable order", () => {
    expect(
      pickDefaultAccount({
        accounts: [account(activeId), account(lowerId), account(lowestId)],
        usage: [usage(activeId, 60), usage(lowerId, 10)],
      })?.id,
      // lowestId has no reading, so measured accounts win even at higher usage.
    ).toBe(lowerId);
    expect(
      pickDefaultAccount({
        accounts: [account(activeId, "reauthenticationRequired"), account(lowerId)],
        usage: [usage(activeId, 5)],
      })?.id,
    ).toBe(lowerId);
    expect(
      pickDefaultAccount({ accounts: [account(lowerId), account(activeId)], usage: [] })?.id,
    ).toBe(activeId);
    expect(pickDefaultAccount({ accounts: [], usage: [] })).toBeNull();
  });
});
