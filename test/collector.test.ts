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
import { stampFailureOf } from "../src/daemon/facts-assembly";
import { judgeRun, type Judged } from "../src/daemon/judge-run";
import { SourceRuns } from "../src/daemon/source-runs";
import { parseClientHints } from "../src/daemon/protocol";
import { sessionIdOf, type SessionId } from "../src/daemon/session-id";
import {
  declareLanes,
  type KeyedOwners,
  type RenderPayloadDeps,
  type ViewFacts,
} from "../src/daemon/render-payload";
import type { StorageKey } from "../src/daemon/cache/managed-storage";
import type { Fact } from "../src/facts/fact";
import type { UpdateNotice, WorldState } from "../src/facts/world-state";
import type { Subscriptions } from "../src/renderer/interface";
import {
  GitService,
  type GitRead,
  type PullRequest,
} from "../src/segments/git";
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
import { systemTimekeeper } from "../src/time";
import { absentOwners } from "./helpers/payload-owners";
import { heldClock, type HeldClock } from "./helpers/held-clock";

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
      declare: (holds: Holds, storage: StorageKey) =>
        entry(holds, `source:${storage.folder}`),
    },
    log: () => {},
  } as unknown as RenderPayloadDeps;
  const land = (key: string, value: Current<unknown>) =>
    runInAction(() => values.set(key, value));
  return { owners, held, land };
}

const ANSWERED = { kind: "answered" } as const;

// A collector over `owners`, on a clock the case moves, with a renderer that
// records each hand-in and answers it at once. `watched` is which sessions an
// open feed draws; `retired` is when each retire settles.
function collectorOver(
  owners: RenderPayloadDeps,
  {
    update = () => pendingOf("unread"),
    watched = new Set<SessionId>(),
    retired = async () => ANSWERED,
  }: {
    readonly update?: () => Fact<UpdateNotice>;
    readonly watched?: ReadonlySet<SessionId>;
    readonly retired?: () => Promise<unknown>;
  } = {},
) {
  const clock: HeldClock = heldClock(new Date(1_700_000_000_000));
  const handedIn: HandedIn[] = [];
  const logged: string[] = [];
  const collector = new Collector({
    owners,
    update,
    clock,
    watched: (session) => watched.has(session),
    deliver: async (event) => {
      handedIn.push(event);
      return event.kind === "retire" ? retired() : ANSWERED;
    },
    log: (level, message) => logged.push(`${level} ${message}`),
  });
  cleanups.push(() => collector.close());
  return { collector, clock, handedIn, logged };
}

const subscribing = (
  session: SessionId,
  ...folders: string[]
): Subscriptions => ({
  sources: new Map([
    [
      session,
      folders.map((folder) => ({
        kind: "plugin" as const,
        source: folder,
        storage: { folder, generation: 1 },
      })),
    ],
  ]),
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
    const document = collector.requested(requestAt("/a"));
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
    const first = collector.requested(requestAt("/a"));
    expect(collector.requested(requestAt("/a"))).toBe(first);
    collector.requested(requestAt("/b"));
    expect(held.has("git:/b")).toBe(true);
    expect(held.has("git:/a")).toBe(false);
    expect(handedIn).toEqual([]);
  });
});

