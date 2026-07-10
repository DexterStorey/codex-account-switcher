import { BaseCommand } from "../../lib/base-command";
import { claudeAuthProvider } from "../../lib/auth/claude";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class ListCommand extends BaseCommand {
  static description = "List saved Claude Code accounts";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doList(this, claudeAuthProvider);
    });
  }
}
