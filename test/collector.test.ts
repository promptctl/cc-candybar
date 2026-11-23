// The host's collector (src/daemon/collector.ts): one record per session the
// host had a request from, holding the owners' entries at the keys the
// session's newest request names and at each plugin source its renderer
// subscribes to, stamping one world state from what they hold, and handing
// every stamp that moved to the renderer. A session no request named across a
// sweep, with no open feed, is retired.
//
// [LAW:behavior-not-structure] Each case drives the collector over owners
// whose entries a test lands by hand, and reads what it handed in and what
// the owners hold; no renderer is built.

import { daemonFactsOf, FILE_EVENTS_STALLED } from "./helpers/daemon-facts";
import { observable, runInAction } from "mobx";
import { TEST_SIGNER } from "./helpers/link-signer";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitDataProvider } from "../src/daemon/cache/git";
import {
  Collector,
  SESSION_SWEEP_MS,
  type HandedIn,
} from "../src/daemon/collector";
import { stampFailureOf } from "../src/facts/world-state";
import { judgeRun, type Judged } from "../src/daemon/foundations/judge-run";
import { SourceRuns } from "../src/daemon/source-runs";
import { parseClientHints } from "../src/daemon/foundations/protocol";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import { declareLanes, type KeyedOwners } from "../src/daemon/readings";
import { type ViewFacts } from "../src/renderer-interface/request-context";
import type { DaemonFacts, WorldState } from "../src/facts/world-state";
import type { Subscriptions } from "../src/renderer-interface/interface";
import { type GitRead, type PullRequest } from "../src/segments/git";
import { GitService } from "../src/daemon/cache/git-service";
import { Holds } from "../src/utils/holds";
import { runOf } from "../src/facts/source-identity";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Outcome,
} from "../src/utils/outcome";
import { settledLane, type Current, type Lane } from "../src/utils/reading";
import { systemTimekeeper } from "./helpers/system-clock";
import { until } from "./helpers/until";
import {
  absentOwners,
  fakeCacheExpiry,
  fakeMetrics,
  withTranscriptLanes,
  type FixtureOwners,
} from "./helpers/payload-owners";
import { unreadOf } from "../src/facts/awaited";
import { NOTHING_SUBSCRIBED } from "./helpers/settled";
import { TRANSCRIPT_PERIOD } from "../src/daemon/cache/transcript-lanes";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { TEST_ENVIRONMENT } from "./helpers/session-environment";

const SID = sessionIdOf("s1");

// A request of `session` from `cwd`.
function requestAt(cwd: string, session = SID): ViewFacts {
  return {
    hookData: {
      hook_event_name: "Status",
      session_id: session,
      transcript_path: `${cwd}/t.jsonl`,
      cwd,
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: cwd, project_dir: cwd },
    },
    cwd,
    hints: parseClientHints({}),
  };
}

// Owners whose every keyed entry is a hold named by its key and a value a
// test lands (`land`), absent until it does. `held` is what the owners hold.
function handLanded() {
  const held = new Set<string>();
  const values = observable.map<string, Current<unknown>>({}, { deep: false });
  const entry = <T>(holds: Holds, key: string): Lane<T> => {
    holds.take(key, () => {
      held.add(key);
      return () => held.delete(key);
    });
    return { current: () => (values.get(key) ?? ABSENT) as Current<T> };
  };
  const base = absentOwners();
  const owners = {
    ...base,
    gitProvider: {
      declare: (holds: Holds, workingDir: string) =>
        entry(holds, `git:${workingDir}`),
    },
    tmuxService: { declare: (holds: Holds) => entry(holds, "tmux") },
    hostService: {
      declareName: (holds: Holds) => entry(holds, "host.name"),
      declareUser: (holds: Holds) => entry(holds, "host.user"),
    },
    usageStore: {
      ...base.usageStore,
      declareToday: (holds: Holds) => entry(holds, "today"),
    },
    managedStorage: {
      declare: (holds: Holds, folder: string) =>
        entry(holds, `source:${folder}`),
    },
    log: () => {},
  } satisfies FixtureOwners;
  const land = (key: string, value: Current<unknown>) =>
    runInAction(() => values.set(key, value));
  return { owners, held, land };
}

