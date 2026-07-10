import { BaseCommand } from "../lib/base-command";
import { codexAuthProvider } from "../lib/auth/codex";
import { doList } from "../lib/cli/provider-commands";

export default class ListCommand extends BaseCommand {
  static description = "List saved Codex accounts";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doList(this, codexAuthProvider);
    });
  }
}
