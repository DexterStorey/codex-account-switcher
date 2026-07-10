import { ProviderId, SnapshotStore, snapshotStore } from "../store/store";
import { AuthProvider, sameAccount } from "../auth/types";
import { codexAuthProvider } from "../auth/codex";
import { claudeAuthProvider } from "../auth/claude";
import { piAuthProvider } from "../auth/pi";
import { RateLimitReader, Usage, effectiveUsedPercent, fiveHourWindow } from "../limits/types";
import { codexRateLimitReader } from "../limits/codex";
import { claudeRateLimitReader } from "../limits/claude";
import { piRateLimitReader } from "../limits/pi";
import { CodexContinuity } from "../sessions/continuity";

export interface ProviderStack {
  auth: AuthProvider;
  limits: RateLimitReader;
  /** Whether rotation should restart user-owned sessions (codex only). */
  restartsSessions: boolean;
}

export const providerRegistry: Record<ProviderId, ProviderStack> = {
  codex: { auth: codexAuthProvider, limits: codexRateLimitReader, restartsSessions: true },
  claude: { auth: claudeAuthProvider, limits: claudeRateLimitReader, restartsSessions: false },
  pi: { auth: piAuthProvider, limits: piRateLimitReader, restartsSessions: false },
};

export interface CandidateReading {
  name: string;
  usage: Usage;
  effectiveFiveHour: number | null;
}

export interface RotationDecision {
  provider: ProviderId;
  active: string | null;
  activeFiveHour: number | null;
  threshold: number;
  shouldRotate: boolean;
  rotated: boolean;
  to: string | null;
  reason: string;
  candidates: CandidateReading[];
}

export interface RotateOptions {
  threshold?: number; // percent, default 95
  dryRun?: boolean;
  log?: (message: string) => void;
}

export class Rotator {
  constructor(
    private readonly registry: Record<ProviderId, ProviderStack> = providerRegistry,
    private readonly store: SnapshotStore = snapshotStore,
  ) {}

  public async rotate(provider: ProviderId, options: RotateOptions = {}): Promise<RotationDecision> {
    const threshold = options.threshold ?? 95;
    const log = options.log ?? (() => {});
    const stack = this.registry[provider];

    const base: Omit<RotationDecision, "reason"> = {
      provider,
      active: null,
      activeFiveHour: null,
      threshold,
      shouldRotate: false,
      rotated: false,
      to: null,
      candidates: [],
    };

    const names = await stack.auth.list();
    if (names.length < 2) {
      return { ...base, reason: `only ${names.length} saved account(s) — nothing to rotate to` };
    }

    const active = await this.resolveActive(provider, stack);
    if (!active) {
      return { ...base, reason: "cannot attribute live credentials to a saved account" };
    }
    base.active = active;

    const activeUsage = await stack.limits.read(active);
    const activeWindow = fiveHourWindow(activeUsage);
    if (!activeWindow) {
      return { ...base, reason: `no 5h usage reading for active account (${activeUsage.error ?? "unknown"})` };
    }
    const activeFiveHour = effectiveUsedPercent(activeWindow);
    base.activeFiveHour = activeFiveHour;

    if (activeFiveHour < threshold) {
      return {
        ...base,
        reason: `active "${active}" at ${activeFiveHour.toFixed(0)}% of 5h window (< ${threshold}%)`,
      };
    }
    base.shouldRotate = true;

    // Candidates: other saved accounts that are genuinely different accounts.
    const activeIdentity = await stack.auth.identityOf(active);
    const candidates: CandidateReading[] = [];
    for (const name of names) {
      if (name === active) continue;
      if (sameAccount(await stack.auth.identityOf(name), activeIdentity)) {
        log(`Skipping "${name}" — same underlying account as "${active}".`);
        continue;
      }
      const usage = await stack.limits.read(name);
      const window = fiveHourWindow(usage);
      candidates.push({
        name,
        usage,
        effectiveFiveHour: window ? effectiveUsedPercent(window) : null,
      });
    }
    base.candidates = candidates;

    const usable = candidates
      .filter((c) => c.effectiveFiveHour !== null)
      .sort((a, b) => (a.effectiveFiveHour as number) - (b.effectiveFiveHour as number));
    if (!usable.length) {
      return { ...base, reason: "no candidate account with a readable 5h window" };
    }

    const pick = usable[0];
    if ((pick.effectiveFiveHour as number) >= threshold) {
      return {
        ...base,
        reason: `all candidates are also above ${threshold}% (best: "${pick.name}" at ${pick.effectiveFiveHour}%)`,
      };
    }

    if (options.dryRun) {
      return {
        ...base,
        to: pick.name,
        reason: `[dry-run] would rotate ${active} (${activeFiveHour.toFixed(0)}%) → ${pick.name} (${pick.effectiveFiveHour}%)`,
      };
    }

    await this.performSwitch(provider, stack, pick.name, log);
    await this.store.logRotation({
      at: new Date().toISOString(),
      provider,
      from: active,
      to: pick.name,
      reason: `5h window ${activeFiveHour.toFixed(0)}% >= ${threshold}%`,
    });

    return {
      ...base,
      rotated: true,
      to: pick.name,
      reason: `rotated ${active} (${activeFiveHour.toFixed(0)}%) → ${pick.name} (${pick.effectiveFiveHour}%)`,
    };
  }

  /**
   * Detect and repair clobbering: if the live credentials no longer belong to
   * the recorded active account (a lingering session's refresh wrote an old
   * account back), sync the stray tokens home and re-assert the active one.
   */
  public async reassert(provider: ProviderId, log: (m: string) => void = () => {}): Promise<boolean> {
    const stack = this.registry[provider];
    const active = await this.store.getActive(provider);
    if (!active) return false;

    const liveIdentity = await stack.auth.current();
    const activeIdentity = await stack.auth.identityOf(active);
    if (!liveIdentity?.accountId || !activeIdentity?.accountId) return false;
    if (sameAccount(liveIdentity, activeIdentity)) return false;

    log(
      `Live ${provider} credentials belong to ${liveIdentity.email ?? liveIdentity.accountId}, ` +
        `not active "${active}" — repairing (a running session likely rewrote them).`,
    );
    await stack.auth.activate(active); // activate() sync-backs the stray blob first
    return true;
  }

  private async performSwitch(
    provider: ProviderId,
    stack: ProviderStack,
    to: string,
    log: (m: string) => void,
  ): Promise<void> {
    if (stack.restartsSessions && provider === "codex") {
      const continuity = new CodexContinuity();
      await continuity.stopUserSessions(log);
      await stack.auth.activate(to);
      await continuity.resumeSessions(log);
    } else {
      await stack.auth.activate(to);
    }
  }

  /** The recorded active account, else attribute live credentials by identity. */
  private async resolveActive(provider: ProviderId, stack: ProviderStack): Promise<string | null> {
    const recorded = await this.store.getActive(provider);
    if (recorded) {
      const names = await stack.auth.list();
      if (names.includes(recorded)) return recorded;
    }
    const live = await stack.auth.current();
    if (!live?.accountId) return null;
    for (const name of await stack.auth.list()) {
      if (sameAccount(await stack.auth.identityOf(name), live)) {
        await this.store.setActive(provider, name);
        return name;
      }
    }
    return null;
  }
}

export const rotator = new Rotator();
