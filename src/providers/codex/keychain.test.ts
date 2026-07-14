import { describe, expect, test } from "bun:test";
import { createMacOsKeychainVault, type KeychainCommandRunner } from "./keychain.ts";

interface RecordedCall {
  command: readonly string[];
  stdinText: string | undefined;
}

// In-memory stand-in for the security tool covering the three subcommands the
// vault uses, including `security -i`'s 4096-byte interactive line buffer.
function fakeKeychain(): {
  runner: KeychainCommandRunner;
  calls: RecordedCall[];
  items: Map<string, string>;
} {
  const items = new Map<string, string>();
  const calls: RecordedCall[] = [];
  return {
    items,
    calls,
    runner: {
      async run(command, stdinText) {
        calls.push({ command, stdinText });
        if (command[0] !== "security") {
          throw new Error(`unexpected binary ${command[0]}`);
        }
        if (command[1] === "-i") {
          const line = (stdinText ?? "").trimEnd();
          if (`${line}\n`.length > 4096) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `security: unknown command "${line.slice(4095)}"`,
            };
          }
          const match = line.match(/^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)$/);
          if (match === null || match[2] === undefined || match[3] === undefined) {
            return { exitCode: 1, stdout: "", stderr: `security: unknown command "${line}"` };
          }
          items.set(match[2], match[3]);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const account = command[command.indexOf("-a") + 1];
        if (account === undefined) {
          return { exitCode: 1, stdout: "", stderr: "missing -a" };
        }
        if (command[1] === "find-generic-password") {
          const value = items.get(account);
          return value === undefined
            ? { exitCode: 44, stdout: "", stderr: "could not be found" }
            : { exitCode: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (command[1] === "delete-generic-password") {
          return items.delete(account)
            ? { exitCode: 0, stdout: "", stderr: "" }
            : { exitCode: 44, stdout: "", stderr: "could not be found" };
        }
        return { exitCode: 1, stdout: "", stderr: `unknown subcommand ${command[1]}` };
      },
    },
  };
}

const smallSecret = JSON.stringify({ tokens: { access_token: 'to"ken with spaces & symbols' } });
// Codex credentials carry three JWTs and run ~7-9KB; force the chunked path.
const largeSecret = JSON.stringify({
  tokens: {
    access_token: "x".repeat(4_000),
    id_token: "y".repeat(3_000),
    refresh: "z".repeat(2_000),
  },
});

describe("macOS keychain vault", () => {
  test("write never places the secret on argv and never opens a TTY prompt", async () => {
    const { runner, calls } = fakeKeychain();
    await createMacOsKeychainVault("com.rubriclabs.tokmax", runner).write("codex:abc", smallSecret);
    const writes = calls.filter((call) => call.command[1] === "-i");
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      // Interactive command mode: the entire add command arrives via stdin.
      expect(call.command).toEqual(["security", "-i"]);
      expect(call.command.join(" ")).not.toContain(smallSecret);
      expect(call.stdinText).not.toContain(smallSecret);
      // A bare trailing `-w` is what triggered the "password data for new
      // item:" terminal prompt; the payload must ride with -w inline.
      expect(call.stdinText).toMatch(/-w \S+\n$/);
    }
  });

  test("small secrets round-trip through a single item", async () => {
    const { runner, items } = fakeKeychain();
    const vault = createMacOsKeychainVault("com.rubriclabs.tokmax", runner);
    await vault.write("codex:abc", smallSecret);
    expect(items.size).toBe(1);
    await expect(vault.read("codex:abc")).resolves.toBe(smallSecret);
  });

  test("large secrets chunk under the 4096-byte interactive line buffer and round-trip", async () => {
    const { runner, calls, items } = fakeKeychain();
    const vault = createMacOsKeychainVault("com.rubriclabs.tokmax", runner);
    await vault.write("codex:abc", largeSecret);
    for (const call of calls.filter((entry) => entry.command[1] === "-i")) {
      expect((call.stdinText ?? "").length).toBeLessThanOrEqual(4096);
    }
    expect(items.size).toBeGreaterThan(2);
    await expect(vault.read("codex:abc")).resolves.toBe(largeSecret);
    // Shrinking the credential must not leave stale chunk items behind.
    await vault.write("codex:abc", smallSecret);
    expect(items.size).toBe(1);
    await expect(vault.read("codex:abc")).resolves.toBe(smallSecret);
    await vault.remove("codex:abc");
    expect(items.size).toBe(0);
    await expect(vault.read("codex:abc")).resolves.toBeNull();
  });

  test("keychain failures never echo credential material", async () => {
    const blob = Buffer.from(largeSecret, "utf8").toString("base64");
    const failing: KeychainCommandRunner = {
      async run() {
        return { exitCode: 1, stdout: "", stderr: `security: unknown command "${blob}"` };
      },
    };
    const vault = createMacOsKeychainVault("com.rubriclabs.tokmax", failing);
    const failure = await vault.write("codex:abc", largeSecret).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(blob.slice(0, 64));
    expect(message.length).toBeLessThanOrEqual(300);
  });

  test("read returns null for a missing item and surfaces corrupt payloads", async () => {
    const empty = fakeKeychain();
    await expect(
      createMacOsKeychainVault("com.rubriclabs.tokmax", empty.runner).read("codex:abc"),
    ).resolves.toBeNull();
    const corrupt = fakeKeychain();
    corrupt.items.set("codex:abc", "{not base64}");
    await expect(
      createMacOsKeychainVault("com.rubriclabs.tokmax", corrupt.runner).read("codex:abc"),
    ).rejects.toThrow("not base64-encoded");
  });

  test("rejects references that could smuggle extra security commands", async () => {
    const { runner } = fakeKeychain();
    const vault = createMacOsKeychainVault("com.rubriclabs.tokmax", runner);
    await expect(vault.write('codex:a" -s other', smallSecret)).rejects.toThrow(
      "contains characters outside",
    );
  });
});
