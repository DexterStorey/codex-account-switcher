import { SnapshotStore, snapshotStore } from "../store/store";
import {
  CLAUDE_OAUTH_BETA_HEADER,
  ClaudeAuthProvider,
  claudeAuthProvider,
} from "../auth/claude";
import { RateLimitReader, Usage, UsageWindow } from "./types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TIMEOUT_MS = 10_000;

interface OauthUsageWindow {
  /** Percent 0-100 (verified live: 26 means 26%, despite the CLI's internal *100 mapper). */
  utilization?: number;
  resets_at?: string | number;
}

interface OauthUsageResponse {
  five_hour?: OauthUsageWindow;
  seven_day?: OauthUsageWindow;
}

export class ClaudeRateLimitReader implements RateLimitReader {
  public readonly provider = "claude" as const;

  constructor(
    private readonly store: SnapshotStore = snapshotStore,
    private readonly auth: ClaudeAuthProvider = claudeAuthProvider,
  ) {}

  public async read(account: string): Promise<Usage> {
    try {
      const usage = await this.readLive(account);
      await this.store.writeUsageCache("claude", account, JSON.stringify(usage));
      return usage;
    } catch (error) {
      return this.fromCache(account, (error as Error).message);
    }
  }

  /** Query the oauth/usage endpoint with an access token (also used by the pi reader). */
  public async queryEndpoint(accessToken: string): Promise<UsageWindow[]> {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`usage endpoint returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as OauthUsageResponse;

    const windows: UsageWindow[] = [];
    if (body.five_hour) windows.push(this.toWindow("5h", body.five_hour, 300));
    if (body.seven_day) windows.push(this.toWindow("weekly", body.seven_day, 10_080));
    return windows;
  }

  private async readLive(account: string): Promise<Usage> {
    const token = await this.freshTokenFor(account);
    if (!token) throw new Error("snapshot has no access token");

    let windows: UsageWindow[];
    try {
      windows = await this.queryEndpoint(token);
    } catch (error) {
      if (!(error as Error).message.includes("401")) throw error;
      const refreshed = await this.refreshSnapshot(account);
      windows = await this.queryEndpoint(refreshed);
    }

    const identity = await this.auth.identityOf(account);
    return {
      provider: "claude",
      account,
      windows,
      identity: { email: identity?.email ?? null, plan: null },
      asOf: new Date().toISOString(),
      source: "live",
      stale: false,
    };
  }

  /**
   * Same discipline as codex: if this snapshot's account is what's live in
   * the keychain, read the live token directly — never self-refresh a token
   * pair the CLI is also refreshing (rotation strands one copy), and never
   * write credentials during a usage read.
   */
  private async freshTokenFor(account: string): Promise<string | null> {
    const snapshotIdentity = await this.auth.identityOf(account);
    const liveIdentity = await this.auth.current();
    if (
      snapshotIdentity?.accountId &&
      liveIdentity?.accountId &&
      snapshotIdentity.accountId === liveIdentity.accountId
    ) {
      const liveBlob = await this.auth.readKeychainBlob();
      const liveToken = liveBlob ? this.auth.accessTokenOfBlob(liveBlob) : null;
      if (liveToken) return liveToken;
    }
    return this.auth.accessTokenOf(account);
  }

  /** OAuth refresh for a NON-LIVE snapshot; persists the rotated pair. */
  private async refreshSnapshot(account: string): Promise<string> {
    const oauth = await this.auth.readSnapshotOauth(account);
    if (!oauth) throw new Error(`no saved claude account "${account}"`);
    const refreshToken = oauth.refreshToken;
    if (!refreshToken) throw new Error("snapshot has no refresh token");

    const snapshotIdentity = await this.auth.identityOf(account);
    const liveIdentity = await this.auth.current();
    if (
      snapshotIdentity?.accountId &&
      snapshotIdentity.accountId === liveIdentity?.accountId
    ) {
      throw new Error(
        "refusing to refresh the live account's snapshot (would strand Claude Code's rotating refresh token)",
      );
    }

    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`token refresh failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error("token refresh returned no access token");

    await this.auth.updateSnapshotOauth(account, {
      ...oauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : oauth.expiresAt,
    });
    return body.access_token;
  }

  private async fromCache(account: string, reason: string): Promise<Usage> {
    const cached = await this.store.readUsageCache("claude", account);
    if (cached) {
      const usage = JSON.parse(cached) as Usage;
      return { ...usage, source: "cache", stale: true, error: reason };
    }
    return {
      provider: "claude",
      account,
      windows: [],
      identity: { email: null, plan: null },
      asOf: new Date().toISOString(),
      source: "cache",
      stale: true,
      error: reason,
    };
  }

  private toWindow(
    kind: "5h" | "weekly",
    w: OauthUsageWindow,
    windowMinutes: number,
  ): UsageWindow {
    let resetsAt: string | null = null;
    if (typeof w.resets_at === "number") {
      // epoch seconds vs milliseconds
      resetsAt = new Date(w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000).toISOString();
    } else if (typeof w.resets_at === "string") {
      const parsed = new Date(w.resets_at);
      resetsAt = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return {
      kind,
      usedPercent: Math.min(100, Math.max(0, w.utilization ?? 0)),
      resetsAt,
      windowMinutes,
    };
  }
}

export const claudeRateLimitReader = new ClaudeRateLimitReader();
