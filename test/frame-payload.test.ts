// brandon-unfiled-3248.8ro6, step 3: sources refresh on their own triggers,
// and a frame only reads. A statusline request refreshes what its arrival
// triggers (`settlePayload`) and draws from what that left; the view's payload
// (`payloadOf`), which every frame draws, reads every owner's stored value as
// it stands — no I/O, no refresh, no instant — and a value not answered yet
// crosses as PENDING, which the draw takes as its loading cell. What moves
// with the instant (`today`, the feeds) is the draw's own projection.
//
// [LAW:behavior-not-structure] Each owner is a fake over a counted reader
// (test/helpers/payload-owners.ts), so "refreshes nothing" is a count of the
// reads its source made, and "reads what the request stored" is the payload
// a frame draws beside the one the request drew.

import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import {
  payloadOf,
  renderWidth,
  settlePayload,
  todayOf,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { globalsFor } from "./helpers/selection";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf } from "../src/utils/instant";
import { ABSENT, PENDING, ok } from "../src/utils/outcome";
import type { ClientHints } from "../src/daemon/protocol";
import { sessionIdOf } from "../src/daemon/session-id";
import type { ClaudeHookData } from "../src/utils/claude";
import {
  absentOwners,
  declaredLanes,
  fakeActivity,
  fakeAutoCompact,
  fakeCacheExpiry,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
} from "./helpers/payload-owners";

const EFFECTIVE = globalsFor(DEFAULT_DSL_CONFIG);
const DRAW = {
  effective: EFFECTIVE,
  configFacts: NO_CONFIG_FILE,
  history: EMPTY_HISTORY_DEPTH,
  back: 0,
};
const PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };
const HINTS: ClientHints = { tmux: PANE };
const AT = instantOf(new Date(1_700_000_000_000));

const HOOK = {
  hook_event_name: "Status",
  session_id: "frame-payload",
  transcript_path: "/no/such/transcript.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
} as unknown as ClaudeHookData;

// One path per lane, so every lane is read.
const EVERY_LANE = new Set([
  "git.branch",
  "git.prNumber",
  "tmux.session",
  "session.cost",
  "today.cost",
  "speed.output",
  "context.totalTokens",
  "metrics.messageCount",
  "activity.running",
  "cache.expiresAt",
  "autocompact.window",
]);

const GIT = {
  branch: "main",
  status: "clean",
  aheadBehind: ok({ ahead: 0, behind: 0 }),
  head: ok("c0ffee"),
  sha: ok("abc1234"),
  stashCount: ok(0),
  upstream: ABSENT,
};

// Every lane over a counted reader; `pr` is the PR the git value carries.
function counted(pr?: unknown) {
  const reads: Record<string, number> = {};
  const logs: string[] = [];
  const count =
    <T>(lane: string, answer: T) =>
    (): T => {
      reads[lane] = (reads[lane] ?? 0) + 1;
      return answer;
    };
  const owners = {
    ...absentOwners(),
    gitProvider: fakeGit(
      count("git", ok(pr === undefined ? GIT : { ...GIT, pullRequest: pr })),
    ),
    tmuxService: fakeTmux(count("tmux", ok("work"))),
    usageStore: fakeUsage({
      usage: count("session", ok({ session: { cost: 2, tokens: 10 } })),
      today: count("today", ok({ cost: 5, tokens: 50 })),
      speed: count("speed", ABSENT),
    }),
    contextProvider: fakeContext(count("context", ABSENT)),
    metricsProvider: fakeMetrics(count("metrics", ABSENT)),
    activityProvider: fakeActivity(count("activity", ABSENT)),
    cacheExpiry: fakeCacheExpiry(count("cache", ok(1_700_003_600))),
    autoCompact: fakeAutoCompact(count("autocompact", ok(400_000))),
    log: (level: string, msg: string) => logs.push(`${level} ${msg}`),
  };
  // The lanes the session's view declared: every frame and the request read
  // the same handles, as the daemon's do.
  const deps = {
    ...owners,
    lanes: declaredLanes(
      owners,
      { sessionId: sessionIdOf(HOOK.session_id), hookData: HOOK, cwd: undefined, hints: HINTS },
      EVERY_LANE,
    ),
  } as unknown as RenderPayloadDeps;
  const inputs = (): PayloadInputs => ({
    hookData: HOOK,
    deps,
    cwd: undefined,
    neededInputPaths: EVERY_LANE,
    hints: HINTS,
  });
  // A request: its refresh and wait, then the view's payload it draws.
  const request = async () => {
    await settlePayload(inputs(), AT, new Map());
    return payloadOf(inputs(), DRAW);
  };
  // `today` as a draw at `at` projects it.
  const today = (at = AT) =>
    todayOf(deps, deps.lanes().today, HOOK, at);
  return { reads, inputs, request, today, deps, logs };
}

