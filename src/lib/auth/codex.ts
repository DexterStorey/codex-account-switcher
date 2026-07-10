import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SnapshotStore, snapshotStore } from "../store/store";
import { AccountIdentity, AccountRef, AuthProvider, sameAccount } from "./types";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const AUTH_PATH = path.join(CODEX_DIR, "auth.json");
const LEGACY_ACCOUNTS_DIR = path.join(CODEX_DIR, "accounts");

interface CodexAuthJson {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function codexIdentityOfBlob(raw: string): AccountIdentity | null {
  try {
    const parsed = JSON.parse(raw) as CodexAuthJson;
    const claims = decodeJwtClaims(parsed.tokens?.id_token);
    const auth = claims?.["https://api.openai.com/auth"] as { user_id?: string } | undefined;
    return {
      accountId: parsed.tokens?.account_id ?? null,
      userId: auth?.user_id ?? (typeof claims?.sub === "string" ? claims.sub : null),
      email: typeof claims?.email === "string" ? claims.email : null,
    };
  } catch {
    return null;
  }
}

export class CodexAuthProvider implements AuthProvider {
  public readonly id = "codex" as const;
  public readonly displayName = "Codex";

  constructor(private readonly store: SnapshotStore = snapshotStore) {}

  public async list(): Promise<string[]> {
    await this.store.migrateLegacyCodexAccounts(LEGACY_ACCOUNTS_DIR);
    return this.store.list("codex");
  }

  public async save(name: string): Promise<AccountRef> {
    const live = await this.readLive();
    if (!live) {
      throw new Error(`No Codex auth at ${AUTH_PATH}. Log into Codex first.`);
    }
    await this.store.write("codex", name, live);
    return { provider: "codex", name: this.store.validName(name) };
  }

  public async add(name: string): Promise<AccountRef> {
    const validName = this.store.validName(name);
    const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-auth-add-"));
    try {
      await this.runCodexLogin(isolatedHome);
      const produced = await fsp
        .readFile(path.join(isolatedHome, "auth.json"), "utf8")
        .catch(() => null);
      if (!produced) {
        throw new Error("codex login finished without producing an auth.json; nothing saved.");
      }
      await this.store.write("codex", validName, produced);
      return { provider: "codex", name: validName };
    } finally {
      await fsp.rm(isolatedHome, { recursive: true, force: true });
    }
  }

  public async activate(name: string): Promise<AccountRef> {
    await this.list(); // ensure migration ran
    const validName = this.store.validName(name);
    const snapshot = await this.store.read("codex", validName);
    if (!snapshot) {
      throw new Error(`No saved Codex account named "${validName}".`);
    }

    await this.syncBack();

    await fsp.rm(AUTH_PATH, { force: true });
    await fsp.mkdir(CODEX_DIR, { recursive: true });
    await fsp.writeFile(AUTH_PATH, snapshot, { mode: 0o600 });

    const verify = await this.readLive();
    if (verify !== snapshot) {
      throw new Error(
        "Post-swap verification failed: auth.json does not match the snapshot (a running session may have rewritten it).",
      );
    }

    await this.store.setActive("codex", validName);
    return { provider: "codex", name: validName };
  }

  /**
   * Copy the live auth.json into every snapshot belonging to the same account,
   * so rotated refresh tokens are never stranded. Attribution reads the
   * identity out of the blob itself, so it stays correct even if a running
   * session clobbered auth.json with a different account.
   */
  public async syncBack(): Promise<void> {
    const live = await this.readLive();
    if (!live) return;
    const liveIdentity = codexIdentityOfBlob(live);
    if (!liveIdentity?.accountId) return;

    for (const name of await this.store.list("codex")) {
      const snapshot = await this.store.read("codex", name);
      if (!snapshot || snapshot === live) continue;
      if (sameAccount(codexIdentityOfBlob(snapshot), liveIdentity)) {
        await this.store.write("codex", name, live);
      }
    }
  }

  public async current(): Promise<AccountIdentity | null> {
    const live = await this.readLive();
    return live ? codexIdentityOfBlob(live) : null;
  }

  public async identityOf(name: string): Promise<AccountIdentity | null> {
    const snapshot = await this.store.read("codex", name);
    return snapshot ? codexIdentityOfBlob(snapshot) : null;
  }

  /** Raw live auth.json contents, or null. */
  public async readLiveBlob(): Promise<string | null> {
    return this.readLive();
  }

  private async readLive(): Promise<string | null> {
    try {
      return await fsp.readFile(AUTH_PATH, "utf8");
    } catch {
      return null;
    }
  }

  private runCodexLogin(codexHome: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("codex", ["login"], {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      child.on("error", (error) => {
        const err = error as NodeJS.ErrnoException;
        reject(
          err.code === "ENOENT"
            ? new Error("Could not find the `codex` CLI on your PATH.")
            : error,
        );
      });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`\`codex login\` exited with code ${code ?? "unknown"}.`));
      });
    });
  }
}

export const codexAuthProvider = new CodexAuthProvider();
