// A threshold cascade whose result is TEXT (brandon-template-funcs-jku).
//
// `ramp` already carries this decision — ordered stops, the last one at or below the
// value wins — but its output domain is a colour, so every threshold whose answer is
// a word or a glyph was spelled as a nested `if` chain instead and could no longer be
// read as a cascade at all. This is `ramp`'s `step` arm over strings, which is the
// whole of it: interpolating between two words is meaningless, so there is no easing
// here and no palette either.
//
// [LAW:one-source-of-truth] exception: the ascending-stop discipline is spelled here
// AND in rich-js's `ColorRamp` constructor. Sharing it would mean extracting a
// generic ladder across a package boundary for twenty lines, against that module's
// own stated boundary ("nothing here knows what a palette is"). Instead the two are
// held to the same behaviour by an EQUIVALENCE TEST — test/cascade.test.ts asserts
// both refuse the same three cases on the same inputs — which is the honest form of
// one-source when one source would cost more than it buys.

// One stop: the value the cascade reads from `at` until the next stop.
export interface CascadeStop {
  readonly at: number;
  readonly text: string;
}

/**
 * Parse `"<position>:<result>"` stops.
 *
 * The spelling matches `{{ gauge }}`'s stops, and for the same reason: the template
 * engine repeats only its trailing argument type, so `<position> <result>` pairs
 * cannot alternate number/string. One form across both functions means an author
 * learns a cascade once.
 *
 * [LAW:no-silent-failure] Refuses what `ColorRamp` refuses, loudly and for the same
 * reason: no stops at all, a position that is not a finite number, and a DESCENDING
 * pair. Sorting would be the tempting kindness and is the one thing that must not
 * happen — `"80:hot" "50:warm"` sorted is a different cascade than the one written,
 * and the author would never be told.
 */
export function parseCascadeStops(specs: readonly string[]): CascadeStop[] {
  if (specs.length === 0) {
    throw new Error('a cascade needs at least one stop, e.g. "0:calm"');
  }
  const stops: CascadeStop[] = [];
  for (const [i, spec] of specs.entries()) {
    const cut = spec.indexOf(":");
    const at = cut < 0 ? Number.NaN : Number(spec.slice(0, cut));
    if (!Number.isFinite(at)) {
      throw new Error(
        `cascade stop ${i} ("${spec}") must be "<position>:<result>", ` +
          `e.g. "80:hot" — the position must be a number`,
      );
    }
    const prev = stops[i - 1];
    if (prev !== undefined && at < prev.at) {
      throw new Error(
        `cascade stops must be in ascending position order; stop ${i} at ${at} ` +
          `follows stop ${i - 1} at ${prev.at}`,
      );
    }
    stops.push({ at, text: spec.slice(cut + 1) });
  }
  return stops;
}

/**
 * The text at `value`: the last stop at or below it, or the first stop's text when
 * the value is below them all — the same clamp `ColorRamp.at` applies, so a cascade
 * reads the same whichever domain its results live in.
 *
 * Two stops may share a position, and the later one wins there: a hard edge, spelled
 * the way `ramp` spells it.
 */
export function cascadeAt(
  value: number,
  stops: readonly CascadeStop[],
): string {
  if (!Number.isFinite(value)) {
    throw new Error(`a cascade needs a finite value, got ${value}`);
  }
  let lower = -1;
  while (lower + 1 < stops.length && stops[lower + 1]!.at <= value) lower++;
  return (lower < 0 ? stops[0]! : stops[lower]!).text;
}
