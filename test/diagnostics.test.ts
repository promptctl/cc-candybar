// [LAW:verifiable-goals] The diagnostics list, the door's indicator projection
// and the viewer, on the pure functions: the list's order and worst level, the
// indicator's label and colours per level and its count cap, the viewer's
// header for one and many messages, its index clamp when the list shrinks, a
// message drawn in full at the width with nothing clipped, and ⧉ copying
// exactly the viewed message. Width is asserted with rich-js cellLength — the
// one display-width measure the renderer wraps by.

import { linksOf } from "../src/click/read";
import { linkUrls } from "./helpers/frame";
import {
  RichText,
  Segment,
  Style,
  resolveDestination,
  segmentsToString,
} from "@promptctl/rich-js";
import {
  APPROVAL_SEVERITY,
  collectDiagnostics as collectSourced,
  copyKeys,
  diagnosticSpan,
  diagnosticsProjection,
  ERROR_SEVERITY,
  HANDOFF_SEVERITY,
  handoffRows,
  UPDATE_SEVERITY,
  viewerKey,
  viewedIndex,
  viewerRows,
  viewerRowCap,
  PAGES,
  WARNING_SEVERITY,
  worstLevel,
  type DiagnosticMessage,
  type DiagnosticGeometry,
} from "../src/render/diagnostics";
import {
  DIAGNOSTIC_ERROR_COLORS,
  DIAGNOSTIC_WARNING_COLORS,
  type DiagnosticColors,
} from "../src/render/diagnostic-style";
import {
  ansiOf,
  diagnosticFrame,
  encodeAnsi,
  plainOf,
  type Frame,
  type Row,
} from "../src/render/frame";
import {
  COLOR_COMPATIBILITIES,
  type ColorCompatibility,
} from "../src/themes/policy";
import { DIAGNOSTICS_VIEWING } from "../src/config/door";
import { effectsOf } from "./helpers/click";

const SID = "sid-1";
// Messages each about their own text, unless a test says otherwise.
const sourced = (text: string) => ({ about: text, text, copy: text });
const collectDiagnostics = (
  errors: readonly string[],
  notices: readonly DiagnosticMessage[],
  warnings: readonly string[],
) => collectSourced(SID, "request", errors.map(sourced), notices, warnings.map(sourced));
const at = (index: number) => ({ index, page: 0 });
const geometry = (width: number): DiagnosticGeometry => ({
  width,
  rows: 40,
  colorCompatibility: "truecolor",
});

// A validator-shaped error: a heading line, then one issue per line, with wide
// glyphs (CJK, emoji) and a path wider than any row we test.
const LONG_PATH =
  "/Users/someone/projects/日本語のディレクトリ/deeply/nested/cc-candybar/config-with-a-very-long-name.json5";
const ERROR = [
  "Invalid config in /Users/someone/.config/cc-candybar/config.json5:",
  `segment "gitaculous" template: the clickable region {{ action "hueUp" "▶" }} needs a display for each state — 日本語 text and 🎨 emoji count as two cells`,
  `root entry "nosuchseg" does not match any declared segment`,
  `file ${LONG_PATH} is unreadable`,
].join("\n");

const notice = (text: string): DiagnosticMessage => ({
  severity: UPDATE_SEVERITY,
  about: text,
  message: text,
  copy: text,
  lines: [[diagnosticSpan(text, null)]],
});

const encoded = (rows: readonly Row[], depth: ColorCompatibility): string =>
  encodeAnsi(
    rows.map((row) => row.runs),
    depth,
  );
const viewer = (...args: Parameters<typeof viewerRows>): Pick<Frame, "rows"> => ({
  rows: viewerRows(...args),
});

const rowsOf = ({ rows }: Pick<Frame, "rows">): string[] =>
  rows.map(({ runs }) => plainOf(runs));
const cellWidth = (row: string): number => new RichText(row).cellLength;

