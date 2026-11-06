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

// [LAW:single-enforcer] The one conversion back to the clock's milliseconds.
// An instant is a millisecond reading over 1000, so rounding recovers the
// reading exactly; `at * 1000` alone can land a hair below it, which a Date
// truncates to the millisecond before.
export const msOf = (at: Instant): number => Math.round(at * 1000);

export const dateOf = (at: Instant): Date => new Date(msOf(at));

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
