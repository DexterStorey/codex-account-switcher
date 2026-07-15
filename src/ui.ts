import type {
  Account,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  UsageSnapshot,
} from "./domain.ts";
import { readDashboard, refreshUsage } from "./ipc.ts";

const clearScreen = "\u001B[2J\u001B[H";

export interface RenderOptions {
  color?: boolean;
}

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  cyan: "\u001B[36m",
} as const;

type AnsiCode = keyof typeof ansi;

function createPainter(enabled: boolean) {
  return (value: string, ...codes: AnsiCode[]): string =>
    enabled && codes.length > 0
      ? `${codes.map((code) => ansi[code]).join("")}${value}${ansi.reset}`
      : value;
}

type Painter = ReturnType<typeof createPainter>;

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value: string, width: number): string {
  const fitted = truncate(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - fitted.length))}`;
}

function pressureCodes(usedPercent: number | null): AnsiCode[] {
  if (usedPercent === null) {
    return ["dim"];
  }
  if (usedPercent >= 85) {
    return ["red"];
  }
  if (usedPercent >= 60) {
    return ["yellow"];
  }
  return ["green"];
}

function progress(paint: Painter, usedPercent: number | null, width = 16): string {
  if (usedPercent === null) {
    return `${paint("·".repeat(width), "dim")}    ?`;
  }
  const bounded = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((bounded / 100) * width);
  const codes = pressureCodes(bounded);
  const bar = `${paint("█".repeat(filled), ...codes)}${paint("░".repeat(width - filled), "dim")}`;
  return `${bar}  ${paint(`${Math.round(bounded)}%`.padStart(4), ...codes)}`;
}

function relativeReset(resetAt: string | null, now: Date): string {
  if (resetAt === null) {
    return "reset unknown";
  }
  const milliseconds = Date.parse(resetAt) - now.getTime();
  if (!Number.isFinite(milliseconds)) {
    return "reset unknown";
  }
  if (milliseconds <= 0) {
    return "resets now";
  }
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) {
    return `resets ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const remainder = minutes % 60;
    return `resets ${hours}h${remainder === 0 ? "" : ` ${remainder}m`}`;
  }
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return `resets ${days}d${hourRemainder === 0 ? "" : ` ${hourRemainder}h`}`;
}

function providerTitle(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI · Codex + Pi";
    case "anthropic":
      return "Anthropic · Claude Code";
  }
}

function providerCliName(provider: ProviderId): string {
  return provider === "openai" ? "codex" : "claude";
}

function sampledAge(observedAt: string, now: Date): string {
  const milliseconds = Math.max(0, now.getTime() - Date.parse(observedAt));
  if (!Number.isFinite(milliseconds)) {
    return "sample time unknown";
  }
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) {
    return `sampled ${seconds}s ago`;
  }
  return `sampled ${Math.floor(seconds / 60)}m ago`;
}

// Health advice for anything other than a quietly healthy account. Ready
// accounts return null so the dashboard stays about usage, not plumbing.
function healthNote(account: Account): { note: string; severity: AnsiCode } | null {
  const relogin = `tokmax ${providerCliName(account.provider)} relogin ${truncate(account.label, 40)}`;
  switch (account.health) {
    case "ready":
      return null;
    case "unchecked":
      return { note: "waiting for first reading", severity: "dim" };
    case "refreshDue":
    case "refreshing":
      return { note: "refreshing credential…", severity: "dim" };
    case "loginExpiring":
      return { note: `login expiring soon — ${relogin}`, severity: "yellow" };
    case "scopeMissing":
      return { note: `login is missing a required scope — ${relogin}`, severity: "yellow" };
    case "reauthenticationRequired":
      return { note: `login required — ${relogin}`, severity: "red" };
    case "temporarilyUnreachable":
      return { note: "provider unreachable — retrying every 60s", severity: "yellow" };
    case "usageRateLimited":
      return {
        note: "usage probe rate-limited — backing off a few minutes; auto-rotate skips it",
        severity: "yellow",
      };
    case "disabled":
      return { note: "disabled", severity: "dim" };
  }
}

