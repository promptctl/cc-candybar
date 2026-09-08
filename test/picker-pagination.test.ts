// [LAW:verifiable-goals] Every page of a paged menu/picker must fit term.cols with
// its ←/→/✕ affordances — the strip paints end-caps OUTSIDE the wrap budget.

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
// Strip cap glyphs ONLY for token membership, never for width — they count.
const stripCaps = (s: string): string => s.replace(/[\u{E0B0}-\u{E0D4}]/gu, "");

const STYLES: StripStyle[] = ["powerline", "capsule", "plain"];
const STYLE_CHARSET: Array<[StripStyle, Charset]> = STYLES.flatMap((s) =>
  CHARSETS.map((c): [StripStyle, Charset] => [s, c]),
);

// The pagination floor: below it no pagination fits — too narrow, not the bug.
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
  // Fails loudly if the declared chrome ever drifts from what the strip paints.
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

  test.each(STYLE_CHARSET)(
    "every page fits and keeps its nav arrows (%s, charset %s)",
    (style, charset) => {
      const { renderPage } = buildRuntime(style, 0, charset);
      for (let width = FLOOR; width <= 80; width++) {
        const seen: string[] = [];
        for (let p = 0; p < 40; p++) {
          const line = stripAnsi(renderPage(width, p)).split("\n")[0] ?? "";
          if (seen.length > 0 && line === seen[seen.length - 1]) break;
          seen.push(line);
        }
        const lastIdx = seen.length - 1;
        seen.forEach((line, p) => {
          expect(cw(line)).toBeLessThanOrEqual(width);
          if (p > 0) expect(line).toContain("←");
          if (p < lastIdx) expect(line).toContain("→");
          expect(line).toContain("✕");
        });
        if (width <= 40) expect(seen.length).toBeGreaterThan(1);
      }
    },
  );

  test.each(STYLES)("all options are reachable across pages (%s)", (style) => {
    const { renderPage } = buildRuntime(style);
    const width = 34;
    const shown = new Set<string>();
    let prev = "";
    for (let p = 0; p < 40; p++) {
      const line = stripAnsi(renderPage(width, p)).split("\n")[0] ?? "";
      if (p > 0 && line === prev) break;
      prev = line;
      // Strip caps first: names are space-delimited tokens, so "dark" ≠ "textual-dark".
      for (const tok of stripCaps(line).split(" ")) shown.add(tok);
    }
    const missing = THEMES.filter((t) => !shown.has(t));
    expect(missing).toEqual([]);
  });

  // wrap:false must disable only the row-wrap; pagination still uses term.cols.
  test.each(STYLES)("pagination is unaffected by wrap:false (%s)", (style) => {
    const { renderPage } = buildRuntime(style);
    for (const width of [FLOOR, 34, 60]) {
      for (let p = 0; p < 40; p++) {
        const wrapped = renderPage(width, p, true);
        const unwrapped = renderPage(width, p, false);
        expect(unwrapped).toBe(wrapped);
        if (p > 0 && wrapped === renderPage(width, p - 1, true)) break;
      }
    }
  });

  // The picker reserves 2×padding at its seam, so a packed page fits at any padding.
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
        expect(stripCaps(line).startsWith("  ")).toBe(true);
      });
    }
  });
});

// [LAW:verifiable-goals] The same reserve on the DROP geometry: a body dropped onto
// its own full-width line, at a finite width [LAW:behavior-not-structure].
describe("brandon-menus-bn5.3 I2 — {{ menu }} DROP body fits within term.cols", () => {
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

  test.each(STYLE_CHARSET)(
    "every dropped page fits and keeps its nav arrows (%s, charset %s)",
    (style, charset) => {
      const { render } = buildMenuRuntime(style, charset);
      for (let width = FLOOR; width <= 80; width++) {
        const bodies: string[] = [];
        for (let p = 0; p < 40; p++) {
          const lines = stripAnsi(render(width, p)).split("\n");
          for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
          // Row 0 is the trigger row, asserted rather than assumed: the width
          // math below measures this suite's own cells, not the ambient menu's.
          expect(lines[0]).not.toContain("☰");
          const body = lines.find((l) => l.includes("✕")) ?? "";
          expect(body).not.toBe("");
          if (bodies.length > 0 && body === bodies[bodies.length - 1]) break;
          bodies.push(body);
        }
        const lastIdx = bodies.length - 1;
        bodies.forEach((body, p) => {
          if (p > 0) expect(body).toContain("←");
          if (p < lastIdx) expect(body).toContain("→");
        });
        if (width <= 40) expect(bodies.length).toBeGreaterThan(1);
      }
    },
  );

  // Each body drops onto its OWN full-width line, so each must fit independently.
  test.each(STYLE_CHARSET)(
    "two open menus in one row each drop full-width and fit (%s, charset %s)",
    (style, charset) => {
      const { render } = buildMenuRuntime(style, charset);
      for (let width = FLOOR; width <= 80; width++) {
        for (let p = 0; p < 12; p++) {
          const lines = stripAnsi(render(width, p, true)).split("\n");
          expect(lines.length).toBeGreaterThanOrEqual(3);
          for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
          const dropped = lines.filter((l) => l.includes("✕"));
          expect(dropped.length).toBe(2);
        }
      }
    },
  );

  test.each(STYLES)("dropped pages fit at padding 2 (%s)", (style) => {
    const PAD = 2;
    const { render } = buildMenuRuntime(style, "unicode", PAD);
    for (let width = FLOOR + 2 * PAD; width <= 60; width++) {
      for (let p = 0; p < 40; p++) {
        const lines = stripAnsi(render(width, p)).split("\n");
        for (const line of lines) expect(cw(line)).toBeLessThanOrEqual(width);
        const body = lines.find((l) => l.includes("✕")) ?? "";
        if (p > 0 && body === "") break;
        if (p > 6) break;
      }
    }
  });
});
