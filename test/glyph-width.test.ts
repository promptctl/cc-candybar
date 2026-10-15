// [LAW:behavior-not-structure] The bar's width budgets (fill, wrap, a picker's
// pages) are rich-js's cell measure, so a glyph measured narrower than the
// terminal draws it leaves its row a column short. The text-default symbols
// below U+1F000 the bar uses (◀ ✖ ⚠ …) are measured one cell, as text fonts
// draw them. Above it, both text-default pictographs the bar has shipped
// mismeasured: the wastebasket U+1F5D1 (kgr) measured one cell against an
// emoji's two, and the slider U+1F39A was replaced (#325) because its VS16
// form is honoured unevenly. So a pictograph above U+1F000 anywhere in src/
// is a default emoji, which rich-js measures two cells, as terminals draw it.
// And no glyph carries VS16 (U+FE0F): rich-js measures the selected form two
// cells, and a terminal that ignores the selector draws one — the edit-mode
// gear U+2699 (dsz). This scans source text, comments included: name a
// refused glyph by its code point.

import fs from "node:fs";
import path from "node:path";
import { RichText } from "@promptctl/rich-js";

const SRC = path.join(__dirname, "..", "src");
const SUPPLEMENTARY = 0x1f000;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

interface Found {
  readonly where: string;
  readonly glyph: string;
}

const lines = sourceFiles(SRC).flatMap((file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({
      where: `${path.relative(SRC, file)}:${index + 1}`,
      text,
    })),
);

const matches = (pattern: RegExp, text: string): readonly string[] =>
  [...text.matchAll(pattern)].map(([glyph]) => glyph);

const scan = (pattern: RegExp): readonly Found[] =>
  lines.flatMap(({ where, text }) =>
    matches(pattern, text).map((glyph) => ({ where, glyph })),
  );

const pictographs = scan(/\p{Extended_Pictographic}/gu).filter(
  ({ glyph }) => glyph.codePointAt(0)! >= SUPPLEMENTARY,
);

// Each VS16 with the glyph it selects, so the label names the glyph; one
// leading its line selects nothing on it and is named itself.
const VS16 = /.?\uFE0F/gu;
const selected = scan(VS16);

const label = ({ where, glyph }: Found): string =>
  `${where} U+${glyph.codePointAt(0)!.toString(16).toUpperCase()} ${glyph}`;

describe("pictographs above U+1F000 in src/", () => {
  test("the scan sees the bar's emoji", () => {
    // An empty scan passes both checks below; the settings door's 🍫 is in
    // every config.
    expect(pictographs.map(({ glyph }) => glyph)).toContain("🍫");
  });

  test("each is a default emoji (Emoji_Presentation)", () => {
    const textDefault = pictographs.filter(
      ({ glyph }) => !/\p{Emoji_Presentation}/u.test(glyph),
    );
    expect(textDefault.map(label)).toEqual([]);
  });

  test("each measures the two cells a terminal draws it", () => {
    const narrow = pictographs.filter(
      ({ glyph }) => new RichText(glyph).cellLength !== 2,
    );
    expect(narrow.map(label)).toEqual([]);
  });
});

describe("variation selectors in src/", () => {
  test("the scan sees a selected glyph", () => {
    // An empty scan passes the check below; src/ holds no selector to find,
    // so the pattern is held to the gear this guard was written for.
    const gear = String.fromCodePoint(0x2699, 0xfe0f);
    expect(matches(VS16, `a ${gear} b`)).toEqual([gear]);
    expect(matches(VS16, gear.slice(1))).toEqual([gear.slice(1)]);
  });

  test("no glyph is two cells only through VS16", () => {
    expect(selected.map(label)).toEqual([]);
  });
});
