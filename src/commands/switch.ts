import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { codexAuthProvider } from "../lib/auth/codex";
import {
  CodexSession,
  sessionService,
} from "../lib/sessions/session-service";

export default class SwitchCommand extends BaseCommand {
  static description =
    "Switch accounts AND restart running Codex sessions on the new account (kill + `codex resume`)";

  static args = {
    account: Args.string({
      name: "account",
      required: true,
      description: "Account to activate",
    }),
  } as const;

  static flags = {
    "dry-run": Flags.boolean({
      description: "Show what would be killed and resumed without doing it",
      default: false,
    }),
    "include-managed": Flags.boolean({
      description:
        "Also kill Codex processes owned by other programs (orchestrators, the Codex desktop app). They cannot be auto-resumed; their manager must restart them.",
      default: false,
    }),
    pid: Flags.integer({
      description: "Only act on these Codex PIDs (repeatable)",
      multiple: true,
    }),
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args, flags } = await this.parse(SwitchCommand);
      const dryRun = flags["dry-run"];
      const includeManaged = flags["include-managed"];
      const pidFilter = flags.pid?.length ? new Set(flags.pid) : null;

      let sessions = await sessionService.discoverSessions();
      if (pidFilter) {
        sessions = sessions.filter((s) => pidFilter.has(s.pid));
      }

      const targets = sessions.filter(
        (s) => s.attachment.kind !== "managed" || includeManaged,
      );
      const skipped = sessions.filter(
        (s) => s.attachment.kind === "managed" && !includeManaged,
      );

      for (const session of skipped) {
        const parent =
          session.attachment.kind === "managed"
            ? session.attachment.parentCommand.split("/").pop()
            : "";
        this.log(
          `Leaving pid ${session.pid} alone (managed by ${parent}; use --include-managed to kill it too).`,
        );
      }

      if (dryRun) {
        this.log(`\n[dry-run] Would switch auth to "${args.account}".`);
        for (const session of targets) {
          this.log(`[dry-run] Would kill pid ${session.pid} → ${this.resumePlan(session)}`);
        }
        return;
      }

      // Kill first so no old-account session refreshes tokens into the
      // freshly written auth.json.
      for (const session of targets) {
        this.log(`Stopping Codex pid ${session.pid}...`);
        await sessionService.killAndWait(session.pid);
      }

      const activated = await codexAuthProvider.activate(args.account as string);
      this.log(`Switched Codex auth to "${activated.name}".`);

      const manualResumes: CodexSession[] = [];
      for (const session of targets) {
        if (!session.sessionId) {
          this.log(
            `Pid ${session.pid} had no resolvable session file; nothing to resume.`,
          );
          continue;
        }
        if (session.attachment.kind === "tmux") {
          await sessionService.resumeInTmuxPane(
            session.attachment.paneId,
            session.sessionId,
          );
          this.log(
            `Resumed session ${session.sessionId} in tmux pane ${session.attachment.paneId}.`,
          );
        } else {
          manualResumes.push(session);
        }
      }

      if (manualResumes.length) {
        this.log("\nResume these yourself (in the terminal where each was running):");
        for (const session of manualResumes) {
          this.log(`  codex resume ${session.sessionId}`);
        }
      }
    });
  }

  private resumePlan(session: CodexSession): string {
    if (!session.sessionId) return "no session file found, nothing to resume";
    if (session.attachment.kind === "tmux") {
      return `auto-resume ${session.sessionId} in tmux pane ${session.attachment.paneId}`;
    }
    return `print \`codex resume ${session.sessionId}\` for manual resume`;
  }
}
