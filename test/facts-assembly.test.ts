// [LAW:behavior-not-structure] A session's facts document, as the daemon's
// owners hold them: what each fact says against the owners read directly, what
// a turn in which nothing moved leaves untouched, and what the stamp says when
// one answer does.

import { restamp, type Fact } from "../src/facts/fact";
import type { BuiltinFacts } from "../src/facts/session-facts";
import { assembleFacts, FACTS_VERSION } from "../src/daemon/facts-assembly";
import type { Update } from "../src/daemon/update-notice";
import {
  readingsOf,
  settlePayload,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { oneDay } from "../src/daemon/cache/today-facts";
import { sumsOf } from "./helpers/today";
import { claudeConfigDir, claudeSettingsPath } from "../src/claude-settings";
import type { ClaudeHookData } from "../src/utils/claude";
import type { ClientHints } from "../src/daemon/protocol";
import { instantOf, type Instant } from "../src/utils/instant";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Outcome,
} from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
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

const SID = sessionIdOf("facts-assembly");
const PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };
const HINTS: ClientHints = { tmux: PANE };
const HOOK = {
  hook_event_name: "Status",
  session_id: SID,
  transcript_path: "/no/such/transcript.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
} as unknown as ClaudeHookData;

const at = (seconds: number): Instant =>
  instantOf(new Date(1_700_000_000_000 + seconds * 1000));
const T0 = at(0);

