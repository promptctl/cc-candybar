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

import { createHash } from "node:crypto";

import { RichText, Style, asCellCol, chopCells } from "@promptctl/rich-js";
import {
  effectsUrl,
  VERB_COPY_DIAGNOSTIC,
  VERB_SET_STATE,
} from "../click/wire.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import type { Drawing } from "../config/lanes.js";
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
// message's first line copies what ⧉ copies and its other lines carry no
// click, while an update notice's and a repository question's answers each
// carry their own. A copy click names its message by key, never by the text
// it copies, so a frame's bytes do not grow with that text. The text
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

// One message: its severity, what it is about, its verbatim text, what ⧉
// copies (the text, or a prompt that fixes what the text reports), and the
// lines the viewer shows. Non-empty by construction — a
// message with no visible line is no message. `about` is named by the message's
// producer — its source, and the file or repository it concerns — and stays
// put while the text changes (an issue fixed, a failure line gained).
export interface DiagnosticMessage {
  readonly severity: DiagnosticSeverity;
  readonly about: string;
  readonly message: string;
  readonly copy: string;
  readonly lines: readonly [DiagnosticLine, ...DiagnosticLine[]];
}

// What a line drawn in a message's colours reads: its severity and its lines.
// The handoff line is one, never listed, so it copies nothing by key.
export type ChannelMessage = Pick<DiagnosticMessage, "severity" | "lines">;

// [LAW:types-are-the-program] Every message one draw owes its reader, in the
// order the viewer pages them. Empty is "nothing to show".
export type DiagnosticList = readonly DiagnosticMessage[];

// A message's text and what it is about (see DiagnosticMessage).
export interface SourcedText {
  readonly about: string;
  readonly text: string;
  readonly copy: string;
}

// [LAW:parse-dont-validate] The one place a draw's diagnostics become a list,
// in severity order: each error, then the notices and questions (already
// shaped — their lines carry per-word clicks), then each warning. A text with
// nothing visible in it — empty, whitespace, control characters — is no
// message, decided here.
export function collectDiagnostics(
  sessionId: string,
  // The renderer drawing the list: a copy click names it, so the daemon
  // reads the list that surface shows.
  by: Drawing["by"],
  errors: readonly SourcedText[],
  notices: readonly DiagnosticMessage[],
  warnings: readonly SourcedText[],
): DiagnosticList {
  const plain = new Set<DiagnosticMessage>();
  const plainOf = (
    text: SourcedText,
    severity: DiagnosticSeverity,
  ): DiagnosticMessage[] => {
    const made = plainMessage(text, severity);
    for (const m of made) plain.add(m);
    return made;
  };
  const list = [
    ...errors.flatMap((e) => plainOf(e, ERROR_SEVERITY)),
    ...notices,
    ...warnings.flatMap((w) => plainOf(w, WARNING_SEVERITY)),
  ];
  // A message's key depends on the whole list (which occurrence it is), so
  // its first line's click is minted once the list stands.
  const keys = copyKeys(list);
  return list.map((m, i) =>
    plain.has(m)
      ? {
          ...m,
          lines: [
            [
              diagnosticSpan(
                m.lines[0][0].text,
                copyLink(sessionId, by, keys[i]!, i + 1),
              ),
            ],
            ...m.lines.slice(1),
          ],
        }
      : m,
  );
}

// A plain message: every visible line one span with no click (its first
// gains the copy click once the list stands). Blank lines are dropped; a
// message with no visible line is none.
function plainMessage(
  { about, text: message, copy }: SourcedText,
  severity: DiagnosticSeverity,
): DiagnosticMessage[] {
  const [first, ...rest] = message
    .split(/\r\n|\r|\n/)
    .map((line) => diagnosticSpan(line, null))
    .filter((span) => span.text !== "")
    .map((span): DiagnosticLine => [span]);
  return first === undefined
    ? []
    : [{ severity, about, message, copy, lines: [first, ...rest] }];
}

// [LAW:one-source-of-truth] The key a copy click names each message by: the
// key the viewer opens it at, so one identity names a message for both.
export function copyKeys(list: DiagnosticList): readonly string[] {
  return stopsOf(list).map((stop) => String(stop * PAGES + 1));
}

// [LAW:single-enforcer] The one click that copies a message, for ⧉ and its
// first line alike: the daemon reads what it copies from the frame renderer
// `by` last delivered for the session when the click runs.
function copyLink(
  sessionId: string,
  by: Drawing["by"],
  key: string,
  position: number,
): string {
  return effectsUrl(
    [{ verb: VERB_COPY_DIAGNOSTIC, args: [sessionId, by, key] }],
    `copy diagnostic ${position}`,
  );
}

// The level the list counts as: the worst of its members, none when empty.
export function worstLevel(list: DiagnosticList): DiagnosticLevel | null {
  return list.length === 0
    ? null
    : list.some((m) => m.severity.level === "error")
      ? "error"
      : "warning";
}

