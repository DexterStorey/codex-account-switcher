import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ProviderId = "codex" | "claude" | "pi";

export const PROVIDER_IDS: ProviderId[] = ["codex", "claude", "pi"];

export interface RotationLogEntry {
  at: string;
  provider: ProviderId;
  from: string | null;
  to: string;
  reason: string;
}

interface StoreState {
  active: Partial<Record<ProviderId, string>>;
  rotations: RotationLogEntry[];
}

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Snapshot storage for all providers.
 *
 *   ~/.codex-auth/<provider>/<name>.json        credential snapshot
 *   ~/.codex-auth/<provider>/<name>.usage.json  cached usage (limits layer)
 *   ~/.codex-auth/state.json                    active accounts + rotation log
 *
 * All writes are atomic (tmp + rename) with 0600 permissions.
 */
export class SnapshotStore {
  constructor(
    public readonly root: string = path.join(os.homedir(), ".codex-auth"),
  ) {}

  public providerDir(provider: ProviderId): string {
    return path.join(this.root, provider);
  }

  public snapshotPath(provider: ProviderId, name: string): string {
    return path.join(this.providerDir(provider), `${this.validName(name)}.json`);
  }

  public usageCachePath(provider: ProviderId, name: string): string {
    return path.join(this.providerDir(provider), `${this.validName(name)}.usage.json`);
  }

  public async list(provider: ProviderId): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.providerDir(provider));
      return entries
        .filter((f) => f.endsWith(".json") && !f.endsWith(".usage.json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch {
      return [];
    }
  }

  public async read(provider: ProviderId, name: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.snapshotPath(provider, name), "utf8");
    } catch {
      return null;
    }
  }

  public async write(provider: ProviderId, name: string, contents: string): Promise<void> {
    await this.atomicWrite(this.snapshotPath(provider, name), contents);
  }

  public async readUsageCache(provider: ProviderId, name: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.usageCachePath(provider, name), "utf8");
    } catch {
      return null;
    }
  }

  public async writeUsageCache(provider: ProviderId, name: string, contents: string): Promise<void> {
    await this.atomicWrite(this.usageCachePath(provider, name), contents);
  }

  public async getActive(provider: ProviderId): Promise<string | null> {
    const state = await this.readState();
    return state.active[provider] ?? null;
  }

  public async setActive(provider: ProviderId, name: string): Promise<void> {
    const state = await this.readState();
    state.active[provider] = this.validName(name);
    await this.writeState(state);
  }

  public async logRotation(entry: RotationLogEntry): Promise<void> {
    const state = await this.readState();
    state.rotations.push(entry);
    if (state.rotations.length > 200) {
      state.rotations = state.rotations.slice(-200);
    }
    await this.writeState(state);
  }

  /** One-time migration of legacy ~/.codex/accounts snapshots into the store. */
  public async migrateLegacyCodexAccounts(legacyDir: string): Promise<string[]> {
    const existing = await this.list("codex");
    if (existing.length) return [];

    let files: string[];
    try {
      files = (await fsp.readdir(legacyDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const migrated: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.json$/, "");
      if (!ACCOUNT_NAME_PATTERN.test(name)) continue;
      const contents = await fsp.readFile(path.join(legacyDir, file), "utf8");
      await this.write("codex", name, contents);
      migrated.push(name);
    }
    return migrated;
  }

  public validName(rawName: string): string {
    const name = rawName.trim().replace(/\.json$/i, "");
    if (!ACCOUNT_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid account name "${rawName}": use letters, numbers, dashes, underscores, dots.`,
      );
    }
    return name;
  }

  private async readState(): Promise<StoreState> {
    try {
      const raw = await fsp.readFile(path.join(this.root, "state.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      return { active: parsed.active ?? {}, rotations: parsed.rotations ?? [] };
    } catch {
      return { active: {}, rotations: [] };
    }
  }

  private async writeState(state: StoreState): Promise<void> {
    await this.atomicWrite(
      path.join(this.root, "state.json"),
      JSON.stringify(state, null, 2),
    );
  }

  private async atomicWrite(filePath: string, contents: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, contents, { mode: 0o600 });
    await fsp.rename(tmp, filePath);
  }
}

export const snapshotStore = new SnapshotStore();