describe("an owner landing", () => {
  test("that moves the world state hands it in once, and one that moves nothing hands in nothing", () => {
    const { owners, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    const first = collector.requested(requestAt("/a"));
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
    collector.requested(requestAt("/a"));
    collector.requested(requestAt("/b"));
    land("git:/a", ok({}));
    expect(handedIn).toEqual([]);
  });
});

describe("a stamp that throws", () => {
  test("hands in the last document with the failure and the next seq; the same failure hands in nothing, and the next good stamp clears it", () => {
    const broken = observable.box(false);
    const tick = observable.box(0);
    const { owners } = handLanded();
    const { collector, handedIn, logged } = collectorOver(owners, {
      update: () => {
        tick.get();
        if (broken.get()) throw new Error("update watch exploded");
        return pendingOf("unread");
      },
    });
    const first = collector.requested(requestAt("/a"));
    runInAction(() => broken.set(true));
    expect(handedIn).toHaveLength(1);
    const failedDoc = (handedIn[0] as { worldState: WorldState }).worldState;
    expect(failedDoc.seq).toBe(first.seq + 1);
    expect(failedDoc.builtins).toBe(first.builtins);
    expect(stampFailureOf(failedDoc)).toContain("update watch exploded");
    expect(logged.join("\n")).toContain("update watch exploded");

    runInAction(() => tick.set(1));
    expect(handedIn).toHaveLength(1);

    runInAction(() => broken.set(false));
    expect(handedIn).toHaveLength(2);
    const clean = (handedIn[1] as { worldState: WorldState }).worldState;
    expect(clean.seq).toBe(failedDoc.seq + 1);
    expect(stampFailureOf(clean)).toBeNull();
  });
});

describe("the renderer's subscriptions", () => {
  test("a plugin source added is declared and read into the world state; one dropped is released after that output", () => {
    const { owners, held, land } = handLanded();
    const { collector, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"));
    collector.subscribed(subscribing(SID, "/plugin"));
    expect(held.has("source:/plugin")).toBe(true);
    land("source:/plugin", ok({ home: "/h" }));
    expect(handedIn.at(-1)).toMatchObject({
      kind: "world-state",
      worldState: { sources: { "/plugin": { kind: "ok" } } },
    });
    collector.subscribed({ sources: new Map() });
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
    } as RenderPayloadDeps);
    const run = runOf({
      read: { kind: "file", path: "status.json", readMode: "whole" },
      parse: { kind: "json" },
      refresh: { kind: "never" },
    });
    const subscription: Subscriptions = {
      sources: new Map([[SID, [{ kind: "run" as const, run }]]]),
    };
    collector.requested(requestAt("/a"));
    collector.subscribed(subscription);
    collector.requested(requestAt("/a"));
    collector.subscribed(subscription);
    collector.requested(requestAt("/a"));
    expect(logged.filter((line) => line.includes("run refused"))).toEqual([
      expect.stringMatching(
        /^warn run refused .* reason=file\.path must be an absolute path/,
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
    const first = collector.requested(requestAt("/a"));
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
    expect(collector.requested(requestAt("/a")).seq).toBe(first.seq);
  });

  test("keeps a session an open feed draws", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners, {
      watched: new Set([SID]),
    });
    collector.requested(requestAt("/a"));
    clock.advance(3 * SESSION_SWEEP_MS);
    expect(handedIn).toEqual([]);
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 0 });
  });

  test("keeps a clicked session through the next sweep, as a request does", () => {
    const { owners } = handLanded();
    const { collector, clock, handedIn } = collectorOver(owners);
    collector.requested(requestAt("/a"));
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
    collector.requested(requestAt("/a"));
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
    const first = collector.requested(requestAt("/a"));
    clock.advance(2 * SESSION_SWEEP_MS);
    expect(collector.stats()).toEqual({ sessions: 1, retiring: 1 });

    collector.subscribed(subscribing(SID, "/plugin"));
    expect(held.size).toBe(0);
    expect(logged.filter((line) => line.startsWith("error"))).toEqual([]);

    const revived = collector.requested(requestAt("/a"));
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
    collector.requested(requestAt("/a"));
    clock.advance(2 * SESSION_SWEEP_MS);
    collector.requested(requestAt("/a"));
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
    } as unknown as RenderPayloadDeps;
    const { collector, handedIn } = collectorOver(owners);
    collector.requested(requestAt(dir));
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
    collector.requested(requestAt(dir));
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
  } as unknown as KeyedOwners;
  const facts: ViewFacts = {
    ...requestAt("/w"),
    hints: parseClientHints({
      tmux: { socket: "/s", pane: "%1", truecolor: null },
    }),
  };
  // The git hold an earlier declaration took goes with the one that threw.
  holds.declare(() => take("git"));
  const declared = holds.declare(() =>
    declareLanes(owners, holds, facts, { plugins: new Map(), runs: new Map() }),
  );
  expect(declared.result.faults).toEqual([
    expect.stringMatching(/^git: .*resolver bug/),
  ]);
  // The lane that threw answers its failure; the others answer their own.
  expect(declared.result.lanes.git.current()).toEqual(
    failed("git: Error: resolver bug", "read"),
  );
  expect(declared.result.lanes.tmux.current()).toEqual(ABSENT);
  expect(taken).toEqual(["git", "tmux", "host.name", "host.user", "today"]);
  expect(released).toEqual(["git"]);
  expect(declared).toMatchObject({ acquired: 4, released: 1 });
});

test("a run whose declaration throws answers its failure, and every other run and lane declares", () => {
  const holds = new Holds();
  const runAt = (command: string) =>
    runOf({
      read: { kind: "shell", command, cwd: "/w" },
      parse: { kind: "text" },
      refresh: { kind: "never" },
    });
  const broken = runAt("broken");
  const fine = runAt("fine");
  const owners = {
    ...absentOwners(),
    sourceRuns: {
      declare: (_: Holds, run: Judged) => {
        if (run.digest === broken.digest) throw new Error("watch bug");
        return { digest: run.digest, current: () => ABSENT, fault: () => null };
      },
    },
  } as unknown as KeyedOwners;
  const declared = holds.declare(() =>
    declareLanes(owners, holds, requestAt("/w"), {
      plugins: new Map(),
      runs: new Map([
        [broken.digest, judgeRun(broken)],
        [fine.digest, judgeRun(fine)],
      ]),
    }),
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
