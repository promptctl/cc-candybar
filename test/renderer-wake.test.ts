// The host's one timer for a renderer (src/daemon/renderer-wake.ts): the
// instant the renderer last declared is answered by one `due` turn made for
// it, and that turn's own declaration sets the next. Over a held clock and a
// host whose turns the case scripts.
//
// [LAW:no-ambient-temporal-coupling] [LAW:behavior-not-structure] A case reads
// the instants the dues were made for, what is armed, and what was said.

import { RendererWake } from "../src/daemon/renderer-wake";
import { failureOf } from "../src/daemon/foundations/verb-error";
import type { HostTurn } from "../src/daemon/renderer-host";
import type { Failure } from "../src/daemon/foundations/verb-error";
import type { EventInput } from "../src/renderer-interface/interface";
import type { Timekeeper } from "../src/time";
import { instantAt, type Instant } from "../src/utils/instant";
import { heldClock } from "./helpers/held-clock";

const START_MS = 1_700_000_000_000;
const T = (START_MS / 1000) as Instant;
const at = (s: number): Instant => (T + s) as Instant;

// A wake over a held clock and a host that answers each due at once. Each
// due turn declares `next(at)` as the renderer's output would, inside its
// slot, and ends as `outcome` says. `firesEarlyMs` makes the first timer fire
// that long before its moment, as one armed late in a slow callback does, and
// `wallOffsetS` moves the wall the wake reads.
// `gate`, while set, holds each due in the mailbox until it settles.
function rig(
  opts: {
    readonly next?: (made: Instant) => Instant | null;
    readonly firesEarlyMs?: number;
  } = {},
) {
  const held = heldClock(new Date(START_MS));
  const state = {
    wallOffsetS: 0,
    outcome: null as Failure | null,
    gate: null as Promise<void> | null,
    turnMs: 1,
  };
  let armed = 0;
  const clock: Pick<Timekeeper, "now" | "monotonic" | "after"> = {
    now: () => held.now() + state.wallOffsetS * 1000,
    monotonic: held.monotonic,
    after: (ms, fire) => {
      const early = armed++ === 0 ? (opts.firesEarlyMs ?? 0) : 0;
      return held.after(Math.max(0, ms - early), fire);
    },
  };
  const made: Instant[] = [];
  const log: string[] = [];
  let next = opts.next ?? (() => null);
  let wake: RendererWake;
  const answer = async (
    make: (at: Instant) => EventInput | Failure,
  ): Promise<HostTurn> => {
    if (state.gate !== null) await state.gate;
    const input = make(instantAt(clock));
    if (input.kind !== "event") throw new Error("a due is always made");
    made.push(input.at);
    wake.declared(next(input.at));
    const ended = state.outcome;
    return {
      ...(ended === null
        ? { kind: "answered" as const }
        : { kind: "threw" as const, failure: ended }),
      effects: [],
      record: [],
      queuedMs: 0,
      turnMs: ended?.kind === "down" ? null : state.turnMs,
      hopMs: null,
      settled: [],
    };
  };
  wake = new RendererWake({
    clock,
    host: { name: "main", answer },
    log: (level, line) => log.push(`${level} ${line}`),
  });
  return {
    wake,
    held,
    declares: (each: (made: Instant) => Instant | null) => (next = each),
    state,
    made,
    log,
    // The seconds after T each due was made for, to the microsecond.
    madeAt: () => made.map((m) => Math.round((m - T) * 1e6) / 1e6),
  };
}

test("a declared instant is answered by one due made for it, and the due's own declaration sets the next", async () => {
  const r = rig({ next: (made) => (made + 0.1) as Instant });
  r.wake.declared(at(0.1));
  await r.held.settle(99);
  expect(r.made).toEqual([]);
  await r.held.settle(1);
  expect(r.madeAt()).toEqual([0.1]);
  // A millisecond over: an instant this late in the epoch carries float noise
  // well under one.
  await r.held.settle(201);
  expect(r.madeAt()).toEqual([0.1, 0.2, 0.3]);
});

