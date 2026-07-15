import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, UsageSnapshot } from "./domain.ts";
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

function account(id: string, label: string): Account {
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

function usage(target: Account): UsageSnapshot {
  return {
    accountId: target.id,
    provider: "openai",
    observedAt: now.toISOString(),
    source: "codexUsageEndpoint",
    windows: [{ id: "primary", label: "5 hour", usedPercent: 10, resetAt: null, kind: "hard" }],
    hardLimitReached: false,
  };
}

function inertAdapter(provider: "openai" | "anthropic"): ProviderAdapter {
  return {
    provider,
    start: async () => undefined,
    stop: async () => undefined,
    probe: async () => {
      throw new Error("Unexpected probe");
    },
    pauseDispatch: async () => undefined,
    resumeDispatch: () => undefined,
    waitUntilIdle: async () => true,
    synchronizeSource: async () => undefined,
    activate: async () => undefined,
  };
}

async function harness(probe: (account: Account) => Promise<ProviderProbeResult>) {
  const directory = await mkdtemp(join(tmpdir(), "manager-test-"));
  temporaryDirectories.push(directory);
  const paths = applicationPaths({ CODEX_AUTH_HOME: directory });
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
  const calls: string[] = [];
  const openai: ProviderAdapter = {
    provider: "openai",
    start: async () => undefined,
    stop: async () => undefined,
    probe: async (candidate) => {
      calls.push(`probe:${candidate.label}`);
      return probe(candidate);
    },
    pauseDispatch: async () => {
      calls.push("pause");
    },
    resumeDispatch: () => {
      calls.push("resume");
    },
    waitUntilIdle: async () => {
      calls.push("idle");
      return true;
    },
    synchronizeSource: async (candidate) => {
      calls.push(`sync:${candidate?.label ?? "none"}`);
    },
    activate: async (candidate) => {
      calls.push(`activate:${candidate.label}`);
    },
    runtimeCredential: async () => ({
      provider: "openai",
      accessToken: "access",
      accountId: "upstream",
    }),
  };
  const vault: CredentialVault = {
    read: async () => null,
    write: async () => undefined,
    remove: async () => undefined,
  };
  const manager = new AccountManager({
    paths,
    store,
    vault,
    dependencies: { now: () => now },
    adapters: { openai, anthropic: inertAdapter("anthropic") },
  });
  return { manager, store, source, target, calls, openai };
}

describe("AccountManager switching", () => {
  test("drains, synchronizes, activates, verifies, and commits one generation", async () => {
    const testHarness = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    await testHarness.manager.switchAccount("openai", testHarness.target.id, "test");
    // No "idle" wait for openai: in-flight HTTP turns finish on their original
    // token and the gate queues new dispatches, so the switch never drains.
    expect(testHarness.calls).toEqual([
      "pause",
      "probe:target@example.com",
      "sync:source@example.com",
      "activate:target@example.com",
      "probe:target@example.com",
      "resume",
    ]);
    expect(testHarness.store.findProviderState("openai")).toMatchObject({
      activeAccountId: testHarness.target.id,
      generation: 2,
    });
    expect(testHarness.store.listSwitchRecords()[0]?.phase).toBe("committed");
    testHarness.store.close();
  });

  test("reactivates the source when post-activation verification fails", async () => {
    let probes = 0;
    const testHarness = await harness(async (candidate) => {
      probes += 1;
      if (probes === 2) {
        throw new Error("verification failed");
      }
      return { account: candidate, usage: usage(candidate) };
    });
    await expect(
      testHarness.manager.switchAccount("openai", testHarness.target.id, "test"),
    ).rejects.toThrow("verification failed");
    expect(testHarness.calls).toContain("activate:source@example.com");
    expect(testHarness.store.findProviderState("openai").activeAccountId).toBe(
      testHarness.source.id,
    );
    expect(testHarness.store.listSwitchRecords()[0]?.phase).toBe("rolledBack");
    testHarness.store.close();
  });

  test("reasserts an unhealthy committed account without synchronizing from mismatched live auth", async () => {
    const testHarness = await harness(async (candidate) => ({
      account: { ...candidate, health: "ready" },
      usage: usage(candidate),
    }));
    testHarness.store.saveAccount({
      ...testHarness.source,
      health: "reauthenticationRequired",
    });
    await testHarness.manager.switchAccount("openai", testHarness.source.id, "reassert");
    expect(testHarness.calls).toEqual([
      "pause",
      "activate:source@example.com",
      "probe:source@example.com",
      "resume",
    ]);
    expect(testHarness.store.findProviderState("openai")).toMatchObject({
      activeAccountId: testHarness.source.id,
      generation: 2,
    });
    testHarness.store.close();
  });

  test("serializes probes and switches for the same provider", async () => {
    let releaseProbe: (() => void) | undefined;
    let reportProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let blockSourceProbe = true;
    const testHarness = await harness(async (candidate) => {
      if (candidate.label === "source@example.com" && blockSourceProbe) {
        reportProbeStarted?.();
        await probeReleased;
        blockSourceProbe = false;
      }
      return { account: candidate, usage: usage(candidate) };
    });

    const refresh = testHarness.manager.refreshAccount(testHarness.source);
    await probeStarted;
    const switching = testHarness.manager.switchAccount("openai", testHarness.target.id, "test");
    await Bun.sleep(10);
    expect(testHarness.calls).toEqual(["probe:source@example.com"]);

    releaseProbe?.();
    await Promise.all([refresh, switching]);
    expect(testHarness.calls.slice(1, 3)).toEqual(["pause", "probe:target@example.com"]);
    testHarness.store.close();
  });

  test("preserves an activated target lease before recovering the committed source", async () => {
    const testHarness = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    testHarness.store.saveSwitchRecord({
      id: "00000000-0000-4000-8000-000000000003",
      provider: "openai",
      sourceAccountId: testHarness.source.id,
      targetAccountId: testHarness.target.id,
      phase: "verifying",
      reason: "test-crash",
      generation: 2,
      message: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    await testHarness.manager.start();
    expect(testHarness.calls.slice(0, 6)).toEqual([
      "pause",
      "idle",
      "sync:target@example.com",
      "activate:source@example.com",
      "probe:source@example.com",
      "resume",
    ]);
    expect(testHarness.store.listSwitchRecords()[0]?.phase).toBe("rolledBack");
    await testHarness.manager.stop();
    testHarness.store.close();
  });

  test("does not overwrite a target lease when activation fails before runtime mutation", async () => {
    const testHarness = await harness(async (candidate) => ({
      account: candidate,
      usage: usage(candidate),
    }));
    testHarness.openai.runtimeExternalAccountId = async () => testHarness.source.externalAccountId;
    testHarness.openai.activate = async (candidate) => {
      testHarness.calls.push(`activate:${candidate.label}`);
      if (candidate.id === testHarness.target.id) {
        throw new Error("activation failed before mutation");
      }
    };

    await expect(
      testHarness.manager.switchAccount("openai", testHarness.target.id, "test"),
    ).rejects.toThrow("activation failed before mutation");
    expect(testHarness.calls).not.toContain("sync:target@example.com");
    expect(testHarness.calls).toContain("activate:source@example.com");
    testHarness.store.close();
  });

  test("keeps dispatch paused when post-activation rollback cannot be proven", async () => {
    let probes = 0;
    const testHarness = await harness(async (candidate) => {
      probes += 1;
      if (probes === 2) {
        throw new Error("target verification failed");
      }
      return { account: candidate, usage: usage(candidate) };
    });
    testHarness.openai.activate = async (candidate) => {
      testHarness.calls.push(`activate:${candidate.label}`);
      if (candidate.id === testHarness.source.id) {
        throw new Error("source rollback failed");
      }
    };

    await expect(
      testHarness.manager.switchAccount("openai", testHarness.target.id, "test"),
    ).rejects.toThrow("target verification failed");
    expect(testHarness.calls).not.toContain("resume");
    expect(testHarness.store.listSwitchRecords()[0]?.phase).toBe("failed");
    testHarness.store.close();
  });

  test("automatically rotates at the threshold to the least-used healthy account", async () => {
    const testHarness = await harness(async (candidate) => {
      const snapshot = usage(candidate);
      const window = snapshot.windows[0];
      if (window === undefined) {
        throw new Error("Usage fixture has no hard window");
      }
      return {
        account: candidate,
        usage: {
          ...snapshot,
          windows: [
            {
              ...window,
              usedPercent: candidate.label === "source@example.com" ? 95 : 12,
            },
          ],
        },
      };
    });
    testHarness.store.saveAutomationPolicy({
      ...testHarness.store.findProviderState("openai").policy,
      enabled: true,
      authorization: "confirmed",
    });

    await testHarness.manager.refreshAll();
    expect(testHarness.store.findProviderState("openai").activeAccountId).toBe(
      testHarness.target.id,
    );
    expect(testHarness.store.listSwitchRecords()[0]).toMatchObject({
      phase: "committed",
      reason: "automatic:threshold",
    });
    testHarness.store.close();
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
      start: async () => undefined,
      stop: async () => undefined,
      probe: async () => {
        probes += 1;
        throw new ApplicationError("USAGE_RATE_LIMITED", "429");
      },
      pauseDispatch: async () => undefined,
      resumeDispatch: () => undefined,
      waitUntilIdle: async () => true,
      synchronizeSource: async () => undefined,
      activate: async () => undefined,
    };
    const manager = new AccountManager({
      paths,
      store,
      vault: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
      dependencies: { now: () => new Date(currentTime) },
      adapters: { openai: adapter, anthropic: inertAdapter("anthropic") },
    });
    await manager.refreshAll();
    expect(probes).toBe(1);
    expect(store.findAccount(limited.id)?.health).toBe("usageRateLimited");
    // One minute later (the normal cadence) the account is still cooling down.
    currentTime += 60_000;
    await manager.refreshAll();
    expect(probes).toBe(1);
    // After the five-minute cooldown, probing resumes.
    currentTime += 5 * 60_000;
    await manager.refreshAll();
    expect(probes).toBe(2);
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
      start: async () => undefined,
      stop: async () => undefined,
      probe: async (candidate) => {
        probes.push(candidate.label);
        return { account: candidate, usage: usage(candidate) };
      },
      pauseDispatch: async () => undefined,
      resumeDispatch: () => undefined,
      waitUntilIdle: async () => true,
      synchronizeSource: async () => undefined,
      activate: async () => undefined,
    };
    const manager = new AccountManager({
      paths,
      store,
      vault: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
      dependencies: { now: () => new Date(currentTime) },
      adapters: { openai: adapter, anthropic: inertAdapter("anthropic") },
    });
    await manager.refreshAll();
    expect(probes).toEqual(["active@example.com", "idle@example.com"]);
    // One minute later only the active account is probed again.
    currentTime += 60_000;
    await manager.refreshAll();
    expect(probes.filter((label) => label === "active@example.com")).toHaveLength(2);
    expect(probes.filter((label) => label === "idle@example.com")).toHaveLength(1);
    // After five minutes the idle account gets its coarse reading.
    currentTime += 5 * 60_000;
    await manager.refreshAll();
    expect(probes.filter((label) => label === "idle@example.com")).toHaveLength(2);
    store.close();
  });
});
