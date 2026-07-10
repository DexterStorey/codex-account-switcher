import { ProviderId } from "../store/store";

export interface AccountRef {
  provider: ProviderId;
  name: string;
}

export interface AccountIdentity {
  /** Provider-native account id (ChatGPT workspace uuid, Anthropic account uuid...). */
  accountId: string | null;
  /** The individual user within that account, where the provider distinguishes them. */
  userId?: string | null;
  email: string | null;
}

/**
 * Do two identities refer to the same credential owner?
 *
 * A ChatGPT `account_id` is a workspace: two seats in one workspace share it
 * but have separate rate limits and separate tokens. Treating them as one
 * account would make sync-back overwrite one seat's tokens with the other's,
 * so the user (or email) must match too whenever the provider reports one.
 */
export function sameAccount(a: AccountIdentity | null, b: AccountIdentity | null): boolean {
  if (!a?.accountId || !b?.accountId) return false;
  if (a.accountId !== b.accountId) return false;

  const userA = a.userId ?? a.email;
  const userB = b.userId ?? b.email;
  if (userA && userB) return userA === userB;
  return true; // provider does not distinguish users; account id is all we have
}

/**
 * Credential mechanics for one CLI. Implementations know where the CLI keeps
 * live credentials, how to snapshot/restore them safely, and how to log in a
 * NEW account without disturbing the live one. No usage/rotation knowledge.
 */
export interface AuthProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Snapshot the CLI's live credentials as a named account. */
  save(name: string): Promise<AccountRef>;

  /**
   * Run a login flow that adds a new account snapshot while leaving the
   * currently-live credentials in place afterwards.
   */
  add(name: string): Promise<AccountRef>;

  /**
   * Make a saved account the live one: sync-back (re-snapshot the outgoing
   * account so rotated refresh tokens are not stranded), swap, verify.
   */
  activate(name: string): Promise<AccountRef>;

  /** Identity of whatever credentials are live right now (not snapshots). */
  current(): Promise<AccountIdentity | null>;

  /** Identity recorded inside a snapshot (no network). */
  identityOf(name: string): Promise<AccountIdentity | null>;

  list(): Promise<string[]>;
}