const ANSWERED = { kind: "answered" } as const;

// A collector over `owners`, on a clock the case moves, with a renderer that
// records each hand-in and answers it at once. `watched` is which sessions an
// open feed draws; `retired` is when each retire settles.
function collectorOver(
  owners: FixtureOwners,
  {
    fileEvents = () => [],
    watched = new Set<SessionId>(),
    retired = async () => ANSWERED,
  }: {
    readonly fileEvents?: () => DaemonFacts["fileEvents"];
    readonly watched?: ReadonlySet<SessionId>;
    readonly retired?: () => Promise<unknown>;
  } = {},
) {
  const clock: HeldClock = heldClock(new Date(1_700_000_000_000));
  const handedIn: HandedIn[] = [];
  const logged: string[] = [];
  const laned = withTranscriptLanes(owners, clock);
  const collector = new Collector({
    owners: laned,
    daemon: () => daemonFactsOf(fileEvents()),
    clock,
    watched: (session) => watched.has(session),
    deliver: async (event) => {
      handedIn.push(event);
      return event.kind === "retire" ? retired() : ANSWERED;
    },
    log: (level, message) => logged.push(`${level} ${message}`),
  });
  cleanups.push(() => {
    collector.close();
    laned.transcriptLanes.close();
  });
  return { collector, clock, handedIn, logged };
}

const subscribing = (
  session: SessionId,
  ...folders: string[]
): Pick<Subscriptions, "sources"> => ({
  sources: {
    [session]: folders.map((folder) => ({
      kind: "plugin" as const,
      source: folder,
      folder,
    })),
  },
});

// Retires the renderer answers only when the case says, in the order sent.
function heldRetires() {
  const answers: Array<() => void> = [];
  return {
    retired: () =>
      new Promise<unknown>((resolve) => answers.push(() => resolve(ANSWERED))),
    answer: (i: number) => answers[i]!(),
  };
}

