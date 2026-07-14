import type {
  Account,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  UsageSnapshot,
} from "./domain.ts";
import { readDashboard, refreshUsage } from "./ipc.ts";

const clearScreen = "\u001B[2J\u001B[H";

function visibleLength(value: string): number {
  return value.length;
}

function pad(value: string, width: number): string {
  const fitted =
    visibleLength(value) <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

function progress(usedPercent: number | null, width = 16): string {
  if (usedPercent === null) {
    return `[${"·".repeat(width)}]   ?`;
  }
  const bounded = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((bounded / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${bounded.toFixed(1).padStart(5)}%`;
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
    return "reset due";
  }
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) {
    return `resets ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `resets ${hours}h${remainder === 0 ? "" : ` ${remainder}m`}`;
}

function providerTitle(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OPENAI · Codex + Pi";
    case "anthropic":
      return "ANTHROPIC · Claude Code";
  }
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

function healthLabel(account: Account): string {
  switch (account.health) {
    case "unchecked":
      return "not checked";
    case "ready":
      return "ready";
    case "refreshDue":
      return "refresh due";
    case "refreshing":
      return "refreshing";
    case "loginExpiring":
      return "login expiring";
    case "scopeMissing":
      return "scope missing";
    case "reauthenticationRequired":
      return "login required";
    case "temporarilyUnreachable":
      return "temporarily unreachable";
    case "usageRateLimited":
      return "usage probe limited";
    case "disabled":
      return "disabled";
  }
}

function accountLine(
  account: Account,
  state: ProviderState,
  usage: UsageSnapshot | undefined,
  now: Date,
  maximumSnapshotAgeMilliseconds: number,
): string {
  const active = state.activeAccountId === account.id ? "●" : "○";
  const lines = [
    `  ${active} ${pad(account.label, 48)}`,
    `     ${pad(healthLabel(account), 28)} ${
      usage === undefined
        ? "never sampled"
        : `${now.getTime() - Date.parse(usage.observedAt) > maximumSnapshotAgeMilliseconds ? "STALE · " : ""}${sampledAge(usage.observedAt, now)}`
    }`,
  ];
  if (usage === undefined || usage.windows.length === 0) {
    lines.push(`     ${pad("limits unavailable", 24)} ${progress(null)}`);
  } else {
    for (const window of usage.windows) {
      lines.push(
        `     ${pad(window.label, 24)} ${progress(window.usedPercent)}  ${relativeReset(window.resetAt, now)}`,
      );
    }
  }
  return lines.join("\n");
}

function providerSection(snapshot: DashboardSnapshot, provider: ProviderId, now: Date): string {
  const state = snapshot.providers.find((candidate) => candidate.provider === provider);
  if (state === undefined) {
    return `${providerTitle(provider)}\n  state unavailable`;
  }
  const accounts = snapshot.accounts.filter((account) => account.provider === provider);
  const automation = state.policy.enabled
    ? `AUTO ON · ${state.policy.thresholdPercent}% threshold`
    : "AUTO OFF";
  const lines = [`${providerTitle(provider)}  ${automation}  auth generation ${state.generation}`];
  if (accounts.length === 0) {
    lines.push("  No accounts registered.");
  }
  for (const account of accounts) {
    lines.push(
      accountLine(
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

export function renderDashboard(snapshot: DashboardSnapshot, now = new Date()): string {
  const managedSessions = snapshot.sessions.filter((session) => session.state !== "stopped");
  const sessionCounts = ["codex", "claude", "pi"]
    .map((client) => ({
      client,
      count: managedSessions.filter((session) => session.client === client).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.client}`)
    .join(" · ");
  return [
    "CODEX · CLAUDE · PI LIMIT CONTROL",
    `local control plane · ${now.toLocaleTimeString()} · ${sessionCounts || "no tracked runtimes"}`,
    "",
    providerSection(snapshot, "openai", now),
    "",
    providerSection(snapshot, "anthropic", now),
    "",
    "q quit dashboard   r refresh upstream now",
    "account add · account reauthenticate · switch · auto are available as commands",
    "Only managed Codex/Claude/Pi sessions participate in switching.",
  ].join("\n");
}

export async function runDashboard(socketPath: string): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${renderDashboard(await readDashboard(socketPath))}\n`);
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
      process.stdout.write(`${clearScreen}${renderDashboard(snapshot)}`);
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
