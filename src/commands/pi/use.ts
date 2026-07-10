import { Args } from "@oclif/core";
import { BaseCommand } from "../../lib/base-command";
import { piAuthProvider } from "../../lib/auth/pi";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class UseCommand extends BaseCommand {
  static description = "Switch the live pi credentials to a saved account";

  static args = {
    account: Args.string({ name: "account", required: false, description: "Account to activate" }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args } = await this.parse(UseCommand);
      await doUse(this, piAuthProvider, args.account);
    });
  }
}
