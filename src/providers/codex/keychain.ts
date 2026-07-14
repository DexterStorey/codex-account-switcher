import { ApplicationError } from "../../errors.ts";
import type { CredentialVault } from "./auth.ts";

const defaultService = "com.rubriclabs.codex-account-switcher";

async function collect(processHandle: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export function createMacOsKeychainVault(service = defaultService): CredentialVault {
  return {
    async read(reference) {
      const result = await collect(
        Bun.spawn(["security", "find-generic-password", "-s", service, "-a", reference, "-w"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      if (result.exitCode === 44) {
        return null;
      }
      if (result.exitCode !== 0) {
        throw new ApplicationError(
          "KEYCHAIN_READ_FAILED",
          result.stderr.trim() || "Keychain read failed",
        );
      }
      return result.stdout.trimEnd();
    },
    async write(reference, value) {
      const processHandle = Bun.spawn(
        ["security", "add-generic-password", "-U", "-s", service, "-a", reference, "-w"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      processHandle.stdin.write(`${value}\n`);
      processHandle.stdin.end();
      const result = await collect(processHandle);
      if (result.exitCode !== 0) {
        throw new ApplicationError(
          "KEYCHAIN_WRITE_FAILED",
          result.stderr.trim() || "Keychain write failed",
        );
      }
    },
    async remove(reference) {
      const result = await collect(
        Bun.spawn(["security", "delete-generic-password", "-s", service, "-a", reference], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      if (result.exitCode !== 0 && result.exitCode !== 44) {
        throw new ApplicationError(
          "KEYCHAIN_DELETE_FAILED",
          result.stderr.trim() || "Keychain delete failed",
        );
      }
    },
  };
}
