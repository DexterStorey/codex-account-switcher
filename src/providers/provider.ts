import type { Account, ProviderId, UsageSnapshot } from "../domain.ts";

export interface ProviderProbeResult {
  account: Account;
  usage: UsageSnapshot;
}

export interface ProviderRuntimeCredential {
  provider: "openai";
  accessToken: string;
  accountId: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  start(): Promise<void>;
  ensureReady?(): Promise<void>;
  stop(): Promise<void>;
  probe(account: Account): Promise<ProviderProbeResult>;
  pauseDispatch(): Promise<void>;
  resumeDispatch(): void;
  waitUntilIdle(): Promise<boolean>;
  synchronizeSource(account: Account | null): Promise<void>;
  runtimeExternalAccountId?(): Promise<string | null>;
  activate(account: Account): Promise<void>;
  runtimeCredential?(account: Account): Promise<ProviderRuntimeCredential>;
}
