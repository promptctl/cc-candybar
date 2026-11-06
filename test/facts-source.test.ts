// The facts source's arms, each alone (src/daemon/facts-source.ts): the
// in-process arm takes and releases a view's holds and stamps its document
// from what the owners hold; the recording arm replays lines under the clock
// it is handed and holds one session. The seam between them, and the
// recorder that writes a session's stream, are held by
// test/facts-seam.test.ts.

import { observable, reaction, runInAction } from "mobx";
import {
  inProcessFacts,
  recordingFacts,
  type Facts,
  type FollowDeclaration,
} from "../src/daemon/facts-source";
import { runsFactOf, type KeyedOwners } from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { restamp, type Fact } from "../src/facts/fact";
import type { FactsLine } from "../src/facts/recording";
import type { UpdateNotice } from "../src/facts/session-facts";
import { Holds } from "../src/utils/holds";
import { instantOf, type Instant } from "../src/utils/instant";
import { ok, pendingOf } from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
import { factsRunning, pendingFacts } from "./helpers/facts";
import { heldClock } from "./helpers/held-clock";
import { absentOwners } from "./helpers/payload-owners";
import { viewFacts } from "./helpers/view-facts";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import { systemTimekeeper } from "../src/time";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  digestOf,
  SourceRuns,
  type SourceIdentity,
} from "../src/var-system/source-runs";
import { until } from "./helpers/until";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";

const AT = new Date(1_700_000_000_000);
const GIT = {
  branch: "main",
  status: "clean" as const,
  aheadBehind: ok({ ahead: 0, behind: 0 }),
  head: ok("c0ffee"),
};
// A config declaring no plugin source: every built-in is gathered whatever
// the layout places, so a declaration names nothing else.
const DECLARED: FollowDeclaration = { sources: new Map() };

const at0 = instantOf(AT);

// A `file` source's identity, read once.
const fileRun = (filePath: string): SourceIdentity => ({
  read: { kind: "file", path: filePath, readMode: "whole" },
  parse: { kind: "text" },
  refresh: { kind: "never" },
});