function accountLines(
  paint: Painter,
  account: Account,
  state: ProviderState,
  usage: UsageSnapshot | undefined,
  now: Date,
  maximumSnapshotAgeMilliseconds: number,
): string[] {
  const isActive = state.activeAccountId === account.id;
  const worstHard = usage?.windows
    .filter((window) => window.kind === "hard")
    .reduce<number | null>(
      (worst, window) =>
        worst === null ? window.usedPercent : Math.max(worst, window.usedPercent),
      null,
    );
  const marker = isActive ? paint("●", ...pressureCodes(worstHard ?? null)) : paint("○", "dim");
  const stale =
    usage !== undefined &&
    now.getTime() - Date.parse(usage.observedAt) > maximumSnapshotAgeMilliseconds;
  const tags = [
    isActive ? paint("active", "cyan") : null,
    stale && usage !== undefined
      ? paint(`STALE · ${sampledAge(usage.observedAt, now)}`, "yellow")
      : null,
  ].filter((tag): tag is string => tag !== null);
  const lines = [
    `  ${marker} ${paint(pad(account.label, 44), ...(isActive ? (["bold"] as AnsiCode[]) : []))}${tags.length === 0 ? "" : ` ${tags.join("  ")}`}`,
  ];
  const health = healthNote(account);
  if (health !== null) {
    lines.push(`      ${paint(health.note, health.severity)}`);
  }
  if (usage === undefined || usage.windows.length === 0) {
    if (account.health === "ready") {
      lines.push(`      ${paint("waiting for first reading", "dim")}`);
    }
  } else {
    for (const window of usage.windows) {
      lines.push(
        `      ${paint(pad(window.label, 20), "dim")} ${progress(paint, window.usedPercent)} ${paint(`· ${relativeReset(window.resetAt, now)}`, "dim")}`,
      );
    }
  }
  return lines;
}

function providerSection(
  paint: Painter,
  snapshot: DashboardSnapshot,
  provider: ProviderId,
  now: Date,
): string {
  const state = snapshot.providers.find((candidate) => candidate.provider === provider);
  if (state === undefined) {
    return `${paint(providerTitle(provider), "bold")}\n  state unavailable`;
  }
  const accounts = snapshot.accounts.filter((account) => account.provider === provider);
  const automation = state.policy.enabled
    ? paint(`auto-rotate on @${state.policy.thresholdPercent}%`, "green")
    : paint("auto-rotate off", "dim");
  const lines = [
    `${paint(pad(providerTitle(provider), 42), "bold")} ${automation} ${paint(`· gen ${state.generation}`, "dim")}`,
  ];
  if (accounts.length === 0) {
    lines.push(`  ${paint(`no accounts yet — tokmax ${providerCliName(provider)} login`, "dim")}`);
  }
  for (const account of accounts) {
    lines.push(
      ...accountLines(
        paint,
        account,
        state,
        snapshot.usage.find((usage) => usage.accountId === account.id),
        now,
        state.policy.maximumSnapshotAgeMilliseconds,
      ),
    );
  }
  return lines.join("\n");
}

export function renderDashboard(
  snapshot: DashboardSnapshot,
  now = new Date(),
  options: RenderOptions = {},
): string {
  const paint = createPainter(options.color === true);
  const managedSessions = snapshot.sessions.filter((session) => session.state !== "stopped");
  const sessionCounts = ["codex", "claude", "pi"]
    .map((client) => ({
      client,
      count: managedSessions.filter((session) => session.client === client).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.client}`)
    .join(" · ");
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return [
    `${paint("tokmax", "bold", "cyan")} ${paint(`· ${clock} · ${sessionCounts || "no managed sessions"}`, "dim")}`,
    "",
    providerSection(paint, snapshot, "openai", now),
    "",
    providerSection(paint, snapshot, "anthropic", now),
    "",
    paint("q quit · r refresh now · tokmax --help for commands", "dim"),
  ].join("\n");
}

export async function runDashboard(socketPath: string): Promise<void> {
  const options: RenderOptions = {
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  };
  if (!process.stdout.isTTY) {
    process.stdout.write(
      `${renderDashboard(await readDashboard(socketPath), new Date(), options)}\n`,
    );
    return;
  }
  let stopped = false;
  let refreshing = false;
  const redraw = async (refresh = false) => {
    if (refreshing || stopped) {
      return;
    }
    refreshing = true;
    try {
      const snapshot = refresh ? await refreshUsage(socketPath) : await readDashboard(socketPath);
      process.stdout.write(`${clearScreen}${renderDashboard(snapshot, new Date(), options)}`);
    } finally {
      refreshing = false;
    }
  };
  const interval = setInterval(() => void redraw(), 2_000);
  const input = process.stdin;
  input.setRawMode?.(true);
  input.resume();
  await redraw();
  await new Promise<void>((resolve) => {
    input.on("data", (data: Buffer) => {
      const key = data.toString("utf8");
      if (key === "q" || key === "\u0003") {
        resolve();
      }
      if (key === "r") {
        void redraw(true);
      }
    });
  });
  stopped = true;
  clearInterval(interval);
  input.setRawMode?.(false);
  input.pause();
  process.stdout.write("\n");
}
