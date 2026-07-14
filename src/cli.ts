import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireDaemonLock } from "./daemon-lock.ts";
import { type Account, AccountEmailSchema } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import {
  managerAvailable,
  managerRequest,
  readDashboard,
  requestSwitch,
  startManagerServer,
} from "./ipc.ts";
import { AccountManager } from "./manager.ts";
import { type ApplicationPaths, applicationPaths, ensureApplicationPaths } from "./paths.ts";
import { runCommand } from "./process.ts";
import {
  registerClaudeAccount,
  removeClaudeProfile,
  runManagedClaude,
} from "./providers/claude/auth.ts";
import { registerCodexAccount } from "./providers/codex/auth.ts";
import { createMacOsKeychainVault } from "./providers/codex/keychain.ts";
import { runManagedCodex } from "./providers/codex/supervisor.ts";
import { createStateStore, type StateStore } from "./storage.ts";
import { renderDashboard, runDashboard } from "./ui.ts";

const CommandSchema = z.array(z.string());
const EmptyResultSchema = z.unknown();
const ClaudeHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "Notification",
      "SessionEnd",
    ]),
  })
  .passthrough();
const HookAcknowledgementSchema = z.object({ acknowledged: z.literal(true) }).strict();

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
  return `tokmax — accounts, rate limits, and safe switching for Codex, Claude Code, and Pi

Accounts
  tokmax codex login                      sign in another OpenAI account
  tokmax claude login [--email a@b.com]   sign in another Anthropic account
  tokmax <codex|claude> relogin <email>   repair an expired login
  tokmax list                             all accounts and their health

Sessions
  tokmax codex [arguments...]             launch a managed Codex TUI
  tokmax claude [arguments...]            launch managed Claude Code
  tokmax pi [arguments...]                launch Pi with safe Codex switching

Limits
  tokmax                                  live dashboard
  tokmax status [--json]                  one-shot snapshot
  tokmax refresh                          re-probe every account now
  tokmax switch <codex|claude> <email>    move managed sessions to an account
  tokmax auto <codex|claude|both> <on|off> [--threshold 95] [--authorized]

Plumbing
  tokmax daemon <start|stop|status>       the manager that owns probes and switches
  tokmax doctor                           verify local tools and the manager boundary

Logins are isolated and never change a running session. Switching only controls
sessions launched through tokmax wrappers. Automatic rotation is off by default;
--authorized records your confirmation that your provider agreement permits it.
Relogin requires a stopped manager so credential replacement stays atomic.`;
}

async function createContext(): Promise<ApplicationContext> {
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  return { paths, store: createStateStore(paths.database) };
}

async function runDaemon(context: ApplicationContext): Promise<void> {
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
  const lock = await acquireDaemonLock(context.paths.managerLock);
  try {
    if (await managerAvailable(context.paths.managerSocket)) {
      throw new ApplicationError(
        "DAEMON_RUNNING",
        "Stop the manager before relogin: tokmax daemon stop",
      );
    }
    const liveSession = context.store.listRuntimeSessions().find((session) => {
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
        `Managed ${liveSession.client} process ${liveSession.processId} is still running`,
      );
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
    process.stdout.write(
      `Reauthenticated ${providerArgument} account ${replacement.label}; it will be projected when the manager starts.\n`,
    );
  } finally {
    await lock.release();
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

async function managedPi(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<number> {
  await ensureDaemon(context);
  const builtExtension = join(import.meta.dir, "extensions", "pi.js");
  const sourceExtension = join(import.meta.dir, "extensions", "pi.ts");
  const extension = (await Bun.file(builtExtension).exists()) ? builtExtension : sourceExtension;
  return Bun.spawn(["pi", "--extension", extension, ...arguments_], {
    env: { ...process.env, TOKMAX_SOCKET: context.paths.managerSocket },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

async function runClaudeHook(
  context: ApplicationContext,
  arguments_: readonly string[],
): Promise<number> {
  const action = z
    .enum(["session-start", "turn-begin", "turn-end", "session-end"])
    .parse(arguments_[0]);
  const input = ClaudeHookInputSchema.parse(JSON.parse(await Bun.stdin.text()));
  const processId = z.coerce.number().int().positive().parse(process.env.TOKMAX_RUNTIME_PID);
  const params = { sessionId: input.session_id, processId };
  try {
    switch (action) {
      case "session-start":
        if (input.hook_event_name !== "SessionStart") {
          throw new ApplicationError("HOOK_EVENT_MISMATCH", "Expected SessionStart hook input");
        }
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "claude/session/start",
          params,
          schema: HookAcknowledgementSchema,
        });
        return 0;
      case "turn-begin":
        if (input.hook_event_name !== "UserPromptSubmit") {
          throw new ApplicationError("HOOK_EVENT_MISMATCH", "Expected UserPromptSubmit hook input");
        }
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "claude/turn/begin",
          params,
          schema: z.object({ generation: z.number().int().nonnegative() }).strict(),
        });
        return 0;
      case "turn-end":
        if (!new Set(["Stop", "StopFailure", "Notification"]).has(input.hook_event_name)) {
          throw new ApplicationError("HOOK_EVENT_MISMATCH", "Expected a Claude turn-end hook");
        }
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "claude/turn/end",
          params,
          schema: HookAcknowledgementSchema,
        });
        return 0;
      case "session-end":
        if (input.hook_event_name !== "SessionEnd") {
          throw new ApplicationError("HOOK_EVENT_MISMATCH", "Expected SessionEnd hook input");
        }
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "claude/session/end",
          params,
          schema: HookAcknowledgementSchema,
        });
        return 0;
    }
  } catch (error) {
    process.stderr.write(`Managed Claude boundary unavailable: ${errorMessage(error)}\n`);
    return action === "turn-begin" ? 2 : 1;
  }
}

async function doctor(context: ApplicationContext): Promise<void> {
  const tools = [
    ["bun", "1.2+"],
    ["codex", "0.144.1"],
    ["claude", "2.1.206"],
    ["pi", "0.80.6"],
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
  process.stdout.write(
    `${(await managerAvailable(context.paths.managerSocket)) ? "running" : "stopped"}  manager daemon\n`,
  );
  process.stdout.write(`state     ${context.paths.database}\n`);
  process.stdout.write("boundary  only sessions launched through tokmax are switchable\n");
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
        await ensureDaemon(context);
        await managerRequest({
          socketPath: context.paths.managerSocket,
          method: "provider/ensure",
          params: { provider: "openai" },
          schema: z.object({ ready: z.literal(true) }).strict(),
        });
        return runManagedCodex(context.paths, arguments_.slice(1));
      case "claude":
        if (arguments_[1] === "login") {
          await addAccount(context, ["claude", ...arguments_.slice(2)]);
          return 0;
        }
        if (arguments_[1] === "relogin") {
          await reauthenticateAccount(context, ["claude", ...arguments_.slice(2)]);
          return 0;
        }
        await ensureDaemon(context);
        return runManagedClaude(context.paths, arguments_.slice(1));
      case "pi":
        if (arguments_[1] === "login" || arguments_[1] === "relogin") {
          throw new ApplicationError(
            "USAGE",
            "Pi has no separate account; it uses the selected OpenAI login. Run: tokmax codex login",
          );
        }
        return managedPi(context, arguments_.slice(1));
      case "list":
        listAccounts(context);
        return 0;
      case "hook":
        if (arguments_[1] !== "claude") {
          throw new ApplicationError("USAGE", "Usage: hook claude <action>");
        }
        return runClaudeHook(context, arguments_.slice(2));
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
