import { Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { PROVIDER_IDS, ProviderId } from "../lib/store/store";
import { rotator, providerRegistry } from "../lib/rotator/rotator";

export default class WatchCommand extends BaseCommand {
  static description =
    "Auto-rotator: poll usage on an interval, repair clobbered credentials, rotate accounts past the threshold";

  static flags = {
    interval: Flags.integer({ description: "Seconds between checks", default: 120 }),
    threshold: Flags.integer({ description: "5h-window percent that triggers rotation", default: 95 }),
    providers: Flags.string({
      description: "Comma-separated providers to watch",
      default: "codex,claude,pi",
    }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { flags } = await this.parse(WatchCommand);
      const requested = flags.providers
        .split(",")
        .map((p) => p.trim())
        .filter((p): p is ProviderId => (PROVIDER_IDS as string[]).includes(p));

      // A provider with one account has nothing to rotate to; say so once,
      // rather than silently skipping it on every cycle.
      const active: ProviderId[] = [];
      for (const provider of requested) {
        const names = await providerRegistry[provider].auth.list();
        if (names.length < 2) {
          this.log(
            `${provider}: ${names.length} saved account(s) — not watching (add another with \`codex-auth ${provider} add <name>\`).`,
          );
          continue;
        }
        active.push(provider);
      }

      if (!active.length) {
        this.log("Nothing to watch. Save at least two accounts for one provider.");
        return;
      }

      this.log(
        `Watching ${active.join(", ")} every ${flags.interval}s (rotate at ${flags.threshold}% of the 5h window). Ctrl-C to stop.`,
      );
      this.log("Note: rotating codex restarts your user-owned codex sessions (kill + resume).");

      process.on("SIGINT", () => {
        this.log("\nStopping watch.");
        process.exit(0);
      });

      for (;;) {
        for (const provider of active) {
          const stamp = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          const log = (m: string) => this.log(`${stamp} [${provider}] ${m}`);
          try {
            if (await rotator.reassert(provider, log)) {
              log("re-asserted the active account after a clobber.");
            }

            const decision = await rotator.rotate(provider, { threshold: flags.threshold, log });
            if (decision.rotated) {
              log(`ROTATED → ${decision.to} (${decision.reason})`);
            } else if (decision.shouldRotate) {
              log(`wants to rotate but cannot: ${decision.reason}`);
            } else {
              const pct = decision.activeFiveHour;
              log(
                `${decision.active ?? "?"} at ${pct === null ? "?" : `${pct.toFixed(0)}%`} of 5h window`,
              );
            }
          } catch (error) {
            log(`error: ${(error as Error).message}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, flags.interval * 1000));
      }
    });
  }
}
