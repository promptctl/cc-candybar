// [LAW:one-source-of-truth] What a stepper means over an option domain, shared
// by the draw that shows it and the click that lands it. A ◀ ▶ ? or page arrow
// link carries its intent (an offset, "random", a page step) and never the
// option it lands on: a terminal keeps the link it found when the mouse last
// moved, so every click after the first would repeat that write. The click
// resolves the intent against the value the key holds when it lands, with the
// functions below, and the draw shows the same ring, so the two cannot
// disagree about where a step lands. While a rule decides the key it holds
// nothing a click can read, so the link also carries the name the draw wore
// (ruledName, render/action.ts), and the first click starts from it.

// A step over an option ring: a signed number of members, or any other member
// than the one the key holds.
export type OptionStep =
  | { readonly kind: "offset"; readonly by: number }
  | { readonly kind: "random" };

const RANDOM = "random";
const OFFSET_RE = /^-?\d+$/;

export const stepOffset = (by: number): OptionStep => ({ kind: "offset", by });
export const STEP_RANDOM: OptionStep = { kind: "random" };

// The step as a link carries it.
export function spellStep(step: OptionStep): string {
  return step.kind === "random" ? RANDOM : String(step.by);
}

// [LAW:parse-dont-validate] A signed whole number a link carried, as a number
// arithmetic cannot lose (past the safe range `Number` rounds, and the ring's
// modular wrap would answer NaN), or why it is none.
export function parseOffset(
  raw: string,
): { ok: true; by: number } | { ok: false; problem: string } {
  const by = Number(raw);
  return OFFSET_RE.test(raw) && Number.isSafeInteger(by)
    ? { ok: true, by }
    : {
        ok: false,
        problem: `a whole number was expected, got ${JSON.stringify(raw)}`,
      };
}

// The step a link carried, or why it is none.
export function parseStep(
  raw: string,
): { ok: true; step: OptionStep } | { ok: false; problem: string } {
  if (raw === RANDOM) return { ok: true, step: STEP_RANDOM };
  const offset = parseOffset(raw);
  if (offset.ok) return { ok: true, step: stepOffset(offset.by) };
  return {
    ok: false,
    problem: `a step is a whole number of options or "${RANDOM}", got ${JSON.stringify(raw)}`,
  };
}

// [LAW:one-source-of-truth] THE rule every enumerated control folds over: the
// value in force is the option it names, and an unknown current counts as the
// first member. A cycle (render/action.ts) and a ring both centre here, so a
// value outside the domain rotates the same way in each.
export const centreOf = (options: readonly string[], current: string): number =>
  Math.max(options.indexOf(current), 0);

// A ring over a domain, centred on the value a key holds: the index `offset`
// steps from the centre, wrapping. The carousel and a `{{ swatches }}` row's
// ◀ ▶ step through this one ring. Over a domain that is not empty. The offset
// is reduced to the ring before the centre is added, so a sum past the safe
// range never rounds.
export function ringAround(
  options: readonly string[],
  current: string,
): (offset: number) => number {
  const count = options.length;
  const centre = centreOf(options, current);
  return (offset) => (((centre + (offset % count)) % count) + count) % count;
}

// [LAW:dataflow-not-control-flow] A random option other than the one at
// `centre`, as a pure function of a seed: the integer hash of the seed (two
// rounds of a multiply-xorshift mix) picks one of the `count - 1` others. The
// click passes its own instant, so a pick lands on a fresh option each time
// and a click at a given instant lands the same one. With one option there is
// no other, and the pick is that option.
export function randomOther(
  seed: number,
  count: number,
  centre: number,
): number {
  let h = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (centre + 1 + ((h >>> 0) % Math.max(count - 1, 1))) % count;
}

// The option `step` lands on from the value the key holds, at `instant`.
// Over a domain that is not empty.
export function landing(
  options: readonly string[],
  current: string,
  step: OptionStep,
  instant: number,
): string {
  const at = ringAround(options, current);
  switch (step.kind) {
    case "offset":
      return options[at(step.by)]!;
    case "random":
      // The instant is fractional seconds and the hash takes an integer, so
      // the seed is whole milliseconds: two clicks a moment apart differ.
      return options[
        randomOther(Math.round(instant * 1000), options.length, at(0))
      ]!;
  }
}
