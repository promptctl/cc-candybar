// [LAW:verifiable-goals] The diagnostics list, the door's indicator projection
// and the viewer, on the pure functions: the list's order and worst level, the
// indicator's label and colours per level and its count cap, the viewer's
// header for one and many messages, its index clamp when the list shrinks, a
// message drawn in full at the width with nothing clipped, and ⧉ copying
// exactly the viewed message. Width is asserted with rich-js cellLength — the
// one display-width measure the renderer wraps by.

import { RichText } from "@promptctl/rich-js";
import {
  APPROVAL_SEVERITY,
  collectDiagnostics,
  diagnosticSpan,
  diagnosticsProjection,
  ERROR_SEVERITY,
  UPDATE_SEVERITY,
  diagnosticKey,
  viewedIndex,
  viewerRows,
  WARNING_SEVERITY,
  worstLevel,
  type DiagnosticMessage,
  type DiagnosticGeometry,
} from "../src/render/diagnostics";
import {
  DIAGNOSTIC_ERROR_COLORS,
  DIAGNOSTIC_WARNING_COLORS,
} from "../src/render/diagnostic-style";
import { DIAGNOSTICS_VIEWING } from "../src/config/door";
import { effectsOf } from "./helpers/click";
import { links, linkUrls, stripAnsi } from "./helpers/ansi";

const SID = "sid-1";
const geometry = (width: number): DiagnosticGeometry => ({
  width,
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
  message: text,
  lines: [[diagnosticSpan(text, null)]],
});

const rowsOf = (out: string): string[] => out.split("\n").map(stripAnsi);
const cellWidth = (row: string): number => new RichText(row).cellLength;

describe("the diagnostic list", () => {
  test("errors first, then notices and questions, then warnings — each its own message", () => {
    const question: DiagnosticMessage = {
      severity: APPROVAL_SEVERITY,
      message: "run it?",
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
      open: diagnosticKey(list[0]!),
    });
  });

  test("amber when every member is a warning or a notice", () => {
    const list = collectDiagnostics([], [notice("n")], ["w"]);
    expect(diagnosticsProjection(list)).toEqual({
      label: "⚠ 2",
      fg: DIAGNOSTIC_WARNING_COLORS.fg,
      bg: DIAGNOSTIC_WARNING_COLORS.bg,
      open: diagnosticKey(list[0]!),
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
    const [a, b, c] = list.map(diagnosticKey);
    expect(viewedIndex(null, list)).toBeNull();
    expect(viewedIndex("0", list)).toBeNull();
    expect(viewedIndex(b!, list)).toBe(2);
    expect(viewedIndex(c!, list)).toBe(3);
    // A new message ahead of it moves it, and the viewer follows it.
    const grown = collectDiagnostics(["new", "a", "b"], [], ["c"]);
    expect(viewedIndex(b!, grown)).toBe(3);
    // Gone: closed, never another message in its place.
    expect(viewedIndex(a!, collectDiagnostics(["b"], [], ["c"]))).toBeNull();
    expect(viewedIndex(a!, [])).toBeNull();
  });

  test("a message's key is its severity and text: the same message keeps it, a warning and an error of one text differ", () => {
    const [error] = collectDiagnostics(["same"], [], []);
    const [again] = collectDiagnostics(["same"], [], []);
    const [warning] = collectDiagnostics([], [], ["same"]);
    expect(diagnosticKey(error!)).toBe(diagnosticKey(again!));
    expect(diagnosticKey(error!)).not.toBe(diagnosticKey(warning!));
    expect(diagnosticKey(error!)).toMatch(/^[1-9]\d*$/u);
  });

  test("one message: ✕, its position and ⧉, then the message", () => {
    const list = collectDiagnostics(["boom"], [], []);
    const out = viewerRows(list, 1, SID, geometry(80));
    expect(rowsOf(out)).toEqual(["✕ [1/1] ⧉ copy ", "⚠ boom "]);
  });

  test("many: ‹ and › step to the neighbours, a blank where there is none", () => {
    const list = collectDiagnostics(["a", "b", "c"], [], []);
    const at = (i: number) => rowsOf(viewerRows(list, i, SID, geometry(80)))[0];
    expect(at(1)).toBe("✕   [1/3] › ⧉ copy ");
    expect(at(2)).toBe("✕ ‹ [2/3] › ⧉ copy ");
    expect(at(3)).toBe("✕ ‹ [3/3]   ⧉ copy ");
    const writes = links(viewerRows(list, 2, SID, geometry(80)))
      .filter((l) => stripAnsi(l.text) !== "⧉ copy ")
      .map((l) => [stripAnsi(l.text).trim(), effectsOf(l.url)]);
    const [a, , c] = list.map(diagnosticKey);
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
      const rows = rowsOf(viewerRows(list, 1, SID, geometry(width)));
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

  test("⧉ copies the viewed message verbatim, and nothing else in it clicks", () => {
    const list = collectDiagnostics([ERROR, "second"], [], []);
    const out = viewerRows(list, 1, SID, geometry(60));
    const copies = linkUrls(out)
      .flatMap((u) => effectsOf(u))
      .filter((e) => e.verb === "copy");
    expect(copies).toEqual([{ verb: "copy", args: [ERROR] }]);
    const bodyLinks = links(out.split("\n").slice(1).join("\n"));
    expect(bodyLinks).toEqual([]);
  });

  test("a message's control characters are neutralized before they reach the terminal", () => {
    const list = collectDiagnostics(["x\x1b[31mred\x9bCSI"], [], []);
    const body = viewerRows(list, 1, SID, geometry(80)).split("\n")[1]!;
    expect(stripAnsi(body)).not.toMatch(/[\x1b\x9b]/);
  });
});
