import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SnapshotStore, snapshotStore } from "../store/store";
import { AccountIdentity, AccountRef, AuthProvider, sameAccount } from "./types";

const PI_AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

interface PiAuthJson {
  "openai-codex"?: { accountId?: string; access?: string; refresh?: string };
  anthropic?: { access?: string; refresh?: string };
  [key: string]: unknown;
}

/**
 * pi (@earendil-works/pi-coding-agent) keeps its own OAuth store at
 * ~/.pi/agent/auth.json with `openai-codex` and `anthropic` entries. Both
 * entries move together as one snapshot: sharing a rotating refresh token
 * with another CLI would strand one of the two, so pi accounts are whole-file
 * snapshots created by logging in inside pi itself.
 *
 * pi's dispatcher has no retry/resume for its codex children — the sessions
 * layer must never kill them. Swaps only affect newly dispatched work.
 */
export class PiAuthProvider implements AuthProvider {
  public readonly id = "pi" as const;
  public readonly displayName = "pi";

  constructor(private readonly store: SnapshotStore = snapshotStore) {}

  public async list(): Promise<string[]> {
    return this.store.list("pi");
  }

  public async save(name: string): Promise<AccountRef> {
    const live = await this.readLive();
    if (!live) {
      throw new Error(`No pi auth at ${PI_AUTH_PATH}. Log into pi first.`);
    }
    await this.store.write("pi", name, live);
    return { provider: "pi", name: this.store.validName(name) };
  }

  public async add(name: string): Promise<AccountRef> {
    throw new Error(
      `pi has no isolated login flow. Instead: run \`pi\`, use its /login to sign into the other account, then \`codex-auth pi save ${name}\` — and switch back with \`codex-auth pi use <previous>\`.`,
    );
  }

  public async activate(name: string): Promise<AccountRef> {
    const validName = this.store.validName(name);
    const snapshot = await this.store.read("pi", validName);
    if (!snapshot) {
      throw new Error(`No saved pi account named "${validName}".`);
    }

    await this.syncBack();

    const dir = path.dirname(PI_AUTH_PATH);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.auth.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, PI_AUTH_PATH);

    const verify = await this.readLive();
    if (verify !== snapshot) {
      throw new Error(
        "Post-swap verification failed: pi auth.json does not match the snapshot.",
      );
    }

    await this.store.setActive("pi", validName);
    return { provider: "pi", name: validName };
  }

  /** Attribute the live file by its openai-codex accountId and re-snapshot. */
  public async syncBack(): Promise<void> {
    const live = await this.readLive();
    if (!live) return;
    const liveId = this.identityOfBlob(live)?.accountId;
    if (!liveId) return;

    for (const name of await this.store.list("pi")) {
      const snapshot = await this.store.read("pi", name);
      if (!snapshot || snapshot === live) continue;
      if (sameAccount(this.identityOfBlob(snapshot), this.identityOfBlob(live))) {
        await this.store.write("pi", name, live);
      }
    }
  }

  public async current(): Promise<AccountIdentity | null> {
    const live = await this.readLive();
    return live ? this.identityOfBlob(live) : null;
  }

  public async identityOf(name: string): Promise<AccountIdentity | null> {
    const snapshot = await this.store.read("pi", name);
    return snapshot ? this.identityOfBlob(snapshot) : null;
  }

  /** Entry tokens for the limits layer. */
  public async entriesOf(
    name: string,
  ): Promise<{ codex: { access: string; accountId: string } | null; anthropic: { access: string } | null }> {
    const snapshot = await this.store.read("pi", name);
    if (!snapshot) return { codex: null, anthropic: null };
    try {
      const parsed = JSON.parse(snapshot) as PiAuthJson;
      const codexEntry = parsed["openai-codex"];
      return {
        codex:
          codexEntry?.access && codexEntry.accountId
            ? { access: codexEntry.access, accountId: codexEntry.accountId }
            : null,
        anthropic: parsed.anthropic?.access ? { access: parsed.anthropic.access } : null,
      };
    } catch {
      return { codex: null, anthropic: null };
    }
  }

  private identityOfBlob(raw: string): AccountIdentity | null {
    try {
      const parsed = JSON.parse(raw) as PiAuthJson;
      return { accountId: parsed["openai-codex"]?.accountId ?? null, email: null };
    } catch {
      return null;
    }
  }

  private async readLive(): Promise<string | null> {
    try {
      return await fsp.readFile(PI_AUTH_PATH, "utf8");
    } catch {
      return null;
    }
  }
}

export const piAuthProvider = new PiAuthProvider();