describe("a frame's payload", () => {
  test("reads what the request's refresh stored, and refreshes nothing", async () => {
    const { reads, inputs, request, today } = counted();
    const drawn = await request();
    today();
    const afterRequest = { ...reads };
    expect(Object.keys(afterRequest).sort()).toEqual(
      [
        "activity",
        "autocompact",
        "cache",
        "context",
        "git",
        "metrics",
        "session",
        "speed",
        "today",
        "tmux",
      ].sort(),
    );
    for (let frame = 0; frame < 5; frame++) {
      expect(payloadOf(inputs(), DRAW)).toEqual(drawn);
      expect(today()).toEqual({ cost: 5, tokens: 50 });
    }
    // `today`'s reader is the day a draw picks of the sums its lane holds
    // (`todayAt`, no I/O): every frame picks its own, since a frame may be
    // drawn after midnight. Every other lane was read by the request alone.
    expect(reads).toEqual({ ...afterRequest, today: afterRequest.today! + 5 });
  });

  test("draws every lane no request has answered as not answered yet", () => {
    const { inputs, today } = counted();
    const payload = payloadOf(inputs(), DRAW);
    expect(today()).toBe(PENDING);
    expect(payload.git).toBe(PENDING);
    expect(payload.tmux).toEqual({ pane: "%7", session: PENDING });
    for (const lane of [
      payload.session,
      payload.speed,
      payload.context,
      payload.metrics,
      payload.activity,
      payload.cache,
      payload.autocompact,
    ]) {
      expect(lane).toBe(PENDING);
    }
  });

  test("a lane whose read throws is that lane's failure; the rest of the frame draws", async () => {
    const { inputs, request, deps, logs } = counted();
    await request();
    deps.contextProvider.contextOf = () => {
      throw new Error("context bug");
    };
    const payload = payloadOf(inputs(), DRAW);
    expect(payload.context).toBeUndefined();
    expect(payload.git).toMatchObject({ branch: "main" });
    expect(payload.session).not.toBe(PENDING);
    // Logged by the frame's read, which no request's failures reach.
    expect(logs).toContainEqual(
      expect.stringMatching(/^error context read threw: Error: context bug/),
    );
  });

  test("a frame reading the context window and no autocompact draws no autocompact", () => {
    const { inputs } = counted();
    const contextOnly = {
      ...inputs(),
      neededInputPaths: new Set(["context.contextLeft"]),
    };
    const payload = payloadOf(contextOnly, DRAW);
    expect(payload.context).toBe(PENDING);
    expect(payload.autocompact).toBeUndefined();
  });

  test("autocompact's controls are not answered while the context window they are capped to is not", async () => {
    // The settings file is shared, the window is per session: another
    // session's frame has the one answered and not the other.
    const { inputs, request } = counted();
    await request();
    const other = { ...inputs(), hookData: { ...HOOK, session_id: "other" } };
    expect(payloadOf(other, DRAW).autocompact).toBe(PENDING);
    expect(payloadOf(inputs(), DRAW).autocompact).not.toBe(PENDING);
  });

  test("a PR not answered yet draws only the PR's fields as not answered", async () => {
    const pr = { kind: "pending", landed: new Promise<void>(() => {}) };
    const { inputs } = counted(pr);
    // The frame that first reads the repo queues its read; the next one draws
    // what it stored.
    payloadOf(inputs(), DRAW);
    await new Promise((resolve) => setImmediate(resolve));
    const { git } = payloadOf(inputs(), DRAW);
    expect(git).toMatchObject({ branch: "main", sha: "abc1234" });
    expect(git).toMatchObject({
      prNumber: PENDING,
      prState: PENDING,
      prUrl: PENDING,
      prError: PENDING,
      prEarlier: PENDING,
    });
  });

  test("carries no fact of the draw's instant, and the width it is drawn to", () => {
    // [LAW:no-ambient-temporal-coupling] `today` and the feeds move with the
    // clock, so they are each draw's projections (DRAW_PROJECTIONS), never a
    // stored value of the view's payload.
    const { inputs } = counted();
    const payload = payloadOf(inputs(), DRAW);
    expect(payload).not.toHaveProperty("today");
    expect(payload).not.toHaveProperty("feeds");
    expect(payload.term).toEqual({ cols: renderWidth(HINTS) });
  });

  test("a lane whose refresh threw is its failure on every frame, until a refresh runs clean", async () => {
    const { inputs, request, deps } = counted();
    const getContextInfo = deps.contextProvider.getContextInfo;
    deps.contextProvider.getContextInfo = () => {
      throw new Error("refresh bug");
    };
    await request();
    for (let frame = 0; frame < 2; frame++) {
      expect(payloadOf(inputs(), DRAW).context).toBeUndefined();
    }
    deps.contextProvider.getContextInfo = getContextInfo;
    await request();
    expect(deps.faults.of(HOOK.session_id, "context")).toBeUndefined();
  });

  // [LAW:no-silent-failure] A failed lane was logged by the refresh that
  // failed, its owner's; the payload derived from it, and each draw of it,
  // logs nothing again.
  test("a failed lane draws as missing, and its payload logs nothing of it", async () => {
    const { inputs, request, deps, logs } = counted();
    await request();
    deps.contextProvider.contextOf = () => ({
      kind: "failed",
      reason: "context: no window",
    });
    const before = logs.length;
    expect(payloadOf(inputs(), DRAW).context).toBeUndefined();
    expect(payloadOf(inputs(), DRAW).context).toBeUndefined();
    expect(logs.slice(before)).toEqual([]);
  });
});
