import { launch } from "../proc/launch";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:single-enforcer] One cache of tmux session lookups, keyed by socket path;
// the session id is stable for the daemon's life. A cached non-ok outcome is
// durable too, and `failed` still reaches the payload boundary as a value rather
// than being demoted to absence [LAW:no-silent-failure].
const sessionIdCache = new Map<string, Outcome<string>>();

// [LAW:one-source-of-truth] `$TMUX` is "<socket>,<client-pid>,<session-num>".
function tmuxCacheKey(raw: string | undefined): string {
  if (!raw) return "";
  const comma = raw.indexOf(",");
  return comma < 0 ? raw : raw.slice(0, comma);
}

export function __resetTmuxCacheForTest(): void {
  sessionIdCache.clear();
}

export class TmuxService {
  async getSessionId(): Promise<Outcome<string>> {
    if (!process.env.TMUX_PANE) {
      return ABSENT;
    }

    const cacheKey = tmuxCacheKey(process.env.TMUX);
    const cached = sessionIdCache.get(cacheKey);
    if (cached !== undefined) return cached;

    debug(`Getting tmux session ID, TMUX_PANE: ${process.env.TMUX_PANE}`);

    const result = await launch({
      bin: "tmux",
      args: ["display-message", "-p", "#S"],
      timeoutMs: 1000,
      category: "tmux",
    });

    const outcome: Outcome<string> = !result.ok
      ? failed(`tmux display-message: ${result.reason}`)
      : result.stdout.trim()
        ? ok(result.stdout.trim())
        : ABSENT;
    sessionIdCache.set(cacheKey, outcome);
    return outcome;
  }

  isInTmux(): boolean {
    return !!process.env.TMUX_PANE;
  }
}
