import { CodexSession, sessionService } from "./session-service";

export interface ContinuityReport {
  restarted: CodexSession[];
  manualResumes: CodexSession[];
  skippedManaged: CodexSession[];
}

/**
 * Continuity strategy per provider, applied AFTER credentials are swapped...
 * except codex, where user-owned sessions must be killed BEFORE the swap so
 * a dying session's token refresh can't clobber the new auth.json.
 *
 * - codex: kill user-owned sessions, then (post-swap) resume each in place.
 * - claude: nothing — running sessions keep their in-memory token and new
 *   requests work across the swap.
 * - pi: nothing — its dispatcher cannot resume killed children (job would be
 *   marked failed and the work lost), so running jobs finish on the old
 *   account and new dispatches pick up the new one.
 */
export class CodexContinuity {
  private pending: CodexSession[] = [];
  private skipped: CodexSession[] = [];

  /** Phase 1 (pre-swap): stop user-owned sessions. */
  public async stopUserSessions(log: (message: string) => void): Promise<void> {
    const sessions = await sessionService.discoverSessions();
    this.pending = sessions.filter((s) => s.attachment.kind !== "managed");
    this.skipped = sessions.filter((s) => s.attachment.kind === "managed");

    for (const session of this.skipped) {
      const parent =
        session.attachment.kind === "managed"
          ? session.attachment.parentCommand.split("/").pop()
          : "";
      log(`Leaving codex pid ${session.pid} alone (managed by ${parent}).`);
    }
    for (const session of this.pending) {
      log(`Stopping codex pid ${session.pid}...`);
      await sessionService.killAndWait(session.pid);
    }
  }

  /** Phase 2 (post-swap): resume what we stopped. */
  public async resumeSessions(log: (message: string) => void): Promise<ContinuityReport> {
    const restarted: CodexSession[] = [];
    const manualResumes: CodexSession[] = [];

    for (const session of this.pending) {
      if (!session.sessionId) {
        log(`Pid ${session.pid} had no resolvable session; nothing to resume.`);
        continue;
      }
      if (session.attachment.kind === "tmux") {
        await sessionService.resumeInTmuxPane(session.attachment.paneId, session.sessionId);
        log(`Resumed ${session.sessionId} in tmux pane ${session.attachment.paneId}.`);
        restarted.push(session);
      } else {
        manualResumes.push(session);
      }
    }

    if (manualResumes.length) {
      log("Resume these yourself (in the terminal where each was running):");
      for (const session of manualResumes) {
        log(`  codex resume ${session.sessionId}`);
      }
    }

    return { restarted, manualResumes, skippedManaged: this.skipped };
  }
}