describe("the in-process arm", () => {
  // Owners whose git lane takes one hold per repository and answers at once,
  // beside owners that answer nothing, and a log the test reads.
  function owners() {
    const held: string[] = [];
    const released: string[] = [];
    const lines: string[] = [];
    const clock = heldClock(AT);
    const providers = {
      ...absentOwners(),
      clock,
      log: (_level: string, message: string) => {
        lines.push(message);
      },
      gitProvider: {
        declare: (holds: Holds, workingDir: string) => {
          holds.take(`repo:${workingDir}`, () => {
            held.push(workingDir);
            return () => {
              released.push(workingDir);
            };
          });
          return settledLane(ok({ ...GIT, pullRequest: undefined }));
        },
      },
    } as unknown as KeyedOwners;
    return { providers, held, released, lines, clock };
  }
  const arm = (
    providers: unknown,
    update: () => Fact<UpdateNotice> = () => pendingOf("unread"),
  ): Facts =>
    inProcessFacts({
      providers: providers as never,
      update,
      runs: new SourceRuns({
        launcher: unscriptedLauncher,
        clock: systemTimekeeper,
      }),
    });

  test("a follow takes the holds its declaration names, a follow at other keys releases the rest, and dispose releases all", () => {
    const { providers, held, released, lines } = owners();
    const followed = arm(providers).follow(viewFacts("/a"), DECLARED);
    expect(held).toEqual(["/a"]);
    expect(followed.stamped().facts.builtins.git).toMatchObject({
      kind: "ok",
      value: { branch: "main" },
    });
    // The same keys again: nothing moves, and nothing is said.
    followed.follow(viewFacts("/a"), DECLARED);
    expect(released).toEqual([]);
    // Another directory: the old repo goes the moment the new is taken.
    followed.follow(viewFacts("/b"), DECLARED);
    expect(held).toEqual(["/a", "/b"]);
    expect(released).toEqual(["/a"]);
    // Every built-in is declared, so the opening takes one hold per owner
    // lane; the move takes and releases only the repo's.
    expect(lines.filter((l) => l.startsWith("session view declared"))).toEqual([
      'session view declared sid="s1" acquired=3 released=0 held=3',
      'session view declared sid="s1" acquired=1 released=1 held=3',
    ]);
    followed.dispose();
    expect(released).toEqual(["/a", "/b"]);
  });

  test("a lane whose owner throws at its declaration answers that failure, takes no hold, and is logged", () => {
    const { providers, held, lines } = owners();
    (
      providers as unknown as { gitProvider: { declare: () => never } }
    ).gitProvider.declare = () => {
      throw new Error("resolver bug");
    };
    const followed = arm(providers).follow(viewFacts("/a"), DECLARED);
    expect(held).toEqual([]);
    expect(followed.stamped().facts.builtins.git).toMatchObject({
      kind: "failed",
      failedAt: "read",
      reason: expect.stringContaining("resolver bug"),
    });
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^session view declaration threw sid="s1" git: .*resolver bug/,
      ),
    );
    followed.dispose();
  });

  test("a follow whose first document cannot be made throws, having released what it took", () => {
    const { providers, held, released } = owners();
    expect(() =>
      arm(providers, () => {
        throw new Error("no update fact");
      }).follow(viewFacts("/a"), DECLARED),
    ).toThrow("no update fact");
    expect(held).toEqual(["/a"]);
    expect(released).toEqual(["/a"]);
  });

  test("a declaration that throws whole is answered on every lane and logged, and a later declaration that returns takes its holds", () => {
    const { providers, held, released, lines } = owners();
    // The hints are read before any lane declares, outside every lane's own
    // catch: a throw there is the declaration's, not a lane's.
    const broken = viewFacts("/a");
    const hints = Object.defineProperty({ ...broken.hints }, "tmux", {
      get: () => {
        throw new Error("hints bug");
      },
    });
    const followed = arm(providers).follow({ ...broken, hints }, DECLARED);
    expect(followed.stamped().facts.builtins.git).toMatchObject({
      kind: "failed",
      failedAt: "read",
      reason: expect.stringContaining(
        "view declaration threw: Error: hints bug",
      ),
    });
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^session view declaration threw sid="s1": .*hints bug/,
      ),
    );
    expect(held).toEqual([]);

    followed.follow(viewFacts("/a"), DECLARED);
    expect(held).toEqual(["/a"]);
    expect(followed.stamped().facts.builtins.git).toMatchObject({
      kind: "ok",
      value: { branch: "main" },
    });
    followed.dispose();
    expect(released).toEqual(["/a"]);
  });

  test("a fault of the source is a value beside the last document, cleared by the next good stamp, and kept across a turn in which nothing moved", () => {
    const { providers, lines } = owners();
    const broken = observable.box(false);
    const landings = observable.box(0);
    const followed = arm(providers, () => {
      landings.get();
      if (broken.get()) throw new Error("update watch exploded");
      return pendingOf("unread");
    }).follow(viewFacts("/a"), DECLARED);
    const before = followed.stamped();
    expect(followed.failure()).toBeNull();

    runInAction(() => broken.set(true));
    expect(followed.failure()).toContain("update watch exploded");
    expect(followed.stamped()).toBe(before);
    const logged = lines.length;
    // A landing that fails the same way is the same fault: nothing new said.
    runInAction(() => landings.set(1));
    expect(lines.length).toBe(logged);

    runInAction(() => broken.set(false));
    expect(followed.failure()).toBeNull();
    // The line is the one before: no fact moved while the source failed, so
    // the fault clearing stamps nothing a recorder would write.
    expect(followed.stamped()).toBe(before);
    followed.dispose();
  });

  test("a run declared while the stamp is failing answers why, never a pending that will not land, and lands once a stamp succeeds", () => {
    const { providers } = owners();
    const broken = observable.box(false);
    const followed = arm(providers, () => {
      if (broken.get()) throw new Error("update watch exploded");
      return pendingOf("unread");
    }).follow(viewFacts("/a"), DECLARED);
    try {
      runInAction(() => broken.set(true));
      const holds = new Holds();
      const { result: lane } = holds.declare(() =>
        followed.runs.declare(holds, fileRun("/notes/a")),
      );
      expect(lane.current()).toEqual({
        kind: "failed",
        reason: expect.stringMatching(
          /^the run of "\/notes\/a" is in no document: .*update watch exploded/,
        ),
        failedAt: "read",
      });
      runInAction(() => broken.set(false));
      expect(lane.current().kind).not.toBe("failed");
      holds.close();
    } finally {
      followed.dispose();
    }
  });
});

