// [LAW:single-enforcer] The one timer a renderer's turns are scheduled by: the
// tick its outputs declare (`Subscriptions.wake`), armed here and handed in as
// a `due` when it comes. The renderer sets no timer of its own, so everything
// it holds for later — work deferred, an idle menu's close, a feed's next
// frame — waits on this one.
//
// [LAW:no-ambient-temporal-coupling] Ticks are the host's monotonic seconds,
// so a wall clock stepped moves no wake. A timer that fires early waits out
// the rest: the tick, not the timer, says when a `due` is made.

import type { Timekeeper } from "../time.js";
import { tickAt, type Tick } from "../utils/instant.js";
import {
  distributionOf,
  durationHistogram,
  encodedOf,
  recordMs,
} from "./foundations/durations.js";
import type { Failure } from "./foundations/verb-error.js";

// How long a `due` that failed holds every later wake off when its turn asks
// for a tick no later than its own: a renderer whose due turn throws before
// any owner of the tick moved on is not handed it again at once.
export const FAILED_DUE_HOLD_S = 1;

// The longest timer the wake arms: Node runs a longer one at once, and one
// that fires early waits out the rest.
const LONGEST_TIMER_MS = 2 ** 31 - 1;

// How often the wake writes its summary to the log.
const SUMMARY_EVERY_S = 60;

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly tick: Tick; readonly cancel: () => void }
  // A `due` waits in the mailbox or runs: what is declared meanwhile is
  // armed once it has answered.
  | { readonly kind: "queued" }
  | { readonly kind: "closed" };

// How a `due` turn ended, and how long the renderer's turn took: null when no
// renderer answered it.
export type DueEnded = { readonly turnMs: number | null } & (
  | { readonly kind: "answered" }
  | { readonly kind: "threw"; readonly failure: Failure }
);

export interface WakeDeps {
  readonly clock: Pick<Timekeeper, "monotonic" | "after">;
  // Hands the renderer its `due`, resolving with how the turn ended, or the
  // failure that made none: refused once the wake has closed. Each turn's
  // line is the host's.
  readonly due: () => Promise<DueEnded>;
  // [LAW:no-silent-failure] Where a run of failed dues is said on every bar,
  // once.
  readonly said: (text: string) => void;
  // [LAW:nothing-unseen] Where the wake's summary goes: a `due` turn that
  // learned nothing writes no line of its own.
  readonly log: (text: string) => void;
}

export class RendererWake {
  private state: State = { kind: "idle" };
  // The tick the renderer last declared, whatever state the wake was in.
  private declared: Tick | null = null;
  // The tick no wake is armed before, after a `due` failed declaring no later
  // tick; null otherwise.
  private heldUntil: Tick | null = null;
  // Whether the last `due` failed: a run of failures is said once.
  private failing = false;
  // [LAW:nothing-unseen] Every `due` turn the renderer answered, by how long
  // it took: what drawing the frames, closing idle menus and running held
  // work costs, read from the log.
  private readonly took = durationHistogram();
  private dues = 0;
  private failed = 0;
  private readonly opened: Tick;
  private summarizedAt: Tick;

  constructor(private readonly deps: WakeDeps) {
    this.opened = this.summarizedAt = tickAt(deps.clock);
  }

  // [LAW:one-source-of-truth] The renderer's wake, whole, as an output
  // declared it: re-declaring the armed tick keeps its timer.
  declare(tick: Tick | null): void {
    this.declared = tick;
    if (this.state.kind === "idle" || this.state.kind === "armed") this.arm();
  }

  // The wake's end: no timer stays armed, and no `due` is made after it.
  close(): void {
    if (this.state.kind === "armed") this.state.cancel();
    this.state = { kind: "closed" };
    this.summarize("closed");
  }

  closed(): boolean {
    return this.state.kind === "closed";
  }

  private arm(): void {
    const tick =
      this.declared === null || this.heldUntil === null
        ? this.declared
        : (Math.max(this.declared, this.heldUntil) as Tick);
    if (this.state.kind === "armed") {
      if (this.state.tick === tick) return;
      this.state.cancel();
    }
    this.state =
      tick === null
        ? { kind: "idle" }
        : { kind: "armed", tick, cancel: this.timer(tick) };
  }

  private timer(tick: Tick): () => void {
    const { clock } = this.deps;
    const ms = Math.min(
      LONGEST_TIMER_MS,
      Math.max(0, (tick - tickAt(clock)) * 1000),
    );
    return clock.after(ms, () => {
      if (this.state.kind !== "armed" || this.state.tick !== tick) return;
      // Fired early: the rest is waited out.
      if (tickAt(clock) < tick) {
        this.state = { kind: "armed", tick, cancel: this.timer(tick) };
        return;
      }
      this.state = { kind: "queued" };
      void this.deps.due().then((ended) => this.answered(tick, ended));
    });
  }

  private answered(tick: Tick, ended: DueEnded): void {
    if (this.state.kind === "closed") return;
    this.state = { kind: "idle" };
    if (ended.turnMs !== null) {
      this.dues++;
      recordMs(this.took, ended.turnMs);
    }
    const now = tickAt(this.deps.clock);
    if (now - this.summarizedAt >= SUMMARY_EVERY_S) this.summarize("running");
    if (ended.kind === "answered") {
      this.failing = false;
      this.heldUntil = null;
      this.arm();
      return;
    }
    // [LAW:single-enforcer] No renderer was live to take it: the supervisor
    // says so, and the next renderer's start declares its own wake.
    if (ended.failure.kind === "down") return;
    this.failed++;
    if (!this.failing)
      this.deps.said(`the renderer's due turn failed: ${ended.failure.detail}`);
    this.failing = true;
    // [LAW:no-ambient-temporal-coupling] Each owner of a tick moves its own
    // work on when it fails, so a failed `due` whose turn declares a later
    // tick is armed for it. One that declares no later tick failed before any
    // owner moved on, and would be handed in again at once: it is held a
    // second from when it answered, not from its tick, which a `due` that
    // waited in the mailbox is already past.
    this.heldUntil =
      this.declared !== null && this.declared <= tick
        ? ((now + FAILED_DUE_HOLD_S) as Tick)
        : null;
    this.arm();
  }

  // [LAW:one-source-of-truth] The closing summary alone writes the whole
  // histogram: it holds every `due` turn of the wake's life once.
  private summarize(state: "running" | "closed"): void {
    const now = tickAt(this.deps.clock);
    const histogram =
      state === "running" ? "" : ` tookHistogram=${encodedOf(this.took)}`;
    this.deps.log(
      `wake ${state} for=${Math.round(now - this.opened)}s dues=${this.dues} failed=${this.failed} took=${distributionOf(this.took)}${histogram}`,
    );
    this.summarizedAt = now;
  }
}
