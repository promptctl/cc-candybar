// [LAW:one-source-of-truth] [LAW:single-enforcer] Ordinary render data: every line
// flows through the SAME renderStripCells the bar's rows do.
// [LAW:effects-at-boundaries] Pure; the trailer's file is written at the daemon edge.

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

// [LAW:one-source-of-truth] Absent rows read as "no client ceiling", not a guess.
export const MAX_DIAGNOSTIC_ROWS = 20;
export function diagnosticRowCap(termRows: number | undefined): number {
  return Math.min(MAX_DIAGNOSTIC_ROWS, termRows ?? MAX_DIAGNOSTIC_ROWS);
}

// [LAW:one-type-per-behavior] One shape; heading, glyph and colours are the data.
export interface DiagnosticSeverity {
  readonly heading: string;
  readonly glyph: string;
  readonly colors: DiagnosticColors;
}
export const ERROR_SEVERITY: DiagnosticSeverity = {
  heading: "ERROR",
  glyph: "⚠",
  colors: DIAGNOSTIC_ERROR_COLORS,
};
export const WARNING_SEVERITY: DiagnosticSeverity = {
  heading: "WARNING",
  glyph: "⚠",
  colors: DIAGNOSTIC_WARNING_COLORS,
};
// An update notice is an offer, not an alarm, and its glyph says so.
export const UPDATE_SEVERITY: DiagnosticSeverity = {
  heading: "UPDATE",
  glyph: "⬆",
  colors: DIAGNOSTIC_WARNING_COLORS,
};

// [LAW:parse-dont-validate] Sanitized at construction, whatever produced the text.
export interface DiagnosticSpan {
  readonly text: string;
  readonly link: string;
}
export function diagnosticSpan(text: string, link: string): DiagnosticSpan {
  return { text: sanitizeText(text), link };
}
export type DiagnosticLine = readonly [DiagnosticSpan, ...DiagnosticSpan[]];

// [LAW:no-silent-failure] The underlying message shows, never a constant label.
export interface DiagnosticChannel {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly lines: readonly [DiagnosticLine, ...DiagnosticLine[]];
}

// `file://` needs no handler of ours — a config error is exactly when ours may be gone.
// [LAW:no-silent-failure] A dump that failed to write is SAID, never linked.
export type FullTextLink =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unavailable"; readonly reason: string };

// [LAW:no-ambient-temporal-coupling] A Diagnostics cannot name an unwritten file.
export interface DiagnosticLinks {
  readonly fullText: FullTextLink;
  readonly failedConfigFile: string | null;
}

// [LAW:types-are-the-program] Non-empty by construction; nothing to show is `null`.
export interface Diagnostics {
  readonly channels: readonly [DiagnosticChannel, ...DiagnosticChannel[]];
}

export interface DiagnosticGeometry {
  readonly width: number;
  readonly rowCap: number;
  readonly colorCompatibility: ColorCompatibility;
}

// [LAW:parse-dont-validate] Typed-or-nothing once, so downstream never re-asks.
export function collectDiagnostics(
  error: string,
  updates: readonly DiagnosticChannel[],
  warning: string,
): Diagnostics | null {
  const [first, ...rest] = [
    messageChannel(error, ERROR_SEVERITY, VERB_SHOW_CONFIG_ERROR),
    updates,
    messageChannel(warning, WARNING_SEVERITY, VERB_SHOW_CONFIG_WARNING),
  ].flat();
  return first === undefined ? null : { channels: [first, ...rest] };
}

// Every span carries the click that copies the WHOLE message, not its own line.
export function messageChannel(
  message: string,
  severity: DiagnosticSeverity,
  verb: typeof VERB_SHOW_CONFIG_ERROR | typeof VERB_SHOW_CONFIG_WARNING,
): DiagnosticChannel[] {
  const link = effectsUrl([{ verb, args: [message] }]);
  const [first, ...rest] = message
    .split(/\r\n|\r|\n/)
    .map((line) => diagnosticSpan(line, link))
    .filter((span) => span.text !== "")
    .map((span): DiagnosticLine => [span]);
  return first === undefined
    ? []
    : [{ severity, message, lines: [first, ...rest] }];
}

