import { rm } from "node:fs/promises";
import { type Account, AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";
import type { ApplicationPaths } from "../../paths.ts";
import type {
  ProviderAdapter,
  ProviderProbeResult,
  ProviderRuntimeCredential,
} from "../provider.ts";
import { CodexAppServerClient } from "./app-server.ts";
import {
  type CodexAuth,
  type CredentialVault,
  codexIdentity,
  readCodexCredential,
  refreshCodexCredential,
} from "./auth.ts";
import { type CodexDispatchGate, startCodexDispatchGate } from "./gate.ts";
import { type ManagedCodexAppServer, startManagedCodexAppServer } from "./supervisor.ts";
import { fetchCodexUsage } from "./usage.ts";

export interface OpenAiProviderDependencies {
  fetchImplementation: FetchImplementation;
  now(): Date;
  activeAccount(): Account | null;
}

function isExpiring(credential: CodexAuth, now: Date): boolean {
  const expiration = codexIdentity(credential).accessExpiresAt;
  return expiration !== null && Date.parse(expiration) <= now.getTime() + 300_000;
}

export class OpenAiProviderAdapter implements ProviderAdapter {
  public readonly provider = "openai" as const;
  readonly #paths: ApplicationPaths;
  readonly #vault: CredentialVault;
  readonly #dependencies: OpenAiProviderDependencies;
  #client: CodexAppServerClient | null = null;
  #gate: CodexDispatchGate | null = null;
  #runtime: ManagedCodexAppServer | null = null;
  #projectedAccount: Extract<Account, { provider: "openai" }> | null = null;
  #runtimeOperation: Promise<void> | null = null;

  public constructor(input: {
    paths: ApplicationPaths;
    vault: CredentialVault;
    dependencies: OpenAiProviderDependencies;
  }) {
    this.#paths = input.paths;
    this.#vault = input.vault;
    this.#dependencies = input.dependencies;
  }

  public async start(): Promise<void> {
    await this.ensureReady();
  }

  public async ensureReady(): Promise<void> {
    await this.ensureRuntime();
  }

  public async stop(): Promise<void> {
    await this.#gate?.close().catch(() => undefined);
    this.#gate = null;
    this.#client?.close();
    this.#client = null;
    this.#projectedAccount = null;
    await this.terminateRuntime();
    await rm(this.#paths.codexCapabilityToken, { force: true });
  }

  public async probe(account: Account): Promise<ProviderProbeResult> {
    const openAiAccount = this.requireAccount(account);
    let credential = await this.freshCredential(openAiAccount);
    let identity = codexIdentity(credential);
    if (
      openAiAccount.externalAccountId !== null &&
      openAiAccount.externalAccountId !== identity.accountId
    ) {
      throw new ApplicationError(
        "IDENTITY_CHANGED",
        "Stored OpenAI credential belongs to a different account",
      );
    }
    if (openAiAccount.externalUserId !== null && openAiAccount.externalUserId !== identity.userId) {
      throw new ApplicationError(
        "IDENTITY_CHANGED",
        "Stored OpenAI credential belongs to a different user",
      );
    }
    const usage = await fetchCodexUsage({
      accountId: openAiAccount.id,
      credential,
      fetchImplementation: this.#dependencies.fetchImplementation,
    }).catch(async (error) => {
      if (!(error instanceof ApplicationError) || error.code !== "ACCESS_TOKEN_REJECTED") {
        throw error;
      }
      credential = await refreshCodexCredential({
        reference: openAiAccount.secretReference,
        vault: this.#vault,
        fetchImplementation: this.#dependencies.fetchImplementation,
      });
      identity = codexIdentity(credential);
      return fetchCodexUsage({
        accountId: openAiAccount.id,
        credential,
        fetchImplementation: this.#dependencies.fetchImplementation,
      });
    });
    const email = AccountEmailSchema.safeParse(identity.email);
    return {
      account: {
        ...openAiAccount,
        externalAccountId: identity.accountId,
        externalUserId: identity.userId,
        label: email.success ? email.data : openAiAccount.label,
        identity: email.success ? email.data : openAiAccount.identity,
        health: "ready",
        updatedAt: this.#dependencies.now().toISOString(),
      },
      usage,
    };
  }

  public async pauseDispatch(): Promise<void> {
    const runtime = await this.ensureRuntime();
    runtime.gate.pause();
  }

  public resumeDispatch(): void {
    this.#gate?.resume();
  }

  public async waitUntilIdle(): Promise<boolean> {
    const { gate, client } = await this.ensureRuntime();
    if (gate.hasPendingDispatch() || !(await client.allThreadsIdle())) {
      return false;
    }
    await Bun.sleep(100);
    return !gate.hasPendingDispatch() && (await client.allThreadsIdle());
  }

  public async synchronizeSource(_account: Account | null): Promise<void> {}

  public async activate(account: Account): Promise<void> {
    const openAiAccount = this.requireAccount(account);
    const { client } = await this.ensureRuntime();
    const previous = this.#projectedAccount;
    this.#projectedAccount = openAiAccount;
    try {
      await client.installCredential(await this.freshCredential(openAiAccount));
      await client.readRateLimits();
    } catch (error) {
      this.#projectedAccount = previous;
      throw error;
    }
  }

  public async runtimeCredential(account: Account): Promise<ProviderRuntimeCredential> {
    const credential = await this.freshCredential(this.requireAccount(account));
    return {
      provider: "openai",
      accessToken: credential.tokens.access_token,
      accountId: codexIdentity(credential).accountId,
    };
  }

  private requireAccount(account: Account): Extract<Account, { provider: "openai" }> {
    if (account.provider !== "openai") {
      throw new ApplicationError(
        "PROVIDER_MISMATCH",
        "OpenAI adapter received a non-OpenAI account",
      );
    }
    return account;
  }

  private async freshCredential(
    account: Extract<Account, { provider: "openai" }>,
  ): Promise<CodexAuth> {
    const credential = await readCodexCredential(this.#vault, account.secretReference);
    if (!isExpiring(credential, this.#dependencies.now())) {
      return credential;
    }
    return refreshCodexCredential({
      reference: account.secretReference,
      vault: this.#vault,
      fetchImplementation: this.#dependencies.fetchImplementation,
    });
  }

  private configureCredentialSupplier(client: CodexAppServerClient): void {
    client.setCredentialSupplier(async () => {
      const active = this.#projectedAccount ?? this.#dependencies.activeAccount();
      if (active === null || active.provider !== "openai") {
        throw new ApplicationError("NO_ACTIVE_ACCOUNT", "No OpenAI account is active");
      }
      return this.freshCredential(active);
    });
  }

  private async ensureRuntime(): Promise<{
    client: CodexAppServerClient;
    gate: CodexDispatchGate;
  }> {
    if (
      this.#runtime?.processHandle.exitCode === null &&
      this.#client !== null &&
      !this.#client.closed &&
      this.#gate !== null
    ) {
      return { client: this.#client, gate: this.#gate };
    }
    if (this.#runtimeOperation === null) {
      const operation = this.rebuildRuntime().finally(() => {
        if (this.#runtimeOperation === operation) {
          this.#runtimeOperation = null;
        }
      });
      this.#runtimeOperation = operation;
    }
    await this.#runtimeOperation;
    if (this.#client === null || this.#gate === null) {
      throw new ApplicationError("APP_SERVER_MISSING", "Managed Codex runtime is unavailable");
    }
    return { client: this.#client, gate: this.#gate };
  }

  private async rebuildRuntime(): Promise<void> {
    await this.#gate?.close().catch(() => undefined);
    this.#gate = null;
    this.#client?.close();
    this.#client = null;
    let runtime = this.#runtime;
    let client =
      runtime === null || runtime.processHandle.exitCode !== null
        ? null
        : await CodexAppServerClient.connect(runtime.endpoint, runtime.capabilityToken).catch(
            () => null,
          );
    if (client === null) {
      await this.terminateRuntime();
      runtime = await startManagedCodexAppServer(this.#paths);
      this.#runtime = runtime;
      client = await CodexAppServerClient.connect(runtime.endpoint, runtime.capabilityToken);
    }
    if (runtime === null) {
      throw new ApplicationError("APP_SERVER_MISSING", "Managed Codex process is unavailable");
    }
    this.configureCredentialSupplier(client);
    const gate = await startCodexDispatchGate({
      clientSocketPath: this.#paths.codexClientSocket,
      appServerEndpoint: runtime.endpoint,
      capabilityToken: runtime.capabilityToken,
    });
    this.#client = client;
    this.#gate = gate;
    const active = this.#projectedAccount ?? this.#dependencies.activeAccount();
    if (active?.provider === "openai") {
      try {
        await client.installCredential(await this.freshCredential(active));
        this.#projectedAccount = active;
      } catch (error) {
        await gate.close().catch(() => undefined);
        client.close();
        this.#gate = null;
        this.#client = null;
        throw error;
      }
    }
  }

  private async terminateRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = null;
    if (runtime === null || runtime.processHandle.exitCode !== null) {
      return;
    }
    runtime.processHandle.kill("SIGTERM");
    await Promise.race([runtime.processHandle.exited, Bun.sleep(2_000)]);
    if (runtime.processHandle.exitCode === null) {
      runtime.processHandle.kill("SIGKILL");
      await runtime.processHandle.exited;
    }
  }
}
