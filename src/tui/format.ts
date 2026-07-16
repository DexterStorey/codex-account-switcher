import type { Account, UsageHistoryPoint } from "../domain.ts";

// Pure presentation helpers shared by the TUI. No terminal or OpenTUI
// dependency, so they stay trivially testable and deterministic.

export interface Theme {
  fg: string;
  dim: string;
  faint: string;
  accent: string;
  bg: string;
  panel: string;
  selected: string;
  border: string;
  good: string;
  warn: string;
  bad: string;
}

export const darkTheme: Theme = {
  fg: "#e6e6e6",
  dim: "#8b93a1",
  faint: "#4b515c",
  accent: "#5ab0ff",
  bg: "#0b0d10",
  panel: "#0f1216",
  selected: "#1b2330",
  border: "#2a3038",
  good: "#3ad07a",
  warn: "#f0a83a",
  bad: "#ff5f6e",
};

export const lightTheme: Theme = {
  fg: "#1c2430",
  dim: "#5a6472",
  faint: "#aab2bd",
  accent: "#0b62d6",
  bg: "#fbfcfe",
  panel: "#f2f4f8",
  selected: "#e3e9f2",
  border: "#c7cedb",
  good: "#1f9d57",
  warn: "#b9770f",
  bad: "#d23b48",
};

export type ThemeName = "dark" | "light";
export const themes: Record<ThemeName, Theme> = { dark: darkTheme, light: lightTheme };

// Picks the starting theme from an explicit override, else the terminal's
// reported background (COLORFGBG is "fg;bg"; bg >= 7 is a light palette),
// else dark.
export function detectThemeName(environment: NodeJS.ProcessEnv): ThemeName {
  const override = environment.TOKMAX_THEME?.toLowerCase();
  if (override === "light" || override === "dark") {
    return override;
  }
  const colorFgBg = environment.COLORFGBG;
  if (colorFgBg !== undefined) {
    const background = Number(colorFgBg.split(";").pop());
    if (Number.isFinite(background)) {
      return background >= 7 ? "light" : "dark";
    }
  }
  return "dark";
}

export function pressureColor(theme: Theme, usedPercent: number | null): string {
  if (usedPercent === null) {
    return theme.dim;
  }
  if (usedPercent >= 85) {
    return theme.bad;
  }
  if (usedPercent >= 60) {
    return theme.warn;
  }
  return theme.good;
}

export function meter(usedPercent: number | null, width = 14): string {
  if (usedPercent === null) {
    return "·".repeat(width);
  }
  const filled = Math.round((clamp(usedPercent) / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function percentLabel(usedPercent: number | null): string {
  return usedPercent === null ? "  ?%" : `${Math.round(clamp(usedPercent))}%`.padStart(4);
}

export type { Timeframe } from "../domain.ts";
export { TIMEFRAMES } from "../domain.ts";

// Resample a time series onto `columns` evenly-spaced buckets over the window
// [nowMillis - spanMillis, nowMillis]. Empty buckets carry the last known
// reading forward so the line stays continuous even when probes are sparse;
// columns before the first-ever sample stay null (nothing to draw yet).
export function bucketSeries(
  points: readonly UsageHistoryPoint[],
  spanMillis: number,
  nowMillis: number,
  columns: number,
): (number | null)[] {
  const start = nowMillis - spanMillis;
  const result: (number | null)[] = new Array(columns).fill(null);
  // Points are appended in observation order, so the last write per bucket wins.
  for (const point of points) {
    if (point.at < start || point.at > nowMillis) {
      continue;
    }
    const index = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((point.at - start) / spanMillis) * columns)),
    );
    result[index] = clamp(point.usedPercent);
  }
  // Seed carry-forward from the most recent sample before the window opens.
  let carry: number | null = null;
  for (const point of points) {
    if (point.at < start) {
      carry = clamp(point.usedPercent);
    } else {
      break;
    }
  }
  for (let column = 0; column < columns; column += 1) {
    const value = result[column];
    if (value === null || value === undefined) {
      result[column] = carry;
    } else {
      carry = value;
    }
  }
  return result;
}

// Collapse several windows' histories into one "pressure" series: the max
// utilization across the given windows at each shared observation timestamp.
export function mergedPressureSeries(
  windows: readonly { points: readonly UsageHistoryPoint[] }[],
): UsageHistoryPoint[] {
  const byAt = new Map<number, number>();
  for (const window of windows) {
    for (const point of window.points) {
      byAt.set(point.at, Math.max(byAt.get(point.at) ?? 0, clamp(point.usedPercent)));
    }
  }
  return [...byAt.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([at, usedPercent]) => ({ at, usedPercent }));
}

