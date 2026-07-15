import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../domain.ts";
import { applicationPaths } from "../../paths.ts";
import {
  activeProfileHoldsAccount,
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

  test("a matching active credential is verified without re-projecting a rotated token", async () => {
    const paths = applicationPaths({ TOKMAX_HOME: "/tmp/tokmax-verify-test" });
    const account: Account = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "anthropic",
      label: "person@example.com",
      identity: "person@example.com",
      externalAccountId: "account-1",
      externalUserId: null,
      secretReference: null,
      profilePath: "/tmp/tokmax-verify-test/profiles/claude/saved",
      health: "ready",
      enabled: true,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const projections: string[] = [];
    const runner: ClaudeCommandRunner = {
      interactive: async () => 1,
      captured: async (_command, environment) => {
        projections.push(environment.CLAUDE_CONFIG_DIR ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const readProfiles: string[] = [];
    const now = new Date("2026-07-14T12:00:00.000Z");
    const verified = await activeProfileHoldsAccount({
      account,
      paths,
      now,
      runner,
      credentialReader: {
        read: async (profilePath) => {
          readProfiles.push(profilePath);
          return {
            accessToken: "active-access",
            refreshToken: "active-refresh",
            expiresAt: now.getTime() + 3_600_000,
          };
        },
      },
      fetchImplementation: async () =>
        new Response(JSON.stringify({ account: { uuid: "account-1" } }), { status: 200 }),
    });
    expect(verified).toBe(true);
    expect(readProfiles).toEqual([paths.claudeActiveProfile]);
    // A valid active credential must not trigger `claude auth login`; that
    // replays a rotated refresh token and the OAuth endpoint rejects it.
    expect(projections).toEqual([]);
    const wrongIdentity = await activeProfileHoldsAccount({
      account,
      paths,
      now,
      runner,
      credentialReader: {
        read: async () => ({
          accessToken: "active-access",
          refreshToken: "active-refresh",
          expiresAt: now.getTime() + 3_600_000,
        }),
      },
      fetchImplementation: async () =>
        new Response(JSON.stringify({ account: { uuid: "someone-else" } }), { status: 200 }),
    });
    expect(wrongIdentity).toBe(false);
    const missingCredential = await activeProfileHoldsAccount({
      account,
      paths,
      now,
      runner,
      credentialReader: {
        read: async () => {
          throw new Error("no credential");
        },
      },
      fetchImplementation: async () => new Response("{}", { status: 200 }),
    });
    expect(missingCredential).toBe(false);
  });

  test("an expired active credential is refreshed in place, not re-projected from the saved profile", async () => {
    const paths = applicationPaths({ TOKMAX_HOME: "/tmp/tokmax-refresh-test" });
    const account: Account = {
      id: "00000000-0000-4000-8000-000000000002",
      provider: "anthropic",
      label: "person@example.com",
      identity: "person@example.com",
      externalAccountId: "account-1",
      externalUserId: null,
      secretReference: null,
      profilePath: "/tmp/tokmax-refresh-test/profiles/claude/saved",
      health: "ready",
      enabled: true,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const now = new Date("2026-07-14T12:00:00.000Z");
    const projections: Array<{ profile: string | undefined; token: string | undefined }> = [];
    let refreshed = false;
    const runner: ClaudeCommandRunner = {
      interactive: async () => 1,
      captured: async (_command, environment) => {
        projections.push({
          profile: environment.CLAUDE_CONFIG_DIR,
          token: environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
        });
        refreshed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const verified = await activeProfileHoldsAccount({
      account,
      paths,
      now,
      runner,
      credentialReader: {
        read: async () => ({
          accessToken: refreshed ? "fresh-access" : "stale-access",
          refreshToken: refreshed ? "fresh-refresh" : "active-refresh",
          expiresAt: refreshed ? now.getTime() + 3_600_000 : now.getTime() - 1_000,
        }),
      },
      fetchImplementation: async () =>
        new Response(JSON.stringify({ account: { uuid: "account-1" } }), { status: 200 }),
    });
    expect(verified).toBe(true);
    // The refresh must run against the active profile with its own rotating
    // token — never against the saved profile's stale copy.
    expect(projections).toEqual([{ profile: paths.claudeActiveProfile, token: "active-refresh" }]);
  });
});

describe("managed profile passthrough", () => {
  test("symlinks user configuration but never credentials or OAuth metadata", async () => {
    const {
      mkdir: makeDirectory,
      writeFile: write,
      lstat,
      readlink,
      readFile,
    } = await import("node:fs/promises");
    const { mirrorUserClaudeProfile } = await import("./auth.ts");
    const root = await mkdtemp(join(tmpdir(), "claude-mirror-test-"));
    temporaryDirectories.push(root);
    const user = join(root, "user-claude");
    const active = join(root, "active");
    await makeDirectory(join(user, "skills"), { recursive: true });
    await makeDirectory(active, { recursive: true });
    await write(join(user, "settings.json"), '{"theme":"dark"}');
    await write(join(user, "CLAUDE.md"), "my memory");
    await write(join(user, ".credentials.json"), '{"claudeAiOauth":{}}');
    await write(
      join(user, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        oauthAccount: { emailAddress: "user@example.com" },
        projects: { "/repo-a": { trusted: true } },
      }),
    );
    await write(
      join(active, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "switched@example.com" },
        projects: { "/repo-b": { trusted: true } },
      }),
    );
    await mirrorUserClaudeProfile(active, user);
    expect((await lstat(join(active, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(active, "settings.json"))).toBe(join(user, "settings.json"));
    expect((await lstat(join(active, "skills"))).isSymbolicLink()).toBe(true);
    // Credentials must never follow the user profile into the managed one.
    await expect(lstat(join(active, ".credentials.json"))).rejects.toThrow();
    const merged = JSON.parse(await readFile(join(active, ".claude.json"), "utf8"));
    expect(merged.theme).toBe("dark");
    // The managed profile keeps its own switched identity metadata...
    expect(merged.oauthAccount.emailAddress).toBe("switched@example.com");
    // ...and trust granted in either profile survives.
    expect(Object.keys(merged.projects).sort()).toEqual(["/repo-a", "/repo-b"]);
    // Idempotent on a second run.
    await mirrorUserClaudeProfile(active, user);
    expect(await readlink(join(active, "settings.json"))).toBe(join(user, "settings.json"));
  });
});
