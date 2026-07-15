import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, ProviderId, UsageSnapshot } from "./domain.ts";

type OpenAiAccount = Extract<Account, { provider: "openai" }>;

import { AccountManager } from "./manager.ts";
import { applicationPaths } from "./paths.ts";
import type { CredentialVault } from "./providers/codex/auth.ts";
import type { ProviderAdapter, ProviderProbeResult } from "./providers/provider.ts";
import { createStateStore } from "./storage.ts";

const temporaryDirectories: string[] = [];
const now = new Date("2026-07-10T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function account(id: string, label: string): OpenAiAccount {
  const email = `${label}@example.com`;
  return {
    id,
    provider: "openai",
    label: email,
    identity: email,
    externalAccountId: `upstream-${id}`,
    externalUserId: `user-${id}`,
    secretReference: `secret-${id}`,
    profilePath: null,
    health: "ready",
    enabled: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function usage(target: Account, usedPercent = 10): UsageSnapshot {
  return {
    accountId: target.id,
    provider: "openai",
    observedAt: now.toISOString(),
    source: "codexUsageEndpoint",
    windows: [{ id: "primary", label: "5 hour", usedPercent, resetAt: null, kind: "hard" }],
    hardLimitReached: false,
  };
}

const inertVault: CredentialVault = {
  read: async () => null,
  write: async () => undefined,
  remove: async () => undefined,
};

function inertAdapter(provider: ProviderId): ProviderAdapter {
  return {
    provider,
    probe: async () => {
      throw new Error("Unexpected probe");
    },
  };
}

async function harness(probe: (account: Account) => Promise<ProviderProbeResult>) {
  const directory = await mkdtemp(join(tmpdir(), "manager-test-"));
  temporaryDirectories.push(directory);
  const paths = applicationPaths({ TOKMAX_HOME: directory });
  const store = createStateStore(paths.database);
  const source = account("00000000-0000-4000-8000-000000000001", "source");
  const target = account("00000000-0000-4000-8000-000000000002", "target");
  store.saveAccount(source);
  store.saveAccount(target);
  store.saveProviderState({
    ...store.findProviderState("openai"),
    activeAccountId: source.id,
    generation: 1,
    switchedAt: "2026-07-10T11:00:00.000Z",
  });
  const probes: string[] = [];
  const openai: ProviderAdapter = {
    provider: "openai",
    probe: async (candidate) => {
      probes.push(candidate.label);
      return probe(candidate);
    },
  };
  const manager = new AccountManager({
    paths,
    store,
    vault: inertVault,
    dependencies: { now: () => now },
    adapters: { openai, anthropic: inertAdapter("anthropic") },
  });
  return { manager, store, source, target, probes };
}

describe("AccountManager switching", () => {
  test("probes the target and commits a new generation", async () => {
    const test_ = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    await test_.manager.switchAccount("openai", test_.target.id, "manual");
    expect(test_.probes).toEqual(["target@example.com"]);
    expect(test_.store.findProviderState("openai")).toMatchObject({
      activeAccountId: test_.target.id,
      generation: 2,
    });
    expect(test_.store.listSwitchRecords()[0]).toMatchObject({
      phase: "committed",
      reason: "manual",
    });
    test_.store.close();
  });

  test("does not re-probe when reasserting the already-active account", async () => {
    const test_ = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    await test_.manager.switchAccount("openai", test_.source.id, "reassert");
    expect(test_.probes).toEqual([]);
    expect(test_.store.findProviderState("openai").generation).toBe(2);
    test_.store.close();
  });

  test("refuses an unusable target and leaves the active account unchanged", async () => {
    const test_ = await harness(async () => {
      throw new Error("credential rejected");
    });
    await expect(test_.manager.switchAccount("openai", test_.target.id, "manual")).rejects.toThrow(
      "credential rejected",
    );
    expect(test_.store.findProviderState("openai").activeAccountId).toBe(test_.source.id);
    test_.store.close();
  });

  test("rejects a target that is not an enabled account of the provider", async () => {
    const test_ = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    await expect(test_.manager.switchAccount("openai", "does-not-exist", "manual")).rejects.toThrow(
      "not an enabled openai account",
    );
    test_.store.close();
  });

  test("serializes concurrent operations for the same provider", async () => {
    let releaseProbe: (() => void) | undefined;
    let reportProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let blockSourceProbe = true;
    const test_ = await harness(async (candidate) => {
      if (candidate.label === "source@example.com" && blockSourceProbe) {
        reportProbeStarted?.();
        await probeReleased;
        blockSourceProbe = false;
      }
      return { account: candidate, usage: usage(candidate) };
    });
    const refresh = test_.manager.refreshAccount(test_.source);
    await probeStarted;
    const switching = test_.manager.switchAccount("openai", test_.target.id, "manual");
    await Bun.sleep(10);
    // The switch cannot probe the target until the in-flight refresh releases.
    expect(test_.probes).toEqual(["source@example.com"]);
    releaseProbe?.();
    await Promise.all([refresh, switching]);
    expect(test_.probes).toEqual(["source@example.com", "target@example.com"]);
    test_.store.close();
  });

  test("automatically rotates at the threshold to the least-used healthy account", async () => {
    const test_ = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate, candidate.label === "source@example.com" ? 95 : 12),
    }));
    test_.store.saveAutomationPolicy({
      ...test_.store.findProviderState("openai").policy,
      enabled: true,
      authorization: "confirmed",
    });
    await test_.manager.refreshAll();
    expect(test_.store.findProviderState("openai").activeAccountId).toBe(test_.target.id);
    expect(test_.store.listSwitchRecords()[0]).toMatchObject({
      phase: "committed",
      reason: "automatic:threshold",
    });
    test_.store.close();
  });
});

