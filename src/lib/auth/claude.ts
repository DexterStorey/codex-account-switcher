import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SnapshotStore, snapshotStore } from "../store/store";
import { AccountIdentity, AccountRef, AuthProvider } from "./types";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");
export const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

/**
 * Snapshot format: ONLY the `claudeAiOauth` section of the keychain payload,
 * plus identity metadata. The keychain item also carries `mcpOAuth` (tokens
 * for MCP servers), which belongs to the machine rather than the Claude
 * account — swapping it between accounts would sign you out of MCP servers.
 */
interface ClaudeSnapshot {
  oauth: ClaudeOauth;
  meta: {
    accountUuid: string | null;
    email: string | null;
    organizationName: string | null;
    savedAt: string;
  };
}

function extractOauth(blob: string): ClaudeOauth | null {
  try {
    return (JSON.parse(blob) as { claudeAiOauth?: ClaudeOauth }).claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/** Put `oauth` into the live payload, preserving every other key (mcpOAuth...). */
function mergeOauth(liveBlob: string | null, oauth: ClaudeOauth): string {
  let base: Record<string, unknown> = {};
  if (liveBlob) {
    try {
      base = JSON.parse(liveBlob) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  base.claudeAiOauth = oauth;
  return JSON.stringify(base);
}

function keychainAccount(): string {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

export class ClaudeAuthProvider implements AuthProvider {
  public readonly id = "claude" as const;
  public readonly displayName = "Claude Code";

  constructor(private readonly store: SnapshotStore = snapshotStore) {}

  public async list(): Promise<string[]> {
    return this.store.list("claude");
  }

  public async save(name: string): Promise<AccountRef> {
    const blob = await this.readKeychainBlob();
    const oauth = blob ? extractOauth(blob) : null;
    if (!oauth) {
      throw new Error(
        `No Claude Code credentials found in the keychain (service "${KEYCHAIN_SERVICE}"). Log into Claude Code first.`,
      );
    }
    const oauthAccount = await this.readOauthAccount();
    const snapshot: ClaudeSnapshot = {
      oauth,
      meta: {
        accountUuid: oauthAccount?.accountUuid ?? null,
        email: oauthAccount?.emailAddress ?? null,
        organizationName: oauthAccount?.organizationName ?? null,
        savedAt: new Date().toISOString(),
      },
    };
    await this.store.write("claude", name, JSON.stringify(snapshot, null, 2));
    return { provider: "claude", name: this.store.validName(name) };
  }

  /**
   * Claude Code's keychain item is global (not per config dir), so an
   * isolated login is impossible. Instead: snapshot current → login
   * (overwrites the keychain) → snapshot the new account → restore previous.
   */
  public async add(name: string): Promise<AccountRef> {
    const validName = this.store.validName(name);

    const previousBlob = await this.readKeychainBlob();
    const previousOauth = previousBlob ? extractOauth(previousBlob) : null;
    let previousName: string | null = null;
    if (previousOauth) {
      previousName = (await this.store.getActive("claude")) ?? "default";
      await this.save(previousName); // capture freshest tokens before login overwrites
      await this.store.setActive("claude", previousName);
    }

    await this.runClaudeLogin();

    const newOauth = extractOauth((await this.readKeychainBlob()) ?? "");
    if (!newOauth || newOauth.accessToken === previousOauth?.accessToken) {
      throw new Error("Login did not produce new credentials; nothing saved.");
    }
    await this.save(validName);

    if (previousName) {
      await this.activate(previousName); // put the original account back
    } else {
      await this.store.setActive("claude", validName);
    }

    return { provider: "claude", name: validName };
  }

  public async activate(name: string): Promise<AccountRef> {
    const validName = this.store.validName(name);
    const raw = await this.store.read("claude", validName);
    if (!raw) {
      throw new Error(`No saved Claude Code account named "${validName}".`);
    }
    const snapshot = JSON.parse(raw) as ClaudeSnapshot;

    await this.syncBack();

    const live = await this.readKeychainBlob();
    await this.writeKeychainBlob(mergeOauth(live, snapshot.oauth));
    await this.patchOauthAccountFromMeta(snapshot.meta);

    const verify = extractOauth((await this.readKeychainBlob()) ?? "");
    if (verify?.accessToken !== snapshot.oauth.accessToken) {
      throw new Error(
        "Post-swap verification failed: keychain credentials do not match the snapshot (a running session may have rewritten them).",
      );
    }

    await this.store.setActive("claude", validName);
    return { provider: "claude", name: validName };
  }

  /**
   * Re-snapshot the live keychain blob into the snapshot it belongs to.
   * Attribution: network profile lookup on the blob's access token (reliable
   * even after a clobbering race); falls back to the recorded active account.
   */
  public async syncBack(): Promise<void> {
    const liveBlob = await this.readKeychainBlob();
    const liveOauth = liveBlob ? extractOauth(liveBlob) : null;
    if (!liveOauth?.accessToken) return;

    const names = await this.store.list("claude");
    const snapshots = new Map<string, ClaudeSnapshot>();
    for (const name of names) {
      const raw = await this.store.read("claude", name);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as ClaudeSnapshot;
      if (parsed.oauth.accessToken === liveOauth.accessToken) return; // already captured
      snapshots.set(name, parsed);
    }

    let ownerUuid = await this.attributeToken(liveOauth.accessToken);
    if (!ownerUuid) {
      const activeName = await this.store.getActive("claude");
      ownerUuid = activeName ? snapshots.get(activeName)?.meta.accountUuid ?? null : null;
    }
    if (!ownerUuid) return;

    for (const [name, snapshot] of snapshots) {
      if (snapshot.meta.accountUuid === ownerUuid) {
        snapshot.oauth = liveOauth;
        snapshot.meta.savedAt = new Date().toISOString();
        await this.store.write("claude", name, JSON.stringify(snapshot, null, 2));
      }
    }
  }

  public async current(): Promise<AccountIdentity | null> {
    const oauthAccount = await this.readOauthAccount();
    if (!oauthAccount) return null;
    return {
      accountId: oauthAccount.accountUuid ?? null,
      userId: oauthAccount.accountUuid ?? null,
      email: oauthAccount.emailAddress ?? null,
    };
  }

  public async identityOf(name: string): Promise<AccountIdentity | null> {
    const raw = await this.store.read("claude", name);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as ClaudeSnapshot;
    return {
      accountId: snapshot.meta.accountUuid,
      userId: snapshot.meta.accountUuid,
      email: snapshot.meta.email,
    };
  }

  /** Access token inside a stored snapshot (for the limits layer). */
  public async accessTokenOf(name: string): Promise<string | null> {
    const oauth = await this.readSnapshotOauth(name);
    return oauth?.accessToken ?? null;
  }

  /** Access token inside a raw keychain payload. */
  public accessTokenOfBlob(blob: string): string | null {
    return extractOauth(blob)?.accessToken ?? null;
  }

  public async readSnapshotOauth(name: string): Promise<ClaudeOauth | null> {
    const raw = await this.store.read("claude", name);
    if (!raw) return null;
    return (JSON.parse(raw) as ClaudeSnapshot).oauth;
  }

  public async updateSnapshotOauth(name: string, oauth: ClaudeOauth): Promise<void> {
    const raw = await this.store.read("claude", name);
    if (!raw) return;
    const snapshot = JSON.parse(raw) as ClaudeSnapshot;
    snapshot.oauth = oauth;
    snapshot.meta.savedAt = new Date().toISOString();
    await this.store.write("claude", name, JSON.stringify(snapshot, null, 2));
  }

  /** Who owns this token? GET /api/oauth/profile. */
  private async attributeToken(token: string): Promise<string | null> {
    if (!token) return null;
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
        },
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        account?: { uuid?: string };
        uuid?: string;
      };
      return body.account?.uuid ?? body.uuid ?? null;
    } catch {
      return null;
    }
  }

  // --- keychain mechanics -------------------------------------------------

  public async readKeychainBlob(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        keychainAccount(),
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const raw = stdout.replace(/\n$/, "");
      // `security` prints hex when the payload isn't plain text.
      if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 && !raw.startsWith("{")) {
        const decoded = Buffer.from(raw, "hex").toString("utf8");
        if (decoded.trimStart().startsWith("{")) return decoded;
      }
      return raw;
    } catch {
      return null;
    }
  }

  private async writeKeychainBlob(blob: string): Promise<void> {
    // -X (hex) avoids all shell quoting; `security -i` reads the command from
    // stdin so the secret never appears in argv.
    const hex = Buffer.from(blob, "utf8").toString("hex");
    const command = `add-generic-password -U -a "${keychainAccount()}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`security add-generic-password failed (${code}): ${stderr}`));
      });
      child.stdin.end(command);
    });
  }

  private async readOauthAccount(): Promise<{
    accountUuid?: string;
    emailAddress?: string;
    organizationName?: string;
  } | null> {
    try {
      const raw = await fsp.readFile(CLAUDE_JSON_PATH, "utf8");
      return (JSON.parse(raw) as { oauthAccount?: never }).oauthAccount ?? null;
    } catch {
      return null;
    }
  }

  /** Keep ~/.claude.json's oauthAccount display info consistent with the swap. */
  private async patchOauthAccountFromMeta(meta: ClaudeSnapshot["meta"]): Promise<void> {
    if (!meta.accountUuid) return;
    try {
      const raw = await fsp.readFile(CLAUDE_JSON_PATH, "utf8");
      const parsed = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> };
      if (!parsed.oauthAccount) return;
      parsed.oauthAccount.accountUuid = meta.accountUuid;
      if (meta.email) parsed.oauthAccount.emailAddress = meta.email;
      if (meta.organizationName) parsed.oauthAccount.organizationName = meta.organizationName;
      const tmp = `${CLAUDE_JSON_PATH}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, CLAUDE_JSON_PATH);
    } catch {
      // display metadata only — never fail a switch over it
    }
  }

  private runClaudeLogin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", ["auth", "login"], { stdio: "inherit" });
      child.on("error", (error) => {
        const err = error as NodeJS.ErrnoException;
        reject(
          err.code === "ENOENT"
            ? new Error("Could not find the `claude` CLI on your PATH.")
            : error,
        );
      });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`\`claude auth login\` exited with code ${code ?? "unknown"}.`));
      });
    });
  }
}

export const claudeAuthProvider = new ClaudeAuthProvider();
