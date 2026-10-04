import { runTmuxAsync } from "../proc/tmux";
import type { TmuxHint } from "../tmux-hint";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:single-enforcer] One module-level cache of tmux session-name lookups,
// keyed by the pane a session's CLIENT reported (src/tmux-hint.ts): its server
// socket and its pane id. The daemon is detached, so its own TMUX/TMUX_PANE
// answer for whichever shell spawned it and are never read here
// (brandon-tmux-tk7). A pane's session is asked once per (daemon, pane) rather
// than once per render.
//
// Value type: the resolved Outcome. `ok` is the session name; `absent` means
// tmux answered with an empty name; `failed` means the invocation itself
// failed. Both non-ok outcomes are durable for the daemon's lifetime —
// retrying every render would burn subprocesses without changing the answer —
// but the cached `failed` still flows to the payload boundary as a value, so
// the failure stays visible instead of being demoted to absence
// ([LAW:no-silent-failure]). A map miss (undefined) means not yet attempted —
// the next call will spawn.
const sessionNameCache = new Map<string, Outcome<string>>();

// A socket path cannot hold a newline's worth of pane id, so the pair is
// unambiguous.
const cacheKey = (hint: TmuxHint): string => `${hint.socket}\n${hint.pane}`;

// Exposed for tests only — resets the cache so each test starts cold.
export function __resetTmuxCacheForTest(): void {
  sessionNameCache.clear();
}

export class TmuxService {
  // [LAW:types-are-the-program] Takes the pane to ask about. "Not in tmux" is
  // the caller's fact (the hint is null), so there is no pane-less call to
  // answer.
  async getSessionId(hint: TmuxHint): Promise<Outcome<string>> {
    const key = cacheKey(hint);
    const cached = sessionNameCache.get(key);
    if (cached !== undefined) return cached;

    debug(`Getting tmux session name for pane ${hint.pane} on ${hint.socket}`);

    const run = await runTmuxAsync(hint, "tmux", [
      "display-message",
      "-p",
      "-t",
      hint.pane,
      "#S",
    ]);
    const name = run.kind === "ok" ? run.stdout.trim() : "";
    const outcome: Outcome<string> =
      run.kind !== "ok" ? failed(run.reason) : name ? ok(name) : ABSENT;
    sessionNameCache.set(key, outcome);
    return outcome;
  }
}
