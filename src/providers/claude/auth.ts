import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, normalize, resolve } from "node:path";
import { z } from "zod";
import { type Account, AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";
import type { ApplicationPaths } from "../../paths.ts";

export const ClaudeOauthSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().nonnegative(),
    refreshTokenExpiresAt: z.number().nonnegative().optional(),
    scopes: z.union([z.array(z.string()), z.string()]).optional(),
    subscriptionType: z.string().optional(),
    rateLimitTier: z.string().optional(),
  })
  .passthrough();
export type ClaudeOauth = z.infer<typeof ClaudeOauthSchema>;

export const ClaudeCredentialPayloadSchema = z
  .object({ claudeAiOauth: ClaudeOauthSchema })
  .passthrough();

const ClaudeAuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    email: z.string().email().optional(),
    subscriptionType: z.string().optional(),
  })
  .passthrough();

const ClaudeProfileSchema = z
  .object({
    account: z
      .object({
        uuid: z.string().min(1),
        email_address: z.string().email().optional(),
      })
      .passthrough()
      .optional(),
    uuid: z.string().min(1).optional(),
    email_address: z.string().email().optional(),
  })
  .passthrough();

export interface ClaudeCommandRunner {
  interactive(
    command: readonly string[],
    environment: Record<string, string | undefined>,
  ): Promise<number>;
  captured(
    command: readonly string[],
    environment: Record<string, string | undefined>,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface ClaudeProfileCredentialReader {
  read(profilePath: string): Promise<ClaudeOauth>;
}

function currentUser(): string {
  return process.env.USER ?? userInfo().username;
}

export function canonicalClaudeProfilePath(profilePath: string): string {
  return normalize(resolve(profilePath)).normalize("NFC");
}

export function claudeKeychainService(profilePath: string): string {
  const canonical = canonicalClaudeProfilePath(profilePath);
  const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

function decodeSecurityOutput(output: string): string {
  const trimmed = output.replace(/\n$/, "");
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (decoded.trimStart().startsWith("{")) {
      return decoded;
    }
  }
  return trimmed;
}

export function defaultClaudeCommandRunner(): ClaudeCommandRunner {
  return {
    async interactive(command, environment) {
      return Bun.spawn([...command], {
        env: { ...process.env, ...environment },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).exited;
    },
    async captured(command, environment) {
      const processHandle = Bun.spawn([...command], {
        env: { ...process.env, ...environment },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => processHandle.kill("SIGTERM"), 30_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      clearTimeout(timeout);
      return { exitCode, stdout, stderr };
    },
  };
}

export function defaultClaudeCredentialReader(
  runner: ClaudeCommandRunner = defaultClaudeCommandRunner(),
): ClaudeProfileCredentialReader {
  return {
    async read(profilePath) {
      const service = claudeKeychainService(profilePath);
      const result = await runner.captured(
        ["security", "find-generic-password", "-a", currentUser(), "-s", service, "-w"],
        {},
      );
      let serialized: string;
      if (result.exitCode === 0) {
        serialized = decodeSecurityOutput(result.stdout);
      } else {
        try {
          const fallbackPath = join(profilePath, ".credentials.json");
          const metadata = await stat(fallbackPath);
          if ((metadata.mode & 0o077) !== 0) {
            throw new ApplicationError(
              "INSECURE_CREDENTIAL_FILE",
              `Claude fallback credential ${fallbackPath} must be mode 0600`,
            );
          }
          serialized = await readFile(fallbackPath, "utf8");
        } catch (error) {
          if (error instanceof ApplicationError) {
            throw error;
          }
          throw new ApplicationError(
            "CREDENTIAL_MISSING",
            `Claude profile ${profilePath} has no credential`,
            {
              cause: error,
            },
          );
        }
      }
      return ClaudeCredentialPayloadSchema.parse(JSON.parse(serialized)).claudeAiOauth;
    },
  };
}

export async function fetchClaudeProfile(
  accessToken: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<{ accountId: string; email: string | null }> {
  const response = await fetchImplementation("https://api.anthropic.com/api/oauth/profile", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(7_000),
  });
  if (response.status === 401) {
    throw new ApplicationError("REAUTHENTICATION_REQUIRED", "Claude credential was rejected");
  }
  if (!response.ok) {
    throw new ApplicationError(
      "PROVIDER_UNREACHABLE",
      `Claude profile endpoint returned HTTP ${response.status}`,
    );
  }
  const profile = ClaudeProfileSchema.parse(await response.json());
  const accountId = profile.account?.uuid ?? profile.uuid;
  if (accountId === undefined) {
    throw new ApplicationError("ACCOUNT_ID_MISSING", "Claude profile response has no account id");
  }
  return {
    accountId,
    email: profile.account?.email_address ?? profile.email_address ?? null,
  };
}

export async function registerClaudeAccount(input: {
  email?: string;
  paths: ApplicationPaths;
  runner?: ClaudeCommandRunner;
  credentialReader?: ClaudeProfileCredentialReader;
  fetchImplementation?: FetchImplementation;
}): Promise<Account> {
  const id = crypto.randomUUID();
  const profilePath = canonicalClaudeProfilePath(join(input.paths.claudeProfiles, id));
  const runner = input.runner ?? defaultClaudeCommandRunner();
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  let registered = false;
  try {
    const command = ["claude", "auth", "login", "--claudeai"];
    if (input.email !== undefined) {
      command.push("--email", input.email);
    }
    const exitCode = await runner.interactive(command, { CLAUDE_CONFIG_DIR: profilePath });
    if (exitCode !== 0) {
      throw new ApplicationError("LOGIN_FAILED", `claude auth login exited with ${exitCode}`);
    }
    const statusResult = await runner.captured(["claude", "auth", "status", "--json"], {
      CLAUDE_CONFIG_DIR: profilePath,
    });
    if (statusResult.exitCode !== 0) {
      throw new ApplicationError(
        "AUTH_STATUS_FAILED",
        statusResult.stderr.trim() || "Claude auth status failed",
      );
    }
    const status = ClaudeAuthStatusSchema.parse(JSON.parse(statusResult.stdout));
    if (!status.loggedIn) {
      throw new ApplicationError(
        "LOGIN_FAILED",
        "Claude reported that the isolated profile is not logged in",
      );
    }
    const credentialReader = input.credentialReader ?? defaultClaudeCredentialReader(runner);
    const credential = await credentialReader.read(profilePath);
    const profile = await fetchClaudeProfile(
      credential.accessToken,
      input.fetchImplementation ?? fetch,
    );
    const email = AccountEmailSchema.safeParse(profile.email ?? status.email);
    if (!email.success) {
      throw new ApplicationError(
        "ACCOUNT_EMAIL_MISSING",
        "Claude did not return a verified account email; the login was not stored",
      );
    }
    const now = new Date().toISOString();
    const account: Account = {
      id,
      provider: "anthropic",
      label: email.data,
      identity: email.data,
      externalAccountId: profile.accountId,
      externalUserId: null,
      secretReference: null,
      profilePath,
      health: credential.expiresAt <= Date.now() ? "refreshDue" : "ready",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    registered = true;
    return account;
  } finally {
    if (!registered) {
      await removeClaudeProfile(profilePath, runner);
    }
  }
}

export async function removeClaudeProfile(
  profilePath: string,
  runner: ClaudeCommandRunner = defaultClaudeCommandRunner(),
): Promise<void> {
  const service = claudeKeychainService(profilePath);
  const result = await runner.captured(
    ["security", "delete-generic-password", "-a", currentUser(), "-s", service],
    {},
  );
  await rm(profilePath, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 44) {
    throw new ApplicationError(
      "KEYCHAIN_DELETE_FAILED",
      result.stderr.trim() || `Could not remove Claude Keychain service ${service}`,
    );
  }
}

function serializedScopes(scopes: ClaudeOauth["scopes"]): string | undefined {
  switch (true) {
    case Array.isArray(scopes):
      return scopes.join(" ");
    case typeof scopes === "string":
      return scopes;
    default:
      return undefined;
  }
}

export async function refreshClaudeProfile(input: {
  profilePath: string;
  runner?: ClaudeCommandRunner;
  credentialReader?: ClaudeProfileCredentialReader;
}): Promise<ClaudeOauth> {
  const runner = input.runner ?? defaultClaudeCommandRunner();
  const reader = input.credentialReader ?? defaultClaudeCredentialReader(runner);
  const credential = await reader.read(input.profilePath);
  await projectClaudeCredential({
    credential,
    targetProfilePath: input.profilePath,
    runner,
  });
  return reader.read(input.profilePath);
}

export async function projectClaudeCredential(input: {
  credential: ClaudeOauth;
  targetProfilePath: string;
  runner?: ClaudeCommandRunner;
}): Promise<void> {
  const runner = input.runner ?? defaultClaudeCommandRunner();
  const result = await runner.captured(["claude", "auth", "login", "--claudeai"], {
    CLAUDE_CONFIG_DIR: input.targetProfilePath,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: input.credential.refreshToken,
    CLAUDE_CODE_OAUTH_SCOPES: serializedScopes(input.credential.scopes),
  });
  if (result.exitCode !== 0) {
    throw new ApplicationError(
      "REAUTHENTICATION_REQUIRED",
      result.stderr.trim() || `Claude profile refresh exited with ${result.exitCode}`,
    );
  }
}

export async function activateClaudeAccount(input: {
  account: Account;
  paths: ApplicationPaths;
  waitUntilIdle: () => Promise<boolean>;
  runner?: ClaudeCommandRunner;
  credentialReader?: ClaudeProfileCredentialReader;
}): Promise<void> {
  if (input.account.provider !== "anthropic" || input.account.profilePath === null) {
    throw new ApplicationError(
      "INVALID_ACCOUNT",
      "Claude activation requires an Anthropic profile account",
    );
  }
  if (!(await input.waitUntilIdle())) {
    throw new ApplicationError(
      "SESSIONS_BUSY",
      "Managed Claude sessions did not reach an idle boundary",
    );
  }
  const runner = input.runner ?? defaultClaudeCommandRunner();
  const reader = input.credentialReader ?? defaultClaudeCredentialReader(runner);
  const credential = await reader.read(input.account.profilePath);
  await projectClaudeCredential({
    credential,
    targetProfilePath: input.paths.claudeActiveProfile,
    runner,
  });
}

export async function runManagedClaude(
  paths: ApplicationPaths,
  arguments_: readonly string[],
): Promise<number> {
  const forbidden = [
    "--bare",
    "--safe-mode",
    "--settings",
    "--setting-sources",
    "--plugin-dir",
    "--bg",
    "--background",
  ];
  const unsafeArgument = arguments_.find((argument) =>
    forbidden.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
  if (unsafeArgument !== undefined) {
    throw new ApplicationError(
      "UNSAFE_CLAUDE_ARGUMENT",
      `${unsafeArgument} bypasses the managed Claude turn-boundary contract`,
    );
  }
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new ApplicationError("ENTRYPOINT_MISSING", "Cannot locate the managed hook entrypoint");
  }
  const settingsPath = join(
    paths.runtime,
    `claude-settings-${process.pid}-${crypto.randomUUID()}.json`,
  );
  const command = [process.execPath, entrypoint, "hook", "claude"].map(shellArgument).join(" ");
  const hook = (action: string, timeout = 120) => ({
    type: "command",
    command: `${command} ${action}`,
    timeout,
  });
  const serializedSettings = `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ matcher: "startup|resume|clear", hooks: [hook("session-start")] }],
        UserPromptSubmit: [{ hooks: [hook("turn-begin", 300)] }],
        Stop: [{ hooks: [hook("turn-end")] }],
        StopFailure: [{ hooks: [hook("turn-end")] }],
        Notification: [{ matcher: "idle_prompt", hooks: [hook("turn-end")] }],
        SessionEnd: [{ hooks: [hook("session-end")] }],
      },
    },
    null,
    2,
  )}\n`;
  const settingsFile = await open(settingsPath, "wx", 0o600);
  try {
    await settingsFile.writeFile(serializedSettings, "utf8");
    await settingsFile.sync();
  } finally {
    await settingsFile.close();
  }
  try {
    return await Bun.spawn(
      ["claude", "--settings", settingsPath, "--setting-sources", "user", ...arguments_],
      {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: paths.claudeActiveProfile,
          TOKMAX_RUNTIME_PID: String(process.pid),
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ).exited;
  } finally {
    await rm(settingsPath, { force: true });
  }
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
