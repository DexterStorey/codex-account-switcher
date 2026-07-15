import { describe, expect, test } from "bun:test";
import {
  type CodexAuth,
  type CredentialVault,
  codexIdentity,
  decodeJwtClaims,
  refreshCodexCredential,
  registerCodexAccount,
} from "./auth.ts";

function token(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex auth", () => {
  test("extracts stable account and preferred ChatGPT user identity", () => {
    const auth: CodexAuth = {
      auth_mode: "chatgpt",
      tokens: {
        id_token: token({
          email: "person@example.com",
          chatgpt_user_id: "user-preferred",
          "https://api.openai.com/auth": { chatgpt_account_id: "account-1", user_id: "legacy" },
        }),
        access_token: token({ exp: 2_000_000_000 }),
        refresh_token: "refresh",
      },
    };
    expect(codexIdentity(auth)).toEqual({
      accountId: "account-1",
      userId: "user-preferred",
      email: "person@example.com",
      plan: null,
      accessExpiresAt: new Date(2_000_000_000 * 1000).toISOString(),
    });
  });

  test("reads the subscription plan from the namespaced auth claim", () => {
    const auth = {
      auth_mode: "chatgpt" as const,
      tokens: {
        id_token: token({
          email: "person@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account-1",
            chatgpt_plan_type: "pro",
          },
        }),
        access_token: token({ exp: 2_000_000_000 }),
        refresh_token: "refresh",
      },
    };
    expect(codexIdentity(auth).plan).toBe("pro");
  });

  test("rejects malformed JWTs at the boundary", () => {
    expect(() => decodeJwtClaims("not-a-jwt")).toThrow("three-segment JWT");
  });

  test("registers through an isolated CODEX_HOME and removes it after vault import", async () => {
    const temporaryHome = "/temporary/codex-registration";
    let loginHome: string | undefined;
    let loginCommand: readonly string[] = [];
    let removed: string | undefined;
    const secrets = new Map<string, string>();
    const vault: CredentialVault = {
      read: async (reference) => secrets.get(reference) ?? null,
      write: async (reference, value) => {
        secrets.set(reference, value);
      },
      remove: async (reference) => {
        secrets.delete(reference);
      },
    };
    const auth: CodexAuth = {
      tokens: {
        id_token: token({ email: "isolated@example.com", chatgpt_account_id: "account-isolated" }),
        access_token: token({ exp: 2_000_000_000 }),
        refresh_token: "refresh",
      },
    };
    const account = await registerCodexAccount({
      vault,
      dependencies: {
        createTemporaryDirectory: async () => temporaryHome,
        run: async (command, environment) => {
          loginCommand = command;
          loginHome = environment.CODEX_HOME;
          return 0;
        },
        read: async () => JSON.stringify(auth),
        remove: async (path) => {
          removed = path;
        },
      },
    });
    expect(loginHome).toBe(temporaryHome);
    expect(loginCommand).toEqual(["codex", "login", "-c", 'cli_auth_credentials_store="file"']);
    expect(removed).toBe(temporaryHome);
    expect(account.label).toBe("isolated@example.com");
    expect(account.identity).toBe("isolated@example.com");
    expect(account.externalAccountId).toBe("account-isolated");
    expect(secrets.get(account.secretReference ?? "")).toBe(JSON.stringify(auth));
  });

  test("rejects a login without a verified email before importing its credential", async () => {
    let writes = 0;
    let removed = false;
    const vault: CredentialVault = {
      read: async () => null,
      write: async () => {
        writes += 1;
      },
      remove: async () => undefined,
    };
    const auth: CodexAuth = {
      tokens: {
        id_token: token({ chatgpt_account_id: "account-without-email" }),
        access_token: token({ exp: 2_000_000_000 }),
        refresh_token: "refresh",
      },
    };

    await expect(
      registerCodexAccount({
        vault,
        dependencies: {
          createTemporaryDirectory: async () => "/temporary/codex-registration",
          run: async () => 0,
          read: async () => JSON.stringify(auth),
          remove: async () => {
            removed = true;
          },
        },
      }),
    ).rejects.toThrow("verified account email");
    expect(writes).toBe(0);
    expect(removed).toBe(true);
  });

  test("serializes rotating refresh tokens per account", async () => {
    const initial: CodexAuth = {
      tokens: {
        id_token: token({ email: "person@example.com", chatgpt_account_id: "account-1" }),
        access_token: token({ exp: 1_900_000_000 }),
        refresh_token: "refresh-1",
      },
    };
    let serialized = JSON.stringify(initial);
    const submittedRefreshTokens: string[] = [];
    const vault: CredentialVault = {
      read: async () => serialized,
      write: async (_reference, value) => {
        serialized = value;
      },
      remove: async () => undefined,
    };
    const fetchImplementation = async (
      _input: string | URL | Request,
      initialization?: RequestInit,
    ) => {
      const body = JSON.parse(String(initialization?.body)) as { refresh_token: string };
      submittedRefreshTokens.push(body.refresh_token);
      const sequence = submittedRefreshTokens.length + 1;
      return new Response(
        JSON.stringify({
          access_token: token({ exp: 2_000_000_000 + sequence }),
          refresh_token: `refresh-${sequence}`,
        }),
        { status: 200 },
      );
    };
    await Promise.all([
      refreshCodexCredential({ reference: "account", vault, fetchImplementation }),
      refreshCodexCredential({ reference: "account", vault, fetchImplementation }),
    ]);
    expect(submittedRefreshTokens).toEqual(["refresh-1", "refresh-2"]);
  });
});
