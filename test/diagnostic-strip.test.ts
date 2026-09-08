// [LAW:verifiable-goals] Width is asserted with rich-js cellLength — the one display-width measure the renderer wraps by.

import { pathToFileURL } from "node:url";
import { RichText } from "@promptctl/rich-js";
import {
  collectDiagnostics,
  composeWithDiagnostics,
  diagnosticRowCap,
  diagnosticSpan,
  formatDiagnosticDump,
  MAX_DIAGNOSTIC_ROWS,
  UPDATE_SEVERITY,
  type DiagnosticChannel,
  type DiagnosticGeometry,
  type DiagnosticLinks,
} from "../src/render/diagnostic-strip";
import { extractUrls, stripAnsi } from "./helpers/daemon-e2e";

const FULL = "/tmp/state/cc-candybar/diagnostics/sid.txt";
const CONFIG = "/Users/someone/.config/cc-candybar/config.json5";
const LINKS: DiagnosticLinks = {
  fullText: { kind: "file", path: FULL },
  failedConfigFile: CONFIG,
};

const geometry = (
  width: number,
  rowCap = diagnosticRowCap(undefined),
): DiagnosticGeometry => ({ width, rowCap, colorCompatibility: "truecolor" });

const LONG_PATH =
  "/Users/someone/projects/日本語のディレクトリ/deeply/nested/cc-candybar/config-with-a-very-long-name.json5";
const ISSUES = [
  `Invalid config in ${CONFIG}:`,
  `segment "gitaculous" template: the clickable region {{ action "hueUp" "▶" }} needs a display for each state — 日本語 text and 🎨 emoji count as two cells`,
  `segment "toolbar" references undeclared action "applyTheme" (declared actions: openMenu, themePage, hueDown)`,
  `root: unknown node kind "cells" — migrate to the { h: [...] } / { v: [...] } shape grammar`,
  `file ${LONG_PATH} is unreadable`,
];
const ERROR = ISSUES.join("\n");

const rowsOf = (output: string): string[] =>
  output.split("\n").map(stripAnsi);
const cellWidth = (row: string): number => new RichText(row).cellLength;
// A word may share its row with others, so check containment, not equality.
const wordsNarrowerThan = (width: number): string[] =>
  ERROR.split(/\s+/).filter((w) => w.length > 0 && cellWidth(w) < width);

