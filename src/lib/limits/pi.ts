import { SnapshotStore, snapshotStore } from "../store/store";
import { PiAuthProvider, piAuthProvider } from "../auth/pi";
import { CodexRateLimitReader, codexRateLimitReader } from "./codex";
import { ClaudeRateLimitReader, claudeRateLimitReader } from "./claude";
import { RateLimitReader, Usage, UsageWindow } from "./types";

/**
 * A pi account holds an openai-codex entry and an anthropic entry. Its usage
 * is read with the same two endpoints, using pi's own tokens. pi refreshes its
 * own tokens — we NEVER refresh them (rotation would strand pi's copy); on
 * 401 we fall back to cache and let pi heal itself.
 *
 * The reported windows are the codex entry's (pi's default provider is
 * openai-codex on this setup); anthropic windows are appended when readable.
 */
export class PiRateLimitReader implements RateLimitReader {
  public readonly provider = "pi" as const;

  constructor(
    private readonly store: SnapshotStore = snapshotStore,
    private readonly auth: PiAuthProvider = piAuthProvider,
    private readonly codexReader: CodexRateLimitReader = codexRateLimitReader,
    private readonly claudeReader: ClaudeRateLimitReader = claudeRateLimitReader,
  ) {}

  public async read(account: string): Promise<Usage> {
    const entries = await this.auth.entriesOf(account);
    const windows: UsageWindow[] = [];
    let email: string | null = null;
    let plan: string | null = null;
    const errors: string[] = [];

    if (entries.codex) {
      try {
        const result = await this.codexReader.queryEndpoint(
          entries.codex.access,
          entries.codex.accountId,
        );
        windows.push(...result.windows);
        email = result.email;
        plan = result.plan;
      } catch (error) {
        errors.push(`codex entry: ${(error as Error).message}`);
      }
    }

    if (entries.anthropic) {
      try {
        const claudeWindows = await this.claudeReader.queryEndpoint(entries.anthropic.access);
        // Only append if the codex entry produced nothing, to keep one
        // authoritative 5h window per account for the rotator.
        if (!windows.length) windows.push(...claudeWindows);
      } catch (error) {
        errors.push(`anthropic entry: ${(error as Error).message}`);
      }
    }

    if (!windows.length) {
      return this.fromCache(account, errors.join("; ") || "no readable entries");
    }

    const usage: Usage = {
      provider: "pi",
      account,
      windows,
      identity: { email, plan },
      asOf: new Date().toISOString(),
      source: "live",
      stale: false,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
    await this.store.writeUsageCache("pi", account, JSON.stringify(usage));
    return usage;
  }

  private async fromCache(account: string, reason: string): Promise<Usage> {
    const cached = await this.store.readUsageCache("pi", account);
    if (cached) {
      const usage = JSON.parse(cached) as Usage;
      return { ...usage, source: "cache", stale: true, error: reason };
    }
    return {
      provider: "pi",
      account,
      windows: [],
      identity: { email: null, plan: null },
      asOf: new Date().toISOString(),
      source: "cache",
      stale: true,
      error: reason,
    };
  }
}

export const piRateLimitReader = new PiRateLimitReader();
