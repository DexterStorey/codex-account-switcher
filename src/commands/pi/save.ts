import { Args } from "@oclif/core";
import { BaseCommand } from "../../lib/base-command";
import { piAuthProvider } from "../../lib/auth/pi";
import { doSave, doAdd, doUse, doList, doCurrent } from "../../lib/cli/provider-commands";

export default class SaveCommand extends BaseCommand {
  static description = "Save the current pi credentials as a named account";

  static args = {
    name: Args.string({ name: "name", required: true, description: "Name for the account snapshot" }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args } = await this.parse(SaveCommand);
      await doSave(this, piAuthProvider, args.name as string);
    });
  }
}
