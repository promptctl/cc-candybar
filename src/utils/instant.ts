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
