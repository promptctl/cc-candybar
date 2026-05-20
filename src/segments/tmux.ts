import { launch } from "../proc/launch";
import { debug } from "../utils/logger";

// [LAW:single-enforcer] One module-level cache of tmux session IDs, keyed by
// the tmux *socket path* (the substring of `$TMUX` before the first comma —
// `$TMUX` is "<socket>,<client-pid>,<session-num>"). The session ID for a
// given socket doesn't change for the life of the daemon, so this collapses
// N per-render `tmux display-message` spawns to one per (daemon, socket).
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

// [LAW:one-source-of-truth] One place that extracts the socket-path prefix
// from `$TMUX`. Empty string means "tmux env not set" — the resolver returns
// early before reaching the cache, but we still tolerate the empty key in
// case a future caller invokes us without the early-return.
function tmuxCacheKey(raw: string | undefined): string {
  if (!raw) return "";
  const comma = raw.indexOf(",");
  return comma < 0 ? raw : raw.slice(0, comma);
}

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
