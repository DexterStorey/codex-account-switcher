import {
  type Account,
  AutomationPolicySchema,
  type ProviderId,
  SwitchRecordSchema,
} from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import type { FetchImplementation } from "./http.ts";
import type { ApplicationPaths } from "./paths.ts";
import { AnthropicProviderAdapter } from "./providers/claude/provider.ts";
import type { CredentialVault } from "./providers/codex/auth.ts";
import { OpenAiProviderAdapter } from "./providers/codex/provider.ts";
import type { ProviderAdapter } from "./providers/provider.ts";
import { type RunningProxy, startProxy } from "./proxy.ts";
import { createRuntimeCredentialSource } from "./runtime-source.ts";
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

export class AccountManager {
  readonly #store: StateStore;
  readonly #paths: ApplicationPaths;
  readonly #dependencies: ManagerDependencies;
  readonly #adapters: ProviderAdapters;
  readonly #vault: CredentialVault;
  readonly #providerOperationTails = new Map<ProviderId, Promise<void>>();
  readonly #probeCooldownUntil = new Map<string, number>();
  readonly #lastProbeStartedAt = new Map<string, number>();
  #proxy: RunningProxy | null = null;
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
    this.#paths = input.paths;
    this.#vault = input.vault;
    this.#dependencies = { ...defaultDependencies, ...input.dependencies };
    this.#adapters =
      input.adapters ??
      ({
        openai: new OpenAiProviderAdapter({
          vault: input.vault,
          dependencies: this.#dependencies,
        }),
        anthropic: new AnthropicProviderAdapter({ dependencies: this.#dependencies }),
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

  public get proxyPort(): number | null {
    return this.#proxy?.port ?? null;
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    const source = createRuntimeCredentialSource({
      store: { activeAccount: (provider) => this.activeAccount(provider) },
      vault: this.#vault,
      fetchImplementation: this.#dependencies.fetchImplementation,
    });
    this.#proxy = startProxy({ source, port: this.#paths.proxyPort });
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
    const bounded = (work: Promise<unknown> | undefined, milliseconds: number) =>
      work === undefined ? Promise.resolve() : Promise.race([work, Bun.sleep(milliseconds)]);
    await bounded(
      this.#refreshOperation?.catch(() => undefined),
      15_000,
    );
    await bounded(
      this.#proxy?.stop().catch(() => undefined),
      5_000,
    );
    this.#proxy = null;
  }

  public dashboard() {
    return this.#store.dashboard();
  }

  public activeAccount(provider: ProviderId): Account | null {
    const accountId = this.#store.findProviderState(provider).activeAccountId;
    return accountId === null ? null : this.#store.findAccount(accountId);
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

  // A switch is now a validated state update: the proxy reads the active
  // account per request, so pointing every subsequent request at the target
  // is all that is required. The target is probed first so a switch never
  // commits to an unusable credential.
  public async switchAccount(
    provider: ProviderId,
    targetAccountId: string,
    reason = "manual",
  ): Promise<void> {
    return this.withProviderOperation(provider, async () => {
      const state = this.#store.findProviderState(provider);
      const target = this.#store.findAccount(targetAccountId);
      if (target === null || target.provider !== provider || !target.enabled) {
        throw new ApplicationError(
          "INVALID_TARGET",
          `Account ${targetAccountId} is not an enabled ${provider} account`,
        );
      }
      if (state.activeAccountId !== targetAccountId) {
        await this.probeAndSave(target);
      }
      const now = this.#dependencies.now().toISOString();
      this.#store.commitSwitch(
        SwitchRecordSchema.parse({
          id: crypto.randomUUID(),
          provider,
          sourceAccountId: state.activeAccountId,
          targetAccountId,
          phase: "committed",
          reason,
          generation: state.generation + 1,
          message: null,
          createdAt: now,
          updatedAt: now,
        }),
        {
          ...state,
          activeAccountId: target.id,
          generation: state.generation + 1,
          switchedAt: now,
        },
      );
    });
  }

  private async performRefreshAll(): Promise<void> {
    for (const account of this.#store.listAccounts()) {
      if (this.#stopping) {
        return;
      }
      if (!account.enabled) {
        continue;
      }
      const cooldownUntil = this.#probeCooldownUntil.get(account.id) ?? 0;
      if (this.#dependencies.now().getTime() < cooldownUntil) {
        continue;
      }
      // Only the active account needs minute-level freshness (it drives
      // rotation); idle accounts get coarse readings so many registered
      // accounts do not multiply the provider's probe traffic.
      const isActive =
        this.#store.findProviderState(account.provider).activeAccountId === account.id;
      const probeInterval = isActive ? 0 : 5 * 60_000;
      const lastStartedAt = this.#lastProbeStartedAt.get(account.id) ?? 0;
      if (this.#dependencies.now().getTime() - lastStartedAt < probeInterval) {
        continue;
      }
      this.#lastProbeStartedAt.set(account.id, this.#dependencies.now().getTime());
      await this.refreshAccount(account).catch((error) => {
        process.stderr.write(
          `probe failed for ${account.provider} ${account.label}: ${errorMessage(error)}\n`,
        );
        if (error instanceof ApplicationError && error.code === "USAGE_RATE_LIMITED") {
          this.#probeCooldownUntil.set(account.id, this.#dependencies.now().getTime() + 5 * 60_000);
        }
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
      await this.performSwitchForAutomation(provider, decision.targetAccountId, decision.reason);
    }
  }

  private async performSwitchForAutomation(
    provider: ProviderId,
    targetAccountId: string,
    reason: string,
  ): Promise<void> {
    const state = this.#store.findProviderState(provider);
    const target = this.#store.findAccount(targetAccountId);
    if (target === null || target.provider !== provider || !target.enabled) {
      return;
    }
    const now = this.#dependencies.now().toISOString();
    this.#store.commitSwitch(
      SwitchRecordSchema.parse({
        id: crypto.randomUUID(),
        provider,
        sourceAccountId: state.activeAccountId,
        targetAccountId,
        phase: "committed",
        reason: `automatic:${reason}`,
        generation: state.generation + 1,
        message: null,
        createdAt: now,
        updatedAt: now,
      }),
      {
        ...state,
        activeAccountId: target.id,
        generation: state.generation + 1,
        switchedAt: now,
      },
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
}
