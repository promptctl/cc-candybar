// The per-render diagnostic strip: the red/amber rows above the bar that
// carry a config error, a click error, or an advisory warning.
//
// [LAW:one-source-of-truth] The strip is ordinary render data. Every
// diagnostic line becomes word cells that flow through the SAME
// renderStripCells the bar's own rows use — so the strip wraps by the same
// width measure (rich-js cellLength), the same FlexStrip pack, the same
// serializer and the same colour downsampling as everything beneath it.
// There is no hand-concatenated ANSI here and no second opinion about what
// "fits the terminal" means. [LAW:single-enforcer]
//
// [LAW:effects-at-boundaries] Pure: (diagnostics, geometry) → string. The
// file the trailer links to is WRITTEN by src/daemon/diagnostic-dump.ts at
// the daemon edge; this module only names it.

import { pathToFileURL } from "node:url";
import { RichText, Style, asCellCol, chopCells } from "@promptctl/rich-js";
import {
  effectsUrl,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
} from "../click/wire.js";
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

// [LAW:one-source-of-truth] The strip's ceiling, resolved in ONE place: a bar
// that eats the whole screen is its own failure, so the cap is the lesser of
// this constant and the client's reported rows. Rows absent (an older client,
// or no TTY on stderr) reads as "no client ceiling", not as a guess.
// Daemon-only — the Rust client never renders this strip — so not mirrored.
export const MAX_DIAGNOSTIC_ROWS = 20;
export function diagnosticRowCap(termRows: number | undefined): number {
  return Math.min(MAX_DIAGNOSTIC_ROWS, termRows ?? MAX_DIAGNOSTIC_ROWS);
}

// [LAW:no-silent-failure] Bad config can't quietly degrade output. The render
// pipeline carries two independent diagnostic channels:
//   error   — load-fatal: parse/validation failed (the bar beneath is
//             last-known-good or the bundled default), a click that failed,
//             or an unknown render flag. Rendered red.
//   warning — advisory: load succeeded but something needs attention (a
//             same-location .json5 + .json collision, a stale bundle).
//             Rendered amber.
// Either way the failure is visible at the point of impact, as (a projection
// of) the underlying message — never a constant label hiding the content
// behind a click. The glyph and background carry severity; the rest is the
// text itself, sanitized, wrapped, never clipped mid-word.
//
// [LAW:one-type-per-behavior] Errors and warnings are one shape: a message,
// a colour pair, and the click verb that copies the text. What differs is
// data. Order in `channels` is severity order (error first) — the composer
// keeps it, and the trailer takes the first channel's colours.
export interface DiagnosticChannel {
  readonly verb:
    | typeof VERB_SHOW_CONFIG_ERROR
    | typeof VERB_SHOW_CONFIG_WARNING;
  readonly colors: DiagnosticColors;
  // Verbatim: the dump's content and the copy click's payload.
  readonly message: string;
  // What the strip shows: the message's sanitized lines, blank ones dropped.
  // Non-empty by construction — a message with no visible line is no channel.
  readonly lines: readonly [string, ...string[]];
}

// The complete, unwrapped, un-truncated text — formatDiagnosticDump's
// output — as the daemon wrote it, or why it could not. Linked as `file://`
// because that URL needs no handler of ours: a config error is precisely the
// moment to assume the `cc-candybar://` scheme may be unregistered.
//
// [LAW:no-silent-failure] A dump the daemon failed to write is SAID in the
// trailer, never linked: the affordance on screen matches the disk.
export type FullTextLink =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unavailable"; readonly reason: string };

// [LAW:no-ambient-temporal-coupling] Links are a separate composer input,
// not a Diagnostics field: the full-text link is the OUTCOME of the dump
// write, which the daemon performs after the channels exist and before the
// strip goes out. A Diagnostics cannot name a file that is not written yet.
export interface DiagnosticLinks {
  readonly fullText: FullTextLink;
  // The config file whose load failed, when the error is a load error.
  readonly failedConfigFile: string | null;
}

// [LAW:types-are-the-program] Non-empty by construction: `channels` carries
// at least one member and each member at least one line, so a Diagnostics
// always has rows and always earns its trailer. "Nothing to show" is `null`,
// decided once in collectDiagnostics.
export interface Diagnostics {
  readonly channels: readonly [DiagnosticChannel, ...DiagnosticChannel[]];
}

export interface DiagnosticGeometry {
  // Usable cells per row — the same post-reserve width the bar renders at.
  readonly width: number;
  // Total rows the strip may occupy, trailer included (diagnosticRowCap).
  readonly rowCap: number;
  readonly colorCompatibility: ColorCompatibility;
}

// [LAW:parse-dont-validate] The one place two message texts become a typed
// Diagnostics-or-nothing. Downstream never re-asks "is there an error": a
// text with nothing visible in it — empty, whitespace, control characters —
// is the same "nothing to show" as no text at all, decided here.
export function collectDiagnostics(
  error: string,
  warning: string,
): Diagnostics | null {
  const [first, ...rest] = [
    channelOf(error, VERB_SHOW_CONFIG_ERROR, DIAGNOSTIC_ERROR_COLORS),
    channelOf(warning, VERB_SHOW_CONFIG_WARNING, DIAGNOSTIC_WARNING_COLORS),
  ].flat();
  return first === undefined ? null : { channels: [first, ...rest] };
}

function channelOf(
  message: string,
  verb: DiagnosticChannel["verb"],
  colors: DiagnosticColors,
): DiagnosticChannel[] {
  const [first, ...rest] = message
    .split(/\r\n|\r|\n/)
    .map(sanitizeText)
    .filter(Boolean);
  return first === undefined
    ? []
    : [{ verb, colors, message, lines: [first, ...rest] }];
}

