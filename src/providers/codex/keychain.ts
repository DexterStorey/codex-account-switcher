import { ApplicationError } from "../../errors.ts";
import type { CredentialVault } from "./auth.ts";

const defaultService = "com.rubriclabs.tokmax";

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const identifierPattern = /^[\w.@:-]+$/;

export interface KeychainCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface KeychainCommandRunner {
  run(command: readonly string[], stdinText?: string): Promise<KeychainCommandResult>;
}

function defaultKeychainCommandRunner(): KeychainCommandRunner {
  return {
    async run(command, stdinText) {
      const processHandle = Bun.spawn([...command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (stdinText !== undefined) {
        processHandle.stdin.write(stdinText);
      }
      processHandle.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

function requireSafeIdentifier(kind: string, value: string): string {
  if (!identifierPattern.test(value)) {
    throw new ApplicationError(
      "KEYCHAIN_IDENTIFIER_INVALID",
      `Keychain ${kind} contains characters outside [A-Za-z0-9_.@:-]`,
    );
  }
  return value;
}

export function createMacOsKeychainVault(
  service = defaultService,
  runner: KeychainCommandRunner = defaultKeychainCommandRunner(),
): CredentialVault {
  requireSafeIdentifier("service", service);
  return {
    async read(reference) {
      requireSafeIdentifier("reference", reference);
      const result = await runner.run([
        "security",
        "find-generic-password",
        "-s",
        service,
        "-a",
        reference,
        "-w",
      ]);
      if (result.exitCode === 44) {
        return null;
      }
      if (result.exitCode !== 0) {
        throw new ApplicationError(
          "KEYCHAIN_READ_FAILED",
          result.stderr.trim() || "Keychain read failed",
        );
      }
      const stored = result.stdout.trim();
      if (!base64Pattern.test(stored)) {
        throw new ApplicationError(
          "KEYCHAIN_ITEM_CORRUPT",
          `Keychain item ${reference} is not base64-encoded; refusing to guess its contents`,
        );
      }
      return Buffer.from(stored, "base64").toString("utf8");
    },
    async write(reference, value) {
      requireSafeIdentifier("reference", reference);
      // `security add-generic-password -w` with no value prompts on the controlling
      // terminal, and passing the secret as an argument would expose it in argv.
      // Interactive command mode reads the whole command from stdin instead; the
      // base64 payload keeps it inside `security`'s unquoted token grammar.
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const command = `add-generic-password -U -s ${service} -a ${reference} -w ${encoded}\n`;
      const result = await runner.run(["security", "-i"], command);
      if (result.exitCode !== 0) {
        throw new ApplicationError(
          "KEYCHAIN_WRITE_FAILED",
          result.stderr.trim() || "Keychain write failed",
        );
      }
    },
    async remove(reference) {
      requireSafeIdentifier("reference", reference);
      const result = await runner.run([
        "security",
        "delete-generic-password",
        "-s",
        service,
        "-a",
        reference,
      ]);
      if (result.exitCode !== 0 && result.exitCode !== 44) {
        throw new ApplicationError(
          "KEYCHAIN_DELETE_FAILED",
          result.stderr.trim() || "Keychain delete failed",
        );
      }
    },
  };
}
