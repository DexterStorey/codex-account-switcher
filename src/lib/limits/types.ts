import { ProviderId } from "../store/store";

export interface UsageWindow {
  kind: "5h" | "weekly";
  usedPercent: number; // 0-100 as reported at asOf
  resetsAt: string | null; // ISO timestamp when the window fully resets
  windowMinutes: number | null;
}

export interface Usage {
  provider: ProviderId;
  account: string;
  windows: UsageWindow[];
  identity: { email: string | null; plan: string | null };
  asOf: string; // ISO timestamp of the reading
  source: "live" | "cache";
  stale: boolean;
  error?: string; // why a live read failed, when source === "cache" or windows empty
}

/**
 * Best current estimate for a window given reading age: after the recorded
 * reset the window is empty; before it, the recorded value is an upper bound.
 */
export function effectiveUsedPercent(window: UsageWindow, now: Date = new Date()): number {
  if (window.resetsAt && now >= new Date(window.resetsAt)) return 0;
  return window.usedPercent;
}

export function fiveHourWindow(usage: Usage): UsageWindow | null {
  return usage.windows.find((w) => w.kind === "5h") ?? null;
}

export interface RateLimitReader {
  readonly provider: ProviderId;
  /** Usage for a SAVED account (live endpoint, cache fallback). */
  read(account: string): Promise<Usage>;
}
