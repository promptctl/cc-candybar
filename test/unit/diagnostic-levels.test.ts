// [LAW:behavior-not-structure] What the door's indicator says for each level a
// list can hold: an offer or a question is information, never a warning, and
// a list that also holds something going wrong reads as its worst level and
// opens on a message of that level.

import { RichText } from "@promptctl/rich-js";
import {
  APPROVAL_SEVERITY,
  collectDiagnostics,
  diagnosticSpan,
  diagnosticsProjection,
  handoffRows,
  HANDOFF_SEVERITY,
  aboutText,
  viewedIndex,
  type DiagnosticMessage,
  type DiagnosticSeverity,
} from "../../src/render/diagnostics";
import {
  DIAGNOSTIC_ERROR_COLORS,
  DIAGNOSTIC_INFO_COLORS,
  DIAGNOSTIC_WARNING_COLORS,
} from "../../src/render/diagnostic-style";

const SID = "sid-1";
const sourced = (text: string) => ({
  about: aboutText("test", text),
  text,
  copy: text,
});
const shaped = (
  severity: DiagnosticSeverity,
  text: string,
): DiagnosticMessage => ({
  severity,
  about: aboutText("test", text),
  message: text,
  copy: text,
  lines: [[diagnosticSpan(text, null)]],
});
const offer = shaped(
  HANDOFF_SEVERITY,
  "Drawing in a tmux pane.",
);
const question = shaped(APPROVAL_SEVERITY, "run this repository's config?");
const list = (
  errors: readonly string[],
  notices: readonly DiagnosticMessage[],
  warnings: readonly string[],
) =>
  collectDiagnostics(
    SID,
    "request",
    errors.map(sourced),
    notices,
    warnings.map(sourced),
  );

// The message the indicator's click opens.
const opened = (shown: ReturnType<typeof list>) => {
  const at = viewedIndex(diagnosticsProjection(shown).open, shown);
  return at === null ? undefined : shown[at.index - 1]!.message;
};

describe("a list with nothing wrong in it", () => {
  test.each([
    ["a handoff notice", offer],
    ["a repository question", question],
  ])("%s alone is ℹ 1 in the info colours, no ⚠ and no amber", (_, message) => {
    const projected = diagnosticsProjection(list([], [message], []));
    expect(projected.label).toBe("ℹ 1");
    expect(projected.label).not.toContain("⚠");
    expect({ fg: projected.fg, bg: projected.bg }).toEqual(
      DIAGNOSTIC_INFO_COLORS,
    );
    expect(projected.bg).not.toBe(DIAGNOSTIC_WARNING_COLORS.bg);
  });

  test("ℹ 9+ stays within four cells", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      shaped(HANDOFF_SEVERITY, `offer ${i}`),
    );
    const { label } = diagnosticsProjection(list([], many, []));
    expect(label).toBe("ℹ 9+");
    expect(new RichText(label).cellLength).toBe(4);
  });
});

describe("a list that also holds something wrong reads as its worst level", () => {
  test("an offer with a warning is an amber ⚠ 2 that opens on the warning", () => {
    const shown = list([], [offer], ["a warning"]);
    const projected = diagnosticsProjection(shown);
    expect(projected.label).toBe("⚠ 2");
    expect({ fg: projected.fg, bg: projected.bg }).toEqual(
      DIAGNOSTIC_WARNING_COLORS,
    );
    expect(opened(shown)).toBe("a warning");
  });

  test("with an error too it is a red ⚠ 3, ordered error, warning, offer", () => {
    const shown = list(["an error"], [offer], ["a warning"]);
    const projected = diagnosticsProjection(shown);
    expect(projected.label).toBe("⚠ 3");
    expect({ fg: projected.fg, bg: projected.bg }).toEqual(
      DIAGNOSTIC_ERROR_COLORS,
    );
    expect(shown.map((m) => m.message)).toEqual([
      "an error",
      "a warning",
      offer.message,
    ]);
    expect(opened(shown)).toBe("an error");
  });
});

describe("the handoff line", () => {
  test("is followed by an indicator in the list's worst level", () => {
    const handoff = {
      severity: HANDOFF_SEVERITY,
      lines: [[diagnosticSpan("[⟲ claude]", null)]],
    } as const;
    const rows = handoffRows(handoff, list(["an error"], [offer], []), SID, {
      width: 80,
      rows: 20,
      colorCompatibility: "truecolor",
    });
    const runs = rows.flatMap((row) => row.runs);
    const indicator = runs.findIndex((run) => run.text.startsWith("⚠ 2"));
    expect(indicator).toBeGreaterThan(0);
    expect({ fg: runs[indicator]!.fg, bg: runs[indicator]!.bg }).toEqual(
      DIAGNOSTIC_ERROR_COLORS,
    );
  });
});
