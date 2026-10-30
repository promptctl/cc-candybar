// The band lane's encoding of a session's frames, for the Claude Code mod that
// draws the bar in the band above the prompt (mod/, epic
// candybar-animation-wbxz.g69): each pushed render response as the rows of
// styled runs the mod's `Text` and `Link` take. The daemon encodes it for each
// band-lane subscriber (src/daemon/lane-frames.ts), beside the renderer whose
// output it encodes, so the mod's child only relays it.
//
// [LAW:one-source-of-truth] The daemon stays the only renderer, and the
// statusline client the only source of the session's data: a frame is the
// statusline's own render, classified and planned by the relay's own outcome
// code, so the band shows exactly what the statusline would, a refused
// render's error glyph included.

import { AnsiDecoder, ColorDepth, Style } from "@promptctl/rich-js";
import type { ColorSpec, StyleOptions } from "@promptctl/rich-js";
import type { BandBar, BandRun, RunColor } from "../../mod/types";
import { renderOutcomeOf } from "../daemon/client";
import type { Response } from "../daemon/protocol";
import {
  ANSI_RESET,
  DIAGNOSTIC_ERROR_BG,
  DIAGNOSTIC_ERROR_FG,
} from "../render/diagnostic-style";
import { sanitizeText } from "../render/diagnostic-text";
import { planOutcome } from "../render/outcome-plan";

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

// [LAW:types-are-the-program] A colour the escape fixed is drawn as that
// colour; one of the sixteen stays a name, so the terminal's theme draws it as
// it draws the statusline's.
function runColor(spec: ColorSpec | undefined): RunColor | undefined {
  if (spec === undefined || spec.isDefault) return undefined;
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

// rich-js's text attributes: every on/off field of a `Style`.
type StyleAttribute = {
  [K in keyof StyleOptions]-?: NonNullable<StyleOptions[K]> extends boolean
    ? K
    : never;
}[keyof StyleOptions];

// Every text attribute a rich-js `Style` carries, and the `Text` prop that
// draws it; null where the mod's `Text` has none, which the band refuses
// rather than drawing concealed text, say, in the clear.
// [LAW:one-source-of-truth] rich-js does not export its ATTRIBUTE_NAMES, so
// this table is keyed by its `StyleOptions` instead: an attribute rich-js
// adds fails to compile here until the band says how to draw it.
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
} as const satisfies Record<StyleAttribute, BandAttribute | null>;

const ATTRIBUTE_NAMES = Object.keys(ATTRIBUTES) as Array<
  keyof typeof ATTRIBUTES
>;

function bandRun(text: string, style: Style): BandRun {
  const color = runColor(style.color);
  const backgroundColor = runColor(style.bgcolor);
  const attributes: Partial<Record<BandAttribute, true>> = {};
  for (const name of ATTRIBUTE_NAMES) {
    if (style[name] !== true) continue;
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
    ...(style.link !== undefined && { href: style.link }),
  };
}

const PLAIN = new Style();

// One rendered bar, ANSI and OSC 8, as the rows of runs the mod draws. Text
// no span covers is drawn plain.
export function bandFrame(ansi: string): BandBar {
  const rows = new AnsiDecoder().decode(ansi).map((line) => {
    const plain = line.plain;
    const runs: BandRun[] = [];
    let at = 0;
    for (const span of line.spans) {
      if (!(span.style instanceof Style)) {
        throw new Error(
          `frames: the decoder gave a span a ${typeof span.style} style`,
        );
      }
      if (span.start > at)
        runs.push(bandRun(plain.slice(at, span.start), PLAIN));
      runs.push(bandRun(plain.slice(span.start, span.end), span.style));
      at = span.end;
    }
    if (at < plain.length) runs.push(bandRun(plain.slice(at), PLAIN));
    return runs;
  });
  return { ok: true, band: rows };
}

// One pushed render response as the frame the mod draws.
// [LAW:no-silent-failure] A bar the band cannot draw is a frame saying why,
// in the diagnostics' colours. The stream goes on, so the next bar it
// can draw takes its place, as the statusline's next render replaces its
// error glyph: a config fixed brings the band back. A render that failed is
// drawn as the statusline draws it, its error glyph — so every frame a band
// subscriber receives is a bar, and every refusal is the stream's end.
export function bandResponse(resp: Response): BandBar {
  const ansi = planOutcome(renderOutcomeOf(resp)).output;
  try {
    return bandFrame(ansi);
  } catch (error) {
    const why = sanitizeText(
      error instanceof Error ? error.message : String(error),
    );
    return bandFrame(
      `${DIAGNOSTIC_ERROR_BG}${DIAGNOSTIC_ERROR_FG}⚠ cc-candybar ${why}${ANSI_RESET}\n`,
    );
  }
}
