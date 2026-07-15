import { Box, createCliRenderer, parseColor, type RGBA, Text } from "@opentui/core";
import type { AnalyticsSnapshot, ProviderId, ProviderState, UsageHistory } from "../domain.ts";
import { readAnalytics, refreshAnalytics, requestPolicy, requestSwitch } from "../ipc.ts";
import {
  detectThemeName,
  healthBadge,
  meter,
  percentLabel,
  pressureColor,
  resetLabel,
  shortWindow,
  sparkline,
  type Theme,
  type ThemeName,
  themes,
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

// Fixed column widths keep every window row aligned regardless of content, so
// the layout never ragged-wraps or overlaps.
const meterWidth = 12;
const sparkWidth = 10;
const labelWidth = 34;

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

function pad(value: string, width: number): string {
  const fitted = value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
  return fitted.padEnd(width);
}

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

interface Render {
  theme: Theme;
}

function windowRow(
  ctx: Render,
  label: string,
  usedPercent: number | null,
  resetAt: string | null,
  history: UsageHistory | undefined,
  nowMillis: number,
) {
  const color = pressureColor(ctx.theme, usedPercent);
  const reset = resetLabel(resetAt, nowMillis);
  // One row, fixed-width segments, no inter-child gap, so columns line up.
  return Box(
    { flexDirection: "row" },
    Text({ content: `  ${pad(shortWindow(label), 7)} `, fg: rgb(ctx.theme.dim) }),
    Text({
      content: `${meter(usedPercent, meterWidth)} ${percentLabel(usedPercent)}  `,
      fg: rgb(color),
    }),
    Text({
      content: `${sparkline(history?.points ?? [], sparkWidth)}  `,
      fg: rgb(ctx.theme.faint),
    }),
    Text({ content: reset === "" ? "" : `↺ ${reset}`, fg: rgb(ctx.theme.dim) }),
  );
}

// Each account is one compact line; the selected account expands to show all
// of its windows with sparklines. This keeps the whole dashboard within a
// normal terminal height regardless of account count.
function accountCard(
  ctx: Render,
  analytics: AnalyticsSnapshot,
  row: Row,
  isActive: boolean,
  isSelected: boolean,
  nowMillis: number,
) {
  const account = analytics.snapshot.accounts.find((a) => a.id === row.accountId);
  if (account === undefined) {
    return Box({ width: "100%" });
  }
  const usage = analytics.snapshot.usage.find((u) => u.accountId === account.id);
  const history = analytics.history.find((h) => h.accountId === account.id);
  const hardWindows = (usage?.windows ?? []).filter((w) => w.kind === "hard");
  const worst = hardWindows.reduce<{ label: string; usedPercent: number } | null>(
    (acc, w) =>
      acc === null || w.usedPercent > acc.usedPercent
        ? { label: w.label, usedPercent: w.usedPercent }
        : acc,
    null,
  );
  const badge = healthBadge(ctx.theme, account);
  const summary =
    worst === null
      ? Text({ content: usage === undefined ? "—" : "no limit windows", fg: rgb(ctx.theme.dim) })
      : Box(
          { flexDirection: "row" },
          Text({ content: `${pad(shortWindow(worst.label), 6)} `, fg: rgb(ctx.theme.dim) }),
          Text({
            content: `${meter(worst.usedPercent, 8)} ${percentLabel(worst.usedPercent)}`,
            fg: rgb(pressureColor(ctx.theme, worst.usedPercent)),
          }),
        );
  const header = Box(
    {
      flexDirection: "row",
      width: "100%",
      backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
    },
    Text({
      content: ` ${isActive ? "●" : isSelected ? "▸" : "○"} ${pad(account.label, labelWidth)}`,
      fg: rgb(isActive ? ctx.theme.fg : isSelected ? ctx.theme.fg : ctx.theme.dim),
      attributes: isActive ? 1 : 0,
    }),
    summary,
    badge === null
      ? Text({ content: "" })
      : Text({ content: `  ${badge.text}`, fg: rgb(badge.color) }),
  );
  if (!isSelected) {
    return header;
  }
  const windows = (usage?.windows ?? []).map((window) =>
    windowRow(
      ctx,
      window.label,
      window.usedPercent,
      window.resetAt,
      history?.windows.find((h) => h.windowId === window.id),
      nowMillis,
    ),
  );
  if (windows.length === 0) {
    windows.push(
      Box(
        { flexDirection: "row" },
        Text({
          content: account.health === "ready" ? "    gathering usage…" : "    no usage yet",
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  return Box(
    { flexDirection: "column", width: "100%", backgroundColor: rgb(ctx.theme.selected) },
    header,
    ...windows,
  );
}

function panelTitle(provider: ProviderId, state: ProviderState | undefined): string {
  const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : "auto off";
  return ` ${providerTitles[provider]}   ${auto} · gen ${state?.generation ?? 0} `;
}

function providerPanel(
  ctx: Render,
  analytics: AnalyticsSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
  nowMillis: number,
) {
  const state = analytics.snapshot.providers.find((s) => s.provider === provider);
  const providerRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.provider === provider);
  const cards =
    providerRows.length === 0
      ? [
          Box(
            { flexDirection: "row", width: "100%" },
            Text({
              content: `  no accounts — tokmax ${providerCli[provider]} login`,
              fg: rgb(ctx.theme.dim),
            }),
          ),
        ]
      : providerRows.map((entry) =>
          accountCard(
            ctx,
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
      width: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title: panelTitle(provider, state),
      titleColor: rgb(ctx.theme.dim),
    },
    ...cards,
  );
}

function view(
  ctx: Render,
  analytics: AnalyticsSnapshot,
  rows: Row[],
  selected: number,
  note: string,
  nowMillis: number,
) {
  const clock = new Date(nowMillis).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return Box(
    {
      flexDirection: "column",
      padding: 1,
      gap: 1,
      width: "100%",
      backgroundColor: rgb(ctx.theme.bg),
    },
    Box(
      { flexDirection: "row" },
      Text({ content: "tokmax", fg: rgb(ctx.theme.accent), attributes: 1 }),
      Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
      note === ""
        ? Text({ content: "" })
        : Text({ content: `   ${note}`, fg: rgb(ctx.theme.warn) }),
    ),
    providerPanel(ctx, analytics, "openai", rows, selected, nowMillis),
    providerPanel(ctx, analytics, "anthropic", rows, selected, nowMillis),
    Text({
      content: "↑↓ select · ⏎ switch · a auto-rotate · t theme · r refresh · q quit",
      fg: rgb(ctx.theme.dim),
    }),
  );
}

export async function runTuiDashboard(socketPath: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  let themeName: ThemeName = detectThemeName(process.env);
  let analytics = await readAnalytics(socketPath);
  let rows = orderedRows(analytics);
  let selected = 0;
  let note = "";
  let busy = false;

  // Single root child, replaced atomically each paint. Removing a snapshot of
  // the child list (not the live array) avoids skipping entries mid-iteration,
  // which previously left stale rows overlapping the new frame.
  const paint = () => {
    try {
      for (const child of [...renderer.root.getChildren()]) {
        renderer.root.remove(child);
      }
      renderer.root.add(
        view({ theme: themes[themeName] }, analytics, rows, selected, note, Date.now()),
      );
    } catch {
      // A single bad frame must never tear down the dashboard.
    }
  };

  const withBusy = async (message: string, work: () => Promise<void>) => {
    if (busy) {
      return;
    }
    busy = true;
    note = message;
    paint();
    try {
      await work();
      note = "";
    } catch (error) {
      note = error instanceof Error ? error.message : "failed";
    } finally {
      busy = false;
      paint();
    }
  };

  const reload = (refresh: boolean) =>
    withBusy(refresh ? "refreshing…" : "", async () => {
      analytics = refresh ? await refreshAnalytics(socketPath) : await readAnalytics(socketPath);
      rows = orderedRows(analytics);
      selected = Math.max(0, Math.min(selected, rows.length - 1));
    });

  const switchToSelected = () => {
    const row = rows[selected];
    if (row === undefined) {
      return;
    }
    void withBusy("switching…", async () => {
      await requestSwitch(socketPath, row.provider, row.accountId);
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics);
    });
  };

  const toggleAuto = () => {
    const row = rows[selected];
    if (row === undefined) {
      return;
    }
    const state = analytics.snapshot.providers.find((s) => s.provider === row.provider);
    const enable = !(state?.policy.enabled ?? false);
    void withBusy(
      `auto-rotate ${providerCli[row.provider]} ${enable ? "on" : "off"}…`,
      async () => {
        // Pressing the key is the explicit authorization for enabling rotation.
        await requestPolicy(socketPath, {
          provider: row.provider,
          enabled: enable,
          thresholdPercent: 95,
          authorizationConfirmed: enable,
        });
        analytics = await readAnalytics(socketPath);
      },
    );
  };

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => void reload(false), 2_000);
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(interval);
      try {
        renderer.destroy();
      } catch {
        // Best-effort teardown; the terminal is restored by process exit too.
      }
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
        switchToSelected();
      } else if (key.name === "a") {
        toggleAuto();
      } else if (key.name === "t") {
        themeName = themeName === "dark" ? "light" : "dark";
        paint();
      } else if (key.name === "r") {
        void reload(true);
      }
    });
    paint();
    renderer.start();
  });
}
