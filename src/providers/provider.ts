import type { Account, ProviderId, UsageSnapshot } from "../domain.ts";

export interface ProviderProbeResult {
  account: Account;
  usage: UsageSnapshot;
}

// Adapters now only read usage and health. Running sessions get their
// credentials from the proxy, so there is no runtime to activate or drain.
export interface ProviderAdapter {
  readonly provider: ProviderId;
  probe(account: Account): Promise<ProviderProbeResult>;
}
