import { Box, createCliRenderer, parseColor, type RGBA, Text } from "@opentui/core";
import type {
  Account,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  UsageWindow,
} from "../domain.ts";
import { readDashboard, refreshUsage, requestPolicy, requestSwitch } from "../ipc.ts";
import {
  detectThemeName,
  healthBadge,
  meter,
  percentLabel,
  pressureColor,
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

const labelWidth = 24;
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

interface Ctx {
  theme: Theme;
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
  // The label field reserves its last column for an attention asterisk so the
  // windows stay column-aligned whether or not an account is flagged.
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
  for (const window of windows.slice(0, 3)) {
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

function providerPanel(
  ctx: Ctx,
  snapshot: DashboardSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
) {
  const state: ProviderState | undefined = snapshot.providers.find((s) => s.provider === provider);
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
          const account = snapshot.accounts.find((a) => a.id === entry.row.accountId);
          const usage = snapshot.usage.find((u) => u.accountId === entry.row.accountId);
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

// Explains the attention asterisk, shown only when an account is flagged.
function legend(ctx: Ctx, snapshot: DashboardSnapshot) {
  const flagged = snapshot.accounts
    .map((account) => healthBadge(ctx.theme, account))
    .filter((badge): badge is NonNullable<typeof badge> => badge !== null);
  if (flagged.length === 0) {
    return Text({ content: "" });
  }
  const distinct = [...new Map(flagged.map((badge) => [badge.text, badge])).values()];
  return Box(
    { flexDirection: "row" },
    Text({ content: " * ", fg: rgb(ctx.theme.warn) }),
    ...distinct.flatMap((badge, index) => [
      Text({
        content: `${index === 0 ? "" : "· "}${badge.text.replace(/^[⚠·]\s*/, "")}`,
        fg: rgb(badge.color),
      }),
      Text({ content: " ", fg: rgb(ctx.theme.dim) }),
    ]),
    Text({ content: "— run tokmax list", fg: rgb(ctx.theme.dim) }),
  );
}

function view(ctx: Ctx, snapshot: DashboardSnapshot, rows: Row[], selected: number, note: string) {
  const clock = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
    providerPanel(ctx, snapshot, "openai", rows, selected),
    providerPanel(ctx, snapshot, "anthropic", rows, selected),
    // Absorbs remaining height so the app fills the terminal and the footer
    // sits at the bottom, without ever shrinking the account panels.
    Box({ flexGrow: 1, width: "100%" }),
    legend(ctx, snapshot),
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
  await renderer.waitForThemeMode(400).catch(() => null);
  const envFallback: ThemeName = detectThemeName(process.env);
  const currentTheme = (): Theme => themes[renderer.themeMode ?? envFallback];
  let snapshot = await readDashboard(socketPath);
  let rows = orderedRows(snapshot);
  let selected = 0;
  let note = "";
  let busy = false;

  const clampSelection = () => {
    selected = rows.length === 0 ? 0 : Math.max(0, Math.min(selected, rows.length - 1));
  };

  // Build the next frame fully before swapping it in, so a render error can
  // never leave the cleared root blank (the white-screen failure mode). Old
  // subtrees are destroyed, not just removed: OpenTUI's remove() only detaches,
  // so without destroy the native renderables leak every frame until the
  // renderer runs out of memory and the screen goes blank after some minutes.
  const paint = () => {
    clampSelection();
    let next: ReturnType<typeof Box>;
    try {
      next = view({ theme: currentTheme() }, snapshot, rows, selected, note);
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
      snapshot = refresh ? await refreshUsage(socketPath) : await readDashboard(socketPath);
      rows = orderedRows(snapshot);
      clampSelection();
    });

  const switchToSelected = () => {
    const row = rows[selected];
    if (row === undefined) {
      return;
    }
    void withBusy("switching…", async () => {
      await requestSwitch(socketPath, row.provider, row.accountId);
      snapshot = await readDashboard(socketPath);
      rows = orderedRows(snapshot);
    });
  };

  const toggleAuto = () => {
    const row = rows[selected];
    if (row === undefined) {
      return;
    }
    const state = snapshot.providers.find((s) => s.provider === row.provider);
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
        snapshot = await readDashboard(socketPath);
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
      // A keystroke must never be able to break the dashboard.
      try {
        if (key.name === "q" || (key.ctrl && key.name === "c")) {
          finish();
        } else if (key.name === "up" || key.name === "k") {
          selected = Math.max(0, selected - 1);
          paint();
        } else if (key.name === "down" || key.name === "j") {
          selected = Math.max(0, Math.min(rows.length - 1, selected + 1));
          paint();
        } else if (key.name === "return") {
          switchToSelected();
        } else if (key.name === "a") {
          toggleAuto();
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