const drained = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let cleanups: Array<() => void>;
beforeEach(() => {
  cleanups = [];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

describe("a request", () => {
  test("declares the built-ins at its keys and is answered with the world state read there, handing in nothing alone", () => {
    const { owners, held, land } = handLanded();
    land("host.name", ok("box"));
    const { collector, handedIn } = collectorOver(owners);
    const document = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect([...held].sort()).toEqual(
      ["git:/a", "host.name", "host.user", "today"].sort(),
    );
    expect(document).toMatchObject({
      session: SID,
      seq: 1,
      builtins: { hostName: { kind: "ok", value: "box" } },
    });
    expect(handedIn).toEqual([]);
  });

  test("naming another key takes it and releases the one it left; the same keys again change nothing", () => {
    const { owners, held } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect(collector.requested(requestAt("/a"), TEST_ENVIRONMENT)).toBe(first);
    collector.requested(requestAt("/b"), TEST_ENVIRONMENT);
    expect(held.has("git:/b")).toBe(true);
    expect(held.has("git:/a")).toBe(false);
    expect(handedIn).toEqual([]);
  });
});

// [LAW:behavior-not-structure] A session's transcript lanes are read on the
// collector's own trigger, never on a request: the world state carries what
// the transcript says once its read lands, whoever asked.
describe("a session's transcript", () => {
  // Owners whose metrics lane reads how many entries the transcript holds,
  // whose other transcript lanes answer at once, and every other key the
  // request names landed.
  function followed() {
    const { owners, land } = handLanded();
    const transcript = { entries: 1 };
    for (const key of ["git:/a", "host.name", "host.user", "today"])
      land(key, ABSENT);
    return {
      owners: {
        ...owners,
        metricsProvider: fakeMetrics(() =>
          ok({ lastResponseTime: null, messageCount: transcript.entries }),
        ),
        cacheExpiry: fakeCacheExpiry(() => ABSENT),
      } satisfies FixtureOwners,
      append: () => transcript.entries++,
    };
  }
  const messagesOf = (state: WorldState | undefined) =>
    state?.builtins.metrics.kind === "ok"
      ? state.builtins.metrics.value.messageCount
      : state?.builtins.metrics.kind;
  const lastHandedIn = (handedIn: HandedIn[]) =>
    handedIn.findLast((e) => e.kind === "world-state")?.worldState;

  test("a first request waits for the lanes' first read, which hands in the world state that answers it", async () => {
    const { owners } = followed();
    const { collector, clock, handedIn } = collectorOver(owners);
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect(first.builtins.metrics).toMatchObject(pendingOf("unread"));
    expect(unreadOf(first, NOTHING_SUBSCRIBED)).toContain("metrics");
    await clock.settle(0);
    const landed = lastHandedIn(handedIn)!;
    expect(messagesOf(landed)).toBe(1);
    expect(unreadOf(landed, NOTHING_SUBSCRIBED)).toEqual([]);
  });

  test("an append lands in the world state on the collector's trigger, with no request", async () => {
    const { owners, append } = followed();
    const { collector, clock, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    await clock.settle(0);
    append();
    await clock.settle(TRANSCRIPT_PERIOD.okMs);
    expect(messagesOf(lastHandedIn(handedIn))).toBe(2);
  });

  test("a request on a warm session waits on nothing, and reads nothing", async () => {
    const { owners, append } = followed();
    const { collector, clock } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    await clock.settle(0);
    append();
    const warm = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect(unreadOf(warm, NOTHING_SUBSCRIBED)).toEqual([]);
    // What the transcript said when the trigger last read it, not the append
    // this request arrived after: the trigger reads it, not the request.
    expect(messagesOf(warm)).toBe(1);
  });
});

// A first read still on its way.
const UNREAD: Current<unknown> = {
  kind: "pending",
  why: "unread",
  landed: new Promise<void>(() => {}),
};

describe("a request's wait", () => {
  // The renderer taking each world state handed to it.
  const takeTurns = (collector: Collector, handedIn: readonly HandedIn[]) =>
    handedIn.forEach((e) => {
      if (e.kind === "world-state") collector.heard(e.worldState);
    });

  test("ends once the read it waits on lands, and a warm session's at once", async () => {
    const { owners, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    land("host.name", UNREAD);
    collector.heard(collector.requested(requestAt("/a"), TEST_ENVIRONMENT));
    let ended = false;
    const waiting = collector
      .settled(SID, new AbortController().signal)
      .then(() => (ended = true));
    await drained();
    expect(ended).toBe(false);
    // The record of a wait that ended here would name the fact it held on.
    expect(collector.holds(SID)).toContain("hostName");
    land("host.name", ok("box"));
    await until(() => {
      takeTurns(collector, handedIn);
      return ended;
    }, "the wait ending once the read landed and was taken");
    await waiting;
    await collector.settled(SID, new AbortController().signal);
  });

  // [LAW:verifiable-goals] The order is forced here: the stamp is in the
  // renderer's mailbox and its turn is not taken, with nothing unread.
  test("holds while the renderer has not taken the turn on the latest stamp, though nothing the draw waits on is unread", async () => {
    const { owners, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    land("host.name", ok("one"));
    collector.heard(collector.requested(requestAt("/a"), TEST_ENVIRONMENT));
    // The first wait ends once every lane has landed and been taken.
    let landed = false;
    void collector
      .settled(SID, new AbortController().signal)
      .then(() => (landed = true));
    await until(() => {
      takeTurns(collector, handedIn);
      return landed;
    }, "the session's first wait ending");
    // A source keyed on a value that moves is subscribed only by the
    // renderer's turn on the move, so a wait that ended before that turn
    // would draw the run it names unread.
    land("host.name", ok("two"));
    let ended = false;
    const waiting = collector
      .settled(SID, new AbortController().signal)
      .then(() => (ended = true));
    await drained();
    expect(ended).toBe(false);
    expect(collector.holds(SID)).toEqual(["turn"]);
    await until(() => {
      takeTurns(collector, handedIn);
      return ended;
    }, "the wait ending once the renderer took the stamp");
    await waiting;
  });

  test("ends when its signal does", async () => {
    const { owners, land } = handLanded();
    const { collector } = collectorOver(owners);
    land("host.name", UNREAD);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    const signal = new AbortController();
    const waiting = collector.settled(SID, signal.signal);
    signal.abort();
    await waiting;
  });
});

describe("an owner landing", () => {
  test("that moves the world state hands it in once, and one that moves nothing hands in nothing", () => {
    const { owners, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    land("host.name", ok("box"));
    expect(handedIn).toEqual([
      {
        kind: "world-state",
        worldState: expect.objectContaining({
          seq: first.seq + 1,
          builtins: expect.objectContaining({
            hostName: expect.objectContaining({ value: "box" }),
          }),
        }),
      },
    ]);
    land("host.name", ok("box"));
    expect(handedIn).toHaveLength(1);
  });

  test("after a request moved the keys, is read at the new keys only", () => {
    const { owners, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    collector.requested(requestAt("/b"), TEST_ENVIRONMENT);
    land("git:/a", ok({}));
    expect(handedIn).toEqual([]);
  });
});

describe("a stamp that throws", () => {
  test("hands in the last document with the failure and the next seq; the same failure hands in nothing, and the next good stamp clears it", () => {
    const broken = observable.box(false);
    const tick = observable.box(0);
    const { owners: base } = handLanded();
    const failing = (): Lane<string> => ({
      current: () => {
        tick.get();
        if (broken.get()) throw new Error("host read exploded");
        return ABSENT as Current<string>;
      },
    });
    const owners = {
      ...base,
      hostService: { declareName: failing, declareUser: failing },
    } satisfies FixtureOwners;
    const { collector, handedIn, logged } = collectorOver(owners);
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    runInAction(() => broken.set(true));
    expect(handedIn).toHaveLength(1);
    const failedDoc = (handedIn[0] as { worldState: WorldState }).worldState;
    expect(failedDoc.seq).toBe(first.seq + 1);
    // A fact that answered keeps its answer; one that never did is the
    // failure, so the request's wait ends on it instead of reading it unread.
    expect(failedDoc.builtins.autocompact).toBe(first.builtins.autocompact);
    expect(first.builtins.metrics).toMatchObject(pendingOf("unread"));
    expect(failedDoc.builtins.metrics).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("host read exploded"),
    });
    expect(unreadOf(failedDoc, NOTHING_SUBSCRIBED)).toEqual([]);
    expect(stampFailureOf(failedDoc)).toContain("host read exploded");
    expect(logged.join("\n")).toContain("host read exploded");

    runInAction(() => tick.set(1));
    expect(handedIn).toHaveLength(1);

    runInAction(() => broken.set(false));
    expect(handedIn).toHaveLength(2);
    const clean = (handedIn[1] as { worldState: WorldState }).worldState;
    expect(clean.seq).toBe(failedDoc.seq + 1);
    expect(stampFailureOf(clean)).toBeNull();
  });
});

describe("owners that keep failing to read", () => {
  test("leave the daemon's facts current: a move of them hands in a document carrying it, still saying what failed", () => {
    const broken = observable.box(false);
    const warnings = observable.box<DaemonFacts["fileEvents"]>([]);
    const { owners: base } = handLanded();
    const failing = (): Lane<string> => ({
      current: () => {
        if (broken.get()) throw new Error("host read exploded");
        return ABSENT as Current<string>;
      },
    });
    const owners = {
      ...base,
      hostService: { declareName: failing, declareUser: failing },
    } satisfies FixtureOwners;
    const { collector, handedIn } = collectorOver(owners, {
      fileEvents: () => warnings.get(),
    });
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    runInAction(() => broken.set(true));
    expect(handedIn).toHaveLength(1);
    runInAction(() => warnings.set(FILE_EVENTS_STALLED));
    expect(handedIn).toHaveLength(2);
    const doc = (handedIn[1] as { worldState: WorldState }).worldState;
    expect(doc.daemon.fileEvents).toEqual(FILE_EVENTS_STALLED);
    expect(stampFailureOf(doc)).toContain("host read exploded");
  });
});

describe("the renderer's subscriptions", () => {
  test("a plugin source added is declared and read into the world state; one dropped is released after that output", () => {
    const { owners, held, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    collector.subscribed(subscribing(SID, "/plugin"));
    expect(held.has("source:/plugin")).toBe(true);
    land("source:/plugin", ok({ home: "/h" }));
    expect(handedIn.at(-1)).toMatchObject({
      kind: "world-state",
      worldState: { sources: { "/plugin": { kind: "ok" } } },
    });
    collector.subscribed({ sources: {} });
    expect(held.has("source:/plugin")).toBe(false);
  });

  test("a run the host refuses is logged once as it joins the set, and stands as its fault; requests judge nothing again", () => {
    const { owners } = handLanded();
    const { collector, handedIn, logged } = collectorOver({
      ...owners,
      sourceRuns: new SourceRuns({
        launcher: unscriptedLauncher,
        clock: heldClock(new Date(0)),
      }),
    });
    const run = runOf({
      read: { kind: "file", path: "status.json", readMode: "whole" },
      parse: { kind: "json" },
      refresh: { kind: "never" },
    });
    const subscription: Pick<Subscriptions, "sources"> = {
      sources: { [SID]: [{ kind: "run" as const, run }] },
    };
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    collector.subscribed(subscription);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    collector.subscribed(subscription);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect(logged.filter((line) => line.includes("run refused"))).toEqual([
      expect.stringMatching(
        /^warn run refused .* reason="file\.path must be an absolute path/,
      ),
    ]);
    expect(handedIn.at(-1)).toMatchObject({
      kind: "world-state",
      worldState: {
        runs: {
          [run.digest]: {
            reading: {
              kind: "failed",
              reason: expect.stringMatching(/^refused: file\.path/),
            },
            fault: expect.stringMatching(/^refused: file\.path/),
          },
        },
      },
    });
  });

  test("a session named like an object's inherited member subscribes to nothing it was not handed", () => {
    const { owners } = handLanded();
    const { collector, logged } = collectorOver(owners);
    collector.requested(
      requestAt("/a", sessionIdOf("constructor")),
      TEST_ENVIRONMENT,
    );
    expect(() => collector.subscribed({ sources: {} })).not.toThrow();
    expect(logged.filter((line) => !line.startsWith("info"))).toEqual([]);
  });

  test("naming a session the collector has no record of is said", () => {
    const { owners } = handLanded();
    const { collector, logged } = collectorOver(owners);
    collector.subscribed(subscribing(sessionIdOf("stranger"), "/plugin"));
    expect(logged).toEqual([
      expect.stringMatching(/^error subscriptions name session "stranger"/),
    ]);
  });
});

describe("the sweep", () => {
  test("retires a session no request named across a whole sweep, releasing what it held, and drops it once the retire settles, even as threw, so the next request starts a new record", async () => {
    const { owners, held } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners, {
      retired: async () => ({ kind: "threw" }),
    });
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
    expect(held.size).toBeGreaterThan(0);
    clock.advance(SESSION_SWEEP_MS);
    expect(handedIn).toEqual([{ kind: "retire", session: SID }]);
    expect(held.size).toBe(0);
    await drained();
    expect(collector.stats()).toEqual({ sessions: 0, retiring: 0 });
    // The last session gone, the sweep stops.
    expect(clock.pending()).toBe(0);
    // The renderer let go of the session's document, so seq 1 is taken.
    expect(collector.requested(requestAt("/a"), TEST_ENVIRONMENT).seq).toBe(
      first.seq,
    );
  });

  test("a wait on a session the sweep retires ends with it", async () => {
    const { owners, land } = handLanded();
    const { collector, clock } = collectorOver(owners);
    land("host.name", UNREAD);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    let ended = false;
    const waiting = collector
      .settled(SID, new AbortController().signal)
      .then(() => (ended = true));
    await drained();
    expect(ended).toBe(false);
    clock.advance(2 * SESSION_SWEEP_MS);
    await waiting;
  });

  test("keeps a session an open feed draws", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners, {
      watched: new Set([SID]),
    });
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(3 * SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 0 });
  });

  test("keeps a clicked session through the next sweep, as a request does", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(SESSION_SWEEP_MS);
    collector.clicked(SID);
    clock.advance(SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
    clock.advance(SESSION_SWEEP_MS);
    expect(handedIn).toEqual([{ kind: "retire", session: SID }]);
  });

  test("keeps a session a turn holds for as long as it holds it, and the first sweep after it settles with no request since retires it", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    const release = collector.holding(SID);
    clock.advance(5 * SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
    // A settled turn is no request: only a request keeps a session past the
    // next sweep, so a turn the collector's own deliveries start keeps none.
    release();
    clock.advance(SESSION_SWEEP_MS);
    expect(handedIn).toEqual([{ kind: "retire", session: SID }]);
  });

  test("a click on a session it holds no record of holds nothing", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners);
    collector.holding(SID)();
    expect(collector.stats()).toEqual({ sessions: 0, retiring: 0 });
    clock.advance(2 * SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
  });

  test("a retiring session takes outputs naming it without holding, and a request makes it live again, which the late answer leaves alone", async () => {
    const { owners, held } = handLanded();
    const { retired, answer } = heldRetires();
    const { collector, clock, logged } = collectorOver(owners, { retired });
    const first = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(2 * SESSION_SWEEP_MS);
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 1 });

    collector.subscribed(subscribing(SID, "/plugin"));
    expect(held.size).toBe(0);
    expect(logged.filter((line) => line.startsWith("error"))).toEqual([]);

    const revived = collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    expect(revived.seq).toBe(first.seq + 1);
    expect(revived.sources).toHaveProperty("/plugin");
    expect(held.has("source:/plugin")).toBe(true);
    answer(0);
    await drained();
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 0 });
  });

  test("a session retired again keeps its record until the later retire settles, however late the earlier one is answered", async () => {
    const { owners } = handLanded();
    const { retired, answer } = heldRetires();
    const { collector, clock } = collectorOver(owners, { retired });
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(2 * SESSION_SWEEP_MS);
    collector.requested(requestAt("/a"), TEST_ENVIRONMENT);
    clock.advance(2 * SESSION_SWEEP_MS);
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 1 });

    answer(0);
    await drained();
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 1 });
    answer(1);
    await drained();
    expect(collector.stats()).toEqual({ sessions: 0, retiring: 0 });
    expect(clock.pending()).toBe(0);
  });
});

