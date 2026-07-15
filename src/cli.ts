import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  installClaudeConfig,
  installCodexConfig,
  isInstalled,
  uninstallClaudeConfig,
  uninstallCodexConfig,
} from "./config-install.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";
import type { Account } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import {
  managerAvailable,
  managerRequest,
  readDashboard,
  readProxyPort,
  requestAccountSave,
  requestSwitch,
  startManagerServer,
} from "./ipc.ts";
import { AccountManager } from "./manager.ts";
import { type ApplicationPaths, applicationPaths, ensureApplicationPaths } from "./paths.ts";
import { runCommand } from "./process.ts";
import { registerClaudeAccount, removeClaudeProfile } from "./providers/claude/auth.ts";
import { registerCodexAccount } from "./providers/codex/auth.ts";
import { createMacOsKeychainVault } from "./providers/codex/keychain.ts";
import { createStateStore, type StateStore } from "./storage.ts";
import { renderDashboard } from "./ui.ts";

const CommandSchema = z.array(z.string());
const EmptyResultSchema = z.unknown();

interface ApplicationContext {
  paths: ApplicationPaths;
  store: StateStore;
}

function providerFromCli(value: string): "openai" | "anthropic" {
  switch (value) {
    case "codex":
    case "openai":
      return "openai";
    case "claude":
    case "anthropic":
      return "anthropic";
    default:
      throw new ApplicationError("INVALID_PROVIDER", `Expected codex or claude, received ${value}`);
  }
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const equals = arguments_.find((argument) => argument.startsWith(`${name}=`));
  if (equals !== undefined) {
    return equals.slice(name.length + 1);
  }
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function help(): string {
  return `tokmax — juggle rate limits across your Codex and Claude Code accounts

Setup
  tokmax login <codex|claude>              sign in an account (re-run to re-auth)
  tokmax install                           route native codex & claude through tokmax
  tokmax uninstall                         restore your original config

Everyday
  tokmax                                   the live dashboard
  tokmax switch <codex|claude> <email>     make an account active
  tokmax auto <codex|claude|both> <on|off> [--threshold 95]
  tokmax list                              accounts and their health

Details
  tokmax status                            machine-readable JSON snapshot
  tokmax refresh                           re-probe usage now
  tokmax doctor                            check tools, proxy, and config
  tokmax daemon <start|stop|status>        the background manager

Once installed, just use codex and claude normally: a local proxy swaps in the
active account's credential per request, so a switch (manual or auto-rotate)
takes effect on the very next request — even mid-turn — with no restart.`;
}

async function createContext(): Promise<ApplicationContext> {
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  return { paths, store: createStateStore(paths.database) };
}

async function runDaemon(context: ApplicationContext): Promise<void> {
  // The daemon must not inherit a user project directory: a daemon parked in
  // directory: Codex threads started without an explicit cwd fall back to the
  // app-server's, and a daemon parked in a repo also pins that directory.
  try {
    process.chdir(homedir());
  } catch {
    // An unreadable home directory is not worth refusing to start over.
  }
  // The daemon must outlive any single failed probe or child process; Bun
  // exits on unhandled rejections by default, which silently stops all
  // probing until someone next runs a tokmax command.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandled rejection: ${errorMessage(reason)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`uncaught exception: ${errorMessage(error)}\n`);
  });
  const lock = await acquireDaemonLock(context.paths.managerLock);
  try {
    if (await managerAvailable(context.paths.managerSocket)) {
      throw new ApplicationError("DAEMON_RUNNING", "The manager daemon is already running");
    }
    const manager = new AccountManager({
      paths: context.paths,
      store: context.store,
      vault: createMacOsKeychainVault(),
    });
    await manager.start();
    try {
      let requestStop: (() => void) | undefined;
      const stopped = new Promise<void>((resolve) => {
        requestStop = resolve;
      });
      const server = await startManagerServer({
        manager,
        socketPath: context.paths.managerSocket,
        onStop: () => requestStop?.(),
      });
      const signalHandler = () => requestStop?.();
      process.once("SIGINT", signalHandler);
      process.once("SIGTERM", signalHandler);
      await stopped;
      await server.close();
    } finally {
      await manager.stop();
    }
  } finally {
    await lock.release();
  }
}

