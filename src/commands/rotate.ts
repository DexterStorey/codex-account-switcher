import { Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { PROVIDER_IDS, ProviderId } from "../lib/store/store";
import { rotator, providerRegistry } from "../lib/rotator/rotator";

export default class RotateCommand extends BaseCommand {
  static description =
    "Rotate any provider whose active account is above the 5h-window threshold to its least-used saved account";

  static flags = {
    provider: Flags.string({
      description: "Providers to consider (default: all with 2+ saved accounts)",
      multiple: true,
      options: [...PROVIDER_IDS],
    }),
    threshold: Flags.integer({ description: "5h-window percent that triggers rotation", default: 95 }),
    "dry-run": Flags.boolean({ description: "Decide but do not switch", default: false }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { flags } = await this.parse(RotateCommand);
      const providers = (flags.provider as ProviderId[] | undefined) ?? PROVIDER_IDS;

      for (const provider of providers) {
        const stack = providerRegistry[provider];
        const names = await stack.auth.list();
        if (names.length < 2 && !flags.provider) continue; // skip silently unless explicitly asked

        const decision = await rotator.rotate(provider, {
          threshold: flags.threshold,
          dryRun: flags["dry-run"],
          log: (m) => this.log(`[${provider}] ${m}`),
        });
        this.log(`[${provider}] ${decision.reason}`);
      }
    });
  }
}
