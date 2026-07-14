import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock } from "./daemon-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("daemon lock", () => {
  test("admits exactly one refresh owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-lock-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manager.lock");
    const first = await acquireDaemonLock(path);
    await expect(acquireDaemonLock(path)).rejects.toThrow("already owned");
    await first.release();
    const second = await acquireDaemonLock(path);
    await second.release();
  });

  test("never reclaims a lock whose owner metadata is still being written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-lock-startup-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manager.lock");
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
    await expect(acquireDaemonLock(path)).rejects.toThrow("incomplete metadata");
    await expect(Bun.file(path).exists()).resolves.toBe(true);
  });
});
