// [LAW:no-ambient-temporal-coupling] A renderer's one timer
// (src/daemon/renderer-wake.ts), over a held clock: each output's declared
// wake arms it, it hands the renderer a `due` through the mailbox no sooner
// than the instant declared, and a due that keeps throwing is spaced and said
// once, never a spin.

import {
  DUE_AFTER_THROW_MS,
  RendererWake,
  TIMER_RESOLUTION_S,
} from "../../src/daemon/renderer-wake";
import type { HostTurn, MakeOrFail } from "../../src/daemon/renderer-host";
import {
  DaemonClosing,
  failureOf,
  type Failure,
} from "../../src/daemon/foundations/verb-error";
import type { EventInput } from "../../src/renderer-interface/interface";
import type { Instant } from "../../src/utils/instant";
import { heldClock } from "../helpers/held-clock";

const START_MS = 1_700_000_000_000;
const T0 = START_MS / 1000;
const at = (ms: number): Instant => (T0 + ms / 1000) as Instant;

const turn = (over: Partial<HostTurn> = {}): HostTurn =>
  ({
    kind: "answered",
    effects: [],
    record: [],
    settled: [],
    queuedMs: 0,
    turnMs: 2,
    hopMs: 0,
    ...over,
  }) as HostTurn;
const THREW = turn({
  kind: "threw",
  failure: failureOf(new Error("the walk broke")),
} as Partial<HostTurn>);

