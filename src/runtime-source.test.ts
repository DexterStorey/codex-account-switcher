import { describe, expect, test } from "bun:test";
import type { Account } from "./domain.ts";
import { createRuntimeCredentialSource } from "./runtime-source.ts";

const openAiAccount: Extract<Account, { provider: "openai" }> = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "openai",
  label: "dexter@example.com",
  identity: "dexter@example.com",
  externalAccountId: "acct-1",
  externalUserId: "user-1",
  secretReference: "codex:acct-1",
  profilePath: null,
  health: "ready",
  enabled: true,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
};

describe("runtime credential source", () => {
  test("returns null when no account is active", async () => {
    const source = createRuntimeCredentialSource({
      store: { activeAccount: () => null },
      vault: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    expect(await source.resolve("openai")).toBeNull();
  });

  test("surfaces an actionable relogin message for an unusable active credential", async () => {
    const source = createRuntimeCredentialSource({
      store: { activeAccount: () => openAiAccount },
      // A missing keychain item stands in for a revoked/cleared credential.
      vault: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(source.resolve("openai")).rejects.toThrow(
      "tokmax codex relogin dexter@example.com",
    );
  });
});