const EVERY_LANE = new Set([
  "git.branch",
  "git.prNumber",
  "tmux.session",
  "host.name",
  "host.user",
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
const PR = { number: 7, state: "open", url: "https://example.test/pr/7" };

// Every lane over the value it is given; the git lane answers `git`.
function owners(git: Outcome<unknown> = ok({ ...GIT, pullRequest: ok(PR) })) {
  return {
    ...absentOwners(),
    gitProvider: fakeGit(() => git),
    tmuxService: fakeTmux(() => ok("work")),
    usageStore: fakeUsage({
      usage: () => ok({ session: { cost: 2, tokens: 10 } }),
      today: () => ok(sumsOf(T0, 5, 50)),
      speed: () => ABSENT,
    }),
    contextProvider: fakeContext(() => ok({ maxTokens: 200_000 })),
    metricsProvider: fakeMetrics(() => ABSENT),
    activityProvider: fakeActivity(() => failed("no transcript", "read")),
    cacheExpiry: fakeCacheExpiry(() => ok(1_700_003_600)),
    autoCompact: fakeAutoCompact(() => ok(400_000)),
  };
}

function rig(
  closure: ReadonlySet<string> = EVERY_LANE,
  git?: Outcome<unknown>,
) {
  const held = owners(git);
  const deps = {
    ...held,
    lanes: declaredLanes(
      held,
      { sessionId: SID, hookData: HOOK, cwd: undefined, hints: HINTS },
      closure,
    ),
  } as unknown as RenderPayloadDeps;
  const inputs: PayloadInputs = {
    hookData: HOOK,
    deps,
    cwd: undefined,
    neededInputPaths: closure,
    hints: HINTS,
  };
  return { held, deps, inputs };
}

const sampled = async (r: ReturnType<typeof rig>) => {
  await settlePayload(r.inputs, T0, new Map());
  return r;
};

const PENDING = pendingOf("unread");
const BUILTIN_KEYS = [
  "activity",
  "autocompact",
  "cache",
  "context",
  "git",
  "hostName",
  "hostUser",
  "metrics",
  "pr",
  "session",
  "speed",
  "tmux",
  "today",
] as const;

describe("a session's facts document", () => {
  test("says, for every built-in, what its owner holds", async () => {
    const r = await sampled(rig());
    const doc = assembleFacts(
      undefined,
      SID,
      readingsOf(r.inputs, new Map()),
      PENDING,
      T0,
    );
    // The expected document is read from the owners, never from the readings.
    const lanes = r.deps.lanes();
    const { pullRequest, ...gitRead } = (
      lanes.git.current() as unknown as { value: Record<string, unknown> }
    ).value;
    const settings = claudeSettingsPath(claudeConfigDir(undefined, r.deps.home));
    const expected: Record<keyof BuiltinFacts, Fact<unknown>> = {
      session: restamp(undefined, r.held.usageStore.usageOf(SID), T0),
      // The fixture's one day, and the session with no days of its own.
      today: restamp(undefined, ok({ sums: oneDay(T0, 5, 50), own: {} }), T0),
      speed: restamp(undefined, r.held.usageStore.speedOf(SID), T0),
      context: restamp(undefined, r.held.contextProvider.contextOf(HOOK), T0),
      metrics: restamp(undefined, r.held.metricsProvider.metricsOf(SID), T0),
      activity: restamp(undefined, r.held.activityProvider.activityOf(SID), T0),
      cache: restamp(undefined, r.held.cacheExpiry.expiryOf(SID), T0),
      autocompact: restamp(undefined, r.held.autoCompact.stored(settings), T0),
      git: restamp(undefined, ok(gitRead), T0),
      pr: restamp(undefined, pullRequest as Outcome<unknown>, T0),
      tmux: restamp(undefined, ok({ session: "work" }), T0),
      hostName: restamp(undefined, lanes.hostName.current(), T0),
      hostUser: restamp(undefined, lanes.hostUser.current(), T0),
    };
    expect(Object.keys(doc.builtins).sort()).toEqual([...BUILTIN_KEYS]);
    expect(doc.builtins).toEqual(expected);
    expect(doc.v).toBe(FACTS_VERSION);
    expect(doc.session).toBe(SID);
    expect(doc.seq).toBe(1);
  });

  test("is total before any owner has answered, every fact pending", () => {
    const r = rig();
    const doc = assembleFacts(
      undefined,
      SID,
      readingsOf(r.inputs, new Map()),
      PENDING,
      T0,
    );
    expect(Object.keys(doc.builtins).sort()).toEqual([...BUILTIN_KEYS]);
    for (const key of ["session", "git", "pr", "tmux", "context"] as const) {
      expect(doc.builtins[key]).toEqual(PENDING);
    }
  });

  test("a built-in the closure does not gather is pending, never absent", async () => {
    const r = await sampled(rig(new Set()));
    const doc = assembleFacts(
      undefined,
      SID,
      readingsOf(r.inputs, new Map()),
      PENDING,
      T0,
    );
    for (const key of BUILTIN_KEYS) {
      expect(doc.builtins[key]).toEqual(PENDING);
    }
  });

  describe("the PR", () => {
    const prOf = async (git: Outcome<unknown>) => {
      const r = await sampled(rig(EVERY_LANE, git));
      return assembleFacts(
        undefined,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        T0,
      ).builtins.pr;
    };

    test("is the lane the repository read carries", async () => {
      expect(await prOf(ok({ ...GIT, pullRequest: ok(PR) }))).toEqual({
        kind: "ok",
        value: PR,
        at: T0,
      });
      expect(await prOf(ok({ ...GIT, pullRequest: ABSENT }))).toEqual({
        kind: "absent",
        at: T0,
      });
    });

    test("is pending unread when the repository read asked for none", async () => {
      expect(await prOf(ok(GIT))).toEqual(PENDING);
    });

    test("is absent when there is no repository", async () => {
      expect(await prOf(ABSENT)).toEqual({ kind: "absent", at: T0 });
    });

    test("is the repository's failure when it could not be read, since the forge cannot be asked", async () => {
      expect(await prOf(failed("not a worktree", "read"))).toEqual({
        kind: "failed",
        reason: "not a worktree",
        failedAt: "read",
        at: T0,
      });
    });
  });

  describe("the declared sources", () => {
    const declared = new Map([
      ["reached", { folder: "/a", generation: 0 }],
      ["unreached", { folder: "/b", generation: 0 }],
    ]);

    test("every one has a key: the reached one its reading, the other pending", async () => {
      const r = await sampled(rig());
      const lanes = r.deps.lanes();
      const deps = {
        ...r.deps,
        lanes: () => ({
          ...lanes,
          sources: new Map([["reached", settledLane(ok({ home: "/h" }))]]),
        }),
      } as RenderPayloadDeps;
      const doc = assembleFacts(
        undefined,
        SID,
        readingsOf({ ...r.inputs, deps }, declared),
        PENDING,
        T0,
      );
      expect(doc.sources).toEqual({
        reached: { kind: "ok", value: { home: "/h" }, at: T0 },
        unreached: PENDING,
      });
    });
  });

  describe("restamped against the document it replaces", () => {
    test("a turn in which nothing moved is the same document", async () => {
      const r = await sampled(rig());
      const first = assembleFacts(
        undefined,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        T0,
      );
      const again = assembleFacts(
        first,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        at(60),
      );
      expect(again).toBe(first);
    });

    test("one answer moving moves its instant and the sequence, and nothing else", async () => {
      const r = await sampled(rig());
      const first = assembleFacts(
        undefined,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        T0,
      );
      r.deps.faults.refreshed(SID, "cache", "refresh threw");
      const second = assembleFacts(
        first,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        at(60),
      );
      expect(second.seq).toBe(2);
      expect(second.builtins.cache).toEqual({
        kind: "failed",
        reason: "refresh threw",
        failedAt: "read",
        at: at(60),
      });
      // Every other fact is the very object it was, its instant untouched.
      for (const key of BUILTIN_KEYS.filter((k) => k !== "cache")) {
        expect(second.builtins[key]).toBe(first.builtins[key]);
      }
      expect(second.diagnostics).toEqual([
        { lane: "cache", reason: "refresh threw" },
      ]);

      // The refresh running clean again is a change too: stamped when it came.
      r.deps.faults.refreshed(SID, "cache", null);
      const third = assembleFacts(
        second,
        SID,
        readingsOf(r.inputs, new Map()),
        PENDING,
        at(120),
      );
      expect(third.seq).toBe(3);
      expect(third.builtins.cache).toEqual({
        kind: "ok",
        value: 1_700_003_600,
        at: at(120),
      });
      expect(third.diagnostics).toEqual([]);
    });

    test("the update is the fact it is handed, by reference", async () => {
      const r = await sampled(rig());
      const readings = readingsOf(r.inputs, new Map());
      const none = restamp(undefined, ABSENT, T0);
      const first = assembleFacts(undefined, SID, readings, none, T0);
      expect(first.update).toBe(none);
      expect(assembleFacts(first, SID, readings, none, at(5))).toBe(first);
      const newer = restamp(
        none,
        ok<Update>({ kind: "release", newer: [2, 0, 0], running: [1, 0, 0] }),
        at(10),
      );
      const second = assembleFacts(first, SID, readings, newer, at(10));
      expect(second.update).toBe(newer);
      expect(second.seq).toBe(2);
      for (const key of BUILTIN_KEYS) {
        expect(second.builtins[key]).toBe(first.builtins[key]);
      }
    });
  });
});