async function startDaemon(context: ApplicationContext): Promise<void> {
  if (await managerAvailable(context.paths.managerSocket)) {
    return;
  }
  await mkdir(context.paths.runtime, { recursive: true, mode: 0o700 });
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new ApplicationError("ENTRYPOINT_MISSING", "Cannot locate the CLI entrypoint");
  }
  const logDescriptor = openSync(join(context.paths.runtime, "daemon.log"), "a", 0o600);
  try {
    // A stopping daemon releases its startup lock only after a full drain, so
    // a freshly spawned manager can lose the lock race and exit. Spawn again
    // instead of failing the whole start.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const child = spawn(process.execPath, [entrypoint, "daemon", "run"], {
        detached: true,
        env: process.env,
        stdio: ["ignore", logDescriptor, logDescriptor],
      });
      child.unref();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await managerAvailable(context.paths.managerSocket)) {
          return;
        }
        if (child.exitCode !== null) {
          break;
        }
        await Bun.sleep(50);
      }
      if (await managerAvailable(context.paths.managerSocket)) {
        return;
      }
      await Bun.sleep(500);
    }
    throw new ApplicationError(
      "DAEMON_START_FAILED",
      `Manager did not start; inspect ${join(context.paths.runtime, "daemon.log")}`,
    );
  } finally {
    closeSync(logDescriptor);
  }
}

async function stopDaemon(context: ApplicationContext): Promise<void> {
  await managerRequest({
    socketPath: context.paths.managerSocket,
    method: "manager/stop",
    schema: EmptyResultSchema,
    timeoutMilliseconds: 1_000,
  });
  // Wait for the drain to finish so `daemon stop && daemon start` and the
  // stopped-manager requirement for relogin are race-free.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const running = await managerAvailable(context.paths.managerSocket);
    const lockHeld = await stat(context.paths.managerLock).then(
      () => true,
      () => false,
    );
    if (!running && !lockHeld) {
      process.stdout.write("Manager daemon stopped.\n");
      return;
    }
    await Bun.sleep(200);
  }
  process.stdout.write("Manager daemon is still draining; check tokmax daemon status.\n");
}

async function ensureDaemon(context: ApplicationContext): Promise<void> {
  if (!(await managerAvailable(context.paths.managerSocket))) {
    await startDaemon(context);
  }
}

// A managed client launched with no active account would reach the provider's
// own sign-in screen, whose login flow the managed boundary rejects. Select an
// account first and say so.
function registerIsolatedAccount(
  context: ApplicationContext,
  provider: "openai" | "anthropic",
): Promise<Account> {
  switch (provider) {
    case "openai":
      return registerCodexAccount({ vault: createMacOsKeychainVault() });
    case "anthropic":
      return registerClaudeAccount({ paths: context.paths });
  }
}

// tokmax login <codex|claude>: runs the browser OAuth, then hands the result to
// the daemon so it stays the single store writer. Idempotent — signing in an
// account that already exists re-auths it in place (running sessions keep
// working); a new account is added, and the first for a provider is activated
// so native clients work immediately.
async function login(
  context: ApplicationContext,
  providerArgument: string | undefined,
): Promise<void> {
  if (providerArgument === undefined) {
    throw new ApplicationError("USAGE", "Usage: tokmax login <codex|claude>");
  }
  const provider = providerFromCli(providerArgument);
  await ensureDaemon(context);
  const authenticated = await registerIsolatedAccount(context, provider);
  const existing = context.store
    .listAccounts(provider)
    .find(
      (candidate) =>
        candidate.externalAccountId !== null &&
        candidate.externalAccountId === authenticated.externalAccountId,
    );
  const account =
    existing === undefined
      ? authenticated
      : {
          ...authenticated,
          id: existing.id,
          enabled: existing.enabled,
          createdAt: existing.createdAt,
        };
  try {
    await requestAccountSave(context.paths.managerSocket, account, {
      secretReference: existing?.secretReference ?? null,
      profilePath: existing?.profilePath ?? null,
    });
  } catch (error) {
    await removeUnstoredAccount(authenticated);
    throw error;
  }
  process.stdout.write(
    existing === undefined
      ? `Signed in ${account.label}.\n`
      : `Re-authenticated ${account.label}; live sessions pick it up on their next request.\n`,
  );
}

async function removeUnstoredAccount(account: Account): Promise<void> {
  if (account.secretReference !== null) {
    await createMacOsKeychainVault().remove(account.secretReference);
  }
  if (account.profilePath !== null) {
    await removeClaudeProfile(account.profilePath);
  }
}

