import { launch } from "../proc/launch";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:single-enforcer] One module-level cache of tmux session lookups, keyed
// by the tmux *socket path* (the substring of `$TMUX` before the first comma —
// `$TMUX` is "<socket>,<client-pid>,<session-num>"). The session ID for a
// given socket doesn't change for the life of the daemon, so this collapses
// N per-render `tmux display-message` spawns to one per (daemon, socket).
//
// [LAW:dataflow-not-control-flow] The lookup always runs the same path: read
// the env key, look up the cached value, spawn-and-record on miss, return.
// Variability lives in the cached values, not in whether the spawn happens.
//
// Value type: the resolved Outcome. `ok` is the session id; `absent` means
// the previous resolution reported an empty session id (definitively no
// session); `failed` means the spawn itself failed. Both non-ok outcomes are
// durable for the daemon's lifetime — retrying every render would burn
// subprocesses without changing the answer — but the cached `failed` still
// flows to the payload boundary as a value, so the failure stays visible
// instead of being demoted to absence ([LAW:no-silent-failure]). A map miss
// (undefined) means not yet attempted — the next call will spawn.
const sessionIdCache = new Map<string, Outcome<string>>();

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

    // A failed tmux invocation in a session that has $TMUX_PANE set is a real
    // misconfiguration; cache it so renders don't re-spawn, and let the
    // outcome carry the reason to the payload boundary's log site.
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
