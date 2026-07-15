import { describe, expect, test } from "bun:test";
import type { Account } from "../../domain.ts";
import { AnthropicProviderAdapter } from "./provider.ts";

const openAiAccount: Extract<Account, { provider: "openai" }> = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "openai",
  label: "person@example.com",
  identity: "person@example.com",
  externalAccountId: "account-1",
  externalUserId: "user-1",
  secretReference: "codex:account-1",
  profilePath: null,
  health: "ready",
  enabled: true,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
};

describe("AnthropicProviderAdapter", () => {
  test("rejects a non-Anthropic account", async () => {
    const adapter = new AnthropicProviderAdapter({
      dependencies: { fetchImplementation: fetch, now: () => new Date("2026-07-10T12:00:00.000Z") },
    });
    await expect(adapter.probe(openAiAccount)).rejects.toThrow("non-Anthropic account");
  });
});
