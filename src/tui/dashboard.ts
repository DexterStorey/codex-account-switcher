import { Box, createCliRenderer, parseColor, type RGBA, Text } from "@opentui/core";
import type {
  Account,
  AnalyticsSnapshot,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  UsageWindow,
} from "../domain.ts";
import { readAnalytics, refreshUsage, requestPolicy, requestSwitch } from "../ipc.ts";
import {
  brailleLine,
  bucketSeries,
  detectThemeName,
  healthBadge,
  mergedPressureSeries,
  meter,
  percentLabel,
  planLabel,
  pressureColor,
  relativeAge,
  resetCountdown,
  shortWindow,
  type Theme,
  type ThemeName,
  TIMEFRAMES,
  type Timeframe,
  themes,
} from "./format.ts";

type Tab = "accounts" | "analytics";
type Scope = ProviderId | "both";

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

const labelWidth = 24;
const providerTitles: Record<ProviderId, string> = {
  openai: "OpenAI · Codex",
  anthropic: "Anthropic · Claude Code",
};
const providerShort: Record<ProviderId, string> = { openai: "Codex", anthropic: "Claude Code" };
const providerCli: Record<ProviderId, string> = { openai: "codex", anthropic: "claude" };
const providerOrder: readonly ProviderId[] = ["openai", "anthropic"];
const scopeOrder: readonly Scope[] = ["openai", "anthropic", "both"];
const scopeLabel: Record<Scope, string> = { openai: "codex", anthropic: "claude", both: "both" };
const fallbackTimeframe = TIMEFRAMES[2] as Timeframe;

interface Row {
  provider: ProviderId;
  accountId: string;
}

interface Ctx {
  theme: Theme;
  now: number;
}

function pad(value: string, width: number): string {
  const fitted = value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
  return fitted.padEnd(width);
}

function hardWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.filter((window) => window.kind === "hard");
}

function currentPressure(windows: readonly UsageWindow[]): number | null {
  const hard = hardWindows(windows);
  return hard.length === 0 ? null : Math.max(...hard.map((window) => window.usedPercent));
}

