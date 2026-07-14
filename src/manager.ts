import {
  type Account,
  AutomationPolicySchema,
  type ProviderId,
  type RuntimeClient,
  RuntimeSessionSchema,
  type SwitchPhase,
  SwitchRecordSchema,
} from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import type { FetchImplementation } from "./http.ts";
import type { ApplicationPaths } from "./paths.ts";
import { AnthropicProviderAdapter } from "./providers/claude/provider.ts";
import type { CredentialVault } from "./providers/codex/auth.ts";
import { OpenAiProviderAdapter } from "./providers/codex/provider.ts";
import type { ProviderAdapter } from "./providers/provider.ts";
import { selectRotation } from "./selection.ts";
import type { StateStore } from "./storage.ts";

export interface ManagerDependencies {
  fetchImplementation: FetchImplementation;
  now(): Date;
}

export interface ProviderAdapters {
  openai: ProviderAdapter;
  anthropic: ProviderAdapter;
}

const defaultDependencies: ManagerDependencies = {
  fetchImplementation: fetch,
  now: () => new Date(),
};

function healthForError(error: unknown): Account["health"] {
  if (error instanceof ApplicationError) {
    switch (error.code) {
      case "REAUTHENTICATION_REQUIRED":
      case "CREDENTIAL_MISSING":
      case "ACCESS_TOKEN_REJECTED":
      case "IDENTITY_CHANGED":
        return "reauthenticationRequired";
      case "USAGE_RATE_LIMITED":
        return "usageRateLimited";
      case "SCOPE_MISSING":
        return "scopeMissing";
      default:
        return "temporarilyUnreachable";
    }
  }
  return "temporarilyUnreachable";
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

class SwitchExecutionError extends ApplicationError {
  public readonly dispatchSafe: boolean;

  public constructor(error: unknown, dispatchSafe: boolean) {
    super("SWITCH_FAILED", errorMessage(error), {
      cause: error instanceof Error ? error : undefined,
    });
    this.dispatchSafe = dispatchSafe;
  }
}

export class AccountManager {
  readonly #store: StateStore;
  readonly #dependencies: ManagerDependencies;
  readonly #adapters: ProviderAdapters;
  readonly #providerOperationTails = new Map<ProviderId, Promise<void>>();
  readonly #providerBarriers = new Map<ProviderId, Promise<void>>();
  readonly #providerBarrierReleases = new Map<ProviderId, () => void>();
  readonly #runtimeIdentifiers = new Map<string, string>();
  #monitor: ReturnType<typeof setInterval> | null = null;
  #refreshOperation: Promise<void> | null = null;
  #stopping = false;

  public constructor(input: {
    paths: ApplicationPaths;
    store: StateStore;
    vault: CredentialVault;
    dependencies?: Partial<ManagerDependencies>;
    adapters?: ProviderAdapters;
  }) {
    this.#store = input.store;
    this.#dependencies = { ...defaultDependencies, ...input.dependencies };
    const activeAccount = (provider: ProviderId) => {
      const accountId = this.#store.findProviderState(provider).activeAccountId;
      return accountId === null ? null : this.#store.findAccount(accountId);
    };
    this.#adapters =
      input.adapters ??
      ({
        openai: new OpenAiProviderAdapter({
          paths: input.paths,
          vault: input.vault,
          dependencies: {
            ...this.#dependencies,
            activeAccount: () => activeAccount("openai"),
          },
        }),
        anthropic: new AnthropicProviderAdapter({
          paths: input.paths,
          dependencies: {
            ...this.#dependencies,
            activeAccount: () => activeAccount("anthropic"),
          },
        }),
      } satisfies ProviderAdapters);
    if (
      this.#adapters.openai.provider !== "openai" ||
      this.#adapters.anthropic.provider !== "anthropic"
    ) {
      throw new ApplicationError(
        "PROVIDER_MISMATCH",
        "Injected provider adapters do not match their registry keys",
      );
    }
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    for (const adapter of Object.values(this.#adapters)) {
      try {
        await adapter.start();
      } catch (error) {
        process.stderr.write(
          `${adapter.provider} adapter failed to start: ${errorMessage(error)}\n`,
        );
        await adapter.stop().catch(() => undefined);
        const activeAccountId = this.#store.findProviderState(adapter.provider).activeAccountId;
        for (const account of this.#store.listAccounts(adapter.provider)) {
          this.#store.saveAccount({
            ...account,
            health:
              account.id === activeAccountId ? healthForError(error) : "temporarilyUnreachable",
            updatedAt: this.#dependencies.now().toISOString(),
          });
        }
      }
    }
    await this.recoverInterruptedSwitches();
    void this.refreshAll().catch(() => undefined);
    this.#monitor = setInterval(() => {
      void this.refreshAll().catch(() => undefined);
    }, 60_000);
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#monitor !== null) {
      clearInterval(this.#monitor);
      this.#monitor = null;
    }
    await this.#refreshOperation?.catch(() => undefined);
    for (const release of this.#providerBarrierReleases.values()) {
      release();
    }
    this.#providerBarriers.clear();
    this.#providerBarrierReleases.clear();
    await Promise.all(
      Object.values(this.#adapters).map((adapter) => adapter.stop().catch(() => undefined)),
    );
  }

  public dashboard() {
    return this.#store.dashboard();
  }

  public async ensureProviderReady(provider: ProviderId): Promise<void> {
    await this.withProviderOperation(provider, async () => {
      const adapter = this.adapter(provider);
      await (adapter.ensureReady?.() ?? adapter.start());
    });
  }

  public setAutomationPolicy(input: {
    provider: ProviderId;
    enabled: boolean;
    thresholdPercent?: number;
    authorizationConfirmed?: boolean;
  }) {
    const current = this.#store.findProviderState(input.provider).policy;
    const policy = AutomationPolicySchema.parse({
      ...current,
      enabled: input.enabled,
      thresholdPercent: input.thresholdPercent ?? current.thresholdPercent,
      authorization: input.authorizationConfirmed ? "confirmed" : current.authorization,
    });
    if (policy.enabled && policy.authorization !== "confirmed") {
      throw new ApplicationError(
        "AUTHORIZATION_REQUIRED",
        "Automatic rotation requires explicit confirmation that your provider authorizes this use",
      );
    }
    return this.#store.saveAutomationPolicy(policy);
  }

  public async refreshAll(): Promise<void> {
    if (this.#refreshOperation !== null) {
      return this.#refreshOperation;
    }
    const operation = this.performRefreshAll().finally(() => {
      if (this.#refreshOperation === operation) {
        this.#refreshOperation = null;
      }
    });
    this.#refreshOperation = operation;
    return operation;
  }

  public async refreshAccount(account: Account): Promise<void> {
    return this.withProviderOperation(account.provider, () => this.probeAndSave(account));
  }

  private async probeAndSave(account: Account): Promise<void> {
    const result = await this.adapter(account.provider).probe(account);
    this.#store.saveUsage(result.usage);
    this.#store.saveAccount(result.account);
  }

  public async switchAccount(
    provider: ProviderId,
    targetAccountId: string,
    reason = "manual",
  ): Promise<void> {
    return this.withProviderOperation(provider, async () => {
      if (!this.#providerBarriers.has(provider)) {
        let releaseBarrier: (() => void) | undefined;
        const barrier = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        this.#providerBarriers.set(provider, barrier);
        if (releaseBarrier !== undefined) {
          this.#providerBarrierReleases.set(provider, releaseBarrier);
        }
      }
      const adapter = this.adapter(provider);
      let dispatchSafe = true;
      try {
        await adapter.pauseDispatch();
        await this.performSwitch(provider, targetAccountId, reason);
      } catch (error) {
        if (error instanceof SwitchExecutionError) {
          dispatchSafe = error.dispatchSafe;
        }
        throw error;
      } finally {
        if (dispatchSafe) {
          adapter.resumeDispatch();
          this.#providerBarriers.delete(provider);
          this.#providerBarrierReleases.get(provider)?.();
          this.#providerBarrierReleases.delete(provider);
        }
      }
    });
  }

  public async currentPiCredential(): Promise<{
    provider: "openai";
    generation: number;
    accessToken: string;
    accountId: string;
  }> {
    const barrier = this.#providerBarriers.get("openai");
    if (barrier !== undefined) {
      await barrier;
    }
    return this.readPiCredential();
  }

  public async beginPiTurn(input: { upstreamSessionId: string; processId: number }): Promise<{
    provider: "openai";
    generation: number;
    accessToken: string;
    accountId: string;
  }> {
    for (;;) {
      const barrier = this.#providerBarriers.get("openai");
      if (barrier !== undefined) {
        await barrier;
        continue;
      }
      const state = this.#store.findProviderState("openai");
      this.updatePiSession({
        ...input,
        generation: state.generation,
        state: "working",
      });
      return this.readPiCredential();
    }
  }

  public async beginClaudeTurn(input: {
    upstreamSessionId: string;
    processId: number;
  }): Promise<{ generation: number }> {
    for (;;) {
      const barrier = this.#providerBarriers.get("anthropic");
      if (barrier !== undefined) {
        await barrier;
        continue;
      }
      const generation = this.#store.findProviderState("anthropic").generation;
      this.updateClaudeSession({ ...input, generation, state: "working" });
      return { generation };
    }
  }

  private async readPiCredential(): Promise<{
    provider: "openai";
    generation: number;
    accessToken: string;
    accountId: string;
  }> {
    const state = this.#store.findProviderState("openai");
    if (state.activeAccountId === null) {
      throw new ApplicationError("NO_ACTIVE_ACCOUNT", "No OpenAI account is active");
    }
    const account = this.#store.findAccount(state.activeAccountId);
    if (account === null) {
      throw new ApplicationError("ACCOUNT_NOT_FOUND", "Active OpenAI account no longer exists");
    }
    const runtimeCredential = this.#adapters.openai.runtimeCredential;
    if (runtimeCredential === undefined) {
      throw new ApplicationError(
        "RUNTIME_UNSUPPORTED",
        "OpenAI adapter cannot supply Pi credentials",
      );
    }
    const credential = await runtimeCredential.call(this.#adapters.openai, account);
    return { ...credential, generation: state.generation };
  }

  public updatePiSession(input: {
    upstreamSessionId: string;
    processId: number;
    generation: number;
    state: "idle" | "working";
  }): void {
    this.updateRuntimeSession({
      ...input,
      client: "pi",
      provider: "openai",
    });
  }

  public updateClaudeSession(input: {
    upstreamSessionId: string;
    processId: number;
    generation?: number;
    state: "idle" | "working";
  }): void {
    this.updateRuntimeSession({
      ...input,
      generation: input.generation ?? this.#store.findProviderState("anthropic").generation,
      client: "claude",
      provider: "anthropic",
    });
  }

  public removeClaudeSession(input: { upstreamSessionId: string; processId: number }): void {
    const key = `claude:${input.processId}:${input.upstreamSessionId}`;
    const identifier = this.#runtimeIdentifiers.get(key);
    const persisted = this.#store
      .listRuntimeSessions()
      .find((session) => session.client === "claude" && session.processId === input.processId);
    const sessionId = identifier ?? persisted?.id;
    if (sessionId !== undefined) {
      this.#store.removeRuntimeSession(sessionId);
    }
    this.#runtimeIdentifiers.delete(key);
  }

  private updateRuntimeSession(input: {
    upstreamSessionId: string;
    processId: number;
    generation: number;
    state: "idle" | "working";
    client: "pi" | "claude";
    provider: ProviderId;
  }): void {
    const key = `${input.client}:${input.processId}:${input.upstreamSessionId}`;
    const persisted = this.#store
      .listRuntimeSessions()
      .find((session) => session.client === input.client && session.processId === input.processId);
    const id = this.#runtimeIdentifiers.get(key) ?? persisted?.id ?? crypto.randomUUID();
    this.#runtimeIdentifiers.set(key, id);
    const prior = this.#store.listRuntimeSessions().find((session) => session.id === id);
    const now = this.#dependencies.now().toISOString();
    this.#store.saveRuntimeSession(
      RuntimeSessionSchema.parse({
        id,
        client: input.client satisfies RuntimeClient,
        provider: input.provider,
        processId: input.processId,
        state: input.state,
        generation: input.generation,
        startedAt: prior?.startedAt ?? now,
        updatedAt: now,
      }),
    );
  }

  private adapter(provider: ProviderId): ProviderAdapter {
    switch (provider) {
      case "openai":
        return this.#adapters.openai;
      case "anthropic":
        return this.#adapters.anthropic;
    }
  }

  private async withProviderOperation<Result>(
    provider: ProviderId,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#providerOperationTails.get(provider) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#providerOperationTails.set(provider, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#providerOperationTails.get(provider) === tail) {
        this.#providerOperationTails.delete(provider);
      }
    }
  }

  private async performRefreshAll(): Promise<void> {
    this.pruneStoppedRuntimeSessions();
    for (const account of this.#store.listAccounts()) {
      if (this.#stopping) {
        return;
      }
      if (!account.enabled) {
        continue;
      }
      await this.refreshAccount(account).catch((error) => {
        process.stderr.write(
          `probe failed for ${account.provider} ${account.label}: ${errorMessage(error)}\n`,
        );
        this.#store.saveAccount({
          ...account,
          health: healthForError(error),
          updatedAt: this.#dependencies.now().toISOString(),
        });
      });
    }
    if (this.#stopping) {
      return;
    }
    for (const provider of ["openai", "anthropic"] as const) {
      if (this.#stopping) {
        return;
      }
      await this.evaluateAutomation(provider);
    }
  }

  private async evaluateAutomation(provider: ProviderId): Promise<void> {
    const state = this.#store.findProviderState(provider);
    const decision = selectRotation({
      accounts: this.#store.listAccounts(provider),
      usage: this.#store.listUsage(),
      state,
      now: this.#dependencies.now(),
    });
    if (decision.rotate) {
      await this.switchAccount(provider, decision.targetAccountId, `automatic:${decision.reason}`);
    }
  }

  private async recoverInterruptedSwitches(): Promise<void> {
    const terminalPhases = new Set<SwitchPhase>(["committed", "rolledBack", "failed"]);
    const records = this.#store.listSwitchRecords(100);
    for (const provider of ["openai", "anthropic"] as const) {
      const record = records.find((candidate) => candidate.provider === provider);
      if (record === undefined || terminalPhases.has(record.phase)) {
        continue;
      }
      const source =
        record.sourceAccountId === null ? null : this.#store.findAccount(record.sourceAccountId);
      const target = this.#store.findAccount(record.targetAccountId);
      let recovered = false;
      const adapter = this.adapter(provider);
      if (
        ["synchronizing", "activating", "verifying"].includes(record.phase) &&
        source?.provider === provider
      ) {
        await adapter.pauseDispatch();
        try {
          if (await waitFor(() => adapter.waitUntilIdle(), 5_000)) {
            const inspectRuntimeIdentity = adapter.runtimeExternalAccountId;
            const runtimeExternalAccountId =
              inspectRuntimeIdentity === undefined
                ? null
                : await inspectRuntimeIdentity.call(adapter).catch(() => null);
            const targetIsActive =
              target?.provider === provider &&
              target.externalAccountId !== null &&
              target.externalAccountId === runtimeExternalAccountId;
            if (
              targetIsActive ||
              (record.phase === "verifying" && inspectRuntimeIdentity === undefined)
            ) {
              await adapter.synchronizeSource(target);
            } else if (record.phase === "synchronizing") {
              await adapter.synchronizeSource(source).catch(() => undefined);
            }
            await adapter.activate(source);
            await this.probeAndSave(source);
            recovered = true;
          }
        } catch {
          recovered = false;
        } finally {
          adapter.resumeDispatch();
        }
      }
      if (source !== null) {
        this.#store.saveAccount({
          ...source,
          health: "unchecked",
          updatedAt: this.#dependencies.now().toISOString(),
        });
      }
      this.#store.saveSwitchRecord({
        ...record,
        phase: recovered ? "rolledBack" : "failed",
        message: recovered
          ? "Recovered the committed source account after manager restart"
          : `Manager restarted during ${record.phase}; reassert the committed account if health verification fails`,
        updatedAt: this.#dependencies.now().toISOString(),
      });
    }
  }

  private async performSwitch(
    provider: ProviderId,
    targetAccountId: string,
    reason: string,
  ): Promise<void> {
    const state = this.#store.findProviderState(provider);
    const target = this.#store.findAccount(targetAccountId);
    if (target === null || target.provider !== provider || !target.enabled) {
      throw new ApplicationError(
        "INVALID_TARGET",
        `Account ${targetAccountId} is not an enabled ${provider} account`,
      );
    }
    const reasserting = state.activeAccountId === targetAccountId;
    if (!reasserting) {
      await this.probeAndSave(target);
    }
    const switchId = crypto.randomUUID();
    const generation = state.generation + 1;
    const createdAt = this.#dependencies.now().toISOString();
    let phase: SwitchPhase = "prepared";
    const record = (message: string | null = null) =>
      SwitchRecordSchema.parse({
        id: switchId,
        provider,
        sourceAccountId: state.activeAccountId,
        targetAccountId,
        phase,
        reason,
        generation,
        message,
        createdAt,
        updatedAt: this.#dependencies.now().toISOString(),
      });
    this.#store.saveSwitchRecord(record());
    let activationAttempted = false;
    const adapter = this.adapter(provider);
    const source =
      state.activeAccountId === null ? null : this.#store.findAccount(state.activeAccountId);

    try {
      phase = "draining";
      this.#store.saveSwitchRecord(record());
      if (!(await this.waitUntilProviderIdle(provider))) {
        throw new ApplicationError(
          "SESSIONS_BUSY",
          `${provider} sessions did not become idle within 60 seconds`,
        );
      }
      if (source?.id !== target.id) {
        phase = "synchronizing";
        this.#store.saveSwitchRecord(record());
        await adapter.synchronizeSource(source);
      }
      phase = "activating";
      this.#store.saveSwitchRecord(record());
      activationAttempted = true;
      await adapter.activate(target);
      phase = "verifying";
      this.#store.saveSwitchRecord(record());
      await this.probeAndSave(target);
      phase = "committed";
      this.#store.commitSwitch(record(), {
        ...state,
        activeAccountId: target.id,
        generation,
        switchedAt: this.#dependencies.now().toISOString(),
      });
    } catch (error) {
      if (activationAttempted) {
        const inspectRuntimeIdentity = adapter.runtimeExternalAccountId;
        const runtimeExternalAccountId =
          inspectRuntimeIdentity === undefined
            ? null
            : await inspectRuntimeIdentity.call(adapter).catch(() => null);
        if (
          target.externalAccountId !== null &&
          target.externalAccountId === runtimeExternalAccountId
        ) {
          await adapter.synchronizeSource(target).catch(() => undefined);
        }
      }
      const rolledBack = activationAttempted
        ? await this.rollback(provider, source).catch(() => false)
        : false;
      phase = rolledBack ? "rolledBack" : "failed";
      this.#store.saveSwitchRecord(record(errorMessage(error)));
      throw new SwitchExecutionError(error, !activationAttempted || rolledBack);
    }
  }

  private async rollback(provider: ProviderId, source: Account | null): Promise<boolean> {
    if (source === null) {
      return false;
    }
    await this.adapter(provider).activate(source);
    await this.probeAndSave(source);
    return true;
  }

  private async waitUntilProviderIdle(provider: ProviderId): Promise<boolean> {
    return waitFor(async () => {
      this.pruneStoppedRuntimeSessions();
      const managedSessionsIdle = this.#store
        .listRuntimeSessions()
        .filter((session) => session.provider === provider)
        .every((session) => session.state === "idle");
      return managedSessionsIdle && (await this.adapter(provider).waitUntilIdle());
    }, 60_000);
  }

  private pruneStoppedRuntimeSessions(): void {
    for (const session of this.#store.listRuntimeSessions()) {
      try {
        process.kill(session.processId, 0);
      } catch {
        this.#store.removeRuntimeSession(session.id);
      }
    }
  }
}
