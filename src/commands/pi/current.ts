import { BaseCommand } from "../../lib/base-command";
import { piAuthProvider } from "../../lib/auth/pi";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class CurrentCommand extends BaseCommand {
  static description = "Show the currently active pi account";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doCurrent(this, piAuthProvider);
    });
  }
}
