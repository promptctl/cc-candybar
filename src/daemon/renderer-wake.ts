// [LAW:no-ambient-temporal-coupling] A renderer's one timer. Every output
// declares the instant the renderer next wants a turn at
// (`Subscriptions.wake`), derived from its own state; the wake keeps one timer
// to the latest declaration and, when it comes, hands the renderer a `due`
// through its mailbox, ordered against every other input. The renderer holds
// no timer of its own, so everything it does in time (a feed's frame, a menu's
// idle close, a torn write's settle, the next entry of a reload walk) is a
// turn the host runs.

import type { Instant } from "../utils/instant.js";
import type { Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger.js";
import { DaemonClosing, failureOf } from "./foundations/verb-error.js";
import type { Declared, HostTurn, MakeOrFail } from "./renderer-host.js";

// How far ahead of the wall a timer may fire and still count as come: the
// resolution timers fire at. A due is handed in at the instant declared, or
// at the slot's own when that is later, so a frame due at a beat is drawn for
// the beat.
export const TIMER_RESOLUTION_S = 0.002;

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
  declare({ subscriptions: { wake }, turn }: Declared): void {
    if (this.state.kind === "closed" || this.state.kind === "queued") return;
    if (this.state.kind === "armed") this.state.cancel();
    this.state = { kind: "idle" };
    if (wake === null) return;
    // [LAW:no-silent-failure] A due that threw holds the next one off, so a
    // throw that repeats is a beat of failures, said once, not a spin.
    const at =
      turn.due !== null && turn.threw
        ? (Math.max(wake, turn.due + DUE_AFTER_THROW_MS / 1000) as Instant)
        : wake;
    this.arm(at);
  }

  // The daemon's close: no due after it. First in the teardown, so nothing
  // the close does to the renderer wakes it again.
  close(): void {
    if (this.state.kind === "armed") this.state.cancel();
    this.state = { kind: "closed" };
    this.summarize();
  }

  private arm(at: Instant): void {
    const ms = Math.max(0, at * 1000 - this.deps.clock.now());
    const cancel = this.deps.clock.after(ms, () => this.fired(at));
    this.state = { kind: "armed", at, cancel };
  }

  // [LAW:no-ambient-temporal-coupling] A timer runs on the monotonic clock
  // and may fire before the wall reaches the instant it was set for: the
  // rest is waited, so no due is handed in before the instant it is for.
  private fired(at: Instant): void {
    if (at - this.deps.clock.now() / 1000 > TIMER_RESOLUTION_S) {
      this.arm(at);
      return;
    }
    this.state = { kind: "queued" };
    void this.handIn(at);
  }

  private async handIn(at: Instant): Promise<void> {
    let lateMs = 0;
    const turn = await this.deps.due((slotAt) => {
      // [LAW:single-enforcer] A due whose slot comes after the close is
      // refused as it is made: the close's own steps run without one.
      if (this.state.kind === "closed")
        return failureOf(new DaemonClosing("due"));
      this.state = { kind: "idle" };
      lateMs = Math.max(0, (slotAt - at) * 1000);
      return {
        kind: "event",
        at: Math.min(
          Math.max(at, slotAt),
          slotAt + TIMER_RESOLUTION_S,
        ) as Instant,
        event: { kind: "due" },
      };
    });
    if (turn.kind === "answered") this.throwSaid = false;
    // [LAW:single-enforcer] No renderer was live to take it, and the
    // supervisor says that; or the close refused it, which is no throw.
    else if (
      turn.failure.kind !== "down" &&
      turn.failure.kind !== "closing" &&
      !this.throwSaid
    ) {
      this.throwSaid = true;
      this.deps.log(
        "error",
        `wake: due threw, next due no sooner than ${DUE_AFTER_THROW_MS}ms after it: ${turn.failure.detail}`,
      );
    }
    this.costs.dues++;
    this.costs.lateMs += lateMs;
    this.costs.lateMaxMs = Math.max(this.costs.lateMaxMs, lateMs);
    this.costs.turnMs += turn.turnMs ?? 0;
    this.costs.turnMaxMs = Math.max(this.costs.turnMaxMs, turn.turnMs ?? 0);
    if (this.deps.clock.monotonic() - this.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize();
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
