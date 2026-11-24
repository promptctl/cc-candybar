// [LAW:verifiable-goals] The step vocabulary a ◀ ▶ ? or page-arrow link carries
// (src/render/option-ring.ts): what a link spells, what the click reads back,
// and where a step lands. The draw and the click both fold through these, so
// they are pinned as pure functions with no rig.

import {
  landing,
  pageCount,
  pageHolding,
  pageMapOf,
  pageShown,
  parsePageMap,
  parseStep,
  randomOther,
  ringAround,
  spellPageMap,
  spellStep,
  stepOffset,
  STEP_RANDOM,
} from "../../src/render/option-ring";

describe("a step as a link spells it", () => {
  test("an offset and `random` read back as they were spelled", () => {
    for (const step of [stepOffset(1), stepOffset(-1), stepOffset(7), STEP_RANDOM]) {
      expect(parseStep(spellStep(step))).toEqual({ ok: true, step });
    }
  });

  test("anything else is refused, naming what a step is", () => {
    for (const raw of ["", "1.5", "next", "--1", " 1"]) {
      expect(parseStep(raw)).toMatchObject({
        ok: false,
        problem: expect.stringContaining("a whole number of options"),
      });
    }
  });
});

describe("a step lands on the ring the value is centred in", () => {
  const options = ["a", "b", "c", "d", "e"];

  test("an offset wraps at both ends", () => {
    expect(landing(options, "a", stepOffset(-1), 0)).toBe("e");
    expect(landing(options, "e", stepOffset(1), 0)).toBe("a");
    expect(landing(options, "c", stepOffset(2), 0)).toBe("e");
    expect(landing(options, "c", stepOffset(-7), 0)).toBe("a");
  });

  test("a value outside the domain counts as the first option", () => {
    expect(landing(options, "x", stepOffset(1), 0)).toBe("b");
    expect(ringAround(options, "")(0)).toBe(0);
  });

  test("random never lands on the option in force, and reaches every other", () => {
    for (const count of [2, 3, 7, 40]) {
      const domain = Array.from({ length: count }, (_, i) => `o${i}`);
      for (const centre of [0, count - 1]) {
        const seen = new Set<string>();
        for (let seed = 0; seed < 4000; seed++) {
          const picked = landing(
            domain,
            domain[centre]!,
            STEP_RANDOM,
            Date.UTC(2026, 9, 15) + seed * 1000,
          );
          expect(picked).not.toBe(domain[centre]);
          seen.add(picked);
        }
        expect([count, centre, seen.size]).toEqual([count, centre, count - 1]);
      }
    }
  });

  test("one option has no other: the pick is that option", () => {
    expect(randomOther(12345, 1, 0)).toBe(0);
  });
});

describe("a page layout as a link carries it", () => {
  // Three pages over eight options: the layout a narrow grid draws.
  const pages = [
    [{ indices: [0, 1, 2] }],
    [{ indices: [3, 4, 5] }],
    [{ indices: [6, 7] }],
  ];
  const map = pageMapOf(pages, 8);

  test("the map is the page each option stands on", () => {
    expect(map).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
    expect(pageCount(map)).toBe(3);
  });

  test("a grid's layout is one short run per page, and reads back whole", () => {
    expect(spellPageMap(map)).toBe("0.3-1.3-2.2");
    expect(parsePageMap(spellPageMap(map))).toEqual({ ok: true, map });
  });

  test("a library page holds sections that need not be contiguous", () => {
    const library = pageMapOf(
      [[{ indices: [0, 2] }, { indices: [4] }], [{ indices: [1, 3] }]],
      5,
    );
    expect(library).toEqual([0, 1, 0, 1, 0]);
    expect(parsePageMap(spellPageMap(library))).toEqual({ ok: true, map: library });
  });

  test("an empty layout has no pages", () => {
    expect(pageCount(pageMapOf([], 0))).toBe(0);
    expect(parsePageMap("")).toEqual({ ok: true, map: [] });
  });

  test("anything that is not runs of <page>.<length> is refused", () => {
    for (const raw of ["0", "0.0", "a.3", "0.3,1.3", "0.3-"]) {
      expect(parsePageMap(raw)).toMatchObject({ ok: false });
    }
  });

  test("a cursor shows its page; below zero it is the page holding the option in force", () => {
    const held = pageHolding(map, 4);
    expect(held).toBe(1);
    expect(pageShown("2", held, 3)).toBe(2);
    expect(pageShown("9", held, 3)).toBe(2);
    expect(pageShown("-1", held, 3)).toBe(1);
    // Never written, or not a number: the first page.
    expect(pageShown("", held, 3)).toBe(0);
    expect(pageShown("x", held, 3)).toBe(0);
  });

  test("an option on no page, and a value that is no option, hold the first page", () => {
    expect(pageHolding(map, -1)).toBe(0);
    expect(pageHolding(map, 99)).toBe(0);
  });
});
