import { Box, createCliRenderer, parseColor, type RGBA, Text } from "@opentui/core";
import type {
  Account,
  AnalyticsSnapshot,
  ProviderId,
  ProviderState,
  UsageWindow,
} from "../domain.ts";
import { readAnalytics, refreshAnalytics, requestPolicy, requestSwitch } from "../ipc.ts";
import {
  detectThemeName,
  healthBadge,
  historyChart,
  meter,
  percentLabel,
  pressureColor,
  resetLabel,
  shortWindow,
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

const labelWidth = 26;
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

interface Ctx {
  theme: Theme;
}

// One account line showing every window inline, each colored by its pressure,
// so all rates are visible at a glance without expanding anything.
function accountLine(
  ctx: Ctx,
  account: Account,
  windows: readonly UsageWindow[],
  isActive: boolean,
  isSelected: boolean,
) {
  const badge = healthBadge(ctx.theme, account);
  const marker = isActive ? "●" : isSelected ? "▸" : "○";
  const markerColor = isActive ? ctx.theme.good : isSelected ? ctx.theme.accent : ctx.theme.faint;
  const children = [
    Text({ content: ` ${marker} `, fg: rgb(markerColor) }),
    Text({
      content: pad(account.label, labelWidth),
      fg: rgb(isActive || isSelected ? ctx.theme.fg : ctx.theme.dim),
      attributes: isActive ? 1 : 0,
    }),
  ];
  if (windows.length === 0) {
    children.push(
      Text({ content: account.health === "ready" ? "…" : "—", fg: rgb(ctx.theme.dim) }),
    );
  }
  for (const window of windows.slice(0, 3)) {
    children.push(
      Text({ content: `${pad(shortWindow(window.label), 5)} `, fg: rgb(ctx.theme.dim) }),
      Text({
        content: `${meter(window.usedPercent, 6)} ${percentLabel(window.usedPercent)}  `,
        fg: rgb(pressureColor(ctx.theme, window.usedPercent)),
      }),
    );
  }
  if (badge !== null) {
    children.push(Text({ content: ` ${badge.text}`, fg: rgb(badge.color) }));
  }
  return Box(
    {
      flexDirection: "row",
      width: "100%",
      backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
    },
    ...children,
  );
}

function providerPanel(
  ctx: Ctx,
  analytics: AnalyticsSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
) {
  const state: ProviderState | undefined = analytics.snapshot.providers.find(
    (s) => s.provider === provider,
  );
  const providerRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.provider === provider);
  const lines =
    providerRows.length === 0
      ? [
          Box(
            { flexDirection: "row", width: "100%" },
            Text({
              content: `   no accounts — tokmax ${providerCli[provider]} login`,
              fg: rgb(ctx.theme.dim),
            }),
          ),
        ]
      : providerRows.map((entry) => {
          const account = analytics.snapshot.accounts.find((a) => a.id === entry.row.accountId);
          const usage = analytics.snapshot.usage.find((u) => u.accountId === entry.row.accountId);
          return account === undefined
            ? Box({ width: "100%" })
            : accountLine(
                ctx,
                account,
                usage?.windows ?? [],
                state?.activeAccountId === entry.row.accountId,
                entry.index === selected,
              );
        });
  const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : "auto off";
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title: ` ${providerTitles[provider]}   ${auto} `,
      titleColor: rgb(state?.policy.enabled ? ctx.theme.good : ctx.theme.dim),
    },
    ...lines,
  );
}

