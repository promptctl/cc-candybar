// What a draw produces: a frame of rows of styled runs, in the colours drawn at
// its depth. A bar exists as this structure, and every byte a terminal receives
// is encoded from it here.

import {
  ColorDepth,
  Segment,
  Style,
  resolveDestination,
  segmentsToString,
  type Attributes,
  type ColorSpec,
  type Destination,
} from "@promptctl/rich-js";
import type { ColorCompatibility } from "../themes/policy.js";
import type { DrawnMotion } from "./drawn-motion.js";
import type { RowKind } from "./effect.js";

export type Attribute = keyof Attributes;

// [LAW:types-are-the-program] Text in one look. `fg` and `bg` are the colours
// drawn at the frame's depth, not the ones a config asked for: a hex at
// truecolor, else what rich-js names the colour (`red`, `color(17)`). `attrs`
// holds only the attributes that are on. At depth `none` a run has no look and
// keeps its link, which is what the encoder writes there.
export interface Run {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly attrs?: readonly Attribute[];
  readonly link?: string;
}

// One line on screen. A row FlexStrip wrapped is one Row per line.
export interface Row {
  readonly kind: RowKind;
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
  // The depth the colours were drawn at: the view's.
  readonly depth: ColorCompatibility;
  readonly rows: readonly Row[];
  // The moment, in wall seconds, the frame next changes without new data, or
  // Infinity: what a feed drawing it waits for (src/daemon/frame-feed.ts).
  readonly nextChange: number;
  readonly motion: DrawnMotion;
  // The sources whose values this frame drew as not answered yet, by name.
  readonly pending: readonly string[];
}

// [LAW:one-source-of-truth] A drawn colour is concrete by its type: a TRUECOLOR
// spec is its value — a ColorBlend is one, with its mix in `value`, so a blend
// is no case here — and anything else is its name, which reads back as itself.
// The spec must be one `Style.drawnColors` returned: a style's own would keep
// every byte the same, since the encoder downgrades it again, while the run
// held a colour never drawn.
function drawnColor(spec: ColorSpec): string {
  return spec.type === ColorDepth.TRUECOLOR ? spec.value!.hex : spec.name;
}

// The look a style draws at a depth that has one.
function lookOf(style: Style, depth: ColorDepth): Omit<Run, "text" | "link"> {
  const { color, bgcolor } = style.drawnColors(depth);
  const attrs = (Object.keys(style.attributes) as Attribute[]).filter(
    (name) => style[name] === true,
  );
  return {
    ...(color !== undefined && { fg: drawnColor(color) }),
    ...(bgcolor !== undefined && { bg: drawnColor(bgcolor) }),
    ...(attrs.length > 0 && { attrs }),
  };
}

function runOf({ text, style }: Segment, { colorSystem }: Destination): Run {
  return {
    text,
    ...(style !== undefined &&
      colorSystem !== null &&
      lookOf(style, colorSystem)),
    ...(style?.link !== undefined && { link: style.link }),
  };
}

// Rich-js segments as the runs of each line they draw. Control segments and
// empty text go first, since the encoder writes nothing for either and
// `Segment.splitLines` would turn one trailing a final newline into a blank
// line of its own. A line ended by a newline is one line: nothing follows it.
export function runLines(
  segments: readonly Segment[],
  destination: Destination,
): Run[][] {
  const written = segments.filter((s) => !s.isControl && s.text.length > 0);
  return Segment.splitLines(written).map((line) =>
    line.map((segment) => runOf(segment, destination)),
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

export function ansiOf(frame: Frame): string {
  return encodeAnsi(
    frame.rows.map((row) => row.runs),
    frame.depth,
  );
}

// A line's text.
export function plainOf(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}
