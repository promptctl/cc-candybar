// The render's diagnostics: every error, notice and warning a bar owes its
// reader, as one ordered list of messages. The bar shows the list as one small
// indicator beside the settings door (the door's own template reads the
// projection below); a click opens the viewer, which takes the body's place
// and shows one message in full.
//
// [LAW:one-source-of-truth] A message's rows are ordinary render data: every
// word becomes a cell that flows through the SAME renderStripCells the bar's
// own rows use, so the viewer wraps by the same width measure (rich-js
// cellLength), the same FlexStrip pack, the same serializer and the same
// colour downsampling as the bar. [LAW:single-enforcer]
//
// [LAW:effects-at-boundaries] Pure: (messages, geometry, viewing) → strings.

import { RichText, Style, asCellCol, chopCells } from "@promptctl/rich-js";
import { effectsUrl, VERB_COPY, VERB_SET_STATE } from "../click/wire.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import { sanitizeText } from "./diagnostic-text.js";
import {
  DIAGNOSTIC_ERROR_COLORS,
  DIAGNOSTIC_WARNING_COLORS,
  type DiagnosticColors,
} from "./diagnostic-style.js";
import {
  renderStripCells,
  type BuildLineOptions,
  type ColorCompatibility,
} from "./strip.js";

// [LAW:types-are-the-program] The two things a reader is told: something is
// broken (red) or something wants attention (amber). The indicator wears the
// worst level in the list.
export type DiagnosticLevel = "error" | "warning";

// [LAW:one-type-per-behavior] Errors, notices, questions and warnings are one
// shape: rows of words under a severity. What differs is data — the glyph that
// leads the message, its colours, and the level it counts as.
export interface DiagnosticSeverity {
  readonly level: DiagnosticLevel;
  readonly glyph: string;
  readonly colors: DiagnosticColors;
}
export const ERROR_SEVERITY: DiagnosticSeverity = {
  level: "error",
  glyph: "⚠",
  colors: DIAGNOSTIC_ERROR_COLORS,
};
export const WARNING_SEVERITY: DiagnosticSeverity = {
  level: "warning",
  glyph: "⚠",
  colors: DIAGNOSTIC_WARNING_COLORS,
};
// An update notice is advisory like a warning, but it is an offer, not an
// alarm, and its glyph says so.
export const UPDATE_SEVERITY: DiagnosticSeverity = {
  level: "warning",
  glyph: "⬆",
  colors: DIAGNOSTIC_WARNING_COLORS,
};
// A repository's config waiting on the user's answer before anything in it
// runs: advisory, and its glyph is a lock.
export const APPROVAL_SEVERITY: DiagnosticSeverity = {
  level: "warning",
  glyph: "🔒",
  colors: DIAGNOSTIC_WARNING_COLORS,
};
// The statusline handing the bar off to an animation lane that draws it
// elsewhere (src/daemon/lane-handoff.ts): advisory, and its glyph is the
// lanes' own.
export const HANDOFF_SEVERITY: DiagnosticSeverity = {
  level: "warning",
  glyph: "🧪",
  colors: DIAGNOSTIC_WARNING_COLORS,
};

// [LAW:parse-dont-validate] A run of words sharing one click, or none: a plain
// message's words carry no click (its copy is the viewer's ⧉), while an update
// notice's and a repository question's answers each carry their own. The text
// is sanitized at construction — `diagnosticSpan` is the only constructor — so
// every span the viewer meets is already safe to emit, whatever produced it.
export interface DiagnosticSpan {
  readonly text: string;
  readonly link: string | null;
}
export function diagnosticSpan(
  text: string,
  link: string | null,
): DiagnosticSpan {
  return { text: sanitizeText(text), link };
}
export type DiagnosticLine = readonly [DiagnosticSpan, ...DiagnosticSpan[]];

// One message: its severity, its verbatim text (what ⧉ copies), and the lines
// the viewer shows. Non-empty by construction — a message with no visible line
// is no message.
export interface DiagnosticMessage {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly lines: readonly [DiagnosticLine, ...DiagnosticLine[]];
}

// [LAW:types-are-the-program] Every message one draw owes its reader, in the
// order the viewer pages them. Empty is "nothing to show".
export type DiagnosticList = readonly DiagnosticMessage[];

// [LAW:parse-dont-validate] The one place a draw's diagnostics become a list,
// in severity order: each error, then the notices and questions (already
// shaped — their lines carry per-word clicks), then each warning. A text with
// nothing visible in it — empty, whitespace, control characters — is no
// message, decided here.
export function collectDiagnostics(
  errors: readonly string[],
  notices: readonly DiagnosticMessage[],
  warnings: readonly string[],
): DiagnosticList {
  return [
    ...errors.flatMap((e) => plainMessage(e, ERROR_SEVERITY)),
    ...notices,
    ...warnings.flatMap((w) => plainMessage(w, WARNING_SEVERITY)),
  ];
}

// A plain message: every visible line one span with no click. Blank lines are
// dropped; a message with no visible line is none.
export function plainMessage(
  message: string,
  severity: DiagnosticSeverity,
): DiagnosticMessage[] {
  const [first, ...rest] = message
    .split(/\r\n|\r|\n/)
    .map((line) => diagnosticSpan(line, null))
    .filter((span) => span.text !== "")
    .map((span): DiagnosticLine => [span]);
  return first === undefined
    ? []
    : [{ severity, message, lines: [first, ...rest] }];
}

// The level the list counts as: the worst of its members, none when empty.
export function worstLevel(list: DiagnosticList): DiagnosticLevel | null {
  return list.length === 0
    ? null
    : list.some((m) => m.severity.level === "error")
      ? "error"
      : "warning";
}