// The one repo every directory resolves to, its PR looked up by count.
const REPO = "/repo";
class OneRepo extends GitService {
  prLookups = 0;

  override resolveEffectiveGitDir(): Outcome<string> {
    return ok(REPO);
  }

  override resolveGitDir(root: string): string {
    return `${root}/.git`;
  }

  override async getGitInfo(): Promise<Outcome<GitRead>> {
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
      workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
      sha: ok("c0ffee"),
      operation: ABSENT,
      committedAt: ok(1_700_000_000),
      stashCount: ABSENT,
      upstream: ok("origin/main"),
      repoName: ok("widget"),
      repoUrl: ok("https://github.com/acme/widget"),
    });
  }

  override async getRepoRemoteUrl(): Promise<Outcome<string>> {
    return ok("git@github.com:acme/widget.git");
  }

  override async resolvePullRequest(): Promise<Outcome<PullRequest>> {
    this.prLookups++;
    return ok({
      number: 7,
      state: "open",
      url: "https://example.test/pull/7",
      head: "c0ffee",
    });
  }
}

describe("over the real repository owner", () => {
  let dir: string;
  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccb-collect-")),
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.useRealTimers();
  });

  test("a held repo's PR is looked up with no draw, and the next request finds the repo's value stored", async () => {
    const inner = new OneRepo(unscriptedLauncher);
    const git = new GitDataProvider({
      clock: systemTimekeeper,
      inner,
      logger: () => {},
    });
    cleanups.push(() => git.close());
    const owners = {
      ...absentOwners(),
      gitProvider: git,
      tmuxService: { declare: () => settledLane(ABSENT) },
      hostService: {
        declareName: () => settledLane(ABSENT),
        declareUser: () => settledLane(ABSENT),
      },
      usageStore: {
        ...absentOwners().usageStore,
        declareToday: () => settledLane(ABSENT),
      },
      log: () => {},
    } satisfies FixtureOwners;
    const { collector, handedIn } = collectorOver(owners);
    collector.requested(requestAt(dir), TEST_ENVIRONMENT);
    expect(git.getStats().held).toBe(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(inner.prLookups).toBe(1);
    expect(handedIn.at(-1)).toMatchObject({
      kind: "world-state",
      worldState: {
        builtins: {
          git: { kind: "ok" },
          pr: { kind: "ok", value: { number: 7 } },
        },
      },
    });
    collector.requested(requestAt(dir), TEST_ENVIRONMENT);
    expect(git.getStats()).toMatchObject({ held: 1, hits: 1, misses: 1 });
    expect(inner.prLookups).toBe(1);
  });
});