function resolveAccount(
  store: StateStore,
  provider: "openai" | "anthropic",
  reference: string,
): Account {
  const matches = store
    .listAccounts(provider)
    .filter((account) => account.id === reference || account.label === reference);
  const account = matches[0];
  if (account === undefined || matches.length !== 1) {
    throw new ApplicationError("ACCOUNT_NOT_FOUND", `Could not uniquely resolve ${reference}`);
  }
  return account;
}

const healthText: Record<Account["health"], string> = {
  unchecked: "checking",
  ready: "ready",
  refreshDue: "refreshing",
  refreshing: "refreshing",
  loginExpiring: "login expiring soon",
  scopeMissing: "missing a scope",
  reauthenticationRequired: "login required — tokmax login",
  temporarilyUnreachable: "provider unreachable",
  usageRateLimited: "rate-limited",
  disabled: "disabled",
};

function listAccounts(context: ApplicationContext): void {
  const states = new Map(
    context.store.listProviderStates().map((state) => [state.provider, state]),
  );
  const accounts = context.store.listAccounts();
  if (accounts.length === 0) {
    process.stdout.write(
      "No accounts yet. Sign in with:  tokmax login codex   ·   tokmax login claude\n",
    );
    return;
  }
  const width = Math.max(...accounts.map((account) => account.label.length));
  for (const [provider, title] of [
    ["openai", "codex"],
    ["anthropic", "claude"],
  ] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (group.length === 0) {
      continue;
    }
    process.stdout.write(`\n${title}\n`);
    for (const account of group) {
      const isActive = states.get(provider)?.activeAccountId === account.id;
      process.stdout.write(
        `  ${isActive ? "●" : " "} ${account.label.padEnd(width)}   ${healthText[account.health]}\n`,
      );
    }
  }
  process.stdout.write("\n● = active\n");
}

