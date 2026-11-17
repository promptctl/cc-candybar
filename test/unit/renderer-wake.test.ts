// The renderer's one timer (src/daemon/renderer-wake.ts): armed at the tick
// its outputs declare, kept when the same tick is declared again, waiting out
// a timer that fires early, holding a failed `due`'s next try a second off
// and saying so once, and making no `due` once closed.

import {
  FAILED_DUE_HOLD_S,
  RendererWake,
  type WakeDeps,
} from "../../src/daemon/renderer-wake";
import type { Monotonic } from "../../src/time";
import type { Tick } from "../../src/utils/instant";
import type { Failure } from "../../src/daemon/foundations/verb-error";

type Ended = Awaited<ReturnType<WakeDeps["due"]>>;

const failure = (kind: Failure["kind"]): Ended => ({
  kind: "threw",
  failure: { kind, message: "it broke", detail: "it broke" },
});

// A wake over a held clock: each timer set is recorded with the monotonic
// moment it was set to fire at, and each `due` answers as `ends` says.
function rig(ends: () => Ended = () => ({ kind: "answered" })) {
  const clock = { ms: 0 };
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> =
    [];
  const dues: number[] = [];
  const said: string[] = [];
  const wake = new RendererWake({
    clock: {
      monotonic: () => clock.ms as Monotonic,
      after: (ms, run) => {
        const timer = { at: clock.ms + ms, run, cancelled: false };
        timers.push(timer);
        return () => void (timer.cancelled = true);
      },
    },
    due: async () => {
      dues.push(clock.ms / 1000);
      return ends();
    },
    said: (text) => void said.push(text),
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
  return { wake, clock, timers, live, dues, said, fire };
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
  let answer: (ended: Ended) => void = () => {};
  const r = rig();
  const wake = new RendererWake({
    clock: {
      monotonic: () => r.clock.ms as Monotonic,
      after: (ms, run) => {
        const timer = { at: r.clock.ms + ms, run, cancelled: false };
        r.timers.push(timer);
        return () => void (timer.cancelled = true);
      },
    },
    due: () => new Promise<Ended>((resolve) => (answer = resolve)),
    said: () => {},
  });
  wake.declare(tick(1));
  r.clock.ms = 1000;
  r.timers[0]!.run();
  wake.declare(tick(3));
  expect(r.timers).toHaveLength(1);
  answer({ kind: "answered" });
  await Promise.resolve();
  expect(r.timers.map((t) => t.at)).toEqual([1000, 3000]);
});

test("a `due` that failed holds every later wake a second off, said once for the run", async () => {
  let ends: Ended = failure("threw");
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
  ends = { kind: "answered" };
  await r.fire();
  ends = failure("threw");
  r.wake.declare(tick(10));
  await r.fire();
  expect(r.said).toHaveLength(2);
});

test("a `due` no renderer was live to take leaves the wake idle for the next renderer's start", async () => {
  const r = rig(() => failure("down"));
  r.wake.declare(tick(1));
  await r.fire();
  expect(r.live()).toEqual([]);
  expect(r.said).toEqual([]);
});

test("a closed wake arms nothing, and a timer it held is let go", () => {
  const r = rig();
  r.wake.declare(tick(1));
  r.wake.close();
  expect(r.wake.closed()).toBe(true);
  expect(r.live()).toEqual([]);
  r.wake.declare(tick(2));
  expect(r.live()).toEqual([]);
});