test("a lane whose declaration throws is reported, takes no hold, and stops no other lane", () => {
  const holds = new Holds();
  const taken: string[] = [];
  const released: string[] = [];
  const take = (key: string): Lane<never> => {
    holds.take(key, () => {
      taken.push(key);
      return () => released.push(key);
    });
    return settledLane(ABSENT);
  };
  const owners = {
    ...absentOwners(),
    gitProvider: {
      declare: () => {
        throw new Error("resolver bug");
      },
    },
    tmuxService: { declare: () => take("tmux") },
    hostService: {
      declareName: () => take("host.name"),
      declareUser: () => take("host.user"),
    },
    usageStore: { declareToday: () => take("today") },
    transcriptLanes: { declare: () => take("transcript") },
    home: "/home/tester",
  } satisfies KeyedOwners;
  const facts: ViewFacts = {
    ...requestAt("/w"),
    hints: parseClientHints({
      tmux: { socket: "/s", pane: "%1", truecolor: null },
    }),
  };
  // The git hold an earlier declaration took goes with the one that threw.
  holds.declare(() => take("git"));
  const declared = holds.declare(() =>
    declareLanes(
      owners,
      holds,
      { ...facts, environment: TEST_ENVIRONMENT },
      {
        plugins: new Map(),
        runs: new Map(),
        env: [],
      },
    ),
  );
  expect(declared.result.faults).toEqual([
    expect.stringMatching(/^git: .*resolver bug/),
  ]);
  // The lane that threw answers its failure; the others answer their own.
  expect(declared.result.lanes.git.current()).toEqual(
    failed("git: Error: resolver bug", "read"),
  );
  expect(declared.result.lanes.tmux.current()).toEqual(ABSENT);
  expect(taken).toEqual([
    "git",
    "tmux",
    "host.name",
    "host.user",
    "today",
    "transcript",
  ]);
  expect(released).toEqual(["git"]);
  expect(declared).toMatchObject({ acquired: 5, released: 1 });
});

