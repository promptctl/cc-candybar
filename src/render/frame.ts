// What a draw produces: a frame of rows of styled runs, in the colours drawn at
// its depth. A bar exists as this structure, and every byte of a draw is encoded
// from it here.

import {
  ColorDepth,
  Segment,
  Style,
  resolveDestination,
  segmentsToString,
  type Attributes,
  type ColorSpec,
} from "@promptctl/rich-js";
import type { ColorCompatibility } from "../themes/policy.js";
import {
  DIAGNOSTIC_ERROR_COLORS,
  type DiagnosticColors,
} from "./diagnostic-style.js";
import { sanitizeText } from "./diagnostic-text.js";
import type { DrawnMotion } from "./drawn-motion.js";
import type { RowKind } from "./effect.js";
import { permanentGlyphText } from "./error-glyph.js";

export type Attribute = keyof Attributes;

// [LAW:types-are-the-program] Text in one look. `fg` and `bg` are the colours
// drawn at the frame's depth, not the ones a config asked for, in one spelling
// each: a hex for a drawn truecolor colour, else `color(n)`, so runs drawn alike
// are one look and a standard colour stays the terminal's at truecolor too.
// `attrs` holds only the attributes that are on. At depth `none` a run has no
// look and keeps its link, which is what the encoder writes there.
// [LAW:single-enforcer] `link` is clean as RichText admitted it. That admission
// is the only check on a link a lane writes past rich-js's encoder, so a run
// comes only from segments a RichText drew.
export interface Run {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly attrs?: readonly Attribute[];
  readonly link?: string;
}

// One line on screen. A row FlexStrip wrapped is one Row per line.
export interface Row {
  // A row of the bar, or of what stands in its place, which no motion reaches.
  readonly kind: RowKind | "diagnostic";
  readonly runs: readonly Run[];
}

// [LAW:types-are-the-program] A drawn bar (brandon-doctor-v62x.tgp): its rows
// and its motion. `moves` is a finite `nextChange`, what its cells and the
// holds told to its draw say, never what the config asked for: a template's
// `frames` moves the bar as surely as an effect does. `can-move` is a still
// frame whose config, under the settings in force, can draw motion at a later
// render — a `globals.effect` rule, placements that fade as they come and go,
// or a placement wearing its own effect that is not drawn now (hidden by its
// `when`, or in a closed body) — which no still cell can say.
export interface Frame {
  // The depth the colours were drawn at.
  readonly depth: ColorCompatibility;
  readonly rows: readonly Row[];
  // The moment, in wall seconds, the frame next changes without new data, or
  // Infinity: what a feed drawing it waits for (src/daemon/frame-feed.ts).
  readonly nextChange: number;
  readonly motion: DrawnMotion;
  // The sources whose values this frame drew as not answered yet, by name.
  readonly pending: readonly string[];
}

// A Frame as it crosses the wire: JSON writes Infinity as null.
export type WireFrame = Omit<Frame, "nextChange"> & {
  readonly nextChange: number | null;
};

// [LAW:parse-dont-validate] The receiving edge of a Frame. A reply that never
// crossed a socket holds its Infinity, and reads the same way.
export function parseFrame(wire: WireFrame): Frame {
  return { ...wire, nextChange: wire.nextChange ?? Infinity };
}

// [LAW:one-source-of-truth] Rows drawn in `frame`'s place: the diagnostics
// viewer, or the handoff line. They are still text, so a feed drawing them waits
// a still period, not the hidden bar's beat, though that bar can move again once
// it is back. They drew none of its sources, so none of them are pending here.
export function standIn(frame: Frame, rows: readonly Row[]): Frame {
  return {
    depth: frame.depth,
    rows,
    nextChange: Infinity,
    motion: frame.motion === "still" ? "still" : "can-move",
    pending: [],
  };
}

// [LAW:types-are-the-program] A frame saying one thing, with no draw behind it.
// Its colours are hex, so it is truecolor whatever the view's depth, and it has
// no attributes, so no lane encoder can refuse it. The text is sanitized here,
// so its one run holds no newline or escape, whoever built the text.
export function diagnosticFrame(text: string, colors: DiagnosticColors): Frame {
  return {
    depth: "truecolor",
    rows: [
      { kind: "diagnostic", runs: [{ text: sanitizeText(text), ...colors }] },
    ],
    nextChange: Infinity,
    motion: "still",
    pending: [],
  };
}

// [LAW:one-source-of-truth] A render that failed, in the words of the glyph the
// statusline's client draws for it, so every lane says what the statusline says.
export function renderFailedFrame(message: string): Frame {
  return diagnosticFrame(
    permanentGlyphText({ kind: "permanent", cause: "render_failed", message }),
    DIAGNOSTIC_ERROR_COLORS,
  );
}

