import { launch } from "../proc/launch";
import { debug } from "../utils/logger";

export class TmuxService {
  async getSessionId(): Promise<string | null> {
    if (!process.env.TMUX_PANE) {
      debug(`TMUX_PANE not set, not in tmux session`);
      return null;
    }

    debug(`Getting tmux session ID, TMUX_PANE: ${process.env.TMUX_PANE}`);

    const result = await launch({
      bin: "tmux",
      args: ["display-message", "-p", "#S"],
      timeoutMs: 1000,
      category: "tmux",
    });

    if (!result.ok) {
      debug(`tmux display-message failed: ${result.reason}`);
      return null;
    }

    const sessionId = result.stdout.trim();
    debug(`Tmux session ID: ${sessionId || "empty"}`);
    return sessionId || null;
  }

  isInTmux(): boolean {
    return !!process.env.TMUX_PANE;
  }
}
