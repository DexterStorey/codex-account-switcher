import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationPaths } from "../../paths.ts";
import {
  type ClaudeCommandRunner,
  canonicalClaudeProfilePath,
  claudeKeychainService,
  projectClaudeCredential,
  registerClaudeAccount,
} from "./auth.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Claude auth", () => {
  test("derives a stable, isolated Keychain service from the canonical profile path", () => {
    const first = claudeKeychainService("/tmp/profiles/../profiles/one");
    expect(first).toBe(claudeKeychainService(canonicalClaudeProfilePath("/tmp/profiles/one")));
    expect(first).not.toBe(claudeKeychainService("/tmp/profiles/two"));
    expect(first).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  test("registers in an isolated CLAUDE_CONFIG_DIR without touching the active profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-registration-test-"));
    temporaryDirectories.push(root);
    const paths = applicationPaths({ CODEX_AUTH_HOME: root });
    let loginProfile: string | undefined;
    const runner: ClaudeCommandRunner = {
      interactive: async (_command, environment) => {
        loginProfile = environment.CLAUDE_CONFIG_DIR;
        return 0;
      },
      captured: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, email: "person@example.com" }),
        stderr: "",
      }),
    };
    const account = await registerClaudeAccount({
      paths,
      runner,
      credentialReader: {
        read: async () => ({
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        }),
      },
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            account: { uuid: "account-1", email_address: "person@example.com" },
          }),
          { status: 200 },
        ),
    });
    expect(account.profilePath).not.toBeNull();
    expect(loginProfile).toBe(account.profilePath ?? undefined);
    expect(loginProfile).not.toBe(paths.claudeActiveProfile);
    expect(account.label).toBe("person@example.com");
    expect(account.identity).toBe("person@example.com");
    expect(account.externalAccountId).toBe("account-1");
  });

  test("rejects and removes a profile when the provider returns no verified email", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-registration-email-test-"));
    temporaryDirectories.push(root);
    const paths = applicationPaths({ CODEX_AUTH_HOME: root });
    const runner: ClaudeCommandRunner = {
      interactive: async () => 0,
      captured: async (command) => ({
        exitCode: 0,
        stdout: command[2] === "status" ? JSON.stringify({ loggedIn: true }) : "",
        stderr: "",
      }),
    };

    await expect(
      registerClaudeAccount({
        paths,
        runner,
        credentialReader: {
          read: async () => ({
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 60_000,
          }),
        },
        fetchImplementation: async () =>
          new Response(JSON.stringify({ account: { uuid: "account-without-email" } }), {
            status: 200,
          }),
      }),
    ).rejects.toThrow("verified account email");
    expect(await readdir(paths.claudeProfiles)).toEqual([]);
  });

  test("projects rotating credentials without exposing tokens in argv", async () => {
    let invokedCommand: readonly string[] = [];
    let invokedEnvironment: Record<string, string | undefined> = {};
    const runner: ClaudeCommandRunner = {
      interactive: async () => 1,
      captured: async (command, environment) => {
        invokedCommand = command;
        invokedEnvironment = environment;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await projectClaudeCredential({
      credential: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: Date.now() + 60_000,
        scopes: ["user:profile"],
      },
      targetProfilePath: "/managed/active",
      runner,
    });
    expect(invokedCommand).toEqual(["claude", "auth", "login", "--claudeai"]);
    expect(invokedCommand.join(" ")).not.toContain("refresh-secret");
    expect(invokedEnvironment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("refresh-secret");
    expect(invokedEnvironment.CLAUDE_CONFIG_DIR).toBe("/managed/active");
  });
});