describe("the diagnostic list", () => {
  test("errors first, then notices and questions, then warnings — each its own message", () => {
    const question: DiagnosticMessage = {
      severity: APPROVAL_SEVERITY,
      about: "run it?",
      message: "run it?",
      copy: "run it?",
      lines: [[diagnosticSpan("run it?", null)]],
    };
    const list = collectDiagnostics(
      ["first error", "second error"],
      [notice("newer"), question],
      ["a warning", "another"],
    );
    expect(list.map((m) => [m.severity, m.message])).toEqual([
      [ERROR_SEVERITY, "first error"],
      [ERROR_SEVERITY, "second error"],
      [UPDATE_SEVERITY, "newer"],
      [APPROVAL_SEVERITY, "run it?"],
      [WARNING_SEVERITY, "a warning"],
      [WARNING_SEVERITY, "another"],
    ]);
  });

  test("a text with nothing visible is no message", () => {
    expect(collectDiagnostics(["  \n\t\x1b \r\n", ""], [], ["   "])).toEqual(
      [],
    );
  });

  test("its level is the worst member's: error over any warning, none when empty", () => {
    expect(worstLevel([])).toBeNull();
    expect(worstLevel(collectDiagnostics([], [notice("n")], ["w"]))).toBe(
      "warning",
    );
    expect(worstLevel(collectDiagnostics(["e"], [notice("n")], ["w"]))).toBe(
      "error",
    );
  });
});

describe("the indicator the door reads", () => {
  test("nothing to show is an empty label", () => {
    expect(diagnosticsProjection([]).label).toBe("");
  });

  test("red with the count when any member is an error", () => {
    const list = collectDiagnostics(["e"], [], ["w"]);
    expect(diagnosticsProjection(list)).toEqual({
      label: "⚠ 2",
      fg: DIAGNOSTIC_ERROR_COLORS.fg,
      bg: DIAGNOSTIC_ERROR_COLORS.bg,
      // Its click opens the first message, by its key.
      open: viewerKey(list, 0, 0),
    });
  });

  test("amber when every member is a warning or a notice", () => {
    const list = collectDiagnostics([], [notice("n")], ["w"]);
    expect(diagnosticsProjection(list)).toEqual({
      label: "⚠ 2",
      fg: DIAGNOSTIC_WARNING_COLORS.fg,
      bg: DIAGNOSTIC_WARNING_COLORS.bg,
      open: viewerKey(list, 0, 0),
    });
  });

  test("the count caps at 9+", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `w${i}`);
    expect(diagnosticsProjection(collectDiagnostics([], [], nine)).label).toBe(
      "⚠ 9",
    );
    expect(
      diagnosticsProjection(collectDiagnostics([], [], [...nine, "w9"])).label,
    ).toBe("⚠ 9+");
  });
});

