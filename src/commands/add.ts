import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Args } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { CodexAuthError } from "../lib/accounts";

export default class AddCommand extends BaseCommand {
  static description =
    "Log into another Codex account and save it, without touching the active ~/.codex/auth.json";

  static args = {
    name: Args.string({
      name: "name",
      required: true,
      description: "Name for the new account",
    }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args } = await this.parse(AddCommand);

      const isolatedHome = await fsp.mkdtemp(
        path.join(os.tmpdir(), "codex-auth-add-"),
      );

      try {
        this.log(
          "Starting `codex login` in an isolated CODEX_HOME — your current session stays active.",
        );
        await this.runCodexLogin(isolatedHome);

        const savedName = await this.accounts.importAccount(
          args.name as string,
          path.join(isolatedHome, "auth.json"),
        );
        this.log(
          `Saved new Codex auth tokens as "${savedName}". ` +
            `Switch with \`codex-auth use ${savedName}\` whenever you're ready.`,
        );
      } finally {
        await fsp.rm(isolatedHome, { recursive: true, force: true });
      }
    });
  }

  private runCodexLogin(codexHome: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("codex", ["login"], {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: codexHome },
      });

      child.on("error", (error) => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          reject(
            new CodexAuthError(
              "Could not find the `codex` CLI on your PATH. Install it first.",
            ),
          );
          return;
        }
        reject(error);
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new CodexAuthError(
              `\`codex login\` exited with code ${code ?? "unknown"}. No account was saved.`,
            ),
          );
        }
      });
    });
  }
}
