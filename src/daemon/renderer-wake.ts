// [LAW:no-ambient-temporal-coupling] The host's one timer for a renderer: at
// the instant the renderer last declared it next needs a turn
// (`Subscriptions.wake`), answered with a `due` input. The renderer derives
// that instant from its own state on every turn, so this holds no list of what
// was asked and nothing to forget: each declaration replaces the last, and a
// renderer that restarts declares its own.
//
// While a due waits in the mailbox, declarations are not taken: the turns
// ahead of it read the state it will act on, and the due's own output declares
// what comes after it. After a due turn that threw, no due is made sooner
// than the still period after it until one answers, so a renderer whose due
// keeps throwing, and keeps declaring it due, is not woken at once forever.

import {
  durationHistogram,
  durationsOf,
  recordMs,
  type Histogram,
} from "./durations.js";
import type { Monotonic, Timekeeper } from "../time.js";
import type { Instant } from "../utils/instant.js";
import { instantAt } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger.js";
import { eventLine } from "../utils/logfmt.js";
import { LEVEL } from "./foundations/request-event.js";
import { tookOf, type RendererHost } from "./renderer-host.js";

// [LAW:no-ambient-temporal-coupling] How far the wall clock read as a due is
// made may fall short of the instant its timer was set for when nothing is
// wrong, in seconds: the wall reading is truncated to the millisecond, and a
// system clock being slewed moves the wall against the timer's clock by well
// under a millisecond across the longest wait. A timer firing early is not in
// the bound: it waits the rest out. A due is made for the instant it was set
// for within this of the wall, so a frame set for a change shows it however
// its timer fires, and a wall clock stepped back is followed at the next due.
const TIMER_RESOLUTION_S = 0.002;

// Seconds a due that threw waits before the next: the still period.
const RETRY_S = 1;

// How often the wake writes what its dues cost, in milliseconds.
const SUMMARY_EVERY_MS = 60_000;

type Phase =
  | { readonly kind: "idle" }
  // A timer set for `at`, firing at `moment` on the monotonic clock.
  | {
      readonly kind: "armed";
      readonly at: Instant;
      readonly moment: number;
      readonly clear: () => void;
    }
  // A due in the mailbox, from the moment it was meant for.
  | { readonly kind: "queued"; readonly moment: number };

export interface RendererWakeDeps {
  readonly clock: Pick<Timekeeper, "now" | "monotonic" | "after">;
  readonly host: Pick<RendererHost, "answer" | "name">;
  readonly log: DaemonLogger;
}

export class RendererWake {
  private phase: Phase = { kind: "idle" };
  // What the renderer last declared.
  private wanted: Instant | null = null;
  // While the last due threw: the soonest the next is made.
  private floor: Instant | null = null;
  // [LAW:single-enforcer] The failure the last due said, so one that keeps
  // throwing it says it once, and says its recovery.
  private fault: string | null = null;
  // The daemon's close: nothing is armed after it.
  private closed = false;
  // [LAW:nothing-unseen] How late each due was made after its moment, and how
  // long the renderer's turn took, each in milliseconds.
  private readonly lateness: Histogram = durationHistogram();
  private readonly turns: Histogram = durationHistogram();
  private summarizedAt: Monotonic;

  constructor(private readonly deps: RendererWakeDeps) {
    this.summarizedAt = deps.clock.monotonic();
  }

  // The renderer's declaration, from a turn's output: its next turn at `at`,
  // or none.
  declared(at: Instant | null): void {
    this.wanted = at;
    this.settle();
  }

  // [LAW:dataflow-not-control-flow] The timer follows the declaration, held
  // to the floor a failed due set: moved only when where it falls moves.
  private settle(): void {
    const { phase, wanted, floor } = this;
    if (this.closed || phase.kind === "queued") return;
    const at =
      wanted === null || floor === null
        ? wanted
        : (Math.max(wanted, floor) as Instant);
    if (phase.kind === "armed") {
      if (phase.at === at) return;
      phase.clear();
    }
    this.phase = { kind: "idle" };
    if (at !== null) this.arm(at);
  }

  // The daemon's close: the timer is cleared and none is set again.
  close(): void {
    this.closed = true;
    if (this.phase.kind === "armed") this.phase.clear();
    this.phase = { kind: "idle" };
  }

