import { Args } from "@oclif/core";
import { BaseCommand } from "../../lib/base-command";
import { claudeAuthProvider } from "../../lib/auth/claude";
import { doAdd } from "../../lib/cli/provider-commands";

export default class AddCommand extends BaseCommand {
  static description =
    "Log into another Claude Code account and save it (snapshots current, logs in, restores current)";

  static args = {
    name: Args.string({ name: "name", required: true, description: "Name for the new account" }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args } = await this.parse(AddCommand);
      await doAdd(this, claudeAuthProvider, args.name as string);
    });
  }
}
