// The facts source's arms, each alone (src/daemon/facts-source.ts): the
// in-process arm takes and releases a view's holds and stamps its document
// from what the owners hold; the recording arm replays lines under the clock
// it is handed and holds one session; the recorder writes what a follow
// stamps. The seam between them is held by test/facts-seam.test.ts.

import { observable, runInAction } from "mobx";
import {
  inProcessFacts,
  recordedFacts,
  recordingFacts,
  type Facts,
  type FollowDeclaration,
} from "../src/daemon/facts-source";
import type { KeyedOwners } from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { restamp, type Fact } from "../src/facts/fact";
import type { FactsLine } from "../src/facts/recording";
import type { UpdateNotice } from "../src/facts/session-facts";
import type { Holds } from "../src/utils/holds";
import { instantOf, type Instant } from "../src/utils/instant";
import { ok, pendingOf } from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
import { pendingFacts } from "./helpers/facts";
import { heldClock } from "./helpers/held-clock";
import { absentOwners } from "./helpers/payload-owners";
import { viewFacts } from "./helpers/view-facts";

const AT = new Date(1_700_000_000_000);
const GIT = {
  branch: "main",
  status: "clean" as const,
  aheadBehind: ok({ ahead: 0, behind: 0 }),
  head: ok("c0ffee"),
};
const reads = (...paths: string[]): FollowDeclaration => ({
  closure: new Set(paths),
  sources: new Map(),
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
  ): Facts => inProcessFacts({ providers: providers as never, update });

  test("a follow takes the holds its declaration names, a follow at other keys releases the rest, and dispose releases all", () => {
    const { providers, held, released, lines } = owners();
    const followed = arm(providers).follow(viewFacts("/a"), reads("git.branch"));
    expect(held).toEqual(["/a"]);
    expect(followed.stamped().facts.builtins.git).toMatchObject({
      kind: "ok",
      value: { branch: "main" },
    });
    // The same keys again: nothing moves, and nothing is said.
    followed.follow(viewFacts("/a"), reads("git.branch"));
    expect(released).toEqual([]);
    // Another directory: the old repo goes the moment the new is taken.
    followed.follow(viewFacts("/b"), reads("git.branch"));
    expect(held).toEqual(["/a", "/b"]);
    expect(released).toEqual(["/a"]);
    expect(lines.filter((l) => l.startsWith("session view declared"))).toEqual([
      'session view declared sid="s1" acquired=1 released=0 held=1',
      'session view declared sid="s1" acquired=1 released=1 held=1',
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
    const followed = arm(providers).follow(viewFacts("/a"), reads("git.branch"));
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
      }).follow(viewFacts("/a"), reads("git.branch")),
    ).toThrow("no update fact");
    expect(held).toEqual(["/a"]);
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
    }).follow(viewFacts("/a"), reads("git.branch"));
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
});

