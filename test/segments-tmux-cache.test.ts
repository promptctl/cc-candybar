import {
  TmuxService,
  __resetTmuxCacheForTest,
} from "../src/segments/tmux";
import {
  setLaunchStats,
  __resetRateLimitsForTest,
} from "../src/proc/launch";
import type { LaunchCategory } from "../src/proc/launch";
import type { LaunchStatsHandle } from "../src/proc/stats-handle";

// [LAW:single-enforcer] One module-level cache means N TmuxService instances
// share state. These tests pin that behavior at the boundary.

function withEnv(
  env: Partial<NodeJS.ProcessEnv>,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      const v = env[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

function spyStats(): {
  starts: LaunchCategory[];
  handle: LaunchStatsHandle;
} {
  const starts: LaunchCategory[] = [];
  return {
    starts,
    handle: {
      onStart: (c) => starts.push(c),
      onEnd: () => {},
    },
  };
}

beforeEach(() => {
  __resetTmuxCacheForTest();
  __resetRateLimitsForTest();
});

afterEach(() => {
  setLaunchStats(null);
});

describe("TmuxService — cache", () => {
  it(
    "returns null without spawning when TMUX_PANE is unset",
    withEnv({ TMUX_PANE: undefined, TMUX: undefined }, async () => {
      const { handle, starts } = spyStats();
      setLaunchStats(handle);
      const svc = new TmuxService();
      const id = await svc.getSessionId();
      expect(id).toBeNull();
      expect(starts).toEqual([]);
    }),
  );

  it(
    "shells out at most once per ($TMUX) socket across calls",
    withEnv(
      { TMUX_PANE: "%0", TMUX: "/private/tmp/tmux-501/default,12345,0" },
      async () => {
        const { handle, starts } = spyStats();
        setLaunchStats(handle);
        const svc = new TmuxService();
        await svc.getSessionId();
        await svc.getSessionId();
        await svc.getSessionId();
        // Exactly one tmux spawn — subsequent calls hit the cache.
        const tmuxStarts = starts.filter((c) => c === "tmux");
        expect(tmuxStarts.length).toBeLessThanOrEqual(1);
      },
    ),
  );

  it(
    "different ($TMUX) sockets each get their own cache entry",
    // [LAW:single-enforcer] All keys mutated inside MUST appear in withEnv's
    // env argument so they get snapshot-and-restored. Otherwise a test
    // mutating process.env.TMUX leaks into later tests.
    withEnv(
      { TMUX_PANE: "%0", TMUX: "/private/tmp/tmux-501/socket-a,1,0" },
      async () => {
        const { handle, starts } = spyStats();
        setLaunchStats(handle);
        const svc = new TmuxService();

        await svc.getSessionId();
        const afterA = starts.filter((c) => c === "tmux").length;

        process.env.TMUX = "/private/tmp/tmux-501/socket-b,2,0";
        await svc.getSessionId();
        const afterB = starts.filter((c) => c === "tmux").length;

        // Switching sockets must trigger a fresh spawn — cache key changed.
        expect(afterB).toBeGreaterThan(afterA);
      },
    ),
  );

  it(
    "same socket with different client-pid suffix hits the same cache entry",
    withEnv(
      { TMUX_PANE: "%0", TMUX: "/private/tmp/tmux-501/default,111,0" },
      async () => {
        const { handle, starts } = spyStats();
        setLaunchStats(handle);
        const svc = new TmuxService();

        // $TMUX format is "<socket>,<client-pid>,<session-num>". Two clients
        // attached to the same tmux server have the same socket but different
        // pid/session suffixes. The cache key is the socket prefix only.
        await svc.getSessionId();
        const afterFirst = starts.filter((c) => c === "tmux").length;

        process.env.TMUX = "/private/tmp/tmux-501/default,222,1";
        await svc.getSessionId();
        const afterSecond = starts.filter((c) => c === "tmux").length;

        expect(afterSecond).toBe(afterFirst);
      },
    ),
  );

  it(
    "two TmuxService instances share the module-level cache",
    withEnv(
      { TMUX_PANE: "%0", TMUX: "/private/tmp/tmux-501/shared,7,0" },
      async () => {
        const { handle, starts } = spyStats();
        setLaunchStats(handle);
        const a = new TmuxService();
        const b = new TmuxService();
        await a.getSessionId();
        await b.getSessionId();
        const tmuxStarts = starts.filter((c) => c === "tmux");
        expect(tmuxStarts.length).toBeLessThanOrEqual(1);
      },
    ),
  );
});
