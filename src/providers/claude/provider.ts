import { z } from "zod";
import { type Account, AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";
import type { ApplicationPaths } from "../../paths.ts";
import type { ProviderAdapter, ProviderProbeResult } from "../provider.ts";
import {
  activateClaudeAccount,
  defaultClaudeCredentialReader,
  fetchClaudeProfile,
  projectClaudeCredential,
  refreshClaudeProfile,
} from "./auth.ts";
import { fetchClaudeUsage } from "./usage.ts";

const ClaudeAgentsSchema = z.union([
  z.array(z.object({ state: z.string().optional(), status: z.string().optional() }).passthrough()),
  z.object({
    agents: z.array(
      z.object({ state: z.string().optional(), status: z.string().optional() }).passthrough(),
    ),
  }),
]);

export function claudeAgentsIdle(value: unknown): boolean {
  const parsed = ClaudeAgentsSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const activeAgents = Array.isArray(parsed.data) ? parsed.data : parsed.data.agents;
  return activeAgents.length === 0;
}

export interface AnthropicProviderDependencies {
  fetchImplementation: FetchImplementation;
  now(): Date;
  activeAccount(): Account | null;
}

function scopesPermitUsage(scopes: string | string[] | undefined): boolean {
  if (scopes === undefined) {
    return true;
  }
  const values = Array.isArray(scopes) ? scopes : scopes.split(/[ ,]+/);
  return values.includes("user:profile");
}

function health(refreshTokenExpiresAt: number | undefined, now: Date): Account["health"] {
  if (refreshTokenExpiresAt === undefined) {
    return "ready";
  }
  if (refreshTokenExpiresAt <= now.getTime()) {
    return "reauthenticationRequired";
  }
  return refreshTokenExpiresAt <= now.getTime() + 5 * 24 * 60 * 60 * 1000
    ? "loginExpiring"
    : "ready";
}

function assertIdentity(
  account: Extract<Account, { provider: "anthropic" }>,
  accountId: string,
): void {
  if (account.externalAccountId !== null && account.externalAccountId !== accountId) {
    throw new ApplicationError(
      "IDENTITY_CHANGED",
      "Active Claude credential belongs to a different account",
    );
  }
}

export class AnthropicProviderAdapter implements ProviderAdapter {
  public readonly provider = "anthropic" as const;
  readonly #paths: ApplicationPaths;
  readonly #dependencies: AnthropicProviderDependencies;
  #projectedAccountId: string | null = null;

  public constructor(input: {
    paths: ApplicationPaths;
    dependencies: AnthropicProviderDependencies;
  }) {
    this.#paths = input.paths;
    this.#dependencies = input.dependencies;
  }

  public async start(): Promise<void> {
    const active = this.#dependencies.activeAccount();
    if (active?.provider === "anthropic") {
      await this.activate(active);
    }
  }

  public async stop(): Promise<void> {}

  public async probe(account: Account): Promise<ProviderProbeResult> {
    const anthropicAccount = this.requireAccount(account);
    const active = this.#dependencies.activeAccount();
    const profilePath =
      active?.id === anthropicAccount.id || this.#projectedAccountId === anthropicAccount.id
        ? this.#paths.claudeActiveProfile
        : anthropicAccount.profilePath;
    const reader = defaultClaudeCredentialReader();
    let credential = await reader.read(profilePath);
    if (credential.expiresAt <= this.#dependencies.now().getTime() + 300_000) {
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
    }
    if (!scopesPermitUsage(credential.scopes)) {
      throw new ApplicationError(
        "SCOPE_MISSING",
        "Claude credential does not include the user:profile scope required for usage",
      );
    }
    let profile = await fetchClaudeProfile(
      credential.accessToken,
      this.#dependencies.fetchImplementation,
    ).catch(async (error) => {
      if (!(error instanceof ApplicationError) || error.code !== "REAUTHENTICATION_REQUIRED") {
        throw error;
      }
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
      return fetchClaudeProfile(credential.accessToken, this.#dependencies.fetchImplementation);
    });
    assertIdentity(anthropicAccount, profile.accountId);
    const usage = await fetchClaudeUsage({
      accountId: anthropicAccount.id,
      accessToken: credential.accessToken,
      fetchImplementation: this.#dependencies.fetchImplementation,
    }).catch(async (error) => {
      if (!(error instanceof ApplicationError) || error.code !== "ACCESS_TOKEN_REJECTED") {
        throw error;
      }
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
      profile = await fetchClaudeProfile(
        credential.accessToken,
        this.#dependencies.fetchImplementation,
      );
      return fetchClaudeUsage({
        accountId: anthropicAccount.id,
        accessToken: credential.accessToken,
        fetchImplementation: this.#dependencies.fetchImplementation,
      });
    });
    assertIdentity(anthropicAccount, profile.accountId);
    const email = AccountEmailSchema.safeParse(profile.email);
    return {
      account: {
        ...anthropicAccount,
        label: email.success ? email.data : anthropicAccount.label,
        identity: email.success ? email.data : anthropicAccount.identity,
        health: health(credential.refreshTokenExpiresAt, this.#dependencies.now()),
        updatedAt: this.#dependencies.now().toISOString(),
      },
      usage,
    };
  }

  public async pauseDispatch(): Promise<void> {}

  public resumeDispatch(): void {}

  public async waitUntilIdle(): Promise<boolean> {
    const processHandle = Bun.spawn(["claude", "agents", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: this.#paths.claudeActiveProfile },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => processHandle.kill("SIGTERM"), 5_000);
    const [exitCode, stdout] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
    ]);
    clearTimeout(timeout);
    if (exitCode !== 0) {
      return false;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout);
    } catch {
      return false;
    }
    return claudeAgentsIdle(decoded);
  }

  public async synchronizeSource(account: Account | null): Promise<void> {
    if (account === null) {
      return;
    }
    const anthropicAccount = this.requireAccount(account);
    const reader = defaultClaudeCredentialReader();
    let activeCredential = await reader.read(this.#paths.claudeActiveProfile);
    if (activeCredential.expiresAt <= this.#dependencies.now().getTime() + 300_000) {
      activeCredential = await refreshClaudeProfile({
        profilePath: this.#paths.claudeActiveProfile,
        credentialReader: reader,
      });
    }
    const profile = await fetchClaudeProfile(
      activeCredential.accessToken,
      this.#dependencies.fetchImplementation,
    );
    assertIdentity(anthropicAccount, profile.accountId);
    await projectClaudeCredential({
      credential: activeCredential,
      targetProfilePath: anthropicAccount.profilePath,
    });
  }

  public async runtimeExternalAccountId(): Promise<string | null> {
    const credential = await defaultClaudeCredentialReader().read(this.#paths.claudeActiveProfile);
    const profile = await fetchClaudeProfile(
      credential.accessToken,
      this.#dependencies.fetchImplementation,
    );
    return profile.accountId;
  }

  public async activate(account: Account): Promise<void> {
    const anthropicAccount = this.requireAccount(account);
    await activateClaudeAccount({
      account: anthropicAccount,
      paths: this.#paths,
      waitUntilIdle: () => this.waitUntilIdle(),
    });
    this.#projectedAccountId = anthropicAccount.id;
  }

  private requireAccount(account: Account): Extract<Account, { provider: "anthropic" }> {
    if (account.provider !== "anthropic") {
      throw new ApplicationError(
        "PROVIDER_MISMATCH",
        "Anthropic adapter received a non-Anthropic account",
      );
    }
    return account;
  }
}