async function switchAccount(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<void> {
  const providerArgument = arguments_[0];
  const accountReference = arguments_[1];
  if (providerArgument === undefined || accountReference === undefined) {
    throw new ApplicationError("USAGE", "Usage: tokmax switch <codex|claude> <email-or-id>");
  }
  const provider = providerFromCli(providerArgument);
  const target = resolveAccount(context.store, provider, accountReference);
  await ensureDaemon(context);
  await requestSwitch(context.paths.managerSocket, provider, target.id);
  process.stdout.write(`Switched managed ${providerArgument} sessions to ${target.label}.\n`);
}

async function configureAutomation(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<void> {
  const providerArgument = arguments_[0];
  const mode = arguments_[1];
  if (providerArgument === undefined || (mode !== "on" && mode !== "off")) {
    throw new ApplicationError(
      "USAGE",
      "Usage: tokmax auto <codex|claude|both> <on|off> [--threshold 95]",
    );
  }
  const providers =
    providerArgument === "both"
      ? (["openai", "anthropic"] as const)
      : ([providerFromCli(providerArgument)] as const);
  const thresholdValue = option(arguments_, "--threshold");
  const thresholdPercent = thresholdValue === undefined ? undefined : Number(thresholdValue);
  await ensureDaemon(context);
  for (const provider of providers) {
    await managerRequest({
      socketPath: context.paths.managerSocket,
      method: "policy/set",
      params: {
        provider,
        enabled: mode === "on",
        thresholdPercent,
        // Enabling from the CLI is itself the confirmation, matching the
        // dashboard's toggle; the ToS guidance lives in the docs.
        authorizationConfirmed: mode === "on",
      },
      schema: z.unknown(),
    });
  }
  process.stdout.write(
    `Auto-rotate ${mode === "on" ? "on" : "off"} for ${providerArgument}${thresholdPercent === undefined ? "" : ` at ${thresholdPercent}%`}.\n`,
  );
}

// Launch a native client. With config installed, plain `codex`/`claude` route
// through the proxy too; the wrapper only adds account auto-selection and, for
// safety, sets the base URL for this launch even if the user has not installed.
async function installConfig(context: ApplicationContext): Promise<void> {
  // Confirms the daemon (and its proxy) can start before pointing config at it.
  await ensureDaemon(context);
  await installCodexConfig(context.paths);
  await installClaudeConfig(context.paths);
  process.stdout.write(
    "Native codex and claude now route through tokmax.\n" +
      "Just run `codex` or `claude` as usual — tokmax injects the active account.\n" +
      "Undo any time with: tokmax uninstall\n",
  );
}

async function uninstallConfig(): Promise<void> {
  const codex = await uninstallCodexConfig();
  const claude = await uninstallClaudeConfig();
  if (codex === null && claude === null) {
    process.stdout.write("tokmax was not installed; nothing to restore.\n");
    return;
  }
  process.stdout.write(
    "Restored your original codex and claude config.\n" +
      "Native clients no longer route through tokmax. Re-enable with: tokmax install\n",
  );
}

async function doctor(context: ApplicationContext): Promise<void> {
  const tools = [
    ["bun", "1.2+"],
    ["codex", "0.144.1"],
    ["claude", "2.1.206"],
  ] as const;
  for (const [tool, testedVersion] of tools) {
    if (Bun.which(tool) === null) {
      process.stdout.write(`missing  ${tool}\n`);
      continue;
    }
    const version = await runCommand([tool, "--version"]);
    process.stdout.write(
      `ok       ${tool.padEnd(8)} ${version.stdout.trim() || version.stderr.trim()}  (tested ${testedVersion})\n`,
    );
  }
  process.stdout.write(`${Bun.which("security") === null ? "missing" : "ok     "}  security\n`);
  const running = await managerAvailable(context.paths.managerSocket);
  process.stdout.write(`${running ? "running" : "stopped"}  manager daemon\n`);
  if (running) {
    const port = await readProxyPort(context.paths.managerSocket).catch(() => null);
    process.stdout.write(
      `${port === null ? "warning  " : "ok     "}  proxy    ${port === null ? "not listening" : `127.0.0.1:${port}`}\n`,
    );
  }
  const installed = await isInstalled();
  process.stdout.write(
    `${installed ? "ok     " : "note   "}  config   ${installed ? "native codex & claude route through tokmax" : "run tokmax install to route native codex & claude"}\n`,
  );
  process.stdout.write(`state     ${context.paths.database}\n`);
  const legacyDirectories = [join(context.paths.root, "codex"), join(context.paths.root, "claude")];
  const legacyDetected = await Promise.all(
    legacyDirectories.map((directory) =>
      stat(directory)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (legacyDetected.some(Boolean)) {
    process.stdout.write(
      "warning  legacy plaintext snapshots detected; re-register accounts before removing them\n",
    );
  }
}

export async function runCli(rawArguments: readonly string[]): Promise<number> {
  const arguments_ = CommandSchema.parse(rawArguments);
  const context = await createContext();
  try {
    const command = arguments_[0];
    switch (command) {
      case undefined:
      case "dashboard":
        await ensureDaemon(context);
        if (process.stdout.isTTY) {
          const { runTuiDashboard } = await import("./tui/dashboard.ts");
          await runTuiDashboard(context.paths.managerSocket, { installed: await isInstalled() });
          // The native renderer can leave the event loop alive after teardown;
          // exit deterministically so quitting never orphans the process.
          context.store.close();
          process.exit(0);
        }
        process.stdout.write(
          `${renderDashboard(await readDashboard(context.paths.managerSocket))}\n`,
        );
        return 0;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${help()}\n`);
        return 0;
      case "login":
        await login(context, arguments_[1]);
        return 0;
      case "switch":
        await switchAccount(context, arguments_.slice(1));
        return 0;
      case "auto":
        await configureAutomation(context, arguments_.slice(1));
        return 0;
      case "refresh":
        await ensureDaemon(context);
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "usage/refresh",
          schema: z.unknown(),
          timeoutMilliseconds: 60_000,
        });
        process.stdout.write("Re-probed usage for every account.\n");
        return 0;
      case "status": {
        await ensureDaemon(context);
        const snapshot = await readDashboard(context.paths.managerSocket);
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
      }
      case "list":
        listAccounts(context);
        return 0;
      case "install":
        await installConfig(context);
        return 0;
      case "uninstall":
        await uninstallConfig();
        return 0;
      case "daemon":
        switch (arguments_[1]) {
          case "run":
            await runDaemon(context);
            return 0;
          case "start":
            await startDaemon(context);
            process.stdout.write("Manager daemon is running.\n");
            return 0;
          case "stop":
            await stopDaemon(context);
            return 0;
          case "status":
            process.stdout.write(
              `${(await managerAvailable(context.paths.managerSocket)) ? "running" : "stopped"}\n`,
            );
            return 0;
          default:
            throw new ApplicationError("USAGE", "Usage: daemon <start|run|stop|status>");
        }
      case "doctor":
        await doctor(context);
        return 0;
      default:
        throw new ApplicationError(
          "UNKNOWN_COMMAND",
          `Unknown command ${command}. Run tokmax --help.`,
        );
    }
  } finally {
    context.store.close();
  }
}