// The dump file's content: every channel's message verbatim, in severity
// order, under a one-word heading. Nothing sanitized, nothing wrapped — this
// is the text the strip is an excerpt of.
export function formatDiagnosticDump(diagnostics: Diagnostics): string {
  return diagnostics.channels
    .map((ch) => `${DUMP_HEADINGS[ch.verb]}\n${ch.message}\n`)
    .join("\n");
}
const DUMP_HEADINGS = {
  [VERB_SHOW_CONFIG_ERROR]: "ERROR",
  [VERB_SHOW_CONFIG_WARNING]: "WARNING",
} as const;

const GLYPH = "⚠";
// Continuation issue lines (the validator emits one issue per line) indent
// under the glyph; wrapped continuations of a single line start at column 0,
// which is how the eye tells "next issue" from "same issue, next row".
const ISSUE_INDENT = " ";

// [LAW:dataflow-not-control-flow] The strip is a fold: channels → rows, rows
// sliced to the cap less one, then the trailer. The cap and the elision count
// are values; there is no "if it fits" path distinct from the "if it doesn't"
// path — a strip that fits simply elides zero rows.
export function composeWithDiagnostics(
  body: string,
  diagnostics: Diagnostics | null,
  links: DiagnosticLinks,
  geometry: DiagnosticGeometry,
): string {
  if (diagnostics === null) return body;
  const opts = stripOptions(geometry);
  const rows = diagnostics.channels.flatMap((ch) => channelRows(ch, opts));
  const shown = rows.slice(0, geometry.rowCap - 1);
  const strip = [
    ...shown,
    trailerRow(diagnostics, links, rows.length - shown.length, opts),
  ].join("\n");
  // No body → the strip alone (renderDsl produced nothing). Body present →
  // the strip sits above it on its own rows.
  return body ? `${strip}\n${body}` : strip;
}

// The strip's own fixed shape: a plain joiner with NO separator (each word
// cell carries its own trailing space so the band's background is
// continuous — the joiner's separator would render unstyled), no intra-cell
// padding, and wrapping always on: a diagnostic exists to be read, so the
// bar's `autoWrap` policy does not reach it. Width and colour depth are the
// render's own.
function stripOptions(geometry: DiagnosticGeometry): BuildLineOptions {
  return {
    style: "plain",
    separator: "",
    width: geometry.width,
    wrap: true,
    padding: 0,
    charset: "unicode",
    colorCompatibility: geometry.colorCompatibility,
  };
}

// One channel → its wrapped rows. Every word is a cell; a word wider than a
// row is folded at cell boundaries (rich-js chopCells, the same cell algebra
// FlexStrip packs by) so nothing overflows the width — a long path breaks
// across rows rather than past the edge. Whole words stay whole.
function channelRows(ch: DiagnosticChannel, opts: BuildLineOptions): string[] {
  // The click URL is born through effectsUrl like every other click — the
  // full message rides in it, so a copy is never an excerpt.
  const style = new Style({
    bgcolor: ch.colors.bg,
    color: ch.colors.fg,
    link: effectsUrl([{ verb: ch.verb, args: [ch.message] }]),
  });
  // A cell plus its trailing space must fit one row, so words fold at width−1
  // — never below the widest glyph (2 cells): a fold narrower than one glyph
  // is not a fold, and a 1–2 cell terminal simply cannot hold one.
  const fold = asCellCol(Math.max(2, opts.width - 1));
  return ch.lines.flatMap((line, i) => {
    const prefix = i === 0 ? GLYPH : ISSUE_INDENT;
    const words = [prefix, ...line.split(" ")].flatMap((w) =>
      chopCells(w, fold),
    );
    const cells = words.map(
      (w) => new RichText(`${w} `, { style, end: "", noWrap: true }),
    );
    return renderStripCells(cells, opts).split("\n");
  });
}

// The strip's last row, always exactly one row that fits: the elision count
// when the cap dropped rows, then the `file://` affordances. The config path
// is middle-truncated into the width that remains after the fixed text,
// keeping its head and tail (the parts that identify a path); then the
// assembled row is clipped to the width, so a terminal narrower than the
// fixed text still gets one row inside it. The link carries the full URL
// regardless of what is visible.
function trailerRow(
  diagnostics: Diagnostics,
  links: DiagnosticLinks,
  elided: number,
  opts: BuildLineOptions,
): string {
  const { colors } = diagnostics.channels[0];
  const { fullText, failedConfigFile } = links;
  const base = new Style({ bgcolor: colors.bg, color: colors.fg });
  const frag = (text: string, style: Style): RichText =>
    new RichText(text, { style, end: "", noWrap: true });
  const head = [
    frag(`↳ ${elided > 0 ? `${elided} more rows · ` : ""}`, base),
    fullText.kind === "file"
      ? frag("open full text", base.withLink(pathToFileURL(fullText.path).href))
      : frag(`full text unavailable: ${sanitizeText(fullText.reason)}`, base),
  ];
  const config =
    failedConfigFile === null
      ? []
      : [
          frag(" · open ", base),
          frag(
            sanitizeText(failedConfigFile),
            base.withLink(pathToFileURL(failedConfigFile).href),
          ),
        ];
  const fixed = [...head, ...config.slice(0, -1)];
  const fixedWidth = fixed.reduce((n, f) => n + f.cellLength, 0);
  const path = config
    .slice(-1)
    .map((p) =>
      p.truncate(Math.max(1, opts.width - fixedWidth), { mode: "middle" }),
    );
  const row = RichText.fromFragments([...fixed, ...path]).truncate(opts.width, {
    overflow: "ellipsis",
  });
  row.noWrap = true;
  return renderStripCells([row], opts);
}