test("a run whose declaration throws answers its failure, and every other run and lane declares", () => {
  const holds = new Holds();
  const runAt = (command: string) =>
    runOf({
      read: { kind: "shell", command, cwd: "/w", env: [] },
      parse: { kind: "text" },
      refresh: { kind: "never" },
    });
  const broken = runAt("broken");
  const fine = runAt("fine");
  const laned = withTranscriptLanes(absentOwners());
  cleanups.push(() => {
    holds.close();
    laned.transcriptLanes.close();
  });
  const owners = {
    ...laned,
    sourceRuns: {
      declare: (_: Holds, run: Judged) => {
        if (run.digest === broken.digest) throw new Error("watch bug");
        return { digest: run.digest, current: () => ABSENT, fault: () => null };
      },
    },
  } satisfies KeyedOwners;
  const declared = holds.declare(() =>
    declareLanes(
      owners,
      holds,
      { ...requestAt("/w"), environment: TEST_ENVIRONMENT },
      {
        plugins: new Map(),
        runs: new Map([
          [broken.digest, judgeRun(broken)],
          [fine.digest, judgeRun(fine)],
        ]),
        env: [],
      },
    ),
  );
  expect(declared.result.faults).toEqual([
    expect.stringMatching(/^run [0-9a-f]+: .*watch bug/),
  ]);
  const { runs, git } = declared.result.lanes;
  expect(runs.get(broken.digest)?.current()).toMatchObject({ kind: "failed" });
  expect(runs.get(broken.digest)?.fault()).toBeNull();
  expect(runs.get(fine.digest)?.current()).toEqual(ABSENT);
  expect(git.current().kind).not.toBe("failed");
});