describe("the viewer", () => {
  test("which message it shows: the one its key names, wherever the list moved it; closed once it is gone", () => {
    const list = collectDiagnostics(["a", "b"], [], ["c"]);
    const [a, b, c] = list.map((_, i) => viewerKey(list, i, 0));
    expect(viewedIndex(null, list)).toBeNull();
    expect(viewedIndex("0", list)).toBeNull();
    expect(viewedIndex(b!, list)).toEqual(at(2));
    expect(viewedIndex(c!, list)).toEqual(at(3));
    // A new message ahead of it moves it, and the viewer follows it.
    const grown = collectDiagnostics(["new", "a", "b"], [], ["c"]);
    expect(viewedIndex(b!, grown)).toEqual(at(3));
    // Gone: closed, never another message in its place.
    expect(viewedIndex(a!, collectDiagnostics(["b"], [], ["c"]))).toBeNull();
    expect(viewedIndex(a!, [])).toBeNull();
    // The same message back again reopens; a different one leaves it closed.
    expect(viewedIndex(a!, collectDiagnostics(["a"], [], []))).toEqual(at(1));
    expect(viewedIndex(a!, collectDiagnostics(["z"], [], []))).toBeNull();
  });

  test("a message's key is its severity and what it is about: its text may change under it, a warning and an error of one source differ", () => {
    const keyOf = (
      errors: { about: string; text: string }[],
      warnings: { about: string; text: string }[],
    ) =>
      viewerKey(
        collectSourced(
          SID,
          "request",
          errors.map((e) => ({ ...e, copy: e.text })),
          [],
          warnings.map((w) => ({ ...w, copy: w.text })),
        ),
        0,
        0,
      );
    const load = (text: string) => ({ about: "load", text });
    expect(keyOf([load("Invalid config in a (3 issues):")], [])).toBe(
      keyOf([load("Invalid config in a (2 issues):")], []),
    );
    expect(keyOf([load("same")], [])).not.toBe(
      keyOf([{ about: "dropped", text: "same" }], []),
    );
    expect(keyOf([load("same")], [])).not.toBe(keyOf([], [load("same")]));
    expect(keyOf([load("same")], [])).toMatch(/^[1-9]\d*$/u);
    expect(Number(keyOf([load("same")], []))).toBeLessThan(2 ** 53);
  });

  test("two alike messages are two stops: › from the first reaches the second, and past it", () => {
    const list = collectDiagnostics(["a", "b", "b", "c"], [], []);
    const keys = list.map((_, i) => viewerKey(list, i, 0));
    expect(new Set(keys).size).toBe(4);
    expect(keys.map((k) => viewedIndex(k, list)!.index)).toEqual([1, 2, 3, 4]);
    const said = linksOf(viewer(list, at(2), SID, "request", geometry(80))).map(
      (l) => /does=([^&]*)/.exec(l.url)![1],
    );
    expect(said).toEqual([
      "close+diagnostics",
      "show+diagnostic+1+of+4+page+1",
      "show+diagnostic+3+of+4+page+1",
      "copy+diagnostic+2",
      "copy+diagnostic+2",
    ]);
    const next = linksOf(viewer(list, at(2), SID, "request", geometry(80)))
      .filter((l) => l.text === "›")
      .flatMap((l) => effectsOf(l.url));
    expect(next).toEqual([
      { verb: "set-state", args: [SID, DIAGNOSTICS_VIEWING, keys[2]] },
    ]);
  });

  test("a long message pages within the terminal's rows, and › walks its pages before the next message", () => {
    const long = Array.from({ length: 30 }, (_, i) => `issue ${i}`).join("\n");
    const list = collectDiagnostics([long, "next"], [], []);
    const short = { ...geometry(80), rows: 5 };
    const first = rowsOf(viewer(list, at(1), SID, "request", short));
    expect(first).toHaveLength(5);
    expect(first[0]).toBe("✕   [1/2 1/8] › ⧉ copy ");
    const last = rowsOf(viewer(list, { index: 1, page: 7 }, SID, "request", short));
    expect(last.at(-1)).toBe("  issue 29 ");
    const onward = (pos: { index: number; page: number }) =>
      linksOf(viewer(list, pos, SID, "request", short))
        .filter((l) => l.text === "›")
        .flatMap((l) => effectsOf(l.url))
        .map((e) => viewedIndex(e.args[2] as string, list));
    expect(onward(at(1))).toEqual([{ index: 1, page: 1 }]);
    expect(onward({ index: 1, page: 7 })).toEqual([at(2)]);
  });

  test("a header a narrow pane wraps still leaves the viewer within its rows", () => {
    const long = Array.from({ length: 30 }, (_, i) => `i${i}`).join("\n");
    const list = collectDiagnostics([long, "next"], [], []);
    const narrow = { ...geometry(14), rows: 5 };
    for (const page of [0, 3])
      expect(
        rowsOf(viewer(list, { index: 1, page }, SID, "request", narrow)).length,
      ).toBeLessThanOrEqual(5);
  });

  test("past the pages a key can name, the last page says what it leaves out and › still moves on", () => {
    const long = Array.from({ length: PAGES + 10 }, (_, i) => `r${i}`).join(
      "\n",
    );
    const list = collectDiagnostics([long, "next"], [], []);
    const tiny = { ...geometry(80), rows: 2 };
    const last = { index: 1, page: PAGES - 1 };
    const rows = rowsOf(viewer(list, last, SID, "request", tiny));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/… 11 more rows: ⧉ copy has them all/);
    const onward = linksOf(viewer(list, last, SID, "request", tiny))
      .filter((l) => l.text === "›")
      .flatMap((l) => effectsOf(l.url))
      .map((e) => viewedIndex(e.args[2] as string, list));
    expect(onward).toEqual([at(2)]);
  });

  test("one message: ✕, its position and ⧉, then the message", () => {
    const list = collectDiagnostics(["boom"], [], []);
    const out = viewer(list, at(1), SID, "request", geometry(80));
    expect(rowsOf(out)).toEqual(["✕ [1/1] ⧉ copy ", "⚠ boom "]);
  });

  test("many: ‹ and › step to the neighbours, a blank where there is none", () => {
    const list = collectDiagnostics(["a", "b", "c"], [], []);
    const header = (i: number) =>
      rowsOf(viewer(list, at(i), SID, "request", geometry(80)))[0];
    expect(header(1)).toBe("✕   [1/3] › ⧉ copy ");
    expect(header(2)).toBe("✕ ‹ [2/3] › ⧉ copy ");
    expect(header(3)).toBe("✕ ‹ [3/3]   ⧉ copy ");
    const writes = linksOf(viewer(list, at(2), SID, "request", geometry(80)))
      .filter((l) =>
        effectsOf(l.url).every((e) => e.verb !== "copy-diagnostic"),
      )
      .map((l) => [l.text, effectsOf(l.url)]);
    const [a, , c] = list.map((_, i) => viewerKey(list, i, 0));
    expect(writes).toEqual([
      ["✕", [{ verb: "set-state", args: [SID, DIAGNOSTICS_VIEWING, "0"] }]],
      ["‹", [{ verb: "set-state", args: [SID, DIAGNOSTICS_VIEWING, a] }]],
      ["›", [{ verb: "set-state", args: [SID, DIAGNOSTICS_VIEWING, c] }]],
    ]);
  });

  test("shows exactly one message, every word of it, wrapped inside the width", () => {
    const list = collectDiagnostics(
      [ERROR, "the other error"],
      [],
      ["a warning"],
    );
    for (const width of [20, 40, 80]) {
      const rows = rowsOf(viewer(list, at(1), SID, "request", geometry(width)));
      for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(width);
      const body = rows.slice(1).join(" ");
      expect(body).not.toContain("the other error");
      expect(body).not.toContain("a warning");
      for (const word of ERROR.split(/\s+/).filter(
        (w) => cellWidth(w) < width - 1,
      ))
        expect(body).toContain(word);
    }
  });

  test("⧉ and the message's first line copy the viewed message by its key, and nothing else in it clicks", () => {
    const list = collectDiagnostics([ERROR, "second"], [], []);
    const own = {
      verb: "copy-diagnostic",
      args: [SID, "request", copyKeys(list)[0]],
    };
    const out = viewer(list, at(1), SID, "request", geometry(60));
    const copies = linkUrls(out)
      .flatMap((u) => effectsOf(u))
      .filter((e) => e.verb.startsWith("copy"));
    expect(copies.length).toBeGreaterThan(1);
    for (const c of copies) expect(c).toEqual(own);
    // Only the first line's words click; the issue lines below carry none.
    const bodyLinks = linksOf({ rows: out.rows.slice(1) });
    const firstLine = ERROR.split("\n")[0]!;
    for (const l of bodyLinks) {
      expect(firstLine).toContain(l.text.split(" ")[0]);
      expect(effectsOf(l.url)).toEqual([own]);
    }
    // The key is the one the viewer opens the message at.
    expect(copyKeys(list)[0]).toBe(viewerKey(list, 0, 0));
  });

  test("a copy link names its message, never the text it copies, so a long prompt costs a frame nothing", () => {
    const prompt = "FIX PROMPT ".repeat(1000);
    const list = collectSourced(
      SID,
      "request",
      [
        {
          about: "dropped",
          text: 'root entry "x" is broken\nmore',
          copy: prompt,
        },
      ],
      [],
      [],
    );
    expect(list[0]!.copy).toBe(prompt);
    expect(list[0]!.lines[0]![0].link).not.toBeNull();
    expect(list[0]!.lines[0]![0].link!.length).toBeLessThan(200);
    expect(list[0]!.lines[1]![0].link).toBeNull();
    for (const url of linkUrls(viewer(list, at(1), SID, "request", geometry(80))))
      expect(url).not.toContain("FIX");
  });

  test("a message's control characters are neutralized before they reach the terminal", () => {
    const list = collectDiagnostics(["x\x1b[31mred\x9bCSI"], [], []);
    const body = rowsOf(viewer(list, at(1), SID, "request", geometry(80)))[1]!;
    expect(body).not.toMatch(/[\x1b\x9b]/);
  });
});