// [LAW:single-enforcer] The one place a lane refuses a frame: an attribute its
// encoder cannot draw throws, and each lane's exported encoder comes through
// here, so no caller sees the throw.
// [LAW:no-silent-failure] The lane draws a frame saying why instead, in the
// diagnostics' colours. The stream goes on, so the next frame it can draw takes
// its place, as the statusline's next render replaces its error glyph: a config
// fixed brings the lane back.
export function laneEncoded<Encoded>(
  encode: (frame: Frame) => Encoded,
  frame: Frame,
): Encoded {
  try {
    return encode(frame);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return encode(
      diagnosticFrame(`⚠ cc-candybar ${why}`, DIAGNOSTIC_ERROR_COLORS),
    );
  }
}

// [LAW:one-source-of-truth] A drawn colour is concrete by its type: a TRUECOLOR
// spec is its value — a ColorBlend is one, with its mix in `value`, so a blend
// is no case here — and one of the terminal's is its number, whichever name
// drew it, since `red` and a hex downgraded to it are one colour. Only `default`
// has no number. Each reads back as itself.
// The spec must be one `Style.drawnColors` returned: a style's own would keep
// every byte the same, since the encoder downgrades it again, while the run
// held a colour never drawn.
function drawnColor(spec: ColorSpec): string {
  if (spec.type === ColorDepth.TRUECOLOR) return spec.value!.hex;
  return spec.number === undefined ? spec.name : `color(${spec.number})`;
}

// Every attribute a style can hold, as rich-js names them. `style.attributes`
// builds a new object on each read, and an effect's row is a run per cell.
const ATTRIBUTES = Object.keys(new Style().attributes) as readonly Attribute[];

// The look a style draws at a depth that has one.
function lookOf(style: Style, depth: ColorDepth): Omit<Run, "text" | "link"> {
  const { color, bgcolor } = style.drawnColors(depth);
  const attrs = ATTRIBUTES.filter((name) => style[name] === true);
  return {
    ...(color !== undefined && { fg: drawnColor(color) }),
    ...(bgcolor !== undefined && { bg: drawnColor(bgcolor) }),
    ...(attrs.length > 0 && { attrs }),
  };
}

function runOf({ text, style }: Segment, depth: ColorDepth | null): Run {
  return {
    text,
    ...(style !== undefined && depth !== null && lookOf(style, depth)),
    ...(style?.link !== undefined && { link: style.link }),
  };
}

// Rich-js segments as the runs of each line they draw. Control segments and
// empty text go first, since the encoder writes nothing for either and
// `Segment.splitLines` would turn one trailing a final newline into a blank
// line of its own. A line ended by a newline is one line: nothing follows it.
export function runLines(
  segments: readonly Segment[],
  depth: ColorDepth | null,
): Run[][] {
  const written = segments.filter((s) => !s.isControl && s.text.length > 0);
  return Segment.splitLines(written).map((line) =>
    line.map((segment) => runOf(segment, depth)),
  );
}

function segmentOf({ text, fg, bg, attrs = [], link }: Run): Segment {
  return new Segment(
    text,
    new Style({
      color: fg,
      bgcolor: bg,
      link,
      ...Object.fromEntries(attrs.map((name) => [name, true])),
    }),
  );
}

// [LAW:one-source-of-truth] The one path from a draw to bytes: each run is
// written alone, its own SGR pair and OSC 8 link, by rich-js's one encoder, and
// lines join with a newline. A caller holding no Frame hands its depth here.
export function encodeAnsi(
  lines: ReadonlyArray<readonly Run[]>,
  depth: ColorCompatibility,
): string {
  const destination = resolveDestination(depth);
  return lines
    .map((runs) => segmentsToString(runs.map(segmentOf), destination))
    .join("\n");
}

export function ansiOf(frame: Pick<Frame, "depth" | "rows">): string {
  return encodeAnsi(
    frame.rows.map((row) => row.runs),
    frame.depth,
  );
}

// The bytes of a reply: the frame's, each row ending its line.
export function composeBar(frame: Pick<Frame, "depth" | "rows">): string {
  return ansiOf(frame) + "\n";
}

const sameLook = (a: Run, b: Run): boolean =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.link === b.link &&
  a.attrs?.join() === b.attrs?.join();

// A row with neighbouring runs of one look joined, for a lane that draws runs
// rather than cells: an effect's row is a run per cell, and one link split
// across runs is one tmux range per run. ANSI never merges: `encodeAnsi` writes
// each run alone.
export function mergedRuns({ runs }: Row): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last !== undefined && sameLook(last, run))
      merged[merged.length - 1] = { ...last, text: last.text + run.text };
    else merged.push(run);
  }
  return merged;
}

// A line's text.
export function plainOf(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}

// A frame's text, a line per row.
export function textOf({ rows }: Pick<Frame, "rows">): string {
  return rows.map((row) => plainOf(row.runs)).join("\n");
}