describe("candybar-diagnostics-avi: the diagnostic strip", () => {
  const diag = collectDiagnostics(ERROR, [], "")!;

  test.each([80, 120])(
    "wraps every row within %d cells and clips no word mid-word",
    (width) => {
      const out = composeWithDiagnostics("BODY", diag, LINKS, geometry(width));
      const rows = rowsOf(out);
      expect(rows[rows.length - 1]).toBe("BODY");
      const strip = rows.slice(0, -1);
      for (const row of strip) expect(cellWidth(row)).toBeLessThanOrEqual(width);
      const joined = strip.join("\n");
      for (const word of wordsNarrowerThan(width)) {
        expect(joined).toContain(word);
      }
      expect(strip.length).toBeGreaterThan(ISSUES.length);
      expect(strip[0]).toMatch(/^⚠ Invalid config in /);
    },
  );

  test("a word wider than the row folds at the width instead of overflowing", () => {
    const out = composeWithDiagnostics("", diag, LINKS, geometry(40, 100));
    for (const row of rowsOf(out)) expect(cellWidth(row)).toBeLessThanOrEqual(40);
    // A wide glyph straddling the fold is padded to the row edge, so strip trailing spaces before joining.
    const text = rowsOf(out)
      .map((r) => r.replace(/ +$/, ""))
      .join("");
    expect(text).toContain(LONG_PATH.replace(/ /g, ""));
  });

  test("caps the strip at min(20, term.rows) rows, trailer included, and says how many rows it dropped", () => {
    const many = collectDiagnostics(
      Array.from({ length: 40 }, (_, i) => `issue number ${i + 1} is here`).join(
        "\n",
      ),
      [],
      "",
    )!;
    expect(diagnosticRowCap(undefined)).toBe(MAX_DIAGNOSTIC_ROWS);
    expect(diagnosticRowCap(50)).toBe(MAX_DIAGNOSTIC_ROWS);
    expect(diagnosticRowCap(12)).toBe(12);

    const capped = rowsOf(
      composeWithDiagnostics("", many, LINKS, geometry(120, diagnosticRowCap(50))),
    );
    expect(capped).toHaveLength(20);
    expect(capped[19]).toMatch(/^↳ 21 more rows · open full text · open /);

    const tight = rowsOf(
      composeWithDiagnostics("", many, LINKS, geometry(120, diagnosticRowCap(12))),
    );
    expect(tight).toHaveLength(12);
    expect(tight[11]).toMatch(/^↳ 29 more rows · /);
  });

  test("a strip that fits offers no full text — only the failing config", () => {
    const small = collectDiagnostics("one line", [], "")!;
    const out = composeWithDiagnostics("", small, LINKS, geometry(80));
    expect(rowsOf(out)).toEqual(["⚠ one line ", `↳ open ${CONFIG}`]);
    expect(extractUrls(out)).not.toContain(pathToFileURL(FULL).href);
  });

  test("the last row links the failing config as a plain file:// URL", () => {
    const out = composeWithDiagnostics("BODY", diag, LINKS, geometry(120));
    const urls = extractUrls(out);
    expect(urls).toContain(pathToFileURL(CONFIG).href);
    expect(urls.some((u) => u.startsWith("cc-candybar://"))).toBe(true);
    const last = rowsOf(out).at(-2)!;
    expect(last).toBe(`↳ open ${CONFIG}`);
  });

  test("a capped strip links the full text beside the failing config", () => {
    const out = composeWithDiagnostics("BODY", diag, LINKS, geometry(120, 3));
    expect(extractUrls(out)).toContain(pathToFileURL(FULL).href);
    expect(rowsOf(out).at(-2)).toMatch(/^↳ \d+ more rows · open full text · open /);
  });

  test("a narrow row middle-truncates the config path but the link keeps the full URL", () => {
    const out = composeWithDiagnostics("", diag, LINKS, geometry(50));
    const last = rowsOf(out).at(-1)!;
    expect(cellWidth(last)).toBeLessThanOrEqual(50);
    expect(last).toMatch(/^↳ open \/Users\/.*….*config\.json5$/);
    expect(extractUrls(out)).toContain(pathToFileURL(CONFIG).href);
  });

  test("a strip that fits with no failed config file has no trailer at all", () => {
    const d = collectDiagnostics("boom", [], "")!;
    const rows = rowsOf(
      composeWithDiagnostics("", d, { ...LINKS, failedConfigFile: null }, geometry(80)),
    );
    expect(rows).toEqual(["⚠ boom "]);
  });

  test("without a failed config file a capped strip offers only the full text", () => {
    const rows = rowsOf(
      composeWithDiagnostics("", diag, { ...LINKS, failedConfigFile: null }, geometry(80, 3)),
    );
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)).toMatch(/^↳ \d+ more rows · open full text$/);
  });

  test("a dump the daemon could not write is said in the trailer, not linked", () => {
    const out = composeWithDiagnostics(
      "",
      diag,
      { fullText: { kind: "unavailable", reason: "ENOSPC: no\x1bspace" }, failedConfigFile: null },
      geometry(80, 3),
    );
    expect(rowsOf(out).at(-1)).toMatch(/^↳ \d+ more rows · full text unavailable: ENOSPC: no space$/);
    expect(extractUrls(out).filter((u) => u.startsWith("file://"))).toEqual([]);
  });

  test("error rows precede update rows precede warning rows; one trailer closes the strip", () => {
    const update: DiagnosticChannel = {
      severity: UPDATE_SEVERITY,
      message: "newer thing",
      lines: [[diagnosticSpan("newer thing", "cc-candybar://copy/x"), diagnosticSpan("[act]", "cc-candybar://act/y")]],
    };
    const all = collectDiagnostics("bad thing", [update], "advisory")!;
    expect(all.channels.map((c) => c.severity.heading)).toEqual(["ERROR", "UPDATE", "WARNING"]);
    const out = composeWithDiagnostics("BODY", all, LINKS, geometry(80));
    expect(rowsOf(out)).toEqual([
      "⚠ bad thing ",
      "⬆ newer thing [act] ",
      "⚠ advisory ",
      `↳ open ${CONFIG}`,
      "BODY",
    ]);
    expect(extractUrls(out)).toEqual(
      expect.arrayContaining(["cc-candybar://copy/x", "cc-candybar://act/y"]),
    );
  });

  test("no diagnostics → the body, untouched", () => {
    expect(collectDiagnostics("", [], "")).toBeNull();
    expect(composeWithDiagnostics("BODY", null, LINKS, geometry(80))).toBe("BODY");
  });

  test("a message that sanitizes to no line is no channel", () => {
    expect(collectDiagnostics("  \n\t\x1b \r\n", [], "")).toBeNull();
    const warned = collectDiagnostics("   ", [], "advisory")!;
    expect(warned.channels).toHaveLength(1);
    expect(warned.channels[0].lines.map((l) => l.map((s) => s.text))).toEqual([["advisory"]]);
  });

  test("the dump holds every channel's message verbatim — unwrapped, unsanitized", () => {
    const both = collectDiagnostics(ERROR, [], "warn\ttab")!;
    expect(formatDiagnosticDump(both)).toBe(
      `ERROR\n${ERROR}\n\nWARNING\nwarn\ttab\n`,
    );
  });

  test("control characters in a message cannot escape the styled cell", () => {
    const hostile = collectDiagnostics("x\x1b[31mred\x9bCSI", [], "")!;
    const first = rowsOf(composeWithDiagnostics("", hostile, LINKS, geometry(80)))[0]!;
    expect(first).toBe("⚠ x [31mred CSI ");
  });

  test("control characters in the failed config path cannot escape the trailer", () => {
    const hostile = collectDiagnostics(ERROR, [], "")!;
    const out = composeWithDiagnostics(
      "",
      hostile,
      { ...LINKS, failedConfigFile: "/a/\x1b[31mb.json5" },
      geometry(80),
    );
    expect(out).not.toContain("\x1b[31m");
    expect(rowsOf(out).at(-1)).toContain("open /a/ [31mb.json5");
  });

  test.each([3, 8, 16, 24, 39])(
    "the trailer fits a %d-cell width narrower than its own fixed text",
    (width) => {
      const out = composeWithDiagnostics("", diag, LINKS, geometry(width, 5));
      const rows = rowsOf(out);
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(width);
      expect(rows.at(-1)).toMatch(/^↳/);
    },
  );

  // The failed config path is middle-truncated into the width the fixed text leaves — a 1-cell budget at 25.
  test.each([25, 26, 30, 40, 60])(
    "a wide-glyph config path fits the trailer at a %d-cell width",
    (width) => {
      const wide = { ...LINKS, failedConfigFile: LONG_PATH };
      const one = collectDiagnostics("boom", [], "")!;
      const out = composeWithDiagnostics("", one, wide, geometry(width, 5));
      const rows = rowsOf(out);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(width);
      expect(rows.at(-1)).toMatch(/^↳ open \S/);
      expect(extractUrls(out)).toContain(pathToFileURL(LONG_PATH).href);
    },
  );

  // The width is a client hint, so a width too narrow for one wide glyph must still render.
  test.each([1, 2])("a %d-cell width renders, bounded by one wide glyph", (width) => {
    const rows = rowsOf(composeWithDiagnostics("", diag, LINKS, geometry(width, 5)));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(3);
  });
});
