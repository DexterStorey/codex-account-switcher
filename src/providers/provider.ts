import type { Account, ProviderId, UsageSnapshot } from "../domain.ts";
import { ApplicationError } from "../errors.ts";

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

// Narrow an account to one provider's variant. The runtime guard makes the cast
// safe; an adapter handed the wrong provider's account fails loudly instead of
// silently mis-injecting a credential.
export function requireProvider<P extends ProviderId>(
  account: Account,
  provider: P,
): Extract<Account, { provider: P }> {
  if (account.provider !== provider) {
    throw new ApplicationError(
      "PROVIDER_MISMATCH",
      `${provider} adapter received a ${account.provider} account`,
    );
  }
  return account as Extract<Account, { provider: P }>;
}
