// The band's encoding of a session's frame stream (`cc-candybar frames
// --format band`), for the Claude Code mod that draws the bar in the band
// above the prompt (mod/, epic candybar-animation-wbxz.g69): each pushed
// render response as the rows of styled runs the mod's `Text` and `Link`
// take, one JSON object a line.
//
// [LAW:one-source-of-truth] The daemon stays the only renderer, and the
// statusline client the only source of the session's data: a frame is the
// statusline's own render, classified and planned by the relay's own outcome
// code, so the band shows exactly what the statusline would, a refused
// render's error glyph included.

import { AnsiDecoder, ColorDepth, Style } from "@promptctl/rich-js";
import type { ColorSpec } from "@promptctl/rich-js";
import type { BandFrame, BandRun, RunColor } from "../../mod/types";
import { renderOutcomeOf } from "../daemon/client";
import type { Response } from "../daemon/protocol";
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

function bandRun(text: string, style: Style): BandRun {
  const color = runColor(style.color);
  const backgroundColor = runColor(style.bgcolor);
  return {
    text,
    ...(color !== undefined && { color }),
    ...(backgroundColor !== undefined && { backgroundColor }),
    ...(style.bold === true && { bold: true }),
    ...(style.dim === true && { dimColor: true }),
    ...(style.italic === true && { italic: true }),
    ...(style.underline === true && { underline: true }),
    ...(style.strike === true && { strikethrough: true }),
    ...(style.reverse === true && { inverse: true }),
    ...(style.link !== undefined && { href: style.link }),
  };
}

const PLAIN = new Style();

// One rendered bar, ANSI and OSC 8, as the rows of runs the mod draws. Text
// no span covers is drawn plain.
export function bandFrame(ansi: string): BandFrame {
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
  return { rows };
}

// One pushed render response as the line the mod reads.
export function bandLine(resp: Response): string {
  return JSON.stringify(bandFrame(planOutcome(renderOutcomeOf(resp)).output));
}
