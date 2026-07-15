import {
  Box,
  type BoxOptions,
  createCliRenderer,
  parseColor,
  type RGBA,
  Text,
} from "@opentui/core";
import type { AnalyticsSnapshot, ProviderId, UsageHistory } from "../domain.ts";
import { readAnalytics, refreshAnalytics, requestSwitch } from "../ipc.ts";
import {
  healthBadge,
  meter,
  palette,
  percentLabel,
  pressureColor,
  resetLabel,
  shortWindow,
  sparkline,
} from "./format.ts";

const colorCache = new Map<string, RGBA>();
function rgb(hex: string): RGBA {
  const cached = colorCache.get(hex);
  if (cached !== undefined) {
    return cached;
  }
  const value = parseColor(hex);
  colorCache.set(hex, value);
  return value;
}

const providerTitles: Record<ProviderId, string> = {
  openai: "OpenAI · Codex",
  anthropic: "Anthropic · Claude Code",
};
const providerCli: Record<ProviderId, string> = { openai: "codex", anthropic: "claude" };
const providerOrder: readonly ProviderId[] = ["openai", "anthropic"];

interface Row {
  provider: ProviderId;
  accountId: string;
}

function text(content: string, color: string, attributes = 0) {
  return Text({ content, fg: rgb(color), attributes });
}

// A stable, deterministic ordering: providers in fixed order, active account
// first, then by label. The selection index addresses into exactly this list.
function orderedRows(analytics: AnalyticsSnapshot): Row[] {
  const rows: Row[] = [];
  for (const provider of providerOrder) {
    const state = analytics.snapshot.providers.find((s) => s.provider === provider);
    const accounts = analytics.snapshot.accounts
      .filter((account) => account.provider === provider)
      .sort((left, right) => {
        const active =
          Number(state?.activeAccountId !== left.id) - Number(state?.activeAccountId !== right.id);
        return active !== 0 ? active : left.label.localeCompare(right.label);
      });
    for (const account of accounts) {
      rows.push({ provider, accountId: account.id });
    }
  }
  return rows;
}

function windowLine(
  label: string,
  usedPercent: number | null,
  resetAt: string | null,
  history: UsageHistory | undefined,
  nowMillis: number,
) {
  const color = pressureColor(usedPercent);
  const reset = resetLabel(resetAt, nowMillis);
  return Box(
    { flexDirection: "row", gap: 1 },
    text(shortWindow(label).padEnd(7), palette.dim),
    text(meter(usedPercent), color),
    text(percentLabel(usedPercent), color),
    text(sparkline(history?.points ?? []), palette.faint),
    text(reset === "" ? "" : `↺ ${reset}`, palette.dim),
  );
}

function accountCard(
  analytics: AnalyticsSnapshot,
  row: Row,
  isActive: boolean,
  isSelected: boolean,
  nowMillis: number,
) {
  const account = analytics.snapshot.accounts.find((a) => a.id === row.accountId);
  if (account === undefined) {
    return Box({}, text("", palette.dim));
  }
  const usage = analytics.snapshot.usage.find((u) => u.accountId === account.id);
  const history = analytics.history.find((h) => h.accountId === account.id);
  const worstHard = (usage?.windows ?? [])
    .filter((w) => w.kind === "hard")
    .reduce<number | null>(
      (worst, w) => (worst === null ? w.usedPercent : Math.max(worst, w.usedPercent)),
      null,
    );
  const badge = healthBadge(account);
  const header = Box(
    { flexDirection: "row", gap: 1 },
    text(isActive ? "●" : "○", isActive ? pressureColor(worstHard) : palette.faint),
    text(account.label, isActive ? palette.fg : palette.dim, isActive ? 1 : 0),
    badge === null ? text("", palette.dim) : text(`· ${badge.text}`, badge.color),
  );
  const windows = (usage?.windows ?? []).slice(0, 3).map((window) =>
    windowLine(
      window.label,
      window.usedPercent,
      window.resetAt,
      history?.windows.find((h) => h.windowId === window.id),
      nowMillis,
    ),
  );
  if (windows.length === 0) {
    windows.push(Box({}, text(account.health === "ready" ? "gathering usage…" : "", palette.dim)));
  }
  const options: BoxOptions = {
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: isSelected ? rgb(palette.selected) : undefined,
  };
  return Box(options, header, ...windows);
}