// [LAW:one-source-of-truth] Which message the viewer shows is stored as the
// message's identity, never as a position: a list that shifts under an open
// viewer would otherwise show another message under the same position, and
// one that shrank and grew again would reopen it. The identity is the
// severity and what the message is about, digested — never its text, which
// moves while the message stays the same one (an issue count, a failure line
// gained) — and which of the list's messages of that identity it is, so two
// alike are two stops. The page of the message shown rides in the same key, so a message has
// at most PAGES pages: the viewer never draws a page its key cannot name.
const IDENTITY_BITS = 32;
const OCCURRENCES = 256;
export const PAGES = 4096;
function identityOf(message: DiagnosticMessage): number {
  const digest = createHash("sha256")
    .update(
      `${message.severity.level}\0${message.severity.glyph}\0${message.about}`,
    )
    .digest("hex");
  return (
    Number.parseInt(digest.slice(0, IDENTITY_BITS / 4 + 1), 16) %
    2 ** IDENTITY_BITS
  );
}

// Each message's identity and the occurrence of it, in list order.
function stopsOf(list: DiagnosticList): readonly number[] {
  const seen = new Map<number, number>();
  return list.map((m) => {
    const id = identityOf(m);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return id * OCCURRENCES + Math.min(n, OCCURRENCES - 1);
  });
}

// The key showing page `page` of the message at `at` (0-based). A positive
// integer below 2^52, so the viewer's key keeps the integer gate every click
// to it crosses.
export function viewerKey(
  list: DiagnosticList,
  at: number,
  page: number,
): string {
  return String(stopsOf(list)[at]! * PAGES + page + 1);
}

// Where the viewer stands: the message (1-based) and its page (0-based).
export interface ViewerPosition {
  readonly index: number;
  readonly page: number;
}

// [LAW:one-source-of-truth] What the door's indicator reads (the `diagnostics`
// draw projection): its label, empty when there is nothing to show, the
// colours of the list's worst level, and the key of the message its click
// opens — the first. The count is capped so the indicator never grows past
// four cells.
export const INDICATOR_CAP = 9;
export interface DiagnosticsProjection {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly open: string;
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
    open: list.length === 0 ? VIEWER_CLOSED : viewerKey(list, 0, 0),
  };
}

// What the viewer's ✕ writes: no message has it as its key.
const VIEWER_CLOSED = "0";

// [LAW:dataflow-not-control-flow] Where the stored key `raw` stands in this
// draw's list; none while closed, and none once its message is no longer in
// the list — the viewer closes rather than show another message in its place.
export function viewedIndex(
  raw: string | null,
  list: DiagnosticList,
): ViewerPosition | null {
  const key = Number(raw) - 1;
  const at = stopsOf(list).indexOf(Math.floor(key / PAGES));
  return raw === null || at === -1
    ? null
    : { index: at + 1, page: key % PAGES };
}

// [LAW:one-source-of-truth] The viewer's ceiling: a bar that eats the screen
// is its own failure, so the viewer is at most this many rows, at most the
// client's reported rows, and at most what the surface drawing it shows (a
// lane's own ceiling, for a feed's frame). Rows absent (an older client, or no
// TTY on stderr) reads as "no client ceiling", not as a guess.
export const MAX_VIEWER_ROWS = 20;
export function viewerRowCap(
  termRows: number | undefined,
  surfaceRows: readonly number[],
): number {
  return Math.min(MAX_VIEWER_ROWS, termRows ?? MAX_VIEWER_ROWS, ...surfaceRows);
}

export interface DiagnosticGeometry {
  // Usable cells per row — the same post-reserve width the bar renders at.
  readonly width: number;
  // The most rows the viewer may draw, header included (viewerRowCap).
  readonly rows: number;
  readonly colorCompatibility: ColorCompatibility;
}