const brailleDots: readonly [number, number, number, number][] = [
  [0x01, 0x02, 0x04, 0x40], // left column, rows top→bottom
  [0x08, 0x10, 0x20, 0x80], // right column
];

// A connected line chart drawn with braille cells (2× horizontal, 4× vertical
// resolution per character). `columns` holds one value (0..100) or null per
// braille sub-column — pass width*2 of them. Adjacent points are joined with a
// vertical run so the trace reads as a continuous line. Returned top row first.
export function brailleLine(
  columns: readonly (number | null)[],
  width: number,
  height: number,
): string[] {
  const dotRows = height * 4;
  const dotCols = width * 2;
  const grid: boolean[][] = Array.from({ length: dotCols }, () => new Array(dotRows).fill(false));
  const toY = (value: number): number =>
    Math.max(0, Math.min(dotRows - 1, Math.round((clamp(value) / 100) * (dotRows - 1))));
  let previousY = -1;
  for (let x = 0; x < dotCols; x += 1) {
    const value = columns[x];
    if (value === null || value === undefined) {
      previousY = -1;
      continue;
    }
    const y = toY(value);
    const column = grid[x];
    if (column === undefined) {
      continue;
    }
    if (previousY >= 0) {
      for (let fill = Math.min(previousY, y); fill <= Math.max(previousY, y); fill += 1) {
        column[fill] = true;
      }
    } else {
      column[y] = true;
    }
    previousY = y;
  }
  const rows: string[] = [];
  for (let charRow = 0; charRow < height; charRow += 1) {
    const topDotY = dotRows - 1 - charRow * 4;
    let line = "";
    for (let charColumn = 0; charColumn < width; charColumn += 1) {
      let bits = 0;
      for (let subColumn = 0; subColumn < 2; subColumn += 1) {
        const gx = charColumn * 2 + subColumn;
        for (let subRow = 0; subRow < 4; subRow += 1) {
          const gy = topDotY - subRow;
          if (gy >= 0 && grid[gx]?.[gy]) {
            bits |= brailleDots[subColumn]?.[subRow] ?? 0;
          }
        }
      }
      line += bits === 0 ? " " : String.fromCharCode(0x2800 + bits);
    }
    rows.push(line);
  }
  return rows;
}

// A compact "resets in 2h 14m" countdown; null when the window has no reset.
export function resetCountdown(resetAtIso: string | null, nowMillis: number): string | null {
  if (resetAtIso === null) {
    return null;
  }
  const resetMillis = Date.parse(resetAtIso);
  if (!Number.isFinite(resetMillis)) {
    return null;
  }
  const remaining = resetMillis - nowMillis;
  if (remaining <= 0) {
    return "now";
  }
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

// Prettify a raw provider plan string: "pro" → "Pro", "claude_max_20x" → "Max 20×".
export function planLabel(plan: string | null | undefined): string | null {
  if (plan === null || plan === undefined) {
    return null;
  }
  const raw = plan.trim().toLowerCase();
  if (raw.length === 0) {
    return null;
  }
  const multiplier = raw.match(/(\d+)\s*x/);
  if (raw.includes("max")) {
    return multiplier ? `Max ${multiplier[1]}×` : "Max";
  }
  return raw
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function relativeAge(observedAtMillis: number, nowMillis: number): string {
  const seconds = Math.max(0, Math.round((nowMillis - observedAtMillis) / 1000));
  if (!Number.isFinite(seconds)) {
    return "?";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export interface HealthBadge {
  text: string;
  color: string;
}

// Short, fixed-length tags so an unhealthy account never overflows its line.
export function healthBadge(theme: Theme, account: Account): HealthBadge | null {
  switch (account.health) {
    case "ready":
    case "unchecked":
    case "refreshDue":
    case "refreshing":
      return null;
    case "loginExpiring":
      return { text: "⚠ expiring", color: theme.warn };
    case "scopeMissing":
      return { text: "⚠ scope", color: theme.warn };
    case "reauthenticationRequired":
      return { text: "⚠ login", color: theme.bad };
    case "temporarilyUnreachable":
      return { text: "· offline", color: theme.warn };
    case "usageRateLimited":
      return { text: "· limited", color: theme.warn };
    case "disabled":
      return { text: "· off", color: theme.dim };
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
