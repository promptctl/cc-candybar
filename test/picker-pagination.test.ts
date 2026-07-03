// [LAW:verifiable-goals] brandon-menu-abg regression: a paged menu/picker must
// fit EVERY page within term.cols, with the ←/→/✕ affordances each page should
// show all present — at any terminal width and any strip style. The bug:
// pagination packed option cells to the raw wrap width, but the strip paints the
// joiner's end-caps OUTSIDE that budget (powerline 1 col, capsule 2), so the
// maximally-packed middle pages overflowed by the cap width and the terminal ate
// the trailing → affordance (page 0 fit while page ≥1 did not — the signature).
//
// [LAW:behavior-not-structure] These assert the rendered geometry (width ≤ limit;
// the nav glyphs visible), never the internal pagination shape — driven through
// the real spine (registerDslConfig + renderDsl) and the real strip serializer.

import { PaletteResolver, getThemePalette, RichText } from "@promptctl/rich-js";
import { Style } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { renderStripCells, stripChromeCols } from "../src/render/strip";
import type { Charset, StripStyle } from "../src/themes/policy";
import { SessionState } from "../src/daemon/session-state";
import { CHARSETS, listResolvablePaletteNames } from "../src/themes/policy";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEMES = listResolvablePaletteNames();

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");
const cw = (s: string): number => new RichText(s).cellLength;
// Powerline cap glyphs (private-use block) glue to the edge token with no space;
// strip them ONLY for token membership, never for width (they count toward it).
const stripCaps = (s: string): string => s.replace(/[\u{E0B0}-\u{E0D4}]/gu, "");

const STYLES: StripStyle[] = ["powerline", "capsule", "plain"];
// brandon-display-dam.3: the ascii glyphs are chosen single-column so the
// chrome (and therefore the picker's reserve) is charset-invariant — the
// style × charset product below is the machine check on that invariant.
const STYLE_CHARSET: Array<[StripStyle, Charset]> = STYLES.flatMap((s) =>
  CHARSETS.map((c): [StripStyle, Charset] => [s, c]),
);

// The pagination floor: a single option cannot be split, so a width below the
// longest option plus its mandatory affordances (✕ ← option →) and the strip's
// caps cannot fit ANY pagination — that's a too-narrow terminal, not the bug
// (which is page ≥1 overflowing while page 0 fits). Tests sweep at/above it.
const MAX_OPT = Math.max(...THEMES.map(cw));
const FLOOR = MAX_OPT + cw("✕") + cw("←") + cw("→") + 3 + 2;

function pickerConfig(): string {
  return `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      theme: { kind: 'state', key: 'theme-pick', default: '${THEMES[0]}' },
      page: { kind: 'state', key: 'theme-page', default: '-1' },
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    actions: {
      applyTheme: { set: 'theme-pick', from: 'themes' },
      themePage: { set: 'theme-page', int: true },
    },
    segments: {
      menu: {
        template: '{{ picker "applyTheme" "themePage" true true }}',
        when: '{{ ge (int .page) 0 }}',
        bg: 'surface', fg: 'foreground',
      },
    },
    root: { v: ['menu'] },
  }`;
}

function buildRuntime(
  style: StripStyle,
  padding = 0,
  charset: Charset = "unicode",
) {
  const config = parseAndValidate("<test>", pickerConfig(), ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const renderPage = (width: number, page: number, wrap = true): string => {
    sessionState.set("s1", "theme-page", String(page));
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s1", project_dir: "/tmp/proj" },
      basePalette,
      {
        style,
        colorCompatibility: "truecolor" as const,
        wrap,
        width,
        padding,
        charset,
      },
    );
  };
  return { renderPage };
}

