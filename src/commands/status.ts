import { Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { PROVIDER_IDS, snapshotStore } from "../lib/store/store";
import { providerRegistry } from "../lib/rotator/rotator";
import { Usage, effectiveUsedPercent } from "../lib/limits/types";

export default class StatusCommand extends BaseCommand {
  static description = "Show usage for every saved account across all providers";

  static flags = {
    json: Flags.boolean({ description: "Machine-readable output", default: false }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { flags } = await this.parse(StatusCommand);
      const report: Usage[] = [];

      for (const providerId of PROVIDER_IDS) {
        const stack = providerRegistry[providerId];
        const names = await stack.auth.list();
        if (!names.length) continue;

        const active = await snapshotStore.getActive(providerId);
        if (!flags.json) this.log(`\n${stack.auth.displayName}`);

        const usages = await Promise.all(names.map((name) => stack.limits.read(name)));
        for (const usage of usages) {
          report.push(usage);
          if (flags.json) continue;
          this.log(this.renderLine(usage, usage.account === active));
        }
      }

      if (flags.json) {
        this.log(JSON.stringify(report, null, 2));
      } else if (!report.length) {
        this.log("No saved accounts in any provider yet.");
      }
    });
  }

  private renderLine(usage: Usage, isActive: boolean): string {
    const mark = isActive ? "*" : " ";
    const email = usage.identity.email ?? "unknown-identity";
    const plan = usage.identity.plan ? ` [${usage.identity.plan}]` : "";
    const windows = usage.windows.length
      ? usage.windows
          .map((w) => {
            const effective = effectiveUsedPercent(w);
            const resets = w.resetsAt
              ? ` resets ${new Date(w.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "";
            return `${w.kind} ${effective.toFixed(0)}%${resets}`;
          })
          .join("  ")
      : `unreadable (${usage.error ?? "no data"})`;
    const staleness = usage.stale ? "  [stale cache]" : "";
    return ` ${mark} ${usage.account.padEnd(16)} ${email.padEnd(28)}${plan}  ${windows}${staleness}`;
  }
}
