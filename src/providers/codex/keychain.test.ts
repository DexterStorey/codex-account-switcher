import { describe, expect, test } from "bun:test";
import { createMacOsKeychainVault, type KeychainCommandRunner } from "./keychain.ts";

interface RecordedCall {
  command: readonly string[];
  stdinText: string | undefined;
}

function recordingRunner(
  respond: (
    command: readonly string[],
    stdinText: string | undefined,
  ) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  },
): { runner: KeychainCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: {
      async run(command, stdinText) {
        calls.push({ command, stdinText });
        return respond(command, stdinText);
      },
    },
  };
}

const secret = JSON.stringify({ tokens: { access_token: 'to"ken with spaces & symbols' } });

describe("macOS keychain vault", () => {
  test("write never places the secret on argv and never opens a TTY prompt", async () => {
    const { runner, calls } = recordingRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    await createMacOsKeychainVault("com.rubriclabs.tokmax", runner).write("codex:abc", secret);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("expected a recorded call");
    }
    // Interactive command mode: the entire add command arrives via stdin.
    expect(call.command).toEqual(["security", "-i"]);
    expect(call.command.join(" ")).not.toContain(secret);
    // A bare trailing `-w` is what triggered the "password data for new item:"
    // terminal prompt; the payload must ride with -w inside the stdin command.
    expect(call.stdinText).toContain(`-w ${Buffer.from(secret, "utf8").toString("base64")}`);
    expect(call.stdinText).not.toContain(secret);
  });

  test("read decodes the base64 payload written by write", async () => {
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    const { runner } = recordingRunner((command) => {
      expect(command).toEqual([
        "security",
        "find-generic-password",
        "-s",
        "com.rubriclabs.tokmax",
        "-a",
        "codex:abc",
        "-w",
      ]);
      return { exitCode: 0, stdout: `${encoded}\n`, stderr: "" };
    });
    const value = await createMacOsKeychainVault("com.rubriclabs.tokmax", runner).read("codex:abc");
    expect(value).toBe(secret);
  });

  test("read returns null for a missing item and surfaces corrupt payloads", async () => {
    const missing = recordingRunner(() => ({ exitCode: 44, stdout: "", stderr: "" }));
    await expect(
      createMacOsKeychainVault("com.rubriclabs.tokmax", missing.runner).read("codex:abc"),
    ).resolves.toBeNull();
    const corrupt = recordingRunner(() => ({ exitCode: 0, stdout: "{not base64}\n", stderr: "" }));
    await expect(
      createMacOsKeychainVault("com.rubriclabs.tokmax", corrupt.runner).read("codex:abc"),
    ).rejects.toThrow("not base64-encoded");
  });

  test("rejects references that could smuggle extra security commands", async () => {
    const { runner } = recordingRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const vault = createMacOsKeychainVault("com.rubriclabs.tokmax", runner);
    await expect(vault.write('codex:a" -s other', secret)).rejects.toThrow(
      "contains characters outside",
    );
  });
});
