import type { Account, UsageHistoryPoint } from "../domain.ts";

// Pure presentation helpers shared by the TUI. No terminal or OpenTUI
// dependency, so they stay trivially testable and deterministic.

export const palette = {
  fg: "#e6e6e6",
  dim: "#6b7280",
  faint: "#3b4048",
  accent: "#4aa8ff",
  bg: "#0b0d10",
  panel: "#12151a",
  selected: "#1e2530",
  good: "#37d67a",
  warn: "#f5a623",
  bad: "#ff5c6c",
} as const;

export function pressureColor(usedPercent: number | null): string {
  if (usedPercent === null) {
    return palette.dim;
  }
  if (usedPercent >= 85) {
    return palette.bad;
  }
  if (usedPercent >= 60) {
    return palette.warn;
  }
  return palette.good;
}

export function meter(usedPercent: number | null, width = 14): string {
  if (usedPercent === null) {
    return "·".repeat(width);
  }
  const filled = Math.round((clamp(usedPercent) / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

const sparkTicks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

// A fixed-scale (0..100) sparkline so a flat-but-high window reads as high,
// not as noise around its own mean.
export function sparkline(points: readonly UsageHistoryPoint[], width = 16): string {
  if (points.length === 0) {
    return "·".repeat(width);
  }
  const recent = points.slice(-width);
  const padded = width - recent.length;
  const body = recent
    .map((point) => {
      const index = Math.min(
        sparkTicks.length - 1,
        Math.floor((clamp(point.usedPercent) / 100) * sparkTicks.length),
      );
      return sparkTicks[index] ?? sparkTicks[0];
    })
    .join("");
  return `${" ".repeat(Math.max(0, padded))}${body}`;
}

export function percentLabel(usedPercent: number | null): string {
  return usedPercent === null ? "  ?%" : `${Math.round(clamp(usedPercent))}%`.padStart(4);
}

export function resetLabel(resetAt: string | null, nowMillis: number): string {
  if (resetAt === null) {
    return "";
  }
  const remaining = Date.parse(resetAt) - nowMillis;
  if (!Number.isFinite(remaining)) {
    return "";
  }
  if (remaining <= 0) {
    return "resets now";
  }
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem === 0 ? `${days}d` : `${days}d ${rem}h`;
}

export interface HealthBadge {
  text: string;
  color: string;
}

export function healthBadge(account: Account): HealthBadge | null {
  switch (account.health) {
    case "ready":
    case "unchecked":
      return null;
    case "refreshDue":
    case "refreshing":
      return { text: "refreshing", color: palette.dim };
    case "loginExpiring":
      return { text: "login expiring", color: palette.warn };
    case "scopeMissing":
      return { text: "scope missing", color: palette.warn };
    case "reauthenticationRequired":
      return { text: "login required", color: palette.bad };
    case "temporarilyUnreachable":
      return { text: "unreachable", color: palette.warn };
    case "usageRateLimited":
      return { text: "rate-limited", color: palette.warn };
    case "disabled":
      return { text: "disabled", color: palette.dim };
  }
}

export function shortWindow(label: string): string {
  if (/^(5 hour|5h session|five hour)$/i.test(label)) {
    return "5h";
  }
  if (/^7 day( · all models)?$/i.test(label)) {
    return "7d";
  }
  const generic = new Set(["day", "days", "hour", "hours", "week", "all", "models", "window"]);
  const tokens = label
    .replace(/^7 day · /i, "")
    .split(/[\s·-]+/)
    .filter((t) => t.length > 1 && !generic.has(t.toLowerCase()) && !/^\d+(\.\d+)?$/.test(t));
  const chosen = tokens[tokens.length - 1] ?? label;
  return chosen.length > 8 ? `${chosen.slice(0, 7)}…` : chosen;
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}
