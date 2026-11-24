// [LAW:verifiable-goals] The page layout a picker draws and a link carries
// (src/render/page-map.ts): what a link spells, what the click reads back, and
// the page a cursor shows. The draw and the click both fold through these, so
// they are pinned as pure functions with no rig.

import {
  pageCount,
  pageHolding,
  pageMapOf,
  pageShown,
  parsePageMap,
  spellPageMap,
} from "../../src/render/page-map";

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
    expect(parsePageMap(spellPageMap(map), 8)).toEqual({ ok: true, map });
  });

  test("a library page holds sections that need not be contiguous", () => {
    const library = pageMapOf(
      [[{ indices: [0, 2] }, { indices: [4] }], [{ indices: [1, 3] }]],
      5,
    );
    expect(library).toEqual([0, 1, 0, 1, 0]);
    expect(parsePageMap(spellPageMap(library), 5)).toEqual({
      ok: true,
      map: library,
    });
  });

  test("an empty layout has no pages", () => {
    expect(pageCount(pageMapOf([], 0))).toBe(0);
    expect(parsePageMap("", 0)).toEqual({ ok: true, map: [] });
  });

  test("anything that is not runs of <page>.<length> is refused", () => {
    for (const raw of ["0", "0.0", "a.3", "0.3,1.3", "0.3-"]) {
      expect(parsePageMap(raw, 3)).toMatchObject({ ok: false });
    }
  });

  test("a layout that does not cover the options in the list now is refused, unexpanded", () => {
    expect(parsePageMap("0.3-1.3-2.2", 9)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("does not cover the 9 option(s)"),
    });
    expect(parsePageMap("0.3-1.3-2.2", 7)).toMatchObject({ ok: false });
    // A corrupt run is refused by its sum, never allocated.
    expect(parsePageMap("0.4000000000", 8)).toMatchObject({ ok: false });
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

  test("a value that is no option holds the first page", () => {
    expect(pageHolding(map, -1)).toBe(0);
  });
});
