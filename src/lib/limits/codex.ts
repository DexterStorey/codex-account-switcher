import { SnapshotStore, snapshotStore } from "../store/store";
import { CodexAuthProvider, codexAuthProvider, codexIdentityOfBlob } from "../auth/codex";
import { sameAccount } from "../auth/types";
import { RateLimitReader, Usage, UsageWindow } from "./types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TIMEOUT_MS = 10_000;
const SAMPLE_COUNT = 3;

interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number; // unix seconds
}

interface WhamUsageResponse {
  email?: string;
  plan_type?: string;
  rate_limit?: {
    primary_window?: WhamWindow;
    secondary_window?: WhamWindow;
  };
}

interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export class CodexRateLimitReader implements RateLimitReader {
  public readonly provider = "codex" as const;

  constructor(
    private readonly store: SnapshotStore = snapshotStore,
    private readonly auth: CodexAuthProvider = codexAuthProvider,
  ) {}

  public async read(account: string): Promise<Usage> {
    try {
      const usage = await this.readLive(account);
      await this.store.writeUsageCache("codex", account, JSON.stringify(usage));
      return usage;
    } catch (error) {
      return this.fromCache(account, (error as Error).message);
    }
  }

  /**
   * Query wham/usage (also used by the pi reader).
   *
   * The endpoint intermittently (~1 in 12 observed) answers with a different
   * rate-limit bucket for the same token — a much lower used_percent with
   * unrelated reset timestamps. Acting on one of those would rotate onto an
   * exhausted account, so take SAMPLE_COUNT readings, keep the majority
   * bucket (grouped by the 5h reset timestamp), and within it use the highest
   * used_percent, which is the conservative choice in both directions:
   * an inflated candidate reading is never picked, and an inflated active
   * reading only rotates us away sooner.
   */
  public async queryEndpoint(
    accessToken: string,
    accountId: string | null,
  ): Promise<{ windows: UsageWindow[]; email: string | null; plan: string | null }> {
    const samples = await Promise.all(
      Array.from({ length: SAMPLE_COUNT }, () => this.queryOnce(accessToken, accountId)),
    );

    const buckets = new Map<string, WhamUsageResponse[]>();
    for (const sample of samples) {
      const key = String(sample.rate_limit?.primary_window?.reset_at ?? "none");
      buckets.set(key, [...(buckets.get(key) ?? []), sample]);
    }
    const majority = [...buckets.values()].sort((a, b) => b.length - a.length)[0];

    const primary = this.pickConservative(majority.map((s) => s.rate_limit?.primary_window));
    const secondary = this.pickConservative(majority.map((s) => s.rate_limit?.secondary_window));

    const windows: UsageWindow[] = [];
    if (primary) windows.push(this.toWindow("5h", primary));
    if (secondary) windows.push(this.toWindow("weekly", secondary));

    const head = majority[0];
    return { windows, email: head.email ?? null, plan: head.plan_type ?? null };
  }

  private async queryOnce(accessToken: string, accountId: string | null): Promise<WhamUsageResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "codex-cli",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`usage endpoint returned HTTP ${res.status}`);
    }
    return (await res.json()) as WhamUsageResponse;
  }

  private pickConservative(windows: (WhamWindow | undefined)[]): WhamWindow | undefined {
    const present = windows.filter((w): w is WhamWindow => Boolean(w));
    if (!present.length) return undefined;
    return present.reduce((worst, w) =>
      (w.used_percent ?? 0) > (worst.used_percent ?? 0) ? w : worst,
    );
  }

  private async readLive(account: string): Promise<Usage> {
    const tokens = await this.freshTokensFor(account);
    if (!tokens?.access_token) {
      throw new Error("snapshot has no access token");
    }

    let result;
    try {
      result = await this.queryEndpoint(tokens.access_token, tokens.account_id ?? null);
    } catch (error) {
      if (!(error as Error).message.includes("401")) throw error;
      const refreshed = await this.refreshSnapshot(account);
      result = await this.queryEndpoint(refreshed.access_token as string, refreshed.account_id ?? null);
    }

    return {
      provider: "codex",
      account,
      windows: result.windows,
      identity: { email: result.email, plan: result.plan },
      asOf: new Date().toISOString(),
      source: "live",
      stale: false,
    };
  }

  /**
   * Token source discipline: for the account that is LIVE in ~/.codex/auth.json,
   * read the live tokens directly — codex keeps them fresh, and refreshing our
   * copy of a rotating refresh token would strand codex's copy.
   *
   * Reading usage must never write credential files (a read racing a write
   * would hand a sibling reader a half-swapped account), so this does NOT
   * sync back; `activate()` owns that.
   */
  private async freshTokensFor(account: string): Promise<CodexTokens | null> {
    const snapshot = await this.store.read("codex", account);
    if (!snapshot) throw new Error(`no saved codex account "${account}"`);

    const live = await this.auth.readLiveBlob();
    if (live && sameAccount(codexIdentityOfBlob(snapshot), codexIdentityOfBlob(live))) {
      return (JSON.parse(live) as { tokens?: CodexTokens }).tokens ?? null;
    }
    return (JSON.parse(snapshot) as { tokens?: CodexTokens }).tokens ?? null;
  }

  /** OAuth refresh for a NON-LIVE snapshot; persists rotated tokens to all same-account snapshots. */
  private async refreshSnapshot(account: string): Promise<CodexTokens> {
    const raw = await this.store.read("codex", account);
    if (!raw) throw new Error(`no saved codex account "${account}"`);
    const parsed = JSON.parse(raw) as { tokens?: CodexTokens; last_refresh?: string };
    const refreshToken = parsed.tokens?.refresh_token;
    if (!refreshToken) throw new Error("snapshot has no refresh token");

    if (sameAccount(codexIdentityOfBlob(raw), await this.auth.current())) {
      throw new Error(
        "refusing to refresh the live account's snapshot (would strand codex's own rotating refresh token)",
      );
    }

    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`token refresh failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    parsed.tokens = {
      ...parsed.tokens,
      id_token: body.id_token ?? parsed.tokens?.id_token,
      access_token: body.access_token ?? parsed.tokens?.access_token,
      refresh_token: body.refresh_token ?? refreshToken,
    };
    parsed.last_refresh = new Date().toISOString();
    const updated = JSON.stringify(parsed);

    // Rotated refresh tokens are single-use: every snapshot of this account
    // must get the new pair or the others die.
    const identity = codexIdentityOfBlob(updated);
    for (const name of await this.store.list("codex")) {
      const other = await this.store.read("codex", name);
      if (!other) continue;
      if (name === account || sameAccount(codexIdentityOfBlob(other), identity)) {
        await this.store.write("codex", name, updated);
      }
    }

    return parsed.tokens;
  }

  private async fromCache(account: string, reason: string): Promise<Usage> {
    const cached = await this.store.readUsageCache("codex", account);
    if (cached) {
      const usage = JSON.parse(cached) as Usage;
      return { ...usage, source: "cache", stale: true, error: reason };
    }
    return {
      provider: "codex",
      account,
      windows: [],
      identity: { email: null, plan: null },
      asOf: new Date().toISOString(),
      source: "cache",
      stale: true,
      error: reason,
    };
  }

  private toWindow(kind: "5h" | "weekly", w: WhamWindow): UsageWindow {
    return {
      kind,
      usedPercent: w.used_percent ?? 0,
      resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
      windowMinutes: w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : null,
    };
  }
}

export const codexRateLimitReader = new CodexRateLimitReader();