describe("the in-process arm's runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runs-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const follow = () => {
    const runs = new SourceRuns({
      launcher: unscriptedLauncher,
      clock: systemTimekeeper,
    });
    const followed = factsRunning(runs).follow(viewFacts("/a"), DECLARED);
    return { runs, followed };
  };

  test("a run declared through the follow lands in its document and its lane reads it there; the declaration's release ends the run and drops it", async () => {
    const file = path.join(dir, "note");
    fs.writeFileSync(file, "noted");
    const { runs, followed } = follow();
    try {
      const identity = fileRun(file);
      const digest = digestOf(identity);
      const holds = new Holds();
      const { result: lane } = holds.declare(() =>
        followed.runs.declare(holds, identity),
      );
      // Declared, not answered yet: pending in the document and on the lane.
      expect(followed.stamped().facts.runs[digest]).toEqual({
        reading: pendingOf("unread"),
        fault: null,
      });
      expect(lane.current()).toEqual(pendingOf("unread"));
      await until(() => lane.current().kind === "ok", "the run's reading");
      expect(lane.current()).toEqual(ok("noted"));
      expect(followed.stamped().facts.runs[digest]).toMatchObject({
        reading: { kind: "ok", value: "noted" },
        fault: null,
      });
      expect(runs.stats().file.held).toBe(1);
      // A declaration that no longer names it: the run ends, the document
      // drops it, and the lane handed out says so rather than waiting.
      holds.declare(() => {});
      expect(runs.stats().file.held).toBe(0);
      expect(followed.stamped().facts.runs[digest]).toBeUndefined();
      expect(lane.current()).toEqual({
        kind: "failed",
        reason: `the run of "${file}" is not declared by this view`,
        failedAt: "read",
      });
    } finally {
      followed.dispose();
      runs.close();
    }
  });

  test("a registry over the follow keeps a source's old value through a key move until the new run lands, and records no failure", async () => {
    const file = path.join(dir, "note");
    fs.writeFileSync(file, "one");
    const { runs, followed } = follow();
    const store = new VariableStore(systemTimekeeper);
    const registry = new SourceRegistry(followed.runs, store);
    const seen: unknown[] = [];
    const stop = reaction(
      () => (store.has("note") ? store.read("note") : undefined),
      (value) => seen.push(value),
    );
    try {
      registry.declareLiteral("which", "a");
      registry.declareFile("note", file, {
        parse: { kind: "text", default: undefined },
        cache: { kind: "key", template: "{{ .which }}" },
      });
      await until(() => store.read("note") === "one", "the first run");
      fs.writeFileSync(file, "two");
      // The key moves: a new identity, a new run, the old value standing.
      store.setBox("which", "b");
      await until(() => store.read("note") === "two", "the moved key's run");
      // The fallback it is declared with, its first run, the moved key's run:
      // nothing between the two runs.
      expect(seen).toEqual(["", "one", "two"]);
      expect(registry.getLastError("note")).toBeUndefined();
      expect(runs.stats().file.held).toBe(1);
    } finally {
      stop();
      // The view's order: its declarations end before its follow.
      registry.dispose();
      followed.dispose();
      runs.close();
    }
  });

  test("a run's lane hands out one reading while its run holds one value, however often the document is stamped for another run", async () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.writeFileSync(a, "from-a");
    fs.writeFileSync(b, "from-b");
    const { runs, followed } = follow();
    const holds = new Holds();
    try {
      const { result: lane } = holds.declare(() =>
        followed.runs.declare(holds, fileRun(a)),
      );
      // Observed, as a registry's publish observes it.
      const seen: unknown[] = [];
      const stop = reaction(
        () => lane.current(),
        (reading) => seen.push(reading),
        { fireImmediately: true },
      );
      await until(() => lane.current().kind === "ok", "a's run");
      const landed = lane.current();
      // Another run is declared and lands: the document is stamped twice
      // more, and a's reading is the object it was.
      const { result: other } = holds.declare(() => {
        followed.runs.declare(holds, fileRun(a));
        return followed.runs.declare(holds, fileRun(b));
      });
      await until(() => other.current().kind === "ok", "b's run");
      expect(lane.current()).toBe(landed);
      expect(seen).toEqual([pendingOf("unread"), ok("from-a")]);
      stop();
    } finally {
      holds.close();
      followed.dispose();
      runs.close();
    }
  });

  test("a run declaration released after the follow's dispose releases nothing: the dispose ended its run", async () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.writeFileSync(a, "from-a");
    fs.writeFileSync(b, "from-b");
    const { runs, followed } = follow();
    try {
      const holds = new Holds();
      holds.declare(() => {
        followed.runs.declare(holds, fileRun(a));
        followed.runs.declare(holds, fileRun(b));
      });
      expect(runs.stats().file.held).toBe(2);
      followed.dispose();
      expect(runs.stats().file.held).toBe(0);
      expect(() => holds.close()).not.toThrow();
      expect(runs.stats().file.held).toBe(0);
      // A run declared after it would start and never end: refused by name.
      const late = new Holds();
      expect(() =>
        late.declare(() => followed.runs.declare(late, fileRun(a))),
      ).toThrow(
        `the run of "${a}" was declared after its view's follow was disposed`,
      );
      expect(runs.stats().file.held).toBe(0);
    } finally {
      runs.close();
    }
  });

  test("the render event says how many runs the view declared and which have not answered", () => {
    const answered = { reading: restamp(undefined, ok("x"), at0), fault: null };
    expect(runsFactOf({})).toEqual({ runs: "0", runsPending: "-" });
    expect(
      runsFactOf({
        ["a".repeat(64)]: answered,
        ["b".repeat(64)]: { reading: pendingOf("unread"), fault: null },
      }),
    ).toEqual({ runs: "2", runsPending: "bbbbbbb:unread" });
  });

  test("two declarations of one identity share one run, and the follow's dispose ends it", async () => {
    const file = path.join(dir, "note");
    fs.writeFileSync(file, "noted");
    const { runs, followed } = follow();
    const other = follow();
    try {
      const holds = new Holds();
      holds.declare(() => followed.runs.declare(holds, fileRun(file)));
      const otherHolds = new Holds();
      otherHolds.declare(() =>
        other.followed.runs.declare(otherHolds, fileRun(file)),
      );
      expect(runs.stats().file.held).toBe(1);
      followed.dispose();
      expect(runs.stats().file.held).toBe(0);
    } finally {
      other.followed.dispose();
      other.runs.close();
      runs.close();
    }
  });
});