export function formatDiagnosticDump(diagnostics: Diagnostics): string {
  return diagnostics.channels
    .map((ch) => `${ch.severity.heading}\n${ch.message}\n`)
    .join("\n");
}

// Indented so the eye tells "next issue" from "same issue, next row".
const ISSUE_INDENT = " ";

// [LAW:dataflow-not-control-flow] The trailer is a value of zero or one rows.
export function composeWithDiagnostics(
  body: string,
  diagnostics: Diagnostics | null,
  links: DiagnosticLinks,
  geometry: DiagnosticGeometry,
): string {
  if (diagnostics === null) return body;
  const opts = stripOptions(geometry);
  const rows = diagnostics.channels.flatMap((ch) => channelRows(ch, opts));
  const trailed =
    links.failedConfigFile !== null || rows.length > geometry.rowCap;
  const shown = rows.slice(0, geometry.rowCap - Number(trailed));
  const trailer = trailed
    ? [trailerRow(diagnostics, links, rows.length - shown.length, opts)]
    : [];
  const strip = [...shown, ...trailer].join("\n");
  return body ? `${strip}\n${body}` : strip;
}

// NO separator: each word carries its own trailing space, since the joiner's would
// render unstyled. Wrapping is always on — the bar's `autoWrap` does not reach here.
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

// Only a word wider than a row folds, at cell boundaries, so whole words stay whole.
function channelRows(ch: DiagnosticChannel, opts: BuildLineOptions): string[] {
  const base = new Style({
    bgcolor: ch.severity.colors.bg,
    color: ch.severity.colors.fg,
  });
  // A cell plus its trailing space must fit; a fold under one glyph is not a fold.
  const fold = asCellCol(Math.max(2, opts.width - 1));
  const cell = (word: string, style: Style): RichText =>
    new RichText(`${word} `, { style, end: "", noWrap: true });
  return ch.lines.flatMap((line, i) => {
    // The glyph joins the same affordance as the words after it.
    const prefix = cell(
      i === 0 ? ch.severity.glyph : ISSUE_INDENT,
      base.withLink(line[0].link),
    );
    const cells = line.flatMap((span) => {
      const style = base.withLink(span.link);
      return span.text
        .split(" ")
        .flatMap((w) => chopCells(w, fold))
        .map((w) => cell(w, style));
    });
    return renderStripCells([prefix, ...cells], opts).split("\n");
  });
}

// Always exactly one row that fits: the path middle-truncates into what remains,
// then the row clips. The link carries the full URL regardless of what shows.
function trailerRow(
  diagnostics: Diagnostics,
  links: DiagnosticLinks,
  elided: number,
  opts: BuildLineOptions,
): string {
  const { colors } = diagnostics.channels[0].severity;
  const { fullText, failedConfigFile } = links;
  const base = new Style({ bgcolor: colors.bg, color: colors.fg });
  const frag = (text: string, style: Style): RichText =>
    new RichText(text, { style, end: "", noWrap: true });
  const more =
    elided > 0
      ? [
          frag(`${elided} more rows · `, base),
          fullText.kind === "file"
            ? frag(
                "open full text",
                base.withLink(pathToFileURL(fullText.path).href),
              )
            : frag(
                `full text unavailable: ${sanitizeText(fullText.reason)}`,
                base,
              ),
        ]
      : [];
  const config =
    failedConfigFile === null
      ? []
      : [
          frag(`${more.length > 0 ? " · " : ""}open `, base),
          frag(
            sanitizeText(failedConfigFile),
            base.withLink(pathToFileURL(failedConfigFile).href),
          ),
        ];
  const fixed = [frag("↳ ", base), ...more, ...config.slice(0, -1)];
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