// [LAW:one-source-of-truth] What the door's indicator reads (the `diagnostics`
// draw projection): its label, empty when there is nothing to show, and the
// colours of the list's worst level. The count is capped so the indicator
// never grows past four cells.
export const INDICATOR_CAP = 9;
export interface DiagnosticsProjection {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
}
const LEVEL_COLORS: Readonly<Record<DiagnosticLevel, DiagnosticColors>> = {
  error: DIAGNOSTIC_ERROR_COLORS,
  warning: DIAGNOSTIC_WARNING_COLORS,
};
export function diagnosticsProjection(
  list: DiagnosticList,
): DiagnosticsProjection {
  const level = worstLevel(list);
  const n = list.length;
  const colors = LEVEL_COLORS[level ?? "warning"];
  return {
    label:
      level === null ? "" : `⚠ ${n > INDICATOR_CAP ? `${INDICATOR_CAP}+` : n}`,
    fg: colors.fg,
    bg: colors.bg,
  };
}

// What the viewer's ✕ writes: any index below 1 is closed.
const VIEWER_CLOSED = 0;

// The message the viewer shows for the stored `raw` over a list of `n`: none
// while closed or with nothing to show, else the stored index clamped into
// range, so a list that shrank shows its last message rather than nothing.
export function viewedIndex(raw: string | null, n: number): number | null {
  const stored = raw === null ? NaN : Number.parseInt(raw, 10);
  return !(stored >= 1) || n === 0 ? null : Math.min(stored, n);
}

export interface DiagnosticGeometry {
  // Usable cells per row — the same post-reserve width the bar renders at.
  readonly width: number;
  readonly colorCompatibility: ColorCompatibility;
}

// The viewer, standing in for the body: a header row — ✕ to close, ‹ › to the
// neighbouring message (each only where there is one), the position, and ⧉ to
// copy — then the one message at `index` (1-based, in range) in full, wrapped
// at the width, with no row cap.
export function viewerRows(
  list: DiagnosticList,
  index: number,
  sessionId: string,
  geometry: DiagnosticGeometry,
): string {
  const shown = list[index - 1]!;
  const opts = viewerOptions(geometry);
  const style = new Style({
    bgcolor: shown.severity.colors.bg,
    color: shown.severity.colors.fg,
  });
  const go = (to: number): string =>
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [sessionId, DIAGNOSTICS_VIEWING, String(to)],
      },
    ]);
  const button = (text: string, link: string | null): RichText =>
    cell(text, link === null ? style : style.withLink(link));
  // [LAW:dataflow-not-control-flow] A step with nowhere to go is a blank of
  // the arrow's width, so the header never shifts as the reader pages.
  const step = (glyph: string, to: number): RichText =>
    to >= 1 && to <= list.length ? button(glyph, go(to)) : button(" ", null);
  const header = [
    button("✕", go(VIEWER_CLOSED)),
    ...(list.length > 1 ? [step("‹", index - 1)] : []),
    button(`[${index}/${list.length}]`, null),
    ...(list.length > 1 ? [step("›", index + 1)] : []),
    button("⧉ copy", effectsUrl([{ verb: VERB_COPY, args: [shown.message] }])),
  ];
  return [renderStripCells(header, opts), messageRows(shown, geometry)].join(
    "\n",
  );
}

// Every row of one message, uncapped: the viewer's body, and the statusline's
// handoff line (src/daemon/lane-handoff.ts).
export function messageRows(
  message: DiagnosticMessage,
  geometry: DiagnosticGeometry,
): string {
  return channelRows(message, viewerOptions(geometry)).join("\n");
}

// The viewer's own fixed shape: a plain joiner with NO separator (each word
// cell carries its own trailing space so the band's background is continuous —
// the joiner's separator would render unstyled), no intra-cell padding, and
// wrapping always on: a message exists to be read, so the bar's `autoWrap`
// policy does not reach it. Width and colour depth are the render's own.
function viewerOptions(geometry: DiagnosticGeometry): BuildLineOptions {
  return {
    endcaps: "plain",
    separator: "",
    width: geometry.width,
    wrap: true,
    padding: 0,
    colorCompatibility: geometry.colorCompatibility,
  };
}

const cell = (word: string, style: Style): RichText =>
  new RichText(`${word} `, { style, end: "", overflow: "ignore" });

// Continuation lines (a validator emits one issue per line) indent under the
// glyph; wrapped continuations of a single line start at column 0, which is
// how the eye tells "next issue" from "same issue, next row".
const ISSUE_INDENT = " ";

// One message → its wrapped rows. Every word is a cell carrying its span's
// click, if any; a word wider than a row is folded at cell boundaries (rich-js
// chopCells, the same cell algebra FlexStrip packs by) so nothing overflows
// the width — a long path breaks across rows rather than past the edge. Whole
// words stay whole.
function channelRows(
  message: DiagnosticMessage,
  opts: BuildLineOptions,
): string[] {
  const base = new Style({
    bgcolor: message.severity.colors.bg,
    color: message.severity.colors.fg,
  });
  const styled = (link: string | null): Style =>
    link === null ? base : base.withLink(link);
  // A cell plus its trailing space must fit one row, so words fold at width−1
  // — never below the widest glyph (2 cells): a fold narrower than one glyph
  // is not a fold, and a 1–2 cell terminal simply cannot hold one.
  const fold = asCellCol(Math.max(2, opts.width - 1));
  return message.lines.flatMap((line, i) => {
    const prefix = cell(i === 0 ? message.severity.glyph : ISSUE_INDENT, base);
    const cells = line.flatMap((span) =>
      span.text
        .split(" ")
        .flatMap((w) => chopCells(w, fold))
        .map((w) => cell(w, styled(span.link))),
    );
    return renderStripCells([prefix, ...cells], opts).split("\n");
  });
}
