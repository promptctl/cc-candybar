// [LAW:no-ambient-temporal-coupling] A renderer's one timer. Every output
// declares the instant the renderer next wants a turn at
// (`Subscriptions.wake`), derived from its own state; the wake keeps one timer
// to the latest declaration and, when it comes, hands the renderer a `due`
// through its mailbox, ordered against every other input. The renderer holds
// no timer of its own, so everything it does in time (a feed's frame, a menu's
// idle close, a torn write's settle, the next entry of a reload walk) is a
// turn the host runs.

import type { Instant } from "../utils/instant.js";
import type { Monotonic, Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger.js";
import {
  DaemonClosing,
  failureOf,
  type Failure,
} from "./foundations/verb-error.js";
import type { Declared, HostTurn, MakeOrFail } from "./renderer-host.js";

// How soon a due after one that threw may come: a renderer whose due keeps
// throwing declares the same instant again, and would otherwise be handed a
// due at once forever.
export const DUE_AFTER_THROW_MS = 1000;

// How often the wake says what its dues cost, in milliseconds.
const SUMMARY_EVERY_MS = 60_000;

type State =
  | { readonly kind: "idle" }
  | {
      readonly kind: "armed";
      readonly at: Instant;
      // [LAW:no-ambient-temporal-coupling] When it comes, on the monotonic
      // clock: a wall that steps after the arming moves no due.
      readonly moment: Monotonic;
      readonly cancel: () => void;
    }
  // A due is in the mailbox: what is declared before its make runs is moot,
  // since the due's own turn declares as it ends.
  | { readonly kind: "queued" }
  | { readonly kind: "closed" };

export interface RendererWakeDeps {
  readonly clock: Pick<Timekeeper, "now" | "monotonic" | "after">;
  // The renderer's mailbox: a due is an input like any other.
  readonly due: (make: MakeOrFail) => Promise<HostTurn>;
  readonly log: DaemonLogger;
}

// [LAW:nothing-unseen] What a minute of dues cost: how late each was handed
// in after the instant declared, and how long its turn took.
interface Costs {
  dues: number;
  lateMs: number;
  lateMaxMs: number;
  turnMs: number;
  turnMaxMs: number;
}
const noCosts = (): Costs => ({
  dues: 0,
  lateMs: 0,
  lateMaxMs: 0,
  turnMs: 0,
  turnMaxMs: 0,
});

export class RendererWake {
  private state: State = { kind: "idle" };
  // The instant the renderer last declared: a due no renderer answered
  // declared nothing, and this stands.
  private wake: Instant | null = null;
  // [LAW:no-silent-failure] Until when a due that threw holds the next one
  // off, whichever turn declares it: a throw that repeats is a beat of
  // failures, said once, not a spin. A due that answers clears it.
  private heldUntil: Instant | null = null;
  // Whether a due's throw has been said since a due last answered: a due
  // that keeps throwing is said once.
  private throwSaid = false;
  private costs = noCosts();
  private summarizedAt: number;

  constructor(private readonly deps: RendererWakeDeps) {
    this.summarizedAt = deps.clock.monotonic();
  }

  // [LAW:single-enforcer] Every output's wake lands here, in the order the
  // turns answered: the latest declaration is the one timer.
  // [LAW:single-enforcer] A due's own declaration says how it ended, so the
  // hold-off and its line are decided here, in the due's slot.
  declare({ subscriptions: { wake }, due }: Declared): void {
    if (due !== null) this.ended(due.at, due.failure);
    this.wake = wake;
    this.rearm();
  }

  // The daemon's close: no due after it. First in the teardown, so nothing
  // the close does to the renderer wakes it again.
  close(): void {
    if (this.state.kind === "armed") this.state.cancel();
    this.state = { kind: "closed" };
    this.summarize();
  }

  // [LAW:dataflow-not-control-flow] The one timer, to the latest declaration
  // held off by a throw. The instant already armed stands as it is.
  private rearm(): void {
    if (this.state.kind === "closed" || this.state.kind === "queued") return;
    const at =
      this.wake === null
        ? null
        : (Math.max(this.wake, this.heldUntil ?? this.wake) as Instant);
    if (this.state.kind === "armed") {
      if (this.state.at === at) return;
      this.state.cancel();
    }
    this.state = { kind: "idle" };
    if (at === null) return;
    // The wall is read once, as the instant is armed: from here the wait is
    // a span on the monotonic clock. The wall reads whole milliseconds, so
    // the span runs to the whole millisecond at or after the instant, and the
    // wall the due's slot reads has reached it.
    const ms = Math.max(0, Math.ceil(at * 1000) - this.deps.clock.now());
    this.arm(at, (this.deps.clock.monotonic() + ms) as Monotonic);
  }

  private arm(at: Instant, moment: Monotonic): void {
    const ms = Math.max(0, moment - this.deps.clock.monotonic());
    const cancel = this.deps.clock.after(ms, () => this.fired(at, moment));
    this.state = { kind: "armed", at, moment, cancel };
  }

  // [LAW:no-ambient-temporal-coupling] A timer may fire before its moment on
  // the monotonic clock: the rest is waited, so no due is handed in early.
  // The wall has no say here, so one stepped back delays no due.
  private fired(at: Instant, moment: Monotonic): void {
    if (this.deps.clock.monotonic() < moment) {
      this.arm(at, moment);
      return;
    }
    this.state = { kind: "queued" };
    void this.handIn(at);
  }

  private async handIn(at: Instant): Promise<void> {
    let lateMs = 0;
    let handedAt = at;
    const turn = await this.deps.due((slotAt) => {
      // [LAW:single-enforcer] A due whose slot comes after the close is
      // refused as it is made: the close's own steps run without one.
      if (this.state.kind === "closed")
        return failureOf(new DaemonClosing("due"));
      this.state = { kind: "idle" };
      handedAt = slotAt;
      lateMs = Math.max(0, (slotAt - at) * 1000);
      // [LAW:one-source-of-truth] At its slot's instant, as every input is,
      // so no input runs at an instant earlier than a turn ahead of it.
      return { kind: "event", at: slotAt, event: { kind: "due" } };
    });
    // A due no renderer answered declared nothing: it ended here, and the
    // last declaration stands, held off. None live to take it is the
    // supervisor's to say, and the start it makes declares; one the close
    // refused is no failure.
    if (
      turn.kind === "threw" &&
      turn.turnMs === null &&
      turn.failure.kind !== "down" &&
      turn.failure.kind !== "closing"
    ) {
      this.ended(handedAt, turn.failure);
      this.rearm();
    }
    this.costs.dues++;
    this.costs.lateMs += lateMs;
    this.costs.lateMaxMs = Math.max(this.costs.lateMaxMs, lateMs);
    this.costs.turnMs += turn.turnMs ?? 0;
    this.costs.turnMaxMs = Math.max(this.costs.turnMaxMs, turn.turnMs ?? 0);
    if (this.deps.clock.monotonic() - this.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize();
  }

  // How the due handed in at `at` ended: one that failed holds the next off
  // and is said, once for a run of failures; one that answered clears both.
  private ended(at: Instant, failure: Failure | null): void {
    this.heldUntil = failure === null ? null : heldOff(at);
    if (failure === null) this.throwSaid = false;
    else if (!this.throwSaid) {
      this.throwSaid = true;
      this.deps.log(
        "error",
        `wake: due threw, next due no sooner than ${DUE_AFTER_THROW_MS}ms after it: ${failure.detail}`,
      );
    }
  }

  // [LAW:nothing-unseen] Due turns write no line each: the wake says what
  // they cost once a minute, and at its close.
  private summarize(): void {
    const { dues, lateMs, lateMaxMs, turnMs, turnMaxMs } = this.costs;
    if (dues > 0) {
      const mean = (ms: number): string => (ms / dues).toFixed(1);
      this.deps.log(
        "info",
        `wake dues=${dues} late=${mean(lateMs)}ms/max${Math.round(lateMaxMs)}ms turn=${mean(turnMs)}ms/max${Math.round(turnMaxMs)}ms`,
      );
    }
    this.costs = noCosts();
    this.summarizedAt = this.deps.clock.monotonic();
  }
}

// The earliest a due may come after one at `due` threw.
const heldOff = (due: Instant): Instant =>
  (due + DUE_AFTER_THROW_MS / 1000) as Instant;