describe("the recording arm", () => {
  const SESSION = sessionIdOf("s1");
  const at = (offsetS: number): Instant =>
    instantOf(new Date(AT.getTime() + offsetS * 1000));
  const line = (offsetS: number, seq: number): FactsLine => ({
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

  test("each line is the document once the clock reaches its offset from the first, the last of several at one instant winning", () => {
    const clock = heldClock(AT);
    const lines = [line(0, 1), line(0, 2), line(1.5, 3), line(1.5, 4), line(4, 5)];
    const followed = recordingFacts(lines, clock).follow(request(), reads());
    expect(followed.stamped()).toBe(lines[1]);
    clock.advance(1000);
    expect(followed.stamped()).toBe(lines[1]);
    clock.advance(500);
    expect(followed.stamped()).toBe(lines[3]);
    clock.advance(10_000);
    expect(followed.stamped()).toBe(lines[4]);
    expect(followed.failure()).toBeNull();
  });

  test("a follow mid-recording opens on the line the clock has reached and arms only the lines after it; one before the first line throws", () => {
    const clock = heldClock(AT);
    const lines = [line(0, 1), line(2, 2), line(5, 3), line(9, 4)];
    const facts = recordingFacts(lines, clock);
    clock.advance(6000);
    const followed = facts.follow(request(), reads());
    expect(followed.stamped()).toBe(lines[2]);
    expect(clock.pending()).toBe(1);
    clock.advance(2999);
    expect(followed.stamped()).toBe(lines[2]);
    clock.advance(1);
    expect(followed.stamped()).toBe(lines[3]);
    // A second follow at the same instant is at the same place.
    expect(facts.follow(request(), reads()).stamped()).toBe(lines[3]);
    const early = heldClock(new Date(AT.getTime() - 1000));
    expect(() =>
      recordingFacts(lines, early).follow(request(), reads()),
    ).toThrow(/this recording begins at .*, and the clock reads/);
  });

  test("a request settles at once with nothing started, and a follow at other keys changes nothing", async () => {
    const clock = heldClock(AT);
    const followed = recordingFacts([line(0, 1)], clock).follow(
      request(),
      reads(),
    );
    const settling = followed.settle(at(0));
    expect(settling.refreshed.size).toBe(0);
    await settling.landed;
    followed.follow(viewFacts("/elsewhere", "s1"), reads("git.branch"));
    expect(followed.stamped().facts.seq).toBe(1);
  });

  test("dispose clears the timers it armed", () => {
    const clock = heldClock(AT);
    const followed = recordingFacts([line(0, 1), line(2, 2)], clock).follow(
      request(),
      reads(),
    );
    expect(clock.pending()).toBe(1);
    followed.dispose();
    expect(clock.pending()).toBe(0);
  });

  test("a recording holds one session: two are refused, none is refused, and a follow of another throws naming both", () => {
    const clock = heldClock(AT);
    expect(() => recordingFacts([], clock)).toThrow(/holds no line/);
    const other: FactsLine = {
      at: at(1),
      facts: pendingFacts(sessionIdOf("s2")),
    };
    expect(() => recordingFacts([line(0, 1), other], clock)).toThrow(
      /names "s1", "s2"/,
    );
    expect(() =>
      recordingFacts([line(0, 1)], clock).follow(viewFacts("/a", "s2"), reads()),
    ).toThrow('this recording holds session "s1", not "s2"');
  });

  test("a line before the one preceding it is refused by number", () => {
    const clock = heldClock(AT);
    expect(() =>
      recordingFacts([line(0, 1), line(3, 2), line(2, 3)], clock),
    ).toThrow(
      `a recording's lines are in time order, and line 3 (at ${at(2)}) is before line 2 (at ${at(3)})`,
    );
  });

  test("a session followed again (its sequence starting over) replays its reopening document at its instant", () => {
    const clock = heldClock(AT);
    const lines = [line(0, 1), line(1, 2), line(2, 1), line(3, 2)];
    const followed = recordingFacts(lines, clock).follow(request(), reads());
    clock.advance(1000);
    expect(followed.stamped()).toBe(lines[1]);
    clock.advance(1000);
    expect(followed.stamped()).toBe(lines[2]);
    clock.advance(1000);
    expect(followed.stamped()).toBe(lines[3]);
  });
});

describe("the recorder", () => {
  test("writes the opening line and each line the follow stamps, and stops with the follow", () => {
    const SESSION = sessionIdOf("s1");
    const box = observable.box<FactsLine>(
      { at: instantOf(AT), facts: pendingFacts(SESSION) },
      { deep: false },
    );
    let disposed = 0;
    const delegate: Facts = {
      follow: () => ({
        stamped: () => box.get(),
        failure: () => null,
        follow: () => {},
        settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
        dispose: () => {
          disposed++;
        },
      }),
    };
    const recorded: FactsLine[] = [];
    const logged: string[] = [];
    const followed = recordedFacts(
      delegate,
      (l) => recorded.push(l),
      (level, message) => logged.push(`${level} ${message}`),
    ).follow(viewFacts("/a", "s1"), reads());
    const next: FactsLine = {
      at: instantOf(new Date(AT.getTime() + 1000)),
      facts: { ...pendingFacts(SESSION), seq: 2 },
    };
    runInAction(() => box.set(next));
    expect(recorded.map((l) => l.facts.seq)).toEqual([0, 2]);
    expect(recorded[1]).toBe(next);
    expect(logged).toEqual([]);
    followed.dispose();
    expect(disposed).toBe(1);
    runInAction(() => box.set({ ...next, facts: { ...next.facts, seq: 3 } }));
    expect(recorded).toHaveLength(2);
  });

  test("a line the edge cannot write is logged against the session, and the next line is still offered", () => {
    const SESSION = sessionIdOf("s1");
    const box = observable.box<FactsLine>(
      { at: instantOf(AT), facts: pendingFacts(SESSION) },
      { deep: false },
    );
    const delegate: Facts = {
      follow: () => ({
        stamped: () => box.get(),
        failure: () => null,
        follow: () => {},
        settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
        dispose: () => {},
      }),
    };
    const offered: number[] = [];
    const logged: string[] = [];
    recordedFacts(
      delegate,
      (l) => {
        offered.push(l.facts.seq);
        if (l.facts.seq === 2) throw new Error("disk full");
      },
      (level, message) => logged.push(`${level} ${message}`),
    ).follow(viewFacts("/a", "s1"), reads());
    const at = (s: number) => instantOf(new Date(AT.getTime() + s * 1000));
    runInAction(() =>
      box.set({ at: at(1), facts: { ...pendingFacts(SESSION), seq: 2 } }),
    );
    runInAction(() =>
      box.set({ at: at(2), facts: { ...pendingFacts(SESSION), seq: 3 } }),
    );
    expect(offered).toEqual([0, 2, 3]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^error recording sid="s1": .*disk full/);
  });
});
