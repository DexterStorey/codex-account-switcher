import { BaseCommand } from "../lib/base-command";
import { codexAuthProvider } from "../lib/auth/codex";
import { doCurrent } from "../lib/cli/provider-commands";

export default class CurrentCommand extends BaseCommand {
  static description = "Show the currently active Codex account";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doCurrent(this, codexAuthProvider);
    });
  }
}
