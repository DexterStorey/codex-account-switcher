import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  configTargets,
  installClaudeConfig,
  installCodexConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
} from "./config-install.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";
import { type Account, AccountEmailSchema } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import {
  managerAvailable,
  managerRequest,
  readDashboard,
  readProxyPort,
  requestSwitch,
  startManagerServer,
} from "./ipc.ts";
import { AccountManager } from "./manager.ts";
import {
  type ApplicationPaths,
  applicationPaths,
  ensureApplicationPaths,
  proxyBaseUrl,
} from "./paths.ts";
import { runCommand } from "./process.ts";
import { registerClaudeAccount, removeClaudeProfile } from "./providers/claude/auth.ts";
import { registerCodexAccount } from "./providers/codex/auth.ts";
import { createMacOsKeychainVault } from "./providers/codex/keychain.ts";
import { pickDefaultAccount } from "./selection.ts";
import { createStateStore, type StateStore } from "./storage.ts";
import { renderDashboard, runDashboard } from "./ui.ts";

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

function flag(arguments_: readonly string[], name: string): boolean {
  return arguments_.includes(name);
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
  return `tokmax — accounts, rate limits, and safe switching for Codex and Claude Code

Accounts
  tokmax codex login                      sign in another OpenAI account
  tokmax claude login [--email a@b.com]   sign in another Anthropic account
  tokmax <codex|claude> relogin <email>   repair an expired login
  tokmax list                             all accounts and their health
  tokmax whoami                           active account per provider

Sessions
  tokmax install                          route native codex/claude through tokmax
  tokmax uninstall                        restore the original client config
  tokmax codex [arguments...]             launch Codex on the active account
  tokmax claude [arguments...]            launch Claude Code on the active account

Limits
  tokmax                                  live dashboard
  tokmax status [--json]                  one-shot snapshot
  tokmax refresh                          re-probe every account now
  tokmax switch <codex|claude> <email>    point every request at an account
  tokmax auto <codex|claude|both> <on|off> [--threshold 95] [--authorized]

Plumbing
  tokmax daemon <start|stop|status>       the manager that runs the proxy and probes
  tokmax doctor                           verify local tools and config

A local proxy injects the active account's credential into every request, so a
switch takes effect on the next request — even mid-turn — and the clients run
natively. After tokmax install, plain codex and claude route through it too.
Automatic rotation is off by default; --authorized records your confirmation
that your provider agreement permits it.`;
}

async function createContext(): Promise<ApplicationContext> {
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  return { paths, store: createStateStore(paths.database) };
}