function orderedRows(snapshot: DashboardSnapshot): Row[] {
  const rows: Row[] = [];
  for (const provider of providerOrder) {
    const state = snapshot.providers.find((s) => s.provider === provider);
    const accounts = snapshot.accounts
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

// One account line showing every window inline, each colored by its pressure,
// so all rates stay visible without expanding anything.
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
      content: pad(account.label, labelWidth - 2),
      fg: rgb(isActive || isSelected ? ctx.theme.fg : ctx.theme.dim),
      attributes: isActive ? 1 : 0,
    }),
    Text({ content: badge === null ? "  " : " *", fg: rgb(badge?.color ?? ctx.theme.dim) }),
  ];
  if (windows.length === 0) {
    children.push(
      Text({ content: account.health === "ready" ? " …" : " —", fg: rgb(ctx.theme.dim) }),
    );
  }
  for (const window of hardWindows(windows).slice(0, 3)) {
    children.push(
      Text({ content: ` ${shortWindow(window.label)} `, fg: rgb(ctx.theme.dim) }),
      Text({
        content: `${meter(window.usedPercent, 6)} ${percentLabel(window.usedPercent)}`,
        fg: rgb(pressureColor(ctx.theme, window.usedPercent)),
      }),
    );
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

// The expansion shown under the selected account on space: plan, each window's
// reset countdown, and identifying detail — the "everything about this account"
// view without leaving the list.
function accountDetail(ctx: Ctx, account: Account, windows: readonly UsageWindow[]) {
  const indent = " ".repeat(5);
  const plan = planLabel(account.plan);
  const lines: ReturnType<typeof Box>[] = [
    Box(
      { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
      Text({ content: `${indent}${providerShort[account.provider]}`, fg: rgb(ctx.theme.dim) }),
      Text({
        content: plan === null ? "  ·  plan —" : `  ·  ${plan}`,
        fg: rgb(plan === null ? ctx.theme.dim : ctx.theme.accent),
        attributes: plan === null ? 0 : 1,
      }),
    ),
  ];
  const hard = hardWindows(windows);
  if (hard.length === 0) {
    lines.push(
      Box(
        { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
        Text({
          content: `${indent}${account.health === "ready" ? "waiting for usage…" : "usage unavailable"}`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  for (const window of hard) {
    const reset = resetCountdown(window.resetAt, ctx.now);
    lines.push(
      Box(
        { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
        Text({ content: `${indent}${pad(window.label, 16)} `, fg: rgb(ctx.theme.dim) }),
        Text({
          content: `${meter(window.usedPercent, 8)} ${percentLabel(window.usedPercent)}`,
          fg: rgb(pressureColor(ctx.theme, window.usedPercent)),
        }),
        Text({
          content: reset === null ? "" : `   resets in ${reset}`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  const shortId = account.externalAccountId?.slice(0, 8) ?? "—";
  const added = account.createdAt.slice(0, 10);
  lines.push(
    Box(
      { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
      Text({ content: `${indent}account ${shortId}  ·  added ${added}`, fg: rgb(ctx.theme.faint) }),
    ),
  );
  return lines;
}

function providerPanel(
  ctx: Ctx,
  snapshot: DashboardSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
  expanded: boolean,
) {
  const state: ProviderState | undefined = snapshot.providers.find((s) => s.provider === provider);
  const providerRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.provider === provider);
  const lines: ReturnType<typeof Box>[] =
    providerRows.length === 0
      ? [
          Box(
            { flexDirection: "row", width: "100%" },
            Text({
              content: `   no accounts — tokmax login ${providerCli[provider]}`,
              fg: rgb(ctx.theme.dim),
            }),
          ),
        ]
      : providerRows.flatMap((entry) => {
          const account = snapshot.accounts.find((a) => a.id === entry.row.accountId);
          if (account === undefined) {
            return [Box({ width: "100%" })];
          }
          const windows = snapshot.usage.find((u) => u.accountId === entry.row.accountId)?.windows;
          const isSelected = entry.index === selected;
          const line = accountLine(
            ctx,
            account,
            windows ?? [],
            state?.activeAccountId === entry.row.accountId,
            isSelected,
          );
          return isSelected && expanded
            ? [line, ...accountDetail(ctx, account, windows ?? [])]
            : [line];
        });
  const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : "auto off";
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title: ` ${providerTitles[provider]}   ${auto} `,
      titleColor: rgb(state?.policy.enabled ? ctx.theme.good : ctx.theme.dim),
    },
    ...lines,
  );
}

// Explains the attention asterisk, shown only when an account is flagged.
// Returns null when nothing is flagged so the caller can omit the row entirely.
function legend(ctx: Ctx, snapshot: DashboardSnapshot): ReturnType<typeof Box> | null {
  const flagged = snapshot.accounts
    .map((account) => healthBadge(ctx.theme, account))
    .filter((badge): badge is NonNullable<typeof badge> => badge !== null);
  if (flagged.length === 0) {
    return null;
  }
  const distinct = [...new Map(flagged.map((badge) => [badge.text, badge])).values()];
  return Box(
    { flexDirection: "row" },
    Text({ content: " * ", fg: rgb(ctx.theme.warn) }),
    ...distinct.flatMap((badge) => [
      Text({ content: badge.text.replace(/^[⚠·]\s*/, ""), fg: rgb(badge.color) }),
      Text({ content: " ", fg: rgb(ctx.theme.dim) }),
    ]),
    Text({ content: "— run tokmax list", fg: rgb(ctx.theme.dim) }),
  );
}

function tabBar(ctx: Ctx, tab: Tab) {
  const pill = (label: string, active: boolean) =>
    Text({
      content: ` ${label} `,
      fg: rgb(active ? ctx.theme.bg : ctx.theme.dim),
      bg: rgb(active ? ctx.theme.accent : ctx.theme.bg),
      attributes: active ? 1 : 0,
    });
  return Box(
    { flexDirection: "row", gap: 1 },
    pill("Accounts", tab === "accounts"),
    pill("Analytics", tab === "analytics"),
  );
}

// The scope + timeframe selectors, each a row of pills with the active one lit.
function analyticsControls(ctx: Ctx, scope: Scope, timeframe: Timeframe) {
  const toggle = (label: string, active: boolean) =>
    Text({
      content: ` ${label} `,
      fg: rgb(active ? ctx.theme.bg : ctx.theme.dim),
      bg: rgb(active ? ctx.theme.accent : ctx.theme.bg),
      attributes: active ? 1 : 0,
    });
  const scopeCells = scopeOrder.flatMap((option, index) => [
    ...(index === 0 ? [] : [Text({ content: " ", fg: rgb(ctx.theme.faint) })]),
    toggle(scopeLabel[option], option === scope),
  ]);
  const rangeCells = TIMEFRAMES.flatMap((option, index) => [
    ...(index === 0 ? [] : [Text({ content: " ", fg: rgb(ctx.theme.faint) })]),
    toggle(option.label, option.key === timeframe.key),
  ]);
  return Box(
    { flexDirection: "row", width: "100%", paddingLeft: 1 },
    ...scopeCells,
    Box({ flexGrow: 1 }),
    ...rangeCells,
    Text({ content: " ", fg: rgb(ctx.theme.bg) }),
  );
}

// One provider's usage trace over the chosen timeframe: a braille line chart of
// the account's worst-window pressure, framed by a 0/100 axis and live metrics.
function chartCard(
  ctx: Ctx,
  analytics: AnalyticsSnapshot,
  provider: ProviderId,
  timeframe: Timeframe,
  height: number,
  width: number,
  showTimeAxis: boolean,
) {
  const state = analytics.snapshot.providers.find((s) => s.provider === provider);
  const active =
    state?.activeAccountId == null
      ? undefined
      : analytics.snapshot.accounts.find((a) => a.id === state.activeAccountId);
  const usage =
    active === undefined
      ? undefined
      : analytics.snapshot.usage.find((u) => u.accountId === active.id);
  const hard = hardWindows(usage?.windows ?? []);
  const hardIds = new Set(hard.map((window) => window.id));
  const history = analytics.history.find((h) => h.accountId === active?.id);
  const series = mergedPressureSeries(
    (history?.windows ?? []).filter((window) => hardIds.has(window.windowId)),
  );
  const plan = active === undefined ? null : planLabel(active.plan);
  const title =
    active === undefined
      ? ` ${providerShort[provider]} · no active account `
      : ` ${providerShort[provider]} · ${active.label}${plan === null ? "" : ` · ${plan}`} `;

  const body: ReturnType<typeof Box>[] = [];
  if (active === undefined) {
    body.push(
      Box(
        { flexDirection: "row" },
        Text({
          content: `  tokmax login ${providerCli[provider]} to begin`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  } else {
    const columns = bucketSeries(series, timeframe.ms, ctx.now, width * 2);
    const drawn = columns.filter((value): value is number => value !== null);
    const nowPercent = currentPressure(usage?.windows ?? []);
    const color = pressureColor(ctx.theme, nowPercent);
    const chart =
      drawn.length === 0
        ? new Array(height).fill(" ".repeat(width))
        : brailleLine(columns, width, height);
    chart.forEach((line, index) => {
      const axis = index === 0 ? "100" : index === chart.length - 1 ? "  0" : "   ";
      body.push(
        Box(
          { flexDirection: "row" },
          Text({ content: `${axis} `, fg: rgb(ctx.theme.faint) }),
          Text({ content: line, fg: rgb(color) }),
        ),
      );
    });
    if (showTimeAxis) {
      const timeAxis = `${timeframe.label} ago`.padEnd(Math.max(0, width - 3));
      body.push(
        Box(
          { flexDirection: "row" },
          Text({ content: "    ", fg: rgb(ctx.theme.bg) }),
          Text({ content: timeAxis, fg: rgb(ctx.theme.faint) }),
          Text({ content: "now", fg: rgb(ctx.theme.faint) }),
        ),
      );
    }
    if (drawn.length === 0) {
      body.push(
        Box(
          { flexDirection: "row" },
          Text({ content: "    collecting usage…", fg: rgb(ctx.theme.dim) }),
        ),
      );
    } else {
      const peak = Math.round(Math.max(...drawn));
      const average = Math.round(drawn.reduce((sum, value) => sum + value, 0) / drawn.length);
      // Show the two windows that reset soonest — the ones worth knowing about —
      // so a third window can never push the line past the panel edge.
      const resets = hard
        .map((window) => ({
          label: shortWindow(window.label),
          reset: resetCountdown(window.resetAt, ctx.now),
          at: window.resetAt === null ? Number.POSITIVE_INFINITY : Date.parse(window.resetAt),
        }))
        .filter((entry) => entry.reset !== null)
        .sort((left, right) => left.at - right.at)
        .slice(0, 2)
        .map((entry) => `${entry.label} ${entry.reset}`);
      const prefix = "    now ";
      const nowText = nowPercent === null ? "—" : `${Math.round(nowPercent)}%`;
      const tail = `   peak ${peak}%   avg ${average}%${resets.length === 0 ? "" : `   resets ${resets.join(" · ")}`}`;
      const budget = Math.max(0, width - prefix.length - nowText.length);
      body.push(
        Box(
          { flexDirection: "row" },
          Text({ content: prefix, fg: rgb(ctx.theme.dim) }),
          Text({ content: nowText, fg: rgb(color), attributes: 1 }),
          Text({ content: tail.slice(0, budget), fg: rgb(ctx.theme.faint) }),
        ),
      );
    }
  }
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
    ...body,
  );
}

function analyticsBody(ctx: Ctx, analytics: AnalyticsSnapshot, scope: Scope, timeframe: Timeframe) {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const width = Math.max(24, Math.min(160, cols - 8));
  const controls = analyticsControls(ctx, scope, timeframe);
  if (scope === "both") {
    // Two stacked cards must share the height, so they run compact: shorter
    // traces and no per-card time axis (the range toggle already names it).
    const height = Math.max(3, Math.min(6, Math.floor((rows - 18) / 2)));
    return [
      controls,
      chartCard(ctx, analytics, "openai", timeframe, height, width, false),
      chartCard(ctx, analytics, "anthropic", timeframe, height, width, false),
    ];
  }
  const height = Math.max(4, Math.min(11, rows - 15));
  return [controls, chartCard(ctx, analytics, scope, timeframe, height, width, true)];
}

function accountsBody(
  ctx: Ctx,
  snapshot: DashboardSnapshot,
  rows: Row[],
  selected: number,
  expanded: boolean,
) {
  const note = legend(ctx, snapshot);
  return [
    providerPanel(ctx, snapshot, "openai", rows, selected, expanded),
    providerPanel(ctx, snapshot, "anthropic", rows, selected, expanded),
    Box({ flexGrow: 1, width: "100%" }),
    ...(note === null ? [] : [note]),
  ];
}

interface ViewState {
  tab: Tab;
  selected: number;
  expanded: boolean;
  scope: Scope;
  timeframeIndex: number;
  installed: boolean;
  note: string;
}

function view(ctx: Ctx, analytics: AnalyticsSnapshot, rows: Row[], state: ViewState) {
  const clock = new Date(ctx.now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const freshestMillis = analytics.snapshot.usage
    .map((u) => Date.parse(u.observedAt))
    .filter((millis) => Number.isFinite(millis))
    .reduce((max, millis) => Math.max(max, millis), 0);
  const refreshed = freshestMillis === 0 ? "—" : `${relativeAge(freshestMillis, ctx.now)} ago`;
  const timeframe = TIMEFRAMES[state.timeframeIndex] ?? fallbackTimeframe;
  const footer =
    state.tab === "accounts"
      ? "↑↓ select · space details · ⏎ switch · a auto-rotate · ←→ tabs · r refresh"
      : "↑↓ scope · 1-5 range · ←→ tabs · r refresh";
  // Assemble children explicitly, skipping empty nodes: an empty Text still
  // consumes a gap row, and at 24 lines those phantom rows push a panel border
  // onto its last account.
  const header = Box(
    { flexDirection: "row" },
    Text({ content: "tokmax", fg: rgb(ctx.theme.accent), attributes: 1 }),
    Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
    Text({ content: `   ↻ ${refreshed}  ·  active 60s / idle 5m`, fg: rgb(ctx.theme.faint) }),
    ...(state.note === "" ? [] : [Text({ content: `   ${state.note}`, fg: rgb(ctx.theme.warn) })]),
  );
  const children: Array<ReturnType<typeof Box> | ReturnType<typeof Text>> = [header];
  if (!state.installed) {
    // Nothing routes through tokmax until installed — say so, loudly but once.
    children.push(
      Box(
        { width: "100%", backgroundColor: rgb(ctx.theme.warn) },
        Text({
          content: " native routing is off — run  tokmax install  to route codex & claude",
          fg: rgb(ctx.theme.bg),
          bg: rgb(ctx.theme.warn),
          attributes: 1,
        }),
      ),
    );
  }
  children.push(tabBar(ctx, state.tab));
  children.push(
    ...(state.tab === "accounts"
      ? accountsBody(ctx, analytics.snapshot, rows, state.selected, state.expanded)
      : analyticsBody(ctx, analytics, state.scope, timeframe)),
  );
  children.push(Text({ content: footer, fg: rgb(ctx.theme.dim) }));
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      gap: 1,
      backgroundColor: rgb(ctx.theme.bg),
    },
    ...children,
  );
}

export async function runTuiDashboard(
  socketPath: string,
  options: { installed: boolean },
): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  await renderer.waitForThemeMode(400).catch(() => null);
  const envFallback: ThemeName = detectThemeName(process.env);
  const currentTheme = (): Theme => themes[renderer.themeMode ?? envFallback];
  let analytics = await readAnalytics(socketPath);
  let rows = orderedRows(analytics.snapshot);
  const state: ViewState = {
    tab: "accounts",
    selected: 0,
    expanded: false,
    scope: "both",
    timeframeIndex: 2,
    installed: options.installed,
    note: "",
  };
  let busy = false;

  const clampSelection = () => {
    state.selected = rows.length === 0 ? 0 : Math.max(0, Math.min(state.selected, rows.length - 1));
  };

  // Build the next frame fully before swapping it in, so a render error can
  // never leave the cleared root blank. Old subtrees are destroyed, not just
  // removed: OpenTUI's remove() only detaches, so without destroy the native
  // renderables leak every frame until the screen goes blank.
  const paint = () => {
    clampSelection();
    let next: ReturnType<typeof Box>;
    try {
      next = view({ theme: currentTheme(), now: Date.now() }, analytics, rows, state);
    } catch {
      return;
    }
    for (const child of [...renderer.root.getChildren()]) {
      renderer.root.remove(child);
      child.destroyRecursively();
    }
    renderer.root.add(next);
  };

  const withBusy = async (message: string, work: () => Promise<void>) => {
    if (busy) {
      return;
    }
    busy = true;
    state.note = message;
    paint();
    try {
      await work();
      state.note = "";
    } catch (error) {
      state.note = error instanceof Error ? error.message : "failed";
    } finally {
      busy = false;
      paint();
    }
  };

  const reload = (refresh: boolean) =>
    withBusy(refresh ? "refreshing…" : "", async () => {
      if (refresh) {
        await refreshUsage(socketPath);
      }
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics.snapshot);
      clampSelection();
    });

  const switchToSelected = () => {
    const row = rows[state.selected];
    if (row === undefined) {
      return;
    }
    void withBusy("switching…", async () => {
      await requestSwitch(socketPath, row.provider, row.accountId);
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics.snapshot);
      // The switched account jumps to the top of its group; keep the cursor on
      // it rather than on whatever now occupies the old row index.
      const moved = rows.findIndex((r) => r.accountId === row.accountId);
      if (moved >= 0) {
        state.selected = moved;
      }
    });
  };

  const toggleAuto = () => {
    const row = rows[state.selected];
    if (row === undefined) {
      return;
    }
    const providerState = analytics.snapshot.providers.find((s) => s.provider === row.provider);
    const enable = !(providerState?.policy.enabled ?? false);
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

  const cycleScope = (delta: number) => {
    const index = scopeOrder.indexOf(state.scope);
    const next = (index + delta + scopeOrder.length) % scopeOrder.length;
    state.scope = scopeOrder[next] ?? "both";
    paint();
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
      // A keystroke must never be able to break the dashboard.
      try {
        if (key.name === "q" || (key.ctrl && key.name === "c")) {
          finish();
        } else if (key.name === "left" || key.name === "right") {
          state.tab = state.tab === "accounts" ? "analytics" : "accounts";
          paint();
        } else if (key.name === "up" || key.name === "k") {
          if (state.tab === "analytics") {
            cycleScope(-1);
          } else {
            state.selected = Math.max(0, state.selected - 1);
            paint();
          }
        } else if (key.name === "down" || key.name === "j") {
          if (state.tab === "analytics") {
            cycleScope(1);
          } else {
            state.selected = Math.max(0, Math.min(rows.length - 1, state.selected + 1));
            paint();
          }
        } else if (key.name === "space" && state.tab === "accounts") {
          state.expanded = !state.expanded;
          paint();
        } else if (key.name === "return" && state.tab === "accounts") {
          switchToSelected();
        } else if (key.name === "a" && state.tab === "accounts") {
          toggleAuto();
        } else if (/^[1-5]$/.test(key.name) && state.tab === "analytics") {
          state.timeframeIndex = Number(key.name) - 1;
          paint();
        } else if (key.name === "r") {
          void reload(true);
        }
      } catch {
        // Swallow; the next paint restores a good frame.
      }
    });
    paint();
    renderer.start();
  });
}