// A wake over a held clock whose wall reads `short` ms behind it for the next
// reads, and a mailbox that makes each due as its slot comes, `slotLateMs`
// after the timer fired, or holds it while `holding`.
function rig() {
  const clock = heldClock(new Date(START_MS));
  const state = {
    shorts: [] as number[],
    slotLateMs: 0,
    holding: false,
    answer: turn(),
    held: [] as MakeOrFail[],
  };
  const made: Array<EventInput | Failure> = [];
  const logged: string[] = [];
  const make = (m: MakeOrFail): HostTurn => {
    made.push(m(((clock.now() + state.slotLateMs) / 1000) as Instant));
    return state.answer;
  };
  const wake = new RendererWake({
    clock: {
      ...clock,
      now: () => clock.now() - (state.shorts.shift() ?? 0),
    },
    due: async (m) => {
      if (state.holding) {
        state.held.push(m);
        return state.answer;
      }
      return make(m);
    },
    log: (level, line) => logged.push(`${level} ${line}`),
  });
  const declare = (
    wakeAt: Instant | null,
    due: { due: Instant | null; threw: boolean } = { due: null, threw: false },
  ) =>
    wake.declare({
      subscriptions: { sources: {}, lanes: {}, wake: wakeAt },
      turn: due,
    });
  const dueAt = () =>
    made.map((m) => ("kind" in m && m.kind === "event" ? m.at : m));
  // Moves the clock `ms`, firing each timer due, then lets what each due's
  // answer queued settle: microtasks alone, as the mailbox here answers at
  // once.
  const step = async (ms: number): Promise<void> => {
    clock.advance(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { clock, state, made, logged, wake, declare, dueAt, make, step };
}

test("a declared wake hands the renderer one due at the instant declared, through the mailbox", async () => {
  const r = rig();
  r.declare(at(100));
  await r.step(99);
  expect(r.made).toEqual([]);
  await r.step(1);
  expect(r.made).toEqual([
    { kind: "event", at: at(100), event: { kind: "due" } },
  ]);
});

test("each declaration replaces the last: one timer, to the latest", async () => {
  const r = rig();
  r.declare(at(100));
  r.declare(at(300));
  expect(r.clock.pending()).toBe(1);
  await r.step(300);
  expect(r.dueAt()).toEqual([at(300)]);
  r.declare(at(400));
  r.declare(null);
  expect(r.clock.pending()).toBe(0);
});

test("a timer that fires before the wall reaches its instant waits out the rest, and hands in one due", async () => {
  const r = rig();
  r.declare(at(100));
  // The wall reads 5 ms behind the timer's moment as it fires.
  r.state.shorts = [5, 5];
  await r.step(100);
  expect(r.made).toEqual([]);
  await r.step(5);
  // [LAW:no-ambient-temporal-coupling] One due, never before its instant.
  expect(r.made).toHaveLength(1);
  expect(r.dueAt()[0]).toBeGreaterThanOrEqual(at(100));
});

test("a timer early by less than its resolution counts as come, and its due is handed in at the instant declared", async () => {
  const r = rig();
  r.declare(at(100));
  const earlyMs = TIMER_RESOLUTION_S * 1000 - 1;
  r.state.shorts = [earlyMs];
  // Its slot comes as early as the timer fired.
  r.state.slotLateMs = -earlyMs;
  await r.step(100);
  expect(r.dueAt()).toEqual([at(100)]);
});

test("a due whose slot comes late is handed in at its slot's instant, its lateness counted", async () => {
  const r = rig();
  r.declare(at(100));
  r.state.slotLateMs = 40;
  await r.step(100);
  expect(r.dueAt()).toEqual([at(140)]);
  r.wake.close();
  expect(r.logged.at(-1)).toBe(
    "info wake dues=1 late=40.0ms/max40ms turn=2.0ms/max2ms",
  );
});

test("while a due waits in the mailbox, what other turns declare is moot: its own turn declares as it ends", async () => {
  const r = rig();
  r.state.holding = true;
  r.declare(at(100));
  await r.step(100);
  r.declare(at(150));
  expect(r.clock.pending()).toBe(0);
  r.make(r.state.held[0]!);
  r.declare(at(200));
  expect(r.clock.pending()).toBe(1);
});

test("a due that threw holds the next one off, and a throw that repeats is said once", async () => {
  const r = rig();
  r.state.answer = THREW;
  r.declare(at(100));
  await r.step(100);
  // The due's own turn declares the same instant again.
  r.declare(at(100), { due: at(100), threw: true });
  await r.step(DUE_AFTER_THROW_MS - 1);
  expect(r.made).toHaveLength(1);
  await r.step(1);
  expect(r.made).toHaveLength(2);
  r.declare(at(1100), { due: at(1100), threw: true });
  await r.step(DUE_AFTER_THROW_MS);
  expect(r.made).toHaveLength(3);
  expect(r.logged.filter((l) => l.startsWith("error wake: due threw"))).toHaveLength(1);
  // A due that answers clears it: the next throw is said again.
  r.state.answer = turn();
  r.declare(at(2200));
  await r.step(100);
  r.state.answer = THREW;
  r.declare(at(2300));
  await r.step(100);
  expect(r.logged.filter((l) => l.startsWith("error wake: due threw"))).toHaveLength(2);
});

test("a due no renderer took is the supervisor's to say, and the next renderer's start declares its own", async () => {
  const r = rig();
  r.state.answer = turn({
    kind: "threw",
    failure: { ...failureOf(new Error("down")), kind: "down" },
  } as Partial<HostTurn>);
  r.declare(at(100));
  await r.step(100);
  expect(r.logged).toEqual([]);
  expect(r.clock.pending()).toBe(0);
});

test("after the close, no due is armed, and one whose slot comes after it is refused as it is made", async () => {
  const r = rig();
  r.state.holding = true;
  r.declare(at(100));
  await r.step(100);
  r.wake.close();
  r.declare(at(200));
  expect(r.clock.pending()).toBe(0);
  r.make(r.state.held[0]!);
  const refused = failureOf(new DaemonClosing("due"));
  expect(r.made).toEqual([
    expect.objectContaining({ kind: refused.kind, message: refused.message }),
  ]);
});

test("the dues' cost is said once a minute, not once a due", async () => {
  const r = rig();
  for (let ms = 1000; ms <= 61_000; ms += 1000) {
    r.declare(at(ms));
    await r.step(1000);
  }
  expect(r.made).toHaveLength(61);
  expect(r.logged.filter((l) => l.startsWith("info wake dues="))).toHaveLength(1);
});
