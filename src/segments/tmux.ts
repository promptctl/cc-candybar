import { launch } from "../proc/launch";
import { debug } from "../utils/logger";

// [LAW:single-enforcer] One module-level cache of tmux session IDs, keyed by
// the daemon-process `$TMUX` socket path. The tmux session ID for a given
// socket doesn't change for the life of the daemon, so this collapses N
// per-render `tmux display-message` spawns to one per (daemon, socket).
//
// [LAW:dataflow-not-control-flow] The lookup always runs the same path: read
// the env key, look up the cached value, spawn-and-record on miss, return.
// Variability lives in the cached values (string | null = "definitively no
// session"), not in whether the spawn happens.
//
// Value type: `string` (resolved session id), `null` (resolution attempted
// and reported no session — definitively no answer, do not retry), or
// `undefined` (not yet attempted — the next call will spawn).
const sessionIdCache = new Map<string, string | null>();

// Exposed for tests only — resets the cache so each test starts cold.
export function __resetTmuxCacheForTest(): void {
  sessionIdCache.clear();
}

export class TmuxService {
  async getSessionId(): Promise<string | null> {
    if (!process.env.TMUX_PANE) {
      debug(`TMUX_PANE not set, not in tmux session`);
      return null;
    }

    const cacheKey = process.env.TMUX ?? "";
    const cached = sessionIdCache.get(cacheKey);
    if (cached !== undefined) return cached;

    debug(`Getting tmux session ID, TMUX_PANE: ${process.env.TMUX_PANE}`);

    const result = await launch({
      bin: "tmux",
      args: ["display-message", "-p", "#S"],
      timeoutMs: 1000,
      category: "tmux",
    });

    if (!result.ok) {
      debug(`tmux display-message failed: ${result.reason}`);
      // [LAW:dataflow-not-control-flow] Cache the failure as null. A failed
      // tmux invocation in a session that has $TMUX_PANE set is a real
      // misconfiguration; retrying every render won't fix it and just burns
      // subprocesses. The daemon restarts on RSS/age limits and re-tries cold.
      sessionIdCache.set(cacheKey, null);
      return null;
    }

    const sessionId = result.stdout.trim() || null;
    sessionIdCache.set(cacheKey, sessionId);
    debug(`Tmux session ID: ${sessionId ?? "empty"}`);
    return sessionId;
  }

  isInTmux(): boolean {
    return !!process.env.TMUX_PANE;
  }
}
