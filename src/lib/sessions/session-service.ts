import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SESSION_FILE_PATTERN =
  /\/sessions\/.*rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/;

const USER_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "login"]);

export type SessionAttachment =
  | { kind: "tmux"; paneId: string }
  | { kind: "tty"; tty: string }
  | { kind: "managed"; parentCommand: string };

export interface CodexSession {
  pid: number;
  sessionId: string | null;
  attachment: SessionAttachment;
}

export class SessionService {
  public async discoverSessions(): Promise<CodexSession[]> {
    const pids = await this.listCodexPids();
    const tmuxPanes = await this.listTmuxPanes();

    const sessions: CodexSession[] = [];
    for (const pid of pids) {
      const [sessionId, tty, parentCommand] = await Promise.all([
        this.findSessionId(pid),
        this.ttyOf(pid),
        this.parentCommandOf(pid),
      ]);

      const parentBase =
        parentCommand?.split("/").pop()?.replace(/^-/, "") ?? "";

      let attachment: SessionAttachment;
      if (!USER_SHELLS.has(parentBase)) {
        attachment = { kind: "managed", parentCommand: parentCommand ?? "unknown" };
      } else if (tty && tmuxPanes.has(tty)) {
        attachment = { kind: "tmux", paneId: tmuxPanes.get(tty) as string };
      } else if (tty) {
        attachment = { kind: "tty", tty };
      } else {
        attachment = { kind: "managed", parentCommand: parentCommand ?? "unknown" };
      }

      sessions.push({ pid, sessionId, attachment });
    }

    return sessions;
  }

  public async killAndWait(pid: number, timeoutMs = 5000): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // already gone
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  public async resumeInTmuxPane(paneId: string, sessionId: string): Promise<void> {
    await execFileAsync("tmux", [
      "send-keys",
      "-t",
      paneId,
      `codex resume ${sessionId}`,
      "Enter",
    ]);
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async listCodexPids(): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-x", "codex"]);
      return stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }
  }

  private async findSessionId(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("lsof", ["-p", String(pid)], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const match = stdout.match(SESSION_FILE_PATTERN);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private async ttyOf(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "tty=", "-p", String(pid)]);
      const tty = stdout.trim();
      if (!tty || tty === "??" || tty === "-") return null;
      return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    } catch {
      return null;
    }
  }

  private async parentCommandOf(pid: number): Promise<string | null> {
    try {
      const { stdout: ppidOut } = await execFileAsync("ps", [
        "-o",
        "ppid=",
        "-p",
        String(pid),
      ]);
      const ppid = ppidOut.trim();
      if (!ppid) return null;
      const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", ppid]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async listTmuxPanes(): Promise<Map<string, string>> {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-panes",
        "-a",
        "-F",
        "#{pane_tty} #{pane_id}",
      ]);
      const panes = new Map<string, string>();
      for (const line of stdout.split("\n")) {
        const [tty, paneId] = line.trim().split(" ");
        if (tty && paneId) panes.set(tty, paneId);
      }
      return panes;
    } catch {
      return new Map(); // no tmux server running
    }
  }
}

export const sessionService = new SessionService();
