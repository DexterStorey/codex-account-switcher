import { Args } from "@oclif/core";
import { BaseCommand } from "../../lib/base-command";
import { claudeAuthProvider } from "../../lib/auth/claude";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class UseCommand extends BaseCommand {
  static description = "Switch the live Claude Code credentials to a saved account";

  static args = {
    account: Args.string({ name: "account", required: false, description: "Account to activate" }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args } = await this.parse(UseCommand);
      await doUse(this, claudeAuthProvider, args.account);
    });
  }
}
