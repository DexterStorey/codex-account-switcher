import { BaseCommand } from "../../lib/base-command";
import { claudeAuthProvider } from "../../lib/auth/claude";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class CurrentCommand extends BaseCommand {
  static description = "Show the currently active Claude Code account";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doCurrent(this, claudeAuthProvider);
    });
  }
}
