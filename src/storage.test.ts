import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "./domain.ts";
import { createStateStore } from "./storage.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("state store", () => {
  test("round-trips schema-validated account and usage state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
    temporaryDirectories.push(directory);
    const store = createStateStore(join(directory, "state.sqlite"));
    expect((await stat(join(directory, "state.sqlite"))).mode & 0o077).toBe(0);
    const timestamp = "2026-07-10T12:00:00.000Z";
    const account: Account = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "openai",
      label: "person@example.com",
      identity: "person@example.com",
      externalAccountId: "account-1",
      externalUserId: "user-1",
      secretReference: "keychain:account-1",
      profilePath: null,
      health: "ready",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.saveAccount(account);
    store.saveUsage({
      accountId: account.id,
      provider: account.provider,
      observedAt: timestamp,
      source: "codexUsageEndpoint",
      windows: [{ id: "five-hour", label: "5 hour", usedPercent: 42, resetAt: null, kind: "hard" }],
      hardLimitReached: false,
    });

    expect(store.dashboard().accounts).toEqual([account]);
    expect(store.findUsage(account.id)?.windows[0]?.usedPercent).toBe(42);
    expect(store.listProviderStates()).toHaveLength(2);
    store.close();
  });

  test("fails closed when durable JSON no longer satisfies its schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-corruption-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const store = createStateStore(databasePath);
    const timestamp = "2026-07-10T12:00:00.000Z";
    store.saveAccount({
      id: "00000000-0000-4000-8000-000000000001",
      provider: "openai",
      label: "person@example.com",
      identity: "person@example.com",
      externalAccountId: "account-1",
      externalUserId: "user-1",
      secretReference: "keychain:account-1",
      profilePath: null,
      health: "ready",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const rawDatabase = new Database(databasePath);
    rawDatabase.query("UPDATE accounts SET payload = ?").run('{"id":"invalid"}');
    expect(() => store.listAccounts()).toThrow("Stored state failed schema validation");
    rawDatabase.close();
    store.close();
  });

  test("enforces account identity uniqueness in the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-uniqueness-test-"));
    temporaryDirectories.push(directory);
    const store = createStateStore(join(directory, "state.sqlite"));
    const timestamp = "2026-07-10T12:00:00.000Z";
    const account: Account = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "openai",
      label: "person@example.com",
      identity: "person@example.com",
      externalAccountId: "account-1",
      externalUserId: "user-1",
      secretReference: "keychain:account-1",
      profilePath: null,
      health: "ready",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.saveAccount(account);

    expect(() =>
      store.saveAccount({
        ...account,
        id: "00000000-0000-4000-8000-000000000002",
        label: "person@example.com",
      }),
    ).toThrow("Account conflicts with registered profile person@example.com");
    store.close();
  });

  test("allows distinct OpenAI users in one workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-workspace-test-"));
    temporaryDirectories.push(directory);
    const store = createStateStore(join(directory, "state.sqlite"));
    const timestamp = "2026-07-10T12:00:00.000Z";
    const first: Account = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "openai",
      label: "first@example.com",
      identity: "first@example.com",
      externalAccountId: "shared-workspace",
      externalUserId: "user-1",
      secretReference: "keychain:first",
      profilePath: null,
      health: "ready",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.saveAccount(first);
    store.saveAccount({
      ...first,
      id: "00000000-0000-4000-8000-000000000002",
      label: "second@example.com",
      identity: "second@example.com",
      externalUserId: "user-2",
      secretReference: "keychain:second",
    });
    expect(store.listAccounts("openai")).toHaveLength(2);
    store.close();
  });
});
