// brandon-unfiled-3248.8ro6, step 3: sources refresh on their own triggers,
// and a frame only reads. A statusline request refreshes what its arrival
// triggers and draws from what that left; a feed's frame (`payloadOf`) reads
// every owner's stored value as it stands — no I/O, no refresh — and a value
// not answered yet crosses as PENDING, which the draw takes as its loading
// cell.
//
// [LAW:behavior-not-structure] Each owner is a fake over a counted reader
// (test/helpers/payload-owners.ts), so "refreshes nothing" is a count of the
// reads its source made, and "reads what the request stored" is the payload
// a frame draws beside the one the request drew.

import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import {
  buildRenderPayload,
  payloadOf,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { globalsFor } from "./helpers/selection";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf, type Instant } from "../src/utils/instant";
import { ABSENT, PENDING, ok } from "../src/utils/outcome";
import type { ClientHints } from "../src/daemon/protocol";
import type { ClaudeHookData } from "../src/utils/claude";
import {
  absentOwners,
  declaredLanes,
  fakeActivity,
  fakeAutoCompact,
  fakeCacheExpiry,
  fakeContext,
  fakeGit,
  fakeMemento,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
} from "./helpers/payload-owners";

const EFFECTIVE = globalsFor(DEFAULT_DSL_CONFIG);
const DRAW = { effective: EFFECTIVE, configFacts: NO_CONFIG_FILE };
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
  "memento.ceiling",
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
  const feedsAt: Instant[] = [];
  const owners = {
    ...absentOwners(),
    gitProvider: fakeGit(
      count("git", ok(pr === undefined ? GIT : { ...GIT, pullRequest: pr })),
    ),
    tmuxService: fakeTmux(count("tmux", ok("work"))),
    mementoProvider: fakeMemento(
      count("memento", ok({ ceiling: 350_000, session: null })),
    ),
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
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
    feeds: (_sessionId: string, at: Instant) => {
      feedsAt.push(at);
      return UNFOLLOWED_FEEDS;
    },
  };
  // The lanes the session's view declared: every frame and the request read
  // the same handles, as the daemon's do.
  const deps = {
    ...owners,
    lanes: declaredLanes(
      owners,
      { hookData: HOOK, cwd: undefined, hints: HINTS },
      EVERY_LANE,
    ),
  } as unknown as RenderPayloadDeps;
  const inputs = (at: Instant): PayloadInputs => ({
    hookData: HOOK,
    at,
    deps,
    cwd: undefined,
    neededInputPaths: EVERY_LANE,
    hints: HINTS,
  });
  const request = () =>
    buildRenderPayload(
      HOOK,
      AT,
      deps,
      undefined,
      EVERY_LANE,
      EFFECTIVE,
      HINTS,
      NO_CONFIG_FILE,
    );
  return { reads, feedsAt, inputs, request, deps, logs };
}

describe("a frame's payload", () => {
  test("reads what the request's refresh stored, and refreshes nothing", async () => {
    const { reads, inputs, request } = counted();
    const drawn = await request();
    const afterRequest = { ...reads };
    expect(Object.keys(afterRequest).sort()).toEqual(
      [
        "activity",
        "autocompact",
        "cache",
        "context",
        "git",
        "memento",
        "metrics",
        "session",
        "speed",
        "today",
        "tmux",
      ].sort(),
    );
    for (let frame = 0; frame < 5; frame++) {
      expect(payloadOf(inputs(AT), DRAW)).toEqual(drawn);
    }
    // `today`'s reader is the day a draw picks of the sums its lane holds
    // (`todayAt`, no I/O): every frame picks its own, since a frame may be
    // drawn after midnight. Every other lane was read by the request alone.
    expect(reads).toEqual({ ...afterRequest, today: afterRequest.today! + 5 });
  });

  test("draws every lane no request has answered as not answered yet", () => {
    const { inputs } = counted();
    const payload = payloadOf(inputs(AT), DRAW);
    expect(payload.git).toBe(PENDING);
    expect(payload.tmux).toEqual({ pane: "%7", session: PENDING });
    expect(payload.memento).toBe(PENDING);
    for (const lane of [
      payload.session,
      payload.today,
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
    const payload = payloadOf(inputs(AT), DRAW);
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
      ...inputs(AT),
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
    const other = { ...inputs(AT), hookData: { ...HOOK, session_id: "other" } };
    expect(payloadOf(other, DRAW).autocompact).toBe(PENDING);
    expect(payloadOf(inputs(AT), DRAW).autocompact).not.toBe(PENDING);
  });

  test("a PR not answered yet draws only the PR's fields as not answered", async () => {
    const pr = { kind: "pending", landed: new Promise<void>(() => {}) };
    const { inputs } = counted(pr);
    // The frame that first reads the repo queues its read; the next one draws
    // what it stored.
    payloadOf(inputs(AT), DRAW);
    await new Promise((resolve) => setImmediate(resolve));
    const { git } = payloadOf(inputs(AT), DRAW);
    expect(git).toMatchObject({ branch: "main", sha: "abc1234" });
    expect(git).toMatchObject({
      prNumber: PENDING,
      prState: PENDING,
      prUrl: PENDING,
      prError: PENDING,
      prEarlier: PENDING,
    });
  });

  test("asks the feeds at the instant the frame is drawn at", () => {
    const { feedsAt, inputs } = counted();
    const later = instantOf(new Date(1_700_000_001_500));
    payloadOf(inputs(AT), DRAW);
    payloadOf(inputs(later), DRAW);
    expect(feedsAt).toEqual([AT, later]);
  });
});