test("a declaration replaces the last, and a declaration of none leaves no timer", async () => {
  const r = rig();
  r.wake.declared(at(1));
  r.wake.declared(at(0.5));
  await r.held.settle(600);
  expect(r.madeAt()).toEqual([0.5]);
  expect(r.held.pending()).toBe(0);
  r.wake.declared(at(2));
  r.wake.declared(null);
  expect(r.held.pending()).toBe(0);
});

test("an instant already past is made at once, for the wall it is made at", async () => {
  const r = rig();
  await r.held.settle(500);
  r.wake.declared(at(0.1));
  await r.held.settle(0);
  expect(r.madeAt()).toEqual([0.5]);
});

// The turns ahead of a due read the state it acts on: what they declare is
// re-derived by the due's own turn.
test("while a due waits in the mailbox no declaration is taken, and the due's own declares what follows", async () => {
  let open = (): void => {};
  const r = rig({ next: (made) => (made < at(1) ? at(1) : null) });
  r.state.gate = new Promise<void>((resolve) => (open = resolve));
  r.wake.declared(at(0.1));
  await r.held.settle(100);
  expect(r.held.pending()).toBe(0);
  r.wake.declared(at(0.2));
  expect(r.held.pending()).toBe(0);
  r.state.gate = null;
  open();
  await r.held.settle(0);
  expect(r.madeAt()).toEqual([0.1]);
  await r.held.settle(901);
  expect(r.madeAt()).toEqual([0.1, 1]);
});

test("a timer that fires before its moment waits out the rest, and the due is made once, for its instant", async () => {
  const r = rig({ firesEarlyMs: 5 });
  r.wake.declared(at(0.1));
  await r.held.settle(96);
  expect(r.made).toEqual([]);
  await r.held.settle(10);
  expect(r.madeAt()).toEqual([0.1]);
});

test("a wall clock stepped back while a timer waits is followed: the due is made for the wall it fires at", async () => {
  const r = rig();
  r.wake.declared(at(1));
  r.state.wallOffsetS = -10;
  await r.held.settle(1000);
  expect(r.madeAt()).toEqual([1 - 10 + 0.002]);
});

test("a due that throws is said once while it keeps throwing, made again no sooner than a still period on, and its recovery said", async () => {
  // A renderer whose due keeps declaring itself due at once.
  const r = rig({ next: (made) => made });
  r.state.outcome = failureOf(new Error("the walk broke"));
  r.wake.declared(at(0));
  await r.held.settle(3500);
  expect(r.madeAt()).toEqual([0, 1, 2, 3]);
  expect(r.log.filter((l) => l.startsWith("error "))).toEqual([
    expect.stringMatching(
      /^error turn renderer=main input=due took=\S+ error=.*the walk broke/,
    ),
  ]);
  r.state.outcome = null;
  r.declares(() => null);
  await r.held.settle(500);
  expect(r.log).toContain(
    "info wake renderer=main recovered after the walk broke",
  );
});

test("a due no renderer took is not said here, and nothing is armed until the next renderer declares", async () => {
  const r = rig({ next: (made) => (made < at(5) ? at(5) : null) });
  r.state.outcome = { kind: "down", message: "gone", detail: "gone" };
  r.wake.declared(at(0));
  await r.held.settle(0);
  expect(r.log).toEqual([]);
  // The due's turn declared through a renderer that is gone: its start's
  // declaration is the one that counts.
  r.wake.declared(at(2));
  await r.held.settle(2000);
  expect(r.madeAt()).toEqual([0, 2]);
});

test("once a minute it says how late its dues were made and how long their turns took", async () => {
  const r = rig({ next: (made) => (made + 1) as Instant });
  r.wake.declared(at(1));
  await r.held.settle(61_000);
  expect(r.log.filter((l) => l.startsWith("info wake "))).toEqual([
    expect.stringMatching(
      /^info wake renderer=main lateness=n:60,p50:0\.00,.* turn=n:60,p50:1\.00,/,
    ),
  ]);
});

test("its close clears the timer, and nothing is armed after it", async () => {
  const r = rig();
  r.wake.declared(at(1));
  r.wake.close();
  expect(r.held.pending()).toBe(0);
  r.wake.declared(at(2));
  await r.held.settle(3000);
  expect(r.made).toEqual([]);
  expect(instantAt(r.held)).toBe(at(3));
});