// Usage-over-time chart for the selected account's most-pressured hard window.
function chartPanel(
  ctx: Ctx,
  analytics: AnalyticsSnapshot,
  row: Row | undefined,
  chartHeight: number,
) {
  const account =
    row === undefined ? undefined : analytics.snapshot.accounts.find((a) => a.id === row.accountId);
  const history =
    row === undefined ? undefined : analytics.history.find((h) => h.accountId === row.accountId);
  const usage =
    row === undefined
      ? undefined
      : analytics.snapshot.usage.find((u) => u.accountId === row.accountId);
  const worst = (usage?.windows ?? [])
    .filter((w) => w.kind === "hard")
    .reduce<UsageWindow | null>(
      (acc, w) => (acc === null || w.usedPercent > acc.usedPercent ? w : acc),
      null,
    );
  const series =
    worst === undefined || worst === null
      ? undefined
      : history?.windows.find((h) => h.windowId === worst.id);
  const width = 56;
  const rows: ReturnType<typeof Box>[] = [];
  if (account === undefined || worst === null || worst === undefined) {
    rows.push(
      Box(
        { flexDirection: "row" },
        Text({ content: "   select an account", fg: rgb(ctx.theme.dim) }),
      ),
    );
  } else {
    const color = pressureColor(ctx.theme, worst.usedPercent);
    const chart = historyChart(series?.points ?? [], width, chartHeight);
    chart.forEach((line, index) => {
      const axis = index === 0 ? "100" : index === chart.length - 1 ? "  0" : "   ";
      rows.push(
        Box(
          { flexDirection: "row" },
          Text({ content: ` ${axis} `, fg: rgb(ctx.theme.faint) }),
          Text({ content: line, fg: rgb(color) }),
        ),
      );
    });
    rows.push(
      Box(
        { flexDirection: "row" },
        Text({ content: `     ${"─".repeat(width)}`, fg: rgb(ctx.theme.faint) }),
      ),
      Box(
        { flexDirection: "row" },
        Text({ content: `     now ${percentLabel(worst.usedPercent).trim()}`, fg: rgb(color) }),
        Text({
          content: `  · resets ${resetLabel(worst.resetAt, Date.now())}`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  const title =
    account === undefined || worst === null || worst === undefined
      ? " usage over time "
      : ` ${account.label} · ${shortWindow(worst.label)} over time `;
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title,
      titleColor: rgb(ctx.theme.dim),
    },
    ...rows,
  );
}

function view(ctx: Ctx, analytics: AnalyticsSnapshot, rows: Row[], selected: number, note: string) {
  const clock = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const terminalRows = process.stdout.rows ?? 40;
  const accountCount = analytics.snapshot.accounts.length;
  // Reserve rows for the header, both panel frames, the chart frame, and the
  // footer; give the rest to the chart so the app fills the terminal height.
  const chartHeight = Math.max(4, Math.min(14, terminalRows - accountCount - 12));
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      gap: 1,
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
    providerPanel(ctx, analytics, "openai", rows, selected),
    providerPanel(ctx, analytics, "anthropic", rows, selected),
    chartPanel(ctx, analytics, rows[selected], chartHeight),
    Text({
      content: "↑↓ select · ⏎ switch · a auto-rotate · r refresh · q quit",
      fg: rgb(ctx.theme.dim),
    }),
  );
}

export async function runTuiDashboard(socketPath: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  // Follow the terminal's own background (OpenTUI queries it), which is the
  // real signal — not the OS appearance, which can differ from the terminal.
  // Prime the detection, then re-read it every frame so it stays in sync.
  await renderer.waitForThemeMode(400).catch(() => null);
  const envFallback: ThemeName = detectThemeName(process.env);
  const currentTheme = (): Theme => themes[renderer.themeMode ?? envFallback];
  let analytics = await readAnalytics(socketPath);
  let rows = orderedRows(analytics);
  let selected = 0;
  let note = "";
  let busy = false;

  // Build the next frame fully before swapping it in. If a render function
  // throws, the previous frame stays on screen instead of leaving the cleared
  // root blank — the white-screen failure mode.
  const paint = () => {
    let next: ReturnType<typeof Box>;
    try {
      next = view({ theme: currentTheme() }, analytics, rows, selected, note);
    } catch {
      return;
    }
    for (const child of [...renderer.root.getChildren()]) {
      renderer.root.remove(child);
    }
    renderer.root.add(next);
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
    const interval = setInterval(() => void reload(false).catch(() => undefined), 2_000);
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
        // Best-effort teardown; process exit restores the terminal too.
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
      } else if (key.name === "r") {
        void reload(true);
      }
    });
    paint();
    renderer.start();
  });
}