describe("probe backoff", () => {
  test("a rate-limited account is not re-probed until its cooldown passes", async () => {
    const { ApplicationError } = await import("./errors.ts");
    const directory = await mkdtemp(join(tmpdir(), "manager-backoff-test-"));
    temporaryDirectories.push(directory);
    const paths = applicationPaths({ TOKMAX_HOME: directory });
    const store = createStateStore(paths.database);
    const limited = account("00000000-0000-4000-8000-000000000011", "limited");
    store.saveAccount(limited);
    let currentTime = now.getTime();
    let probes = 0;
    const adapter: ProviderAdapter = {
      provider: "openai",
      probe: async () => {
        probes += 1;
        throw new ApplicationError("USAGE_RATE_LIMITED", "429");
      },
    };
    const manager = new AccountManager({
      paths,
      store,
      vault: inertVault,
      dependencies: { now: () => new Date(currentTime) },
      adapters: { openai: adapter, anthropic: inertAdapter("anthropic") },
    });
    await manager.refreshAll();
    expect(probes).toBe(1);
    expect(store.findAccount(limited.id)?.health).toBe("usageRateLimited");
    currentTime += 60_000;
    await manager.refreshAll();
    expect(probes).toBe(1);
    currentTime += 5 * 60_000;
    await manager.refreshAll();
    expect(probes).toBe(2);
    store.close();
  });
});

describe("probe cadence", () => {
  test("idle accounts are probed at a coarser interval than the active account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "manager-cadence-test-"));
    temporaryDirectories.push(directory);
    const paths = applicationPaths({ TOKMAX_HOME: directory });
    const store = createStateStore(paths.database);
    const active = account("00000000-0000-4000-8000-000000000021", "active");
    const idle = account("00000000-0000-4000-8000-000000000022", "idle");
    store.saveAccount(active);
    store.saveAccount(idle);
    store.saveProviderState({
      ...store.findProviderState("openai"),
      activeAccountId: active.id,
      generation: 1,
      switchedAt: now.toISOString(),
    });
    let currentTime = now.getTime();
    const probes: string[] = [];
    const adapter: ProviderAdapter = {
      provider: "openai",
      probe: async (candidate) => {
        probes.push(candidate.label);
        return { account: candidate, usage: usage(candidate) };
      },
    };
    const manager = new AccountManager({
      paths,
      store,
      vault: inertVault,
      dependencies: { now: () => new Date(currentTime) },
      adapters: { openai: adapter, anthropic: inertAdapter("anthropic") },
    });
    await manager.refreshAll();
    expect(probes).toEqual(["active@example.com", "idle@example.com"]);
    currentTime += 60_000;
    await manager.refreshAll();
    expect(probes.filter((label) => label === "active@example.com")).toHaveLength(2);
    expect(probes.filter((label) => label === "idle@example.com")).toHaveLength(1);
    currentTime += 5 * 60_000;
    await manager.refreshAll();
    expect(probes.filter((label) => label === "idle@example.com")).toHaveLength(2);
    store.close();
  });
});
