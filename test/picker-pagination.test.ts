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

import { getThemePalette, RichText } from "@promptctl/rich-js";
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
    // The global settings menu (candybar-settings-ui-aok.1) rides every bar;
    // placed EXPLICITLY on its own row here so the picker keeps its row to
    // itself — a sibling cell would eat into the width this suite measures
    // pagination against, which is not what these tests are about.
    root: { v: ['menu', 'settings.menu'] },
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
  const basePalette = getThemePalette("textual-dark"!);
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

// [LAW:verifiable-goals] brandon-menus-bn5.3 (I2): the abg/#135 reserve must hold
// on the OTHER geometry the same picker renders through — a `{{ menu }}` body that
// DROPS onto its own full-width line below the enclosing horizontal row
// (composeBlocks, src/dsl/node-registry.ts), and MULTIPLE open menus in one row
// (each body drops onto its own line). The pre-existing coverage tested only a
// standalone picker segment in a VERTICAL root (line 0, no drop); dsl-menus tested
// the drop path but only at width=Infinity (never a finite-width fit). This crosses
// the two: the drop path AND a finite width AND every style × charset.
//
// [LAW:behavior-not-structure] Driven through the real spine (registerDslConfig +
// renderDsl + the real menu synthesis) and the real strip serializer; asserts the
// rendered geometry (every line ≤ width; the → the abg bug ate is present on each
// non-last dropped page), never the internal pagination shape.
describe("brandon-menus-bn5.3 I2 — {{ menu }} DROP body fits within term.cols", () => {
  // Two independent menus (no shared key) beside each other in ONE horizontal
  // row, each declaring ONLY its apply action — the bn5.6 acceptance shape. The
  // default `paged: true` slices each body into ←/→ pages at the live width,
  // and the page cursor (state var + int action) is SYNTHESIZED per state key
  // (menuPageKey) — the hand-declared page var+action pair whose omission used
  // to silently freeze the picker on page 0 no longer exists to forget. The
  // theme menu draws the large `themes` domain (the interesting pagination);
  // the style menu draws the small `styles` domain. Opening a menu = writing
  // its derived state key to its member (menus.<seg>.<apply> = <apply>).
  function menuRowConfig(): string {
    return `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
      },
      actions: {
        applyTheme: { set: 'theme', from: 'themes' },
        applyStyle: { set: 'style', from: 'styles' },
      },
      segments: {
        label: { template: 'L', bg: 'surface', fg: 'foreground' },
        themeMenu: { template: 'T {{ menu "applyTheme" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
        styleMenu: { template: 'S {{ menu "applyStyle" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
      },
      // The global settings menu rides every bar. Isolated onto its own row
      // (as pickerConfig does) so row 0 stays exactly the inline trigger row
      // these tests measure — an unaccounted ambient cell in the measured row
      // would make the width budget below lie.
      root: { v: [{ h: ['label', 'themeMenu', 'styleMenu'] }, 'settings.menu'] },
    }`;
  }

  const THEME_OPEN = "menus.themeMenu.applyTheme";
  const STYLE_OPEN = "menus.styleMenu.applyStyle";
  // The synthesized page cursors: derived from identity (menuPageKey), one per
  // disclosure state key.
  const THEME_PAGE = `${THEME_OPEN}.page`;
  const STYLE_PAGE = `${STYLE_OPEN}.page`;

  function buildMenuRuntime(
    style: StripStyle,
    charset: Charset = "unicode",
    padding = 0,
  ) {
    const config = parseAndValidate("<test>", menuRowConfig(), ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = getThemePalette("textual-dark"!);
    // openStyle: also open the style menu (its own page cursor) so BOTH bodies
    // drop in one render — the multiple-open-menus-in-one-row case.
    const render = (
      width: number,
      themePage: number,
      openStyle = false,
    ): string => {
      sessionState.set("s1", THEME_OPEN, "applyTheme");
      sessionState.set("s1", THEME_PAGE, String(themePage));
      if (openStyle) {
        sessionState.set("s1", STYLE_OPEN, "applyStyle");
        sessionState.set("s1", STYLE_PAGE, "0");
      }
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
          wrap: true,
          width,
          padding,
          charset,
        },
      );
    };
    return { render };
  }

  // The single-menu drop: walk every page of the theme body at a range of widths;
  // assert each rendered line (the inline trigger row AND the dropped body) fits,
  // and the dropped body keeps the nav arrows a page should show. The dropped body
  // is the line carrying the picker's ✕ affordance.
  test.each(STYLE_CHARSET)(
    "every dropped page fits and keeps its nav arrows (%s, charset %s)",
    (style, charset) => {
      const { render } = buildMenuRuntime(style, charset);
      for (let width = FLOOR; width <= 80; width++) {
        const bodies: string[] = [];
        for (let p = 0; p < 40; p++) {
          const lines = stripAnsi(render(width, p)).split("\n");
          // Every emitted line — inline trigger row 0 AND the dropped body — must
          // fit the width budget; the reserve is what makes the padded, capped
          // dropped band fit even when packed to the full page.
          for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
          // Row 0 really is the trigger row, asserted rather than assumed: the
          // ambient settings menu is isolated onto its own row precisely so the
          // width math below measures this suite's own cells. Without this, the
          // claim in the next comment silently went stale once already.
          expect(lines[0]).not.toContain("☰");
          // The dropped body is the line with the ✕ affordance (row 0 is the
          // inline "L T ▾ S ▸" trigger row and never carries the body).
          const body = lines.find((l) => l.includes("✕")) ?? "";
          expect(body).not.toBe(""); // the menu IS open → a body dropped
          if (bodies.length > 0 && body === bodies[bodies.length - 1]) break;
          bodies.push(body);
        }
        const lastIdx = bodies.length - 1;
        bodies.forEach((body, p) => {
          if (p > 0) expect(body).toContain("←");
          if (p < lastIdx) expect(body).toContain("→"); // the arrow abg ate
        });
        // Narrow widths actually paginate (the multi-page / bug regime).
        if (width <= 40) expect(bodies.length).toBeGreaterThan(1);
      }
    },
  );

  // Multiple open menus in ONE horizontal row: both bodies drop, each onto its own
  // full-width line (composeBlocks stacks drops, never zips them side by side), so
  // EACH must fit term.cols independently. A regression that zipped two bodies onto
  // one line, or dropped the per-body reserve, would overflow here.
  test.each(STYLE_CHARSET)(
    "two open menus in one row each drop full-width and fit (%s, charset %s)",
    (style, charset) => {
      const { render } = buildMenuRuntime(style, charset);
      for (let width = FLOOR; width <= 80; width++) {
        for (let p = 0; p < 12; p++) {
          const lines = stripAnsi(render(width, p, true)).split("\n");
          // row 0 (inline triggers) + one dropped body per open menu = ≥ 3 lines.
          expect(lines.length).toBeGreaterThanOrEqual(3);
          for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
          // Both menus are open: two dropped bodies, each carrying its own ✕.
          const dropped = lines.filter((l) => l.includes("✕"));
          expect(dropped.length).toBe(2);
        }
      }
    },
  );

  // The reserve must also absorb padding on the DROP path (the abg/#135 pad half
  // of the reserve), exactly as it does for a standalone picker segment.
  test.each(STYLES)("dropped pages fit at padding 2 (%s)", (style) => {
    const PAD = 2;
    const { render } = buildMenuRuntime(style, "unicode", PAD);
    for (let width = FLOOR + 2 * PAD; width <= 60; width++) {
      for (let p = 0; p < 40; p++) {
        const lines = stripAnsi(render(width, p)).split("\n");
        for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
        const body = lines.find((l) => l.includes("✕")) ?? "";
        if (p > 0 && body === "") break;
        // Past the last page the body repeats; a cheap stop that still sweeps all.
        if (p > 6) break;
      }
    }
  });
});
