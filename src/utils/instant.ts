import type { Timekeeper } from "../time";

// The instant a render is drawn at: seconds since the Unix epoch, fractional,
// the unit rich-js effects take their `t` in. Wall-clock time rather than a
// daemon-relative clock, because the daemon restarts routinely (a rebuilt
// binary, the memory backstop) and a relative clock would jump at every restart.
// [LAW:types-are-the-program] Branded, so a millisecond count (`Date.now()`)
// cannot be passed where seconds are meant: `instantOf` is the one way in.
export type Instant = number & { readonly __instant: unique symbol };

export const instantOf = (date: Date): Instant =>
  (date.getTime() / 1000) as Instant;

export const dateOf = (at: Instant): Date => new Date(at * 1000);

// [LAW:single-enforcer] The clock's wall reading (epoch milliseconds) as the
// instant a stamp carries (epoch seconds): the one conversion, so a stamp is
// never a millisecond count.
export const instantAt = (clock: Pick<Timekeeper, "now">): Instant =>
  instantOf(new Date(clock.now()));

// A time on a session's ANIMATION clock (brandon-menus-sjhy.nt2): seconds,
// like an Instant, but advancing at the session's animation speed — equal to
// the wall instant for a session that has only ever run at 1x. Every looping
// effect, transition and template `frames` reads it; nothing measuring real
// time does.
// [LAW:types-are-the-program] Branded apart from Instant, so a wall instant
// cannot be subtracted from an animation stamp, or handed to an animation where
// animation time is meant: `SessionEffects.clockAt` is the one way in.
export type AnimationTime = number & {
  readonly __animationTime: unique symbol;
};

// A reading of the host's monotonic clock, in seconds: what everything
// scheduled is measured on (a feed's next frame, a menu's idle close, a held
// deferral), because a tick never runs back while the wall may step.
// [LAW:types-are-the-program] Branded apart from Instant, so a wall instant
// is never held where a schedule is meant, or the reverse: `tickAt` is the
// one way in.
export type Tick = number & { readonly __tick: unique symbol };

// [LAW:single-enforcer] The clock's monotonic reading (milliseconds) as the
// tick a schedule is measured on (seconds).
export const tickAt = (clock: Pick<Timekeeper, "monotonic">): Tick =>
  (clock.monotonic() / 1000) as Tick;

// What the host reads as an input's slot in a renderer's mailbox comes: the
// wall instant, for what the bar shows and what is stamped, and the tick, for
// what is scheduled.
export interface Readings {
  readonly at: Instant;
  readonly tick: Tick;
}

// [LAW:single-enforcer] Both readings, taken together.
export const readingsAt = (
  clock: Pick<Timekeeper, "now" | "monotonic">,
): Readings => ({ at: instantAt(clock), tick: tickAt(clock) });