// The viewer, standing in for the body: a header row — ✕ to close, ‹ › to the
// neighbouring page (the message's own, then the neighbouring message's; each
// only where there is one), the position, and ⧉ to copy the whole message —
// then one page of the message at `at.index` (1-based, in range), wrapped at
// the width, the header and the page together within the geometry's rows.
export function viewerRows(
  list: DiagnosticList,
  at: ViewerPosition,
  sessionId: string,
  by: Drawing["by"],
  geometry: DiagnosticGeometry,
): string {
  const { index } = at;
  const shown = list[index - 1]!;
  const opts = viewerOptions(geometry);
  const body = channelRows(shown, opts, []);
  const style = new Style({
    bgcolor: shown.severity.colors.bg,
    color: shown.severity.colors.fg,
  });
  const go = (key: string, says: string): string =>
    viewerLink(sessionId, key, says);
  const button = (text: string, link: string | null): RichText =>
    cell(text, link === null ? style : style.withLink(link));
  // [LAW:dataflow-not-control-flow] A step with nowhere to go is a blank of
  // the arrow's width, so the header never shifts as the reader pages.
  const step = (glyph: string, to: ViewerPosition | null): RichText =>
    to === null
      ? button(" ", null)
      : button(
          glyph,
          go(
            viewerKey(list, to.index - 1, to.page),
            `show diagnostic ${to.index} of ${list.length} page ${to.page + 1}`,
          ),
        );
  // The header for a message of `pages` pages, shown at `page`.
  const headerOf = (pages: number, page: number): string => {
    const back =
      page > 0
        ? { index, page: page - 1 }
        : index > 1
          ? { index: index - 1, page: 0 }
          : null;
    const on =
      page < pages - 1
        ? { index, page: page + 1 }
        : index < list.length
          ? { index: index + 1, page: 0 }
          : null;
    const steps = list.length > 1 || pages > 1;
    const position =
      pages > 1
        ? `[${index}/${list.length} ${page + 1}/${pages}]`
        : `[${index}/${list.length}]`;
    return renderStripCells(
      [
        button("✕", go(VIEWER_CLOSED, "close diagnostics")),
        ...(steps ? [step("‹", back)] : []),
        button(position, null),
        ...(steps ? [step("›", on)] : []),
        button(
          "⧉ copy",
          copyLink(sessionId, by, viewerKey(list, index - 1, 0), index),
        ),
      ],
      opts,
    );
  };
  // [LAW:one-source-of-truth] The page is what the rows left by the header
  // hold, the header measured as drawn: a narrow pane wraps it, and its
  // position text grows with the page count, so the two settle together.
  // Fewer rows per page only adds pages, so the header only grows, and the
  // settling ends. A header too tall for the cap still leaves the page a row.
  let headerRows = 1;
  for (;;) {
    const perPage = Math.max(1, geometry.rows - headerRows);
    const pages = Math.min(PAGES, Math.ceil(body.length / perPage));
    // A message that shrank under an open viewer shows its last page.
    const page = Math.min(at.page, pages - 1);
    const header = headerOf(pages, page);
    const measured = header.split("\n").length;
    if (measured > headerRows) {
      headerRows = measured;
      continue;
    }
    const rows = body.slice(page * perPage, (page + 1) * perPage);
    // [LAW:no-silent-failure] Past the pages a key can name, the last page
    // says how much it leaves out, and ⧉ copies the whole message.
    const left = body.length - (page + 1) * perPage;
    const shownRows =
      page === pages - 1 && left > 0
        ? [
            ...rows.slice(0, -1),
            renderStripCells(
              [button(`… ${left + 1} more rows: ⧉ copy has them all`, null)],
              { ...opts, wrap: false },
            ),
          ]
        : rows;
    return [header, ...shownRows].join("\n");
  }
}

// Every row of one message, unpaged: what the viewer pages.
export function messageRows(
  message: DiagnosticMessage,
  geometry: DiagnosticGeometry,
): string {
  return channelRows(message, viewerOptions(geometry), []).join("\n");
}

// [LAW:single-enforcer] The statusline's handoff line (src/daemon/lane-handoff.ts)
// with the indicator after it: the bar it hands off carries the indicator
// beside its door, and the statusline is what a person reads when that bar is
// somewhere they are not looking. The indicator is the door's own — the same
// projection, the same colours, its click opening the same viewer, which the
// statusline then draws in the handoff line's place.
export function handoffRows(
  handoff: ChannelMessage,
  list: DiagnosticList,
  sessionId: string,
  geometry: DiagnosticGeometry,
): string {
  const { label, fg, bg, open } = diagnosticsProjection(list);
  const indicator =
    label === ""
      ? []
      : [
          cell(
            label,
            new Style({ bgcolor: bg, color: fg }).withLink(
              viewerLink(sessionId, open, "open diagnostics"),
            ),
          ),
        ];
  return channelRows(handoff, viewerOptions(geometry), indicator).join("\n");
}

// The click that shows the message whose key is `key`, or closes the viewer.
function viewerLink(sessionId: string, key: string, says: string): string {
  return effectsUrl(
    [{ verb: VERB_SET_STATE, args: [sessionId, DIAGNOSTICS_VIEWING, key] }],
    says,
  );
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

// One message → its wrapped rows, `trailing` after its first line's words.
// Every word is a cell carrying its span's click, if any; a word wider than a row is folded at cell boundaries (rich-js
// chopCells, the same cell algebra FlexStrip packs by) so nothing overflows
// the width — a long path breaks across rows rather than past the edge. Whole
// words stay whole.
function channelRows(
  message: ChannelMessage,
  opts: BuildLineOptions,
  trailing: readonly RichText[],
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
    const after = i === 0 ? trailing : [];
    return renderStripCells([prefix, ...cells, ...after], opts).split("\n");
  });
}
