import type {
  Account,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  UsageSnapshot,
  UsageWindow,
} from "./domain.ts";
import { readDashboard, refreshUsage } from "./ipc.ts";

const enterAlternateScreen = "\u001B[?1049h\u001B[?25l";
const leaveAlternateScreen = "\u001B[?25h\u001B[?1049l";
const clearScreen = "\u001B[2J\u001B[H";

export interface RenderOptions {
  color?: boolean;
  note?: string;
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

function miniBar(paint: Painter, usedPercent: number, width = 8): string {
  const bounded = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((bounded / 100) * width);
  const codes = pressureCodes(bounded);
  return `${paint("█".repeat(filled), ...codes)}${paint("░".repeat(width - filled), "dim")} ${paint(
    `${Math.round(bounded)}%`.padStart(4),
    ...codes,
  )}`;
}

// Rows must stay one line even with three windows, so labels compress to
// their most distinctive token: "GPT-5.3-Codex-Spark" → "Spark".
function shortWindowLabel(window: UsageWindow): string {
  const label = window.label;
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
    .filter(
      (token) =>
        token.length > 1 && !generic.has(token.toLowerCase()) && !/^\d+(\.\d+)?$/.test(token),
    );
  return truncate(tokens[tokens.length - 1] ?? label, 7);
}

function shortReset(resetAt: string | null, now: Date): string | null {
  if (resetAt === null) {
    return null;
  }
  const milliseconds = Date.parse(resetAt) - now.getTime();
  if (!Number.isFinite(milliseconds)) {
    return null;
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
    return `resets ${hours}h ${minutes % 60}m`.replace(/ 0m$/, "");
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return `resets ${days}d${remainder === 0 ? "" : ` ${remainder}h`}`;
}

function providerTitle(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI · Codex";
    case "anthropic":
      return "Anthropic · Claude Code";
  }
}

function providerCliName(provider: ProviderId): string {
  return provider === "openai" ? "codex" : "claude";
}

function sampleAge(observedAt: string, now: Date): string | null {
  const milliseconds = now.getTime() - Date.parse(observedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// Health advice for anything other than a quietly healthy account; healthy
// rows stay about usage, not plumbing.
function healthNote(account: Account): { note: string; severity: AnsiCode } | null {
  const relogin = `tokmax ${providerCliName(account.provider)} relogin ${truncate(account.label, 40)}`;
  switch (account.health) {
    case "ready":
    case "unchecked":
      return null;
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
      return { note: "provider unreachable — retrying", severity: "yellow" };
    case "usageRateLimited":
      return { note: "probe rate-limited — backing off a few minutes", severity: "yellow" };
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
): string[] {
  const isActive = state.activeAccountId === account.id;
  const hardWindows = (usage?.windows ?? []).filter((window) => window.kind === "hard");
  const worstHard = hardWindows.reduce<number | null>(
    (worst, window) => (worst === null ? window.usedPercent : Math.max(worst, window.usedPercent)),
    null,
  );
  const marker = isActive ? paint("●", ...pressureCodes(worstHard)) : paint("○", "dim");
  const email = paint(pad(account.label, 27), ...((isActive ? ["bold"] : ["dim"]) as AnsiCode[]));
  const segments: string[] = [];
  if (usage === undefined || usage.windows.length === 0) {
    segments.push(paint("no reading yet", "dim"));
  } else {
    for (const window of usage.windows.slice(0, 3)) {
      segments.push(
        `${paint(pad(shortWindowLabel(window), 7), "dim")} ${miniBar(paint, window.usedPercent)}`,
      );
    }
    const soonestReset = hardWindows
      .map((window) => window.resetAt)
      .filter((resetAt): resetAt is string => resetAt !== null)
      .sort()[0];
    const reset = shortReset(soonestReset ?? null, now);
    if (reset !== null) {
      segments.push(paint(reset, "dim"));
    }
    const stale =
      now.getTime() - Date.parse(usage.observedAt) > state.policy.maximumSnapshotAgeMilliseconds;
    if (stale) {
      const age = sampleAge(usage.observedAt, now);
      segments.push(paint(`${age ?? "?"} old`, "yellow"));
    }
  }
  const lines = [` ${marker} ${email} ${segments.join(paint(" · ", "dim"))}`];
  const health = healthNote(account);
  if (health !== null) {
    lines.push(`      ${paint(health.note, health.severity)}`);
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
  const accounts = snapshot.accounts
    .filter((account) => account.provider === provider)
    .sort((left, right) => {
      const activeOrder =
        Number(state.activeAccountId !== left.id) - Number(state.activeAccountId !== right.id);
      return activeOrder !== 0 ? activeOrder : left.label.localeCompare(right.label);
    });
  const sessionCount = snapshot.sessions.filter(
    (session) => session.provider === provider && session.state !== "stopped",
  ).length;
  const details = [
    sessionCount === 0 ? null : `${sessionCount} session${sessionCount === 1 ? "" : "s"}`,
    state.policy.enabled ? `auto-rotate @${state.policy.thresholdPercent}%` : "auto-rotate off",
    `gen ${state.generation}`,
  ].filter((detail): detail is string => detail !== null);
  const lines = [
    `${paint(pad(providerTitle(provider), 34), "bold")}${paint(details.join(" · "), sessionCount > 0 ? "cyan" : "dim")}`,
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
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const header = `${paint("tokmax", "bold", "cyan")} ${paint(`· ${clock}`, "dim")}${
    options.note === undefined ? "" : ` ${paint(options.note, "yellow")}`
  }`;
  return [
    header,
    "",
    providerSection(paint, snapshot, "openai", now),
    "",
    providerSection(paint, snapshot, "anthropic", now),
    "",
    paint("● active — managed sessions use it · q quit · r refresh · tokmax --help", "dim"),
  ].join("\n");
}

export async function runDashboard(socketPath: string): Promise<void> {
  const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  if (!process.stdout.isTTY) {
    process.stdout.write(`${renderDashboard(await readDashboard(socketPath), new Date(), {})}\n`);
    return;
  }
  let stopped = false;
  let refreshing = false;
  const redraw = async (refresh = false) => {
    if (stopped || (refreshing && refresh)) {
      return;
    }
    refreshing = refreshing || refresh;
    try {
      const snapshot = refresh ? await refreshUsage(socketPath) : await readDashboard(socketPath);
      if (stopped) {
        return;
      }
      process.stdout.write(
        `${clearScreen}${renderDashboard(snapshot, new Date(), {
          color,
          note: refreshing && !refresh ? "refreshing…" : undefined,
        })}`,
      );
    } finally {
      if (refresh) {
        refreshing = false;
      }
    }
  };
  process.stdout.write(enterAlternateScreen);
  const interval = setInterval(() => void redraw(), 2_000);
  const input = process.stdin;
  input.setRawMode?.(true);
  input.resume();
  try {
    await redraw();
    // The store paints instantly; fresh upstream readings follow.
    void redraw(true).catch(() => undefined);
    await new Promise<void>((resolve) => {
      input.on("data", (data: Buffer) => {
        const key = data.toString("utf8");
        if (key === "q" || key === "\u0003") {
          resolve();
        }
        if (key === "r") {
          void redraw(true).catch(() => undefined);
        }
      });
    });
  } finally {
    stopped = true;
    clearInterval(interval);
    input.setRawMode?.(false);
    input.pause();
    process.stdout.write(leaveAlternateScreen);
  }
}