describe("the recording arm", () => {
  const SESSION = sessionIdOf("s1");
  const at = (offsetS: number): Instant =>
    instantOf(new Date(AT.getTime() + offsetS * 1000));
  const line = (
    offsetS: number,
    seq: number,
  ): FactsLine & { readonly kind: "facts" } => ({
    kind: "facts",
    at: at(offsetS),
    facts: {
      ...pendingFacts(SESSION),
      seq,
      builtins: {
        ...pendingFacts(SESSION).builtins,
        hostName: restamp(undefined, ok(`host-${seq}`), at(offsetS)),
      },
    },
  });
  const request = () => viewFacts("/a", "s1");
  // The session, the document it opens on and the documents after it, as the
  // parser hands them over (test/unit/facts-recording.test.ts).
  const recording = (
    opening: FactsLine,
    ...later: ReadonlyArray<ReturnType<typeof line>>
  ) => ({ session: SESSION, opening, lines: later });

  test("a follow's document is the opening one until the walk reaches another, then each line it reaches, whatever instants they carry", () => {
    const lines = [line(0, 1), line(2, 2), line(2, 3), line(1, 1)] as const;
    const facts = recordingFacts(recording(...lines));
    const followed = facts.follow(request(), DECLARED);
    expect(followed.stamped()).toBe(lines[0]);
    // A document stamped at the instant of the one before it, and one of a
    // view the session moved away from, stamped earlier: the walk's order is
    // the recording's.
    for (const reached of lines.slice(1)) {
      facts.reach(reached);
      expect(followed.stamped()).toBe(reached);
    }
    expect(followed.failure()).toBeNull();
  });

  test("a follow taken mid-walk opens on the line reached, and every follow stands at the one place", () => {
    const lines = [line(0, 1), line(2, 2), line(5, 3)] as const;
    const facts = recordingFacts(recording(...lines));
    const first = facts.follow(request(), DECLARED);
    facts.reach(lines[1]);
    const second = facts.follow(request(), DECLARED);
    expect(second.stamped()).toBe(lines[1]);
    facts.reach(lines[2]);
    expect(first.stamped()).toBe(lines[2]);
    expect(second.stamped()).toBe(lines[2]);
  });

  test("a request settles at once with nothing started, and a follow at other keys changes nothing", async () => {
    const followed = recordingFacts(recording(line(0, 1))).follow(
      request(),
      DECLARED,
    );
    const settling = followed.settle(at(0));
    expect(settling.refreshed.size).toBe(0);
    await settling.landed;
    followed.follow(viewFacts("/elsewhere", "s1"), DECLARED);
    expect(followed.stamped().facts.seq).toBe(1);
  });

  test("a run's lane reads the reached document: pending while a later document holds it, failed, naming the run, once none from there on does", () => {
    const identity = fileRun("/notes/a");
    const digest = digestOf(identity);
    const withRun = (offsetS: number, seq: number, value: string) => {
      const l = line(offsetS, seq);
      return {
        ...l,
        facts: {
          ...l.facts,
          runs: {
            [digest]: {
              reading: restamp(undefined, ok(value), at(offsetS)),
              fault: null,
            },
          },
        },
      };
    };
    const lines = [line(0, 1), withRun(1, 2, "first"), line(2, 3)] as const;
    const facts = recordingFacts(recording(...lines));
    const followed = facts.follow(request(), DECLARED);
    const lane = followed.runs.declare(new Holds(), identity);
    expect(lane.current()).toEqual(pendingOf("unread"));
    facts.reach(lines[1]);
    expect(lane.current()).toEqual(ok("first"));
    // Held only before the line reached: it will not land again.
    facts.reach(lines[2]);
    expect(lane.current()).toEqual({
      kind: "failed",
      reason: 'this recording holds no run of "/notes/a" from here on',
      failedAt: "read",
    });
    // Held by no document at all.
    expect(
      followed.runs.declare(new Holds(), fileRun("/notes/b")).current(),
    ).toMatchObject({ kind: "failed" });
  });

  test("a run's lane hands out one reading across lines that hold its run at one value", () => {
    const identity = fileRun("/notes/a");
    const digest = digestOf(identity);
    // Each line parsed anew: equal runs, never one object.
    const withRun = (offsetS: number, seq: number) => {
      const l = line(offsetS, seq);
      return {
        ...l,
        facts: {
          ...l.facts,
          runs: {
            [digest]: {
              reading: restamp(undefined, ok("same"), at(0)),
              fault: null,
            },
          },
        },
      };
    };
    const lines = [withRun(0, 1), withRun(1, 2), withRun(2, 3)] as const;
    const facts = recordingFacts(recording(...lines));
    const lane = facts
      .follow(request(), DECLARED)
      .runs.declare(new Holds(), identity);
    const seen: unknown[] = [];
    const stop = reaction(
      () => lane.current(),
      (reading) => seen.push(reading),
      { fireImmediately: true },
    );
    facts.reach(lines[1]);
    facts.reach(lines[2]);
    stop();
    expect(seen).toEqual([ok("same")]);
  });

  test("the walk reaching a document the recording does not hold throws", () => {
    const facts = recordingFacts(recording(line(0, 1)));
    expect(() => facts.reach(line(1, 2))).toThrow(
      "the walk reached a document this recording does not hold",
    );
  });

  test("a follow of a session the recording does not hold throws naming both", () => {
    expect(() =>
      recordingFacts(recording(line(0, 1))).follow(
        viewFacts("/a", "s2"),
        DECLARED,
      ),
    ).toThrow('this recording holds session "s1", not "s2"');
  });
});
