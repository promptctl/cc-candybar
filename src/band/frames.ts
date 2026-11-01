// The band lane's encoding of a session's frames, for the Claude Code mod that
// draws the bar in the band above the prompt (mod/, epic
// candybar-animation-wbxz.g69): each drawn Frame as the rows of styled runs the
// mod's `Text` and `Link` take. The daemon encodes it for each band-lane
// subscriber (src/daemon/lane-frames.ts), beside the renderer that drew it, so
// the mod's child only relays it.
//
// [LAW:one-source-of-truth] The daemon stays the only renderer, and the
// statusline client the only source of the session's data: a frame is the draw
// the statusline's bytes are encoded from, so the band shows exactly what the
// statusline would.

import { ColorDepth, ColorSpec } from "@promptctl/rich-js";
import type { BandBar, BandRun, RunColor } from "../../mod/types";
import {
  laneEncoded,
  mergedRuns,
  type Attribute,
  type Frame,
  type Run,
} from "../render/frame";

// The sixteen colours a terminal's theme draws, by the names the mod's `Text`
// takes, in SGR order (30–37, then 90–97).
const STANDARD_NAMES: readonly RunColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
];

// [LAW:types-are-the-program] A colour the draw fixed is drawn as that colour;
// one of the sixteen stays a name, so the terminal's theme draws it as it draws
// the statusline's.
function runColor(drawn: string | undefined): RunColor | undefined {
  if (drawn === undefined) return undefined;
  const spec = ColorSpec.parse(drawn);
  if (spec.isDefault) return undefined;
  const fixed = spec.fixedValue;
  if (fixed !== undefined) return fixed.hex;
  const name =
    spec.type === ColorDepth.STANDARD && spec.number !== undefined
      ? STANDARD_NAMES[spec.number]
      : undefined;
  if (name === undefined) {
    throw new Error(`frames: no band colour for ${spec.name}`);
  }
  return name;
}

type BandAttribute =
  | "bold"
  | "dimColor"
  | "italic"
  | "underline"
  | "strikethrough"
  | "inverse";

// Every text attribute a Run can hold, and the `Text` prop that draws it; null
// where the mod's `Text` has none, which the band refuses rather than drawing
// concealed text, say, in the clear.
// [LAW:one-source-of-truth] Keyed by the Run's own `Attribute`: an attribute
// rich-js adds fails to compile here until the band says how to draw it.
const ATTRIBUTES = {
  bold: "bold",
  dim: "dimColor",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  reverse: "inverse",
  blink: null,
  blink2: null,
  conceal: null,
  underline2: null,
  frame: null,
  encircle: null,
  overline: null,
} as const satisfies Record<Attribute, BandAttribute | null>;

function bandRun({ text, fg, bg, attrs = [], link }: Run): BandRun {
  const color = runColor(fg);
  const backgroundColor = runColor(bg);
  const attributes: Partial<Record<BandAttribute, true>> = {};
  for (const name of attrs) {
    const prop = ATTRIBUTES[name];
    if (prop === null)
      throw new Error(`frames: the band cannot draw ${name} text`);
    attributes[prop] = true;
  }
  return {
    text,
    ...(color !== undefined && { color }),
    ...(backgroundColor !== undefined && { backgroundColor }),
    ...attributes,
    ...(link !== undefined && { href: link }),
  };
}

function encode(frame: Frame): BandBar {
  return {
    ok: true,
    band: frame.rows.map((row) => mergedRuns(row).map(bandRun)),
  };
}

// One drawn bar as the rows of runs the mod draws.
export function bandFrame(frame: Frame): BandBar {
  return laneEncoded(encode, frame);
}
