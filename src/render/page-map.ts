// [LAW:types-are-the-program] The page each option stands on, by option
// index: the layout a paged picker drew, as data a link can carry. A page
// arrow's clamp and the page a swatches step turns to both read it, and the
// draw's own "the page holding the option in force" reads the same map.
export type PageMap = readonly number[];

const UNPLACED = -1;

export function pageMapOf(
  pages: ReadonlyArray<ReadonlyArray<{ readonly indices: readonly number[] }>>,
  optionCount: number,
): PageMap {
  const map = new Array<number>(optionCount).fill(UNPLACED);
  pages.forEach((sections, page) =>
    sections.forEach((section) =>
      section.indices.forEach((index) => {
        map[index] = page;
      }),
    ),
  );
  // [LAW:no-silent-failure] A layout that leaves an option on no page would
  // turn a row to a page that does not hold it.
  const unplaced = map.indexOf(UNPLACED);
  if (unplaced >= 0) {
    throw new Error(
      `the page layout places no page for option ${unplaced} of ${optionCount}`,
    );
  }
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

const RUN_RE = /^(\d+)\.([1-9]\d*)$/;

// [LAW:parse-dont-validate] The map a link carried over `optionCount` options,
// or why it is none. The runs are summed before any is expanded, so a layout
// that does not cover the options (a stale link, or a corrupt one) is refused
// without allocating it, and a map that parses covers every option.
export function parsePageMap(
  raw: string,
  optionCount: number,
): { ok: true; map: PageMap } | { ok: false; problem: string } {
  const runs = (raw === "" ? [] : raw.split("-")).map((run) =>
    RUN_RE.exec(run),
  );
  if (runs.some((run) => run === null)) {
    return {
      ok: false,
      problem: `a page layout is runs of <page>.<length> joined by "-", got ${JSON.stringify(raw)}`,
    };
  }
  const parsed = runs.map((run) => ({
    page: Number(run![1]),
    length: Number(run![2]),
  }));
  const covered = parsed.reduce((sum, run) => sum + run.length, 0);
  if (covered !== optionCount) {
    return {
      ok: false,
      problem: `a page layout of ${covered} option(s) does not cover the ${optionCount} option(s) now in the list`,
    };
  }
  return {
    ok: true,
    map: parsed.flatMap((run) => new Array<number>(run.length).fill(run.page)),
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

// The page holding option `index`; the value that is no option (-1) is on the
// first page.
export const pageHolding = (map: PageMap, index: number): number =>
  map[index] ?? 0;