describe("brandon-menu-abg — paged menu fits every page within term.cols", () => {
  // The chrome declaration must match what the strip actually paints, else the
  // picker's reserve drifts from reality. Measure a single styled full-width
  // cell — under BOTH charsets, since stripChromeCols is deliberately total
  // over StripStyle alone (the ascii glyphs are single-column by choice; this
  // is the pin that fails loudly if a wider glyph ever lands).
  test.each(STYLE_CHARSET)(
    "stripChromeCols(%s) matches measured strip chrome (charset %s)",
    (style, charset) => {
      const content = "ABCDEFGHIJ";
      const cell = new RichText(content, {
        end: "",
        noWrap: true,
        style: new Style({ bgcolor: "#445566", color: "#ffffff" }),
      });
      const out = stripAnsi(
        renderStripCells([cell], {
          style,
          colorCompatibility: "truecolor",
          wrap: true,
          padding: 0,
          charset,
          width: 60,
        }),
      );
      expect(cw(out) - cw(content)).toBe(stripChromeCols(style));
    },
  );

  // The core acceptance: walk every page at a range of widths spanning many page
  // counts; assert each rendered line fits, and the nav arrows that a page should
  // show are present. The trailing → on every non-last page is the affordance the
  // bug ate.
  test.each(STYLE_CHARSET)(
    "every page fits and keeps its nav arrows (%s, charset %s)",
    (style, charset) => {
      const { renderPage } = buildRuntime(style, 0, charset);
      for (let width = FLOOR; width <= 80; width++) {
        // Discover the page count by walking until a page repeats its last item
        // (the cursor clamps past the end). Cap the walk well above any real count.
        const seen: string[] = [];
        for (let p = 0; p < 40; p++) {
          const line = stripAnsi(renderPage(width, p)).split("\n")[0] ?? "";
          // Past the last page the cursor clamps, re-rendering the last page; stop.
          if (seen.length > 0 && line === seen[seen.length - 1]) break;
          seen.push(line);
        }
        const lastIdx = seen.length - 1;
        seen.forEach((line, p) => {
          expect(cw(line)).toBeLessThanOrEqual(width);
          // No option cell may be ellipsed/wrapped: every theme shown is whole.
          if (p > 0) expect(line).toContain("←");
          if (p < lastIdx) expect(line).toContain("→");
          expect(line).toContain("✕");
        });
        // Multi-page widths actually produced more than one page (the bug regime).
        if (width <= 40) expect(seen.length).toBeGreaterThan(1);
      }
    },
  );

  // Every theme is reachable across the pages (none silently dropped by overflow).
  test.each(STYLES)("all options are reachable across pages (%s)", (style) => {
    const { renderPage } = buildRuntime(style);
    const width = 34;
    const shown = new Set<string>();
    let prev = "";
    for (let p = 0; p < 40; p++) {
      const line = stripAnsi(renderPage(width, p)).split("\n")[0] ?? "";
      if (p > 0 && line === prev) break;
      prev = line;
      // Whole-cell membership: theme names are space-delimited tokens, so a name
      // that is a substring of another ("dark" in "textual-dark") isn't a false
      // hit. The strip glues its cap glyph to the edge token with no space, so
      // strip caps before tokenizing.
      for (const tok of stripCaps(line).split(" ")) shown.add(tok);
    }
    const missing = THEMES.filter((t) => !shown.has(t));
    expect(missing).toEqual([]);
  });

  // brandon-display-dam.1: globals.autoWrap=false must disable ONLY the
  // FlexStrip row-wrap. The picker paginates from the same finite width
  // (term.cols), so every page renders byte-identically with wrap off —
  // proof that no-wrap is not implemented as width=Infinity, which would
  // collapse pagination to one infinite page.
  test.each(STYLES)("pagination is unaffected by wrap:false (%s)", (style) => {
    const { renderPage } = buildRuntime(style);
    for (const width of [FLOOR, 34, 60]) {
      for (let p = 0; p < 40; p++) {
        const wrapped = renderPage(width, p, true);
        const unwrapped = renderPage(width, p, false);
        expect(unwrapped).toBe(wrapped);
        // Stop after the cursor clamps to the last page.
        if (p > 0 && wrapped === renderPage(width, p - 1, true)) break;
      }
    }
  });

  // brandon-display-dam.2: the segment layout pads EVERY line it emits (the
  // picker's included) by globals.padding, and the picker reserves 2×padding
  // at its pagination seam beside the joiner chrome — so a maximally-packed
  // page still fits term.cols at any padding, not just the default.
  test.each(STYLES)("every page fits at padding 2 (%s)", (style) => {
    const PAD = 2;
    const { renderPage } = buildRuntime(style, PAD);
    for (let width = FLOOR + 2 * PAD; width <= 60; width++) {
      const seen: string[] = [];
      for (let p = 0; p < 40; p++) {
        const line = stripAnsi(renderPage(width, p)).split("\n")[0] ?? "";
        if (seen.length > 0 && line === seen[seen.length - 1]) break;
        seen.push(line);
      }
      seen.forEach((line) => {
        expect(cw(line)).toBeLessThanOrEqual(width);
        // The band itself is padded (cap glyphs sit outside the cell).
        expect(stripCaps(line).startsWith("  ")).toBe(true);
      });
    }
  });
});
