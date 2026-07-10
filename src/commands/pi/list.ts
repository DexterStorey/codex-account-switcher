import { BaseCommand } from "../../lib/base-command";
import { piAuthProvider } from "../../lib/auth/pi";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class ListCommand extends BaseCommand {
  static description = "List saved pi accounts";

  async run(): Promise<void> {
    await this.runSafe(async () => {
      await doList(this, piAuthProvider);
    });
  }
}