async function runDaemon(context: ApplicationContext): Promise<void> {
  // The daemon and its app-server children must not inherit a user project
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
async function ensureActiveProviderAccount(
  context: ApplicationContext,
  provider: "openai" | "anthropic",
  clientName: string,
): Promise<void> {
  await ensureDaemon(context);
  const snapshot = await readDashboard(context.paths.managerSocket);
  const state = snapshot.providers.find((candidate) => candidate.provider === provider);
  if (state === undefined || state.activeAccountId !== null) {
    return;
  }
  const loginName = provider === "openai" ? "codex" : "claude";
  const accounts = snapshot.accounts.filter((account) => account.provider === provider);
  if (accounts.length === 0) {
    throw new ApplicationError(
      "NO_ACCOUNTS",
      `No ${loginName} account is registered yet. Run: tokmax ${loginName} login`,
    );
  }
  const target = pickDefaultAccount({ accounts, usage: snapshot.usage });
  if (target === null) {
    throw new ApplicationError(
      "NO_ACCOUNTS",
      `No enabled ${loginName} account is available; check tokmax list`,
    );
  }
  await requestSwitch(context.paths.managerSocket, provider, target.id);
  process.stdout.write(
    `Activated ${target.label} for ${clientName}. Change with: tokmax switch ${loginName} <email>\n`,
  );
}

async function addAccount(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<void> {
  const providerArgument = arguments_[0];
  if (providerArgument === undefined) {
    throw new ApplicationError("USAGE", "Usage: tokmax <codex|claude> login [--email address]");
  }
  const provider = providerFromCli(providerArgument);
  const registration = parseRegistrationOptions(provider, arguments_.slice(1));
  const account = await registerIsolatedAccount(context, provider, registration.email);
  const duplicate = context.store
    .listAccounts(provider)
    .find(
      (candidate) =>
        candidate.externalAccountId !== null &&
        candidate.externalAccountId === account.externalAccountId,
    );
  if (duplicate !== undefined) {
    await removeUnstoredAccount(account);
    throw new ApplicationError(
      "DUPLICATE_ACCOUNT",
      `This login is already registered as ${duplicate.label}`,
    );
  }
  try {
    context.store.saveAccount(account);
  } catch (error) {
    await removeUnstoredAccount(account);
    throw error;
  }
  process.stdout.write(
    `Registered ${account.label} without changing the active ${providerArgument} account.\n`,
  );
}

function registerIsolatedAccount(
  context: ApplicationContext,
  provider: "openai" | "anthropic",
  email: string | undefined,
): Promise<Account> {
  switch (provider) {
    case "openai":
      return registerCodexAccount({ vault: createMacOsKeychainVault() });
    case "anthropic":
      return registerClaudeAccount({
        email,
        paths: context.paths,
      });
  }
}

function parseRegistrationOptions(
  provider: "openai" | "anthropic",
  arguments_: readonly string[],
): { email: string | undefined } {
  switch (provider) {
    case "openai":
      if (arguments_.length !== 0) {
        throw new ApplicationError("USAGE", "Usage: tokmax codex login");
      }
      return { email: undefined };
    case "anthropic":
      switch (arguments_.length) {
        case 0:
          return { email: undefined };
        case 1: {
          const argument = arguments_[0];
          if (argument?.startsWith("--email=") !== true) {
            throw new ApplicationError(
              "USAGE",
              "Usage: tokmax claude login [--email user@example.com]",
            );
          }
          return { email: AccountEmailSchema.parse(argument.slice("--email=".length)) };
        }
        case 2:
          if (arguments_[0] !== "--email" || arguments_[1] === undefined) {
            throw new ApplicationError(
              "USAGE",
              "Usage: tokmax claude login [--email user@example.com]",
            );
          }
          return { email: AccountEmailSchema.parse(arguments_[1]) };
        default:
          throw new ApplicationError(
            "USAGE",
            "Usage: tokmax claude login [--email user@example.com]",
          );
      }
  }
}

async function removeUnstoredAccount(account: Account): Promise<void> {
  if (account.secretReference !== null) {
    await createMacOsKeychainVault().remove(account.secretReference);
  }
  if (account.profilePath !== null) {
    await removeClaudeProfile(account.profilePath);
  }
}

async function reauthenticateAccount(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<void> {
  const providerArgument = arguments_[0];
  const accountReference = arguments_[1];
  if (providerArgument === undefined || accountReference === undefined) {
    throw new ApplicationError("USAGE", "Usage: tokmax <codex|claude> relogin <email-or-id>");
  }
  const provider = providerFromCli(providerArgument);
  // Relogin owns the daemon lifecycle instead of telling the user to.
  const managerWasRunning = await managerAvailable(context.paths.managerSocket);
  if (managerWasRunning) {
    process.stdout.write("Pausing the manager for relogin…\n");
    await stopDaemon(context);
  }
  const lock = await acquireDaemonLock(context.paths.managerLock);
  try {
    // Live sessions only matter when they ride the credential being replaced;
    // refreshing a non-active account never touches the active profile.
    const activeAccountId = context.store.findProviderState(provider).activeAccountId;
    const target = resolveAccount(context.store, provider, accountReference);
    if (target.id === activeAccountId) {
      const liveSession = context.store.listRuntimeSessions().find((session) => {
        if (session.provider !== provider) {
          return false;
        }
        try {
          process.kill(session.processId, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (liveSession !== undefined) {
        throw new ApplicationError(
          "SESSIONS_RUNNING",
          `${target.label} is the active ${providerArgument} account and managed ${liveSession.client} process ${liveSession.processId} is still using it; close it or switch first`,
        );
      }
    }
    const existing = resolveAccount(context.store, provider, accountReference);
    if (existing.externalAccountId === null) {
      throw new ApplicationError(
        "IDENTITY_UNBOUND",
        `${existing.label} has no stable provider identity and must be registered again`,
      );
    }
    const registration = parseRegistrationOptions(provider, arguments_.slice(2));
    const authenticated = await registerIsolatedAccount(context, provider, registration.email);
    if (
      authenticated.externalAccountId !== existing.externalAccountId ||
      (existing.provider === "openai" &&
        existing.externalUserId !== null &&
        authenticated.provider === "openai" &&
        authenticated.externalUserId !== existing.externalUserId)
    ) {
      await removeUnstoredAccount(authenticated);
      throw new ApplicationError(
        "IDENTITY_CHANGED",
        `Login belongs to a different ${providerArgument} account than ${existing.label}`,
      );
    }
    const replacement: Account = {
      ...authenticated,
      id: existing.id,
      enabled: existing.enabled,
      createdAt: existing.createdAt,
    };
    try {
      context.store.saveAccount(replacement);
    } catch (error) {
      await removeUnstoredAccount(authenticated);
      throw error;
    }
    try {
      await removeUnstoredAccount(existing);
    } catch (error) {
      process.stderr.write(
        `warning: reauthentication succeeded but the prior credential could not be removed: ${errorMessage(error)}\n`,
      );
    }
    process.stdout.write(`Reauthenticated ${providerArgument} account ${replacement.label}.\n`);
  } finally {
    await lock.release();
    if (managerWasRunning) {
      await startDaemon(context).then(
        () => process.stdout.write("Manager resumed.\n"),
        (error) =>
          process.stderr.write(
            `warning: manager did not restart (${errorMessage(error)}); run tokmax daemon start\n`,
          ),
      );
    }
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

function listAccounts(context: ApplicationContext): void {
  const states = new Map(
    context.store.listProviderStates().map((state) => [state.provider, state]),
  );
  const accounts = context.store.listAccounts();
  if (accounts.length === 0) {
    process.stdout.write("No accounts registered.\n");
    return;
  }
  for (const account of accounts) {
    const active =
      states.get(account.provider)?.activeAccountId === account.id ? "active" : "     ";
    process.stdout.write(
      `${active}  ${account.provider.padEnd(10)}  ${account.label.padEnd(32)}  ${account.health}\n`,
    );
  }
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
      "Usage: tokmax auto <codex|claude|both> <on|off> [--threshold 95] [--authorized]",
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
        authorizationConfirmed: flag(arguments_, "--authorized"),
      },
      schema: z.unknown(),
    });
  }
  process.stdout.write(
    `Automatic ${providerArgument} switching is ${mode === "on" ? "enabled" : "disabled"}${thresholdPercent === undefined ? "" : ` at ${thresholdPercent}%`}.\n`,
  );
}

function whoami(context: ApplicationContext): void {
  const states = new Map(
    context.store.listProviderStates().map((state) => [state.provider, state]),
  );
  for (const [provider, clientName] of [
    ["openai", "codex"],
    ["anthropic", "claude"],
  ] as const) {
    const state = states.get(provider);
    const active =
      state?.activeAccountId == null ? null : context.store.findAccount(state.activeAccountId);
    process.stdout.write(
      `${clientName.padEnd(7)} ${
        active === null ? "no active account" : `${active.label} (gen ${state?.generation ?? 0})`
      }\n`,
    );
  }
}

// Launch a native client. With config installed, plain `codex`/`claude` route
// through the proxy too; the wrapper only adds account auto-selection and, for
// safety, sets the base URL for this launch even if the user has not installed.
async function launchNative(
  context: ApplicationContext,
  provider: "openai" | "anthropic",
  arguments_: readonly string[],
): Promise<number> {
  await ensureActiveProviderAccount(context, provider, provider === "openai" ? "codex" : "claude");
  const base = proxyBaseUrl(context.paths, provider);
  if (provider === "openai") {
    return Bun.spawn(
      [
        "codex",
        "-c",
        "model_provider=tokmax",
        "-c",
        `model_providers.tokmax={name="tokmax",base_url="${base}",wire_api="responses"}`,
        ...arguments_,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ).exited;
  }
  return Bun.spawn(["claude", ...arguments_], {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: "managed-by-tokmax",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

async function installConfig(context: ApplicationContext): Promise<void> {
  // Confirms the daemon (and its proxy) can start before pointing config at it.
  await ensureDaemon(context);
  const codexPath = await installCodexConfig(context.paths);
  const claudePath = await installClaudeConfig(context.paths);
  process.stdout.write(
    `Routed native Codex and Claude Code through tokmax:\n  ${codexPath}\n  ${claudePath}\nPlain \`codex\` and \`claude\` now use the active account. Undo with: tokmax uninstall\n`,
  );
}

async function uninstallConfig(): Promise<void> {
  const codexPath = await uninstallCodexConfig();
  const claudePath = await uninstallClaudeConfig();
  const targets = configTargets();
  process.stdout.write(
    `${codexPath === null ? `No tokmax block in ${targets.codex}` : `Restored ${codexPath}`}\n` +
      `${claudePath === null ? `No tokmax env in ${targets.claude}` : `Restored ${claudePath}`}\n`,
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
  const targets = configTargets();
  const installed = await readFile(targets.codex, "utf8")
    .then((content) => content.includes("model_providers.tokmax"))
    .catch(() => false);
  process.stdout.write(
    `${installed ? "ok     " : "note   "}  config   ${installed ? "native Codex/Claude routed through tokmax" : "run tokmax install to route native codex/claude"}\n`,
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
        await runDashboard(context.paths.managerSocket);
        return 0;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${help()}\n`);
        return 0;
      case "account":
        switch (arguments_[1]) {
          case "add":
            await addAccount(context, arguments_.slice(2));
            return 0;
          case "reauthenticate":
            await reauthenticateAccount(context, arguments_.slice(2));
            return 0;
          case "list":
            listAccounts(context);
            return 0;
          default:
            throw new ApplicationError("USAGE", "Usage: account <add|reauthenticate|list>");
        }
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
        process.stdout.write("Usage and health refreshed.\n");
        return 0;
      case "status": {
        await ensureDaemon(context);
        const snapshot = await readDashboard(context.paths.managerSocket);
        process.stdout.write(
          flag(arguments_, "--json")
            ? `${JSON.stringify(snapshot, null, 2)}\n`
            : `${renderDashboard(snapshot)}\n`,
        );
        return 0;
      }
      case "codex":
        if (arguments_[1] === "login") {
          await addAccount(context, ["codex", ...arguments_.slice(2)]);
          return 0;
        }
        if (arguments_[1] === "relogin") {
          await reauthenticateAccount(context, ["codex", ...arguments_.slice(2)]);
          return 0;
        }
        return launchNative(context, "openai", arguments_.slice(1));
      case "claude":
        if (arguments_[1] === "login") {
          await addAccount(context, ["claude", ...arguments_.slice(2)]);
          return 0;
        }
        if (arguments_[1] === "relogin") {
          await reauthenticateAccount(context, ["claude", ...arguments_.slice(2)]);
          return 0;
        }
        return launchNative(context, "anthropic", arguments_.slice(1));
      case "list":
        listAccounts(context);
        return 0;
      case "whoami":
        whoami(context);
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