describe("the viewer's row cap", () => {
  test("is the least of its own ceiling, the terminal's rows and every surface showing it", () => {
    expect(viewerRowCap(undefined, [])).toBe(20);
    expect(viewerRowCap(12, [])).toBe(12);
    // A feed's frame the tmux status line shows pages within its five rows.
    expect(viewerRowCap(40, [5])).toBe(5);
    expect(viewerRowCap(3, [5])).toBe(3);
  });
});

// [LAW:verifiable-goals] A viewer row's bytes, by comparison: what rich-js writes
// for its text and link in the colours the message stated, encoded at the depth
// it was drawn at. So nothing between the strip and the bytes moves a look at
// any depth, and no snapshot has to say what those bytes are.
describe("the viewer and the handoff line at every colour depth", () => {
  const written = (
    rows: readonly Row[],
    { fg, bg }: DiagnosticColors,
    depth: ColorCompatibility,
  ): string =>
    rows
      .map(({ runs }) =>
        segmentsToString(
          runs.map(
            ({ text, link }) =>
              new Segment(text, new Style({ color: fg, bgcolor: bg, link })),
          ),
          resolveDestination(depth),
        ),
      )
      .join("\n");
  const at40 = (colorCompatibility: ColorCompatibility): DiagnosticGeometry => ({
    width: 40,
    rows: 40,
    colorCompatibility,
  });
  const clicks = (rows: readonly Row[]): number =>
    rows.flatMap((row) => row.runs).filter((run) => run.link !== undefined)
      .length;
  const handoff = {
    severity: HANDOFF_SEVERITY,
    lines: [[diagnosticSpan("the bar is drawn in the band", null)]],
  } as const;
  const warned = collectDiagnostics([], [], ["a warning"]);

  test.each(COLOR_COMPATIBILITIES)("the viewer at %s", (depth) => {
    const list = collectDiagnostics([ERROR, "second"], [], []);
    const rows = viewerRows(list, at(1), SID, "request", at40(depth));
    expect(encoded(rows, depth)).toBe(
      written(rows, DIAGNOSTIC_ERROR_COLORS, depth),
    );
    // A message that wrapped, and clicks, so neither passes by being absent.
    expect(rows.length).toBeGreaterThan(ERROR.split("\n").length);
    expect(clicks(rows)).toBeGreaterThan(0);
  });

  test.each(COLOR_COMPATIBILITIES)("the handoff line at %s", (depth) => {
    const rows = handoffRows(handoff, warned, SID, at40(depth));
    expect(encoded(rows, depth)).toBe(
      written(rows, DIAGNOSTIC_WARNING_COLORS, depth),
    );
    expect(clicks(rows)).toBeGreaterThan(0);
  });

  test("a depth moves the looks: the text, the rows and the clicks stay", () => {
    const list = collectDiagnostics([ERROR], [], []);
    const drawn = COLOR_COMPATIBILITIES.map((depth) => ({
      depth,
      rows: viewerRows(list, at(1), SID, "request", at40(depth)),
    }));
    const unstyled = ({ rows }: (typeof drawn)[number]) =>
      rows.map(({ kind, runs }) => ({
        kind,
        runs: runs.map(({ text, link }) => ({ text, link })),
      }));
    for (const one of drawn) expect(unstyled(one)).toEqual(unstyled(drawn[0]!));
    expect(
      new Set(drawn.map(({ depth, rows }) => encoded(rows, depth))).size,
    ).toBe(COLOR_COMPATIBILITIES.length);
  });
});

describe("a diagnostic frame", () => {
  test("is one row of one run in its colours, whatever its text holds", () => {
    const { fg, bg } = DIAGNOSTIC_ERROR_COLORS;
    const frame = diagnosticFrame(
      "first\n\x1b[31msecond",
      DIAGNOSTIC_ERROR_COLORS,
    );
    expect(frame.rows).toEqual([
      { kind: "diagnostic", runs: [{ text: "first [31msecond", fg, bg }] },
    ]);
    expect(ansiOf(frame)).not.toContain("\n");
    expect(frame.nextChange).toBe(Infinity);
    expect(frame.motion).toBe("still");
  });
});
