// [LAW:one-source-of-truth] What a stepper means over an option domain, shared
// by the draw that shows it and the click that lands it. A ◀ ▶ ? or page arrow
// link carries its intent (an offset, "random", a page step) and never the
// value the draw computed from the state it read: a terminal keeps the link it
// found when the mouse last moved, so every click after the first would repeat
// that write. The click resolves the intent against the state it finds, with
// the functions below, and the draw shows the same ring, so the two cannot
// disagree about where a step lands.

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

// [LAW:parse-dont-validate] The step a link carried, or why it is none.
export function parseStep(
  raw: string,
): { ok: true; step: OptionStep } | { ok: false; problem: string } {
  if (raw === RANDOM) return { ok: true, step: STEP_RANDOM };
  if (OFFSET_RE.test(raw)) return { ok: true, step: stepOffset(Number(raw)) };
  return {
    ok: false,
    problem: `a step is a whole number of options or "${RANDOM}", got ${JSON.stringify(raw)}`,
  };
}

// [LAW:one-source-of-truth] A ring over a domain, centred on the value a key
// holds: the index `offset` steps from the centre, wrapping. The centre is
// THE "unknown current counts as the first member" rule every enumerated
// control folds over (render/action.ts cycleIndex), so a value outside the
// domain rotates exactly as a cycle over it would. The carousel and a
// `{{ swatches }}` row's ◀ ▶ step through this one ring. Over a domain that
// is not empty.
export function ringAround(
  options: readonly string[],
  current: string,
): (offset: number) => number {
  const count = options.length;
  const centre = Math.max(options.indexOf(current), 0);
  return (offset) => (((centre + offset) % count) + count) % count;
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
  return options[
    step.kind === "offset"
      ? at(step.by)
      : randomOther(instant, options.length, at(0))
  ]!;
}

// ─── Pages ───────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The page each option stands on, by option
// index: the layout a paged picker drew, as data a link can carry. A page
// arrow's clamp and the page a swatches step turns to both read it, and the
// draw's own "the page holding the option in force" reads the same map.
export type PageMap = readonly number[];

export function pageMapOf(
  pages: ReadonlyArray<ReadonlyArray<{ readonly indices: readonly number[] }>>,
  optionCount: number,
): PageMap {
  const map = new Array<number>(optionCount).fill(0);
  pages.forEach((sections, page) =>
    sections.forEach((section) =>
      section.indices.forEach((index) => {
        map[index] = page;
      }),
    ),
  );
  return map;
}

// The map as a link carries it: runs of one page, `<page>.<length>` joined by
// `-`. A grid's pages are contiguous runs of options, so a link carries one
// short run per page however many options the domain holds.
export function spellPageMap(map: PageMap): string {
  const runs: string[] = [];
  let start = 0;
  for (let i = 1; i <= map.length; i++) {
    if (i === map.length || map[i] !== map[start]) {
      runs.push(`${map[start]}.${i - start}`);
      start = i;
    }
  }
  return runs.join("-");
}

const RUN_RE = /^\d+\.[1-9]\d*$/;

// [LAW:parse-dont-validate] The map a link carried, or why it is none.
export function parsePageMap(
  raw: string,
): { ok: true; map: PageMap } | { ok: false; problem: string } {
  const runs = raw === "" ? [] : raw.split("-");
  if (!runs.every((run) => RUN_RE.test(run))) {
    return {
      ok: false,
      problem: `a page layout is runs of <page>.<length> joined by "-", got ${JSON.stringify(raw)}`,
    };
  }
  return {
    ok: true,
    map: runs.flatMap((run) => {
      const [page, length] = run.split(".").map(Number);
      return new Array<number>(length!).fill(page!);
    }),
  };
}

export const pageCount = (map: PageMap): number =>
  map.length === 0 ? 0 : Math.max(...map) + 1;

// The page a cursor shows. [LAW:no-defensive-null-guards] The cursor
// genuinely may be absent or not a number (never written): the first page. A
// value below zero is the page holding the option in force (a list opens where
// its value is), and one past the end is the last page, so a picker never
// indexes a page that does not exist.
export function pageShown(
  cursor: string,
  holding: number,
  pages: number,
): number {
  const raw = parseInt(cursor, 10);
  if (!Number.isInteger(raw)) return 0;
  return raw < 0 ? holding : Math.min(raw, pages - 1);
}

// The page holding option `index`; an option on no page, and a value that is
// no option (-1), are on the first.
export const pageHolding = (map: PageMap, index: number): number =>
  map[index] ?? 0;
