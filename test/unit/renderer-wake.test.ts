// The renderer's one timer (src/daemon/renderer-wake.ts): armed at the tick
// its outputs declare, kept when the same tick is declared again, waiting out
// a timer that fires early, holding a failed `due`'s next try a second off
// and saying so once, making no `due` once closed, and summarizing what its
// dues took.

import {
  FAILED_DUE_HOLD_S,
  RendererWake,
  type DueEnded,
} from "../../src/daemon/renderer-wake";
import type { Monotonic } from "../../src/time";
import { handClock } from "../helpers/hand-clock";
import type { Tick } from "../../src/utils/instant";
import type { Failure } from "../../src/daemon/foundations/verb-error";

const answered: DueEnded = { kind: "answered", queuedMs: 0, turnMs: 2 };

const failure = (kind: Failure["kind"]): DueEnded => ({
  kind: "threw",
  failure: { kind, message: "it broke", detail: "it broke" },
  queuedMs: 0,
  turnMs: kind === "down" ? null : 2,
});

// A wake over a held clock: each timer set is recorded with the monotonic
// moment it was set to fire at, and each `due` answers as `ends` says, after
// `waits` ms in the mailbox.
function rig(
  ends: () => DueEnded = () => answered,
  waits = 0,
  onLog: (text: string) => void = () => {},
) {
  const clock = { ms: 0 };
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const dues: number[] = [];
  const said: string[] = [];
  const logged: string[] = [];
  // What the wake's tasks threw, as the daemon's clock reports them.
  const threw: Array<{ task: string; thrown: unknown }> = [];
  const wake = new RendererWake({
    task: "renderer wake",
    clock: handClock(
      {
        now: () => 0,
        monotonic: () => clock.ms as Monotonic,
        timer: (ms, run) => {
          const timer = { at: clock.ms + ms, run, cancelled: false };
          timers.push(timer);
          return () => void (timer.cancelled = true);
        },
      },
      (task, thrown) => threw.push({ task, thrown }),
    ),
    due: async () => {
      clock.ms += waits;
      dues.push(clock.ms / 1000);
      return { ...ends(), queuedMs: waits };
    },
    said: (text) => void said.push(text),
    log: (text) => {
      logged.push(text);
      onLog(text);
    },
  });
  const live = () => timers.filter((t) => !t.cancelled);
  // Fires the live timer at the moment it was set for, or at `ms`.
  const fire = async (ms?: number) => {
    const timer = live().at(-1)!;
    clock.ms = ms ?? timer.at;
    timer.cancelled = true;
    timer.run();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { wake, clock, timers, live, dues, said, logged, threw, fire };
}

const tick = (s: number) => s as Tick;

test("a declared tick arms one timer, kept when the same tick is declared again", () => {
  const r = rig();
  r.wake.declare(tick(2));
  r.wake.declare(tick(2));
  expect(r.timers).toHaveLength(1);
  expect(r.live()[0]!.at).toBe(2000);
  r.wake.declare(tick(1));
  expect(r.live().map((t) => t.at)).toEqual([1000]);
  r.wake.declare(null);
  expect(r.live()).toEqual([]);
});

test("a timer that fires early waits out the rest, and the `due` is made at the tick", async () => {
  const r = rig();
  r.wake.declare(tick(2));
  await r.fire(1990);
  expect(r.dues).toEqual([]);
  expect(r.live().map((t) => t.at)).toEqual([2000]);
  await r.fire();
  expect(r.dues).toEqual([2]);
});

test("what is declared while a `due` is out is armed once it has answered", async () => {
  let answer: (ended: DueEnded) => void = () => {};
  const r = rig();
  const wake = new RendererWake({
    task: "renderer wake",
    clock: handClock({
      now: () => 0,
      monotonic: () => r.clock.ms as Monotonic,
      timer: (ms, run) => {
        const timer = { at: r.clock.ms + ms, run, cancelled: false };
        r.timers.push(timer);
        return () => void (timer.cancelled = true);
      },
    }),
    due: () => new Promise<DueEnded>((resolve) => (answer = resolve)),
    said: () => {},
    log: () => {},
  });
  wake.declare(tick(1));
  r.clock.ms = 1000;
  r.timers[0]!.run();
  wake.declare(tick(3));
  expect(r.timers).toHaveLength(1);
  answer(answered);
  await Promise.resolve();
  expect(r.timers.map((t) => t.at)).toEqual([1000, 3000]);
});

test("a `due` that failed holds every later wake a second off, said once for the run", async () => {
  let ends: DueEnded = failure("threw");
  const r = rig(() => ends);
  r.wake.declare(tick(1));
  await r.fire();
  // The renderer still wants the tick it failed at: held to a second after.
  expect(r.live().map((t) => t.at)).toEqual([1000 + FAILED_DUE_HOLD_S * 1000]);
  await r.fire();
  expect(r.dues).toEqual([1, 2]);
  expect(r.said).toEqual([
    expect.stringMatching(/the renderer's due turn failed.*it broke/),
  ]);
  // The run ends with a `due` that answers, and a later failure is said again.
  ends = answered;
  await r.fire();
  ends = failure("threw");
  r.wake.declare(tick(10));
  await r.fire();
  expect(r.said).toHaveLength(2);
});

test("a failed `due` that waited past its tick is held a second from when it answered", async () => {
  const r = rig(() => failure("threw"), 3000);
  r.wake.declare(tick(1));
  await r.fire();
  // Waited in the mailbox until 4s: the next try is a second after that.
  expect(r.dues).toEqual([4]);
  expect(r.live().map((t) => t.at)).toEqual([4000 + FAILED_DUE_HOLD_S * 1000]);
});

test("a failed `due` whose turn declares a later tick is armed for it unheld, and one declaring none later is held; the run is said once", async () => {
  // Each turn declares tick 5, as the host takes a turn's wake before the
  // `due` it answered resolves.
  const r: ReturnType<typeof rig> = rig(() => {
    r.wake.declare(tick(5));
    return failure("threw");
  });
  r.wake.declare(tick(1));
  await r.fire();
  // Its owners moved on: armed for the tick it declared.
  expect(r.live().map((t) => t.at)).toEqual([5000]);
  await r.fire();
  // The due at 5 declared 5 again: nothing moved on, so it is held.
  expect(r.live().map((t) => t.at)).toEqual([5000 + FAILED_DUE_HOLD_S * 1000]);
  expect(r.said).toHaveLength(1);
});

test("a tick further off than Node's longest timer arms the longest, which waits out the rest", async () => {
  const r = rig();
  r.wake.declare(tick(60 * 60 * 24 * 365));
  expect(r.live().map((t) => t.at)).toEqual([2 ** 31 - 1]);
  await r.fire();
  expect(r.dues).toEqual([]);
  expect(r.live()).toHaveLength(1);
});

test("a `due` that rejected is heard as one that failed: said, and the wake arms again", async () => {
  const r = rig(() => {
    throw new Error("the record broke");
  });
  r.wake.declare(tick(1));
  await r.fire();
  expect(r.said).toEqual([expect.stringMatching(/the record broke/)]);
  expect(r.live().map((t) => t.at)).toEqual([1000 + FAILED_DUE_HOLD_S * 1000]);
});

test("a `due` no renderer was live to take leaves the wake idle for the next renderer's start", async () => {
  const r = rig(() => failure("down"));
  r.wake.declare(tick(1));
  await r.fire();
  expect(r.live()).toEqual([]);
  expect(r.said).toEqual([]);
});

test("a closed wake cancels its timer and summarizes the due's turn and mailbox time", async () => {
  const r = rig(() => answered, 200);
  r.wake.declare(tick(1));
  await r.fire();
  r.wake.close();
  expect(r.wake.closed()).toBe(true);
  expect(r.live()).toEqual([]);
  r.wake.declare(tick(2));
  expect(r.live()).toEqual([]);
  expect(r.logged).toEqual([
    expect.stringMatching(
      /^wake closed for=1s dues=1 failed=0 took=n:1,.* queuedMaxMs=200 tookHistogram=\S+$/,
    ),
  ]);
});

test("a failing wake summary leaves the next due armed, and reaches the clock", async () => {
  const r: ReturnType<typeof rig> = rig(
    () => {
      r.wake.declare(tick(61));
      return answered;
    },
    0,
    (text) => {
      if (text.startsWith("wake running")) throw new Error("summary failed");
    },
  );
  r.wake.declare(tick(60));
  await r.fire();
  expect(r.live().map((timer) => timer.at)).toEqual([61_000]);
  expect(r.threw).toEqual([
    { task: "renderer wake", thrown: new Error("summary failed") },
  ]);
});
