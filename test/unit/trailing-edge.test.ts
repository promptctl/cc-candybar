// [LAW:behavior-not-structure] The contract is what a trigger MEANS, not how the
// flags are stored: a trigger that arrives while a key's work is out must cause
// exactly one more pass — not a second parallel pass, and not nothing. Both
// production callers (the git cache's refresh path, the var-system's shell/file
// reads) rest on that sentence, so it is asserted here once rather than twice
// through their own machinery.
//
// Every wait below is on a promise the helper or the test controls. There is no
// sleep and no tick count: a mechanism whose whole purpose is to stop losing
// races cannot be tested by winning one.

import { TrailingEdge, type Trigger } from "../../src/utils/trailing-edge";

// A pass whose completion the test decides, and which records that it ran.
function controllable() {
  const calls: Array<() => void> = [];
  const started: Array<Promise<void>> = [];
  const work = (): Promise<void> => {
    const promise = new Promise<void>((resolve) => calls.push(resolve));
    started.push(promise);
    return promise;
  };
  return {
    work,
    // How many passes have begun.
    get passes(): number {
      return calls.length;
    },
    // Let pass `i` finish, then yield the microtask queue so the loop advances.
    finish: async (i: number): Promise<void> => {
      calls[i]!();
      await started[i];
      await Promise.resolve();
    },
  };
}

function started(trigger: Trigger): Promise<void> {
  if (trigger.kind !== "started") throw new Error("expected a started trigger");
  return trigger.done;
}

describe("TrailingEdge", () => {
  it("an idle key starts one pass and hands back its completion", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const done = started(edge.run("k", w.work));
    expect(w.passes).toBe(1);
    expect(edge.size).toBe(1);

    await w.finish(0);
    await done;
    expect(w.passes).toBe(1);
    expect(edge.size).toBe(0);
  });

  it("triggers during a pass collapse into exactly one more pass", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const done = started(edge.run("k", w.work));
    // Ten triggers while the first pass is out. Ten means the same thing as one:
    // the inputs changed and the work must be redone once with current ones.
    for (let i = 0; i < 10; i++) {
      expect(edge.run("k", w.work)).toEqual({ kind: "queued" });
    }
    expect(w.passes).toBe(1);

    await w.finish(0);
    expect(w.passes).toBe(2);

    await w.finish(1);
    await done;
    expect(w.passes).toBe(2);
    expect(edge.size).toBe(0);
  });

  it("a share during a pass joins that pass and queues none", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const done = started(edge.run("k", w.work));
    // An ask (a period's tick) carries no news that the answer changed: the
    // pass already out answers it.
    // Its end is the starter's to hear, so the share hands back nothing.
    expect(edge.share("k", w.work)).toBeUndefined();
    expect(w.passes).toBe(1);

    await w.finish(0);
    await done;
    expect(w.passes).toBe(1);
    expect(edge.size).toBe(0);
  });

  it("a share on an idle key starts a pass, and a change during it still queues one", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const shared = edge.share("k", w.work);
    expect(shared).toBeInstanceOf(Promise);
    expect(w.passes).toBe(1);
    expect(edge.run("k", w.work)).toEqual({ kind: "queued" });

    await w.finish(0);
    expect(w.passes).toBe(2);
    await w.finish(1);
    await shared;
    expect(w.passes).toBe(2);
  });

  it("the started promise resolves only after the queued pass has run", async () => {
    const edge = new TrailingEdge();
    const w = controllable();
    let resolved = false;

    const done = started(edge.run("k", w.work)).then(() => {
      resolved = true;
    });
    edge.run("k", w.work);

    await w.finish(0);
    // The first pass is complete, but the trigger it collided with has not been
    // honoured yet — so a caller awaiting this (settled(), via `track`) must
    // still be waiting. This is the assertion that makes the promise worth
    // handing back at all.
    expect(resolved).toBe(false);
    expect(w.passes).toBe(2);

    await w.finish(1);
    await done;
    expect(resolved).toBe(true);
  });

  it("a trigger after the loop has exited starts a fresh pass", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const first = started(edge.run("k", w.work));
    await w.finish(0);
    await first;

    const second = started(edge.run("k", w.work));
    expect(w.passes).toBe(2);
    await w.finish(1);
    await second;
  });

  it("clear() drops a queued pass: teardown honours no further trigger", async () => {
    const edge = new TrailingEdge();
    const w = controllable();

    const done = started(edge.run("k", w.work));
    edge.run("k", w.work);
    edge.clear();

    await w.finish(0);
    await done;
    // The pass that was out still ran to completion — clear() cannot cancel an
    // await it does not own — but the queued one never happened.
    expect(w.passes).toBe(1);
    expect(edge.size).toBe(0);
  });

  it("a loop clear() let go leaves the key's next loop its own: it takes none of its queued passes and ends none of its records", async () => {
    const edge = new TrailingEdge();
    const old = controllable();
    const next = controllable();

    const oldDone = started(edge.run("k", old.work));
    edge.clear();
    const nextDone = started(edge.run("k", next.work));
    expect(edge.run("k", next.work)).toEqual({ kind: "queued" });

    await old.finish(0);
    await oldDone;
    // The orphan ran its one pass and left the next loop's queued one to it.
    expect(old.passes).toBe(1);
    expect(edge.size).toBe(1);
    expect(edge.run("k", next.work)).toEqual({ kind: "queued" });

    await next.finish(0);
    expect(next.passes).toBe(2);
    await next.finish(1);
    await nextDone;
    expect(edge.size).toBe(0);
  });

  it("keys are independent: one key's pass does not serialize another's", async () => {
    const edge = new TrailingEdge();
    const a = controllable();
    const b = controllable();

    const doneA = started(edge.run("a", a.work));
    const doneB = started(edge.run("b", b.work));
    expect(a.passes).toBe(1);
    expect(b.passes).toBe(1);
    expect(edge.size).toBe(2);

    await a.finish(0);
    await doneA;
    expect(edge.size).toBe(1);

    await b.finish(0);
    await doneB;
    expect(edge.size).toBe(0);
  });

  it("a pass that throws still runs the pass queued behind it, and the loop throws what it threw", async () => {
    const edge = new TrailingEdge();
    const broke = new Error("the pass broke");
    let passes = 0;
    let fail: (thrown: unknown) => void = () => {};
    const work = (): Promise<void> => {
      passes++;
      return passes === 1
        ? new Promise<void>((_, reject) => (fail = reject))
        : Promise.resolve();
    };

    const done = started(edge.run("k", work));
    expect(edge.run("k", work).kind).toBe("queued");
    fail(broke);

    await expect(done).rejects.toBe(broke);
    expect(passes).toBe(2);
    expect(edge.size).toBe(0);
  });
});