function providerPanel(
  analytics: AnalyticsSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
  nowMillis: number,
) {
  const state = analytics.snapshot.providers.find((s) => s.provider === provider);
  const meta = state?.policy.enabled
    ? `auto-rotate @${state.policy.thresholdPercent}%`
    : "auto-rotate off";
  const providerRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.provider === provider);
  const cards =
    providerRows.length === 0
      ? [
          Box(
            { paddingLeft: 1 },
            text(`no accounts — tokmax ${providerCli[provider]} login`, palette.dim),
          ),
        ]
      : providerRows.map((entry) =>
          accountCard(
            analytics,
            entry.row,
            state?.activeAccountId === entry.row.accountId,
            entry.index === selected,
            nowMillis,
          ),
        );
  return Box(
    {
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(palette.faint),
      title: `${providerTitles[provider]}  ${meta} · gen ${state?.generation ?? 0}`,
      titleColor: rgb(palette.dim),
      paddingTop: 0,
      paddingBottom: 0,
    },
    ...cards,
  );
}

function view(
  analytics: AnalyticsSnapshot,
  rows: Row[],
  selected: number,
  note: string,
  nowMillis: number,
) {
  const clock = new Date(nowMillis).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return Box(
    { flexDirection: "column", padding: 1, gap: 1, backgroundColor: rgb(palette.bg) },
    Box(
      { flexDirection: "row", gap: 1 },
      text("tokmax", palette.accent, 1),
      text(`· ${clock}`, palette.dim),
      note === "" ? text("", palette.dim) : text(`· ${note}`, palette.warn),
    ),
    providerPanel(analytics, "openai", rows, selected, nowMillis),
    providerPanel(analytics, "anthropic", rows, selected, nowMillis),
    text("↑↓ select · ⏎ switch to selected · r refresh · q quit", palette.dim),
  );
}

export async function runTuiDashboard(socketPath: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  let analytics = await readAnalytics(socketPath);
  let rows = orderedRows(analytics);
  let selected = 0;
  let note = "";
  let busy = false;

  const paint = () => {
    for (const child of renderer.root.getChildren()) {
      renderer.root.remove(child);
    }
    renderer.root.add(view(analytics, rows, selected, note, Date.now()));
  };

  const reload = async (refresh: boolean) => {
    if (busy) {
      return;
    }
    busy = true;
    note = refresh ? "refreshing…" : note;
    paint();
    try {
      analytics = refresh ? await refreshAnalytics(socketPath) : await readAnalytics(socketPath);
      rows = orderedRows(analytics);
      selected = Math.min(selected, Math.max(0, rows.length - 1));
      note = "";
    } catch (error) {
      note = error instanceof Error ? error.message : "refresh failed";
    } finally {
      busy = false;
      paint();
    }
  };

  const switchToSelected = async () => {
    const row = rows[selected];
    if (row === undefined || busy) {
      return;
    }
    busy = true;
    note = "switching…";
    paint();
    try {
      await requestSwitch(socketPath, row.provider, row.accountId);
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics);
      note = "";
    } catch (error) {
      note = error instanceof Error ? error.message : "switch failed";
    } finally {
      busy = false;
      paint();
    }
  };

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => void reload(false), 2_000);
    const finish = () => {
      clearInterval(interval);
      renderer.destroy();
      resolve();
    };
    renderer.keyInput.on("keypress", (key: { name: string; ctrl: boolean }) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        finish();
      } else if (key.name === "up") {
        selected = Math.max(0, selected - 1);
        paint();
      } else if (key.name === "down") {
        selected = Math.min(rows.length - 1, selected + 1);
        paint();
      } else if (key.name === "return") {
        void switchToSelected();
      } else if (key.name === "r") {
        void reload(true);
      }
    });
    paint();
    renderer.start();
  });
}
