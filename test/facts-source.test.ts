// The facts source's arms, each alone (src/daemon/facts-source.ts): the
// in-process arm takes and releases a view's holds and stamps its document
// from what the owners hold; the recording arm replays lines under the clock
// it is handed and holds one session. The seam between them, and the
// recorder that writes a session's stream, are held by
// test/facts-seam.test.ts.

import { observable, runInAction } from "mobx";
import {
  inProcessFacts,
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
// A config declaring no plugin source: every built-in is gathered whatever
// the layout places, so a declaration names nothing else.
const DECLARED: FollowDeclaration = { sources: new Map() };

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
  // The session and the document it opens on, as the parser hands them over
  // (test/unit/facts-recording.test.ts).
  const recording = (opening: FactsLine) => ({ session: SESSION, opening });

  test("a follow's document is the opening one until the walk reaches another, then each line it reaches, whatever instants they carry", () => {
    const lines = [line(0, 1), line(2, 2), line(2, 3), line(1, 1)] as const;
    const facts = recordingFacts(recording(lines[0]));
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
    const facts = recordingFacts(recording(lines[0]));
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

  test("a follow of a session the recording does not hold throws naming both", () => {
    expect(() =>
      recordingFacts(recording(line(0, 1))).follow(
        viewFacts("/a", "s2"),
        DECLARED,
      ),
    ).toThrow('this recording holds session "s1", not "s2"');
  });
});