  // [LAW:single-enforcer] The one timer, set to make a due for `at`. Its wait
  // is measured from one wall reading, and its moment on the monotonic clock
  // is what it fires against, so a wall stepped back cannot stall it.
  private arm(at: Instant, wall: Instant = instantAt(this.deps.clock)): void {
    const wait = (at - wall) * 1000;
    const moment = this.deps.clock.monotonic() + wait;
    this.setTimer(at, moment, Math.max(0, wait));
  }

  private setTimer(at: Instant, moment: number, delay: number): void {
    this.phase = {
      kind: "armed",
      at,
      moment,
      clear: this.deps.clock.after(delay, () => this.fire(at, moment)),
    };
  }

  // [LAW:no-ambient-temporal-coupling] A timer that fires before its moment
  // on the monotonic clock waits out the rest. Node starts a timer from the
  // loop's cached time, so one armed late in a slow callback fires early by as
  // long as that callback ran, with no bound but the machine's load: a due
  // made then would be clamped to the wall, short of `at`, and its frame drawn
  // twice. The wall clock is not asked, so a wall stepped back, which leaves
  // the monotonic moment reached, still fires and is followed by the clamp.
  private fire(at: Instant, moment: number): void {
    const remaining = moment - this.deps.clock.monotonic();
    if (remaining > 0) {
      this.setTimer(at, moment, remaining);
      return;
    }
    this.phase = { kind: "queued", moment };
    void this.due(at, moment);
  }

  private async due(at: Instant, moment: number): Promise<void> {
    const { clock, host, log } = this.deps;
    const turn = await host.answer((wall) => {
      // Made as its slot comes: declarations are taken again from here, so
      // the due's own output declares what follows it.
      this.phase = { kind: "idle" };
      // [LAW:single-enforcer] exception: kept to the microsecond, since a due
      // is read against a frame period of a few ms.
      recordMs(this.lateness, clock.monotonic() - moment);
      return {
        kind: "event",
        at: Math.min(Math.max(at, wall), wall + TIMER_RESOLUTION_S) as Instant,
        event: { kind: "due" },
      };
    });
    if (turn.turnMs !== null) recordMs(this.turns, turn.turnMs);
    const head = [
      ["renderer", host.name],
      ["input", "due"],
      ["took", tookOf(turn.turnMs)],
    ] as const;
    if (turn.kind === "answered") {
      if (turn.record.length > 0)
        log("info", eventLine("turn", [...head, ...turn.record]));
      if (this.fault !== null) {
        log("info", `wake renderer=${host.name} recovered after ${this.fault}`);
        this.fault = null;
      }
      this.floor = null;
      this.settle();
    } else if (turn.failure.kind !== "down") {
      // [LAW:no-silent-failure] Said once while it keeps failing the same way,
      // and made again no sooner than a still period on.
      if (this.fault !== turn.failure.message)
        log(
          LEVEL[turn.failure.kind],
          eventLine("turn", [
            ...head,
            ...turn.record,
            ["error", turn.failure.detail],
          ]),
        );
      this.fault = turn.failure.message;
      this.floor = (instantAt(clock) + RETRY_S) as Instant;
      this.settle();
    }
    // A due no renderer took is the supervisor's to say, and the next
    // renderer's start declares its own wake.
    const now = clock.monotonic();
    if (now - this.summarizedAt >= SUMMARY_EVERY_MS) {
      this.summarizedAt = now;
      log(
        "info",
        `wake renderer=${host.name} lateness=${distributionOf(this.lateness)} turn=${distributionOf(this.turns)}`,
      );
    }
  }
}

// The spread of a wake's timings over its life: for lateness, the spread
// between p50 and the tail is the jitter.
const distributionOf = (h: Histogram): string => {
  const d = durationsOf(h);
  const ms = (v: number): string => v.toFixed(2);
  return d.count === 0
    ? "-"
    : `n:${d.count},p50:${ms(d.p50Ms)},p90:${ms(d.p90Ms)},p99:${ms(d.p99Ms)},max:${ms(d.maxMs)},mean:${ms(d.meanMs)}`;
};
