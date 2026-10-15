// [LAW:one-source-of-truth] `{{ themePreview }}` — a small sample of the theme
// the bar is wearing, drawn from the colours the bar itself is drawn from
// (brandon-theme-picker-bgw.ef6): every decoration a closed cell can wear under
// the render's decor (each of its variation's roles at each of its shade's
// shades), the state/plane pair an open disclosure at the bar's root wears,
// and the two alerts. Nothing here computes a colour. Each swatch is a call to
// the SAME function the render walk calls for that kind of cell
// (`decorEntryColour`, `decorationFor`, `bandFor`, the role lookup), on the
// SAME palette object the walk colours every unpinned segment from
// (`ActionRuntime.palette`, published by renderDsl), with its text the one the
// walk draws there — the shade's for a closed cell, `textOn` for the rest — so
// a preview cannot show a colour the bar under that theme would not draw.
//
// The palette sampled is the render's own, not the active segment's: a segment
// pinned to another theme by `palette:` still previews the bar's theme, which
// is what a theme or style control is choosing.
//
// [LAW:one-way-deps] Lives in render/, injected into the engine as data by
// registerDslConfig; the generic engine never imports it.

import { RichText } from "@promptctl/rich-js";
import type { ColorRgba, ColorDepth, Palette } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  bandFor,
  barRoot,
  decorationFor,
  decorEntryColour,
  paletteRole,
  textOn,
  vocabularyOf,
  type Decor,
} from "../themes/decor.js";
import type { ActionRuntime } from "./action.js";
import type { ActiveSegmentRef } from "./active-segment.js";
import { decoratedCell } from "./band-style.js";
import { ledRowBudget } from "./picker.js";

// What the closed swatches say: words a bar actually carries, so the sample
// reads as a bar rather than a colour chart. Dealt to the vocabulary in order
// and repeated if the vocabulary outgrows them — the words are decoration too.
const BAR_WORDS = ["~/code", "main", "opus", "42%", "5m", "$1.20"] as const;

/** One swatch of the preview: what it says, the colour it is drawn on, and the text colour it is written in. */
export interface Swatch {
  readonly text: string;
  readonly colour: ColorRgba;
  readonly ink: ColorRgba;
}

// [LAW:dataflow-not-control-flow] The preview as data, in the order it is
// drawn: one group per kind of cell. Exported so a test can hold every swatch
// against the cell the bar renders, rather than re-reading them off bytes.
export function previewSwatches(
  palette: Palette,
  decor: Decor,
  drawnAt: ColorDepth,
): readonly Swatch[][] {
  // What a trigger at the bar's root opens: its row's ground, its band.
  const band = bandFor(
    palette,
    decorationFor(palette, barRoot(decor), drawnAt).disclosure,
    drawnAt,
  );
  // A cell chosen its text the way the walk chooses it off its decoration.
  const chosen = (text: string, colour: ColorRgba): Swatch => ({
    text,
    colour,
    ink: textOn(palette, colour, drawnAt),
  });
  return [
    vocabularyOf(decor).map((entry, i) => {
      const colour = decorEntryColour(palette, entry);
      return {
        text: BAR_WORDS[i % BAR_WORDS.length]!,
        colour,
        ink: decor.shade.text(palette, entry.hue, colour, drawnAt),
      };
    }),
    [chosen("▾ open", band.state), chosen("menu", band.plane)],
    [
      chosen("warn", paletteRole(palette, "warning")),
      chosen("error", paletteRole(palette, "error")),
    ],
  ];
}

// [LAW:dataflow-not-control-flow] The preview fits the row it sits on the way
// the carousel above it does (`ledRowBudget`): whole swatches, in drawing
// order, while they fit — a narrow terminal shows fewer swatches, never a line
// the terminal breaks away from its ✕.
export function renderThemePreview(
  palette: Palette,
  decor: Decor,
  drawnAt: ColorDepth,
  available: number,
): RichText {
  // Swatches in a group touch, like neighbouring bar cells; groups are set
  // apart by one space of whatever the preview sits on.
  const cells = previewSwatches(palette, decor, drawnAt).flatMap((group, g) =>
    group.map(({ text, colour, ink }, i) => ({
      gap: g > 0 && i === 0 ? " " : "",
      cell: new RichText(` ${text} `, {
        style: decoratedCell({ tint: colour, text: ink }),
      }),
    })),
  );
  const fragments: RichText[] = [];
  let width = 0;
  for (const { gap, cell } of cells) {
    width += gap.length + cell.cellLength;
    if (width > available) break;
    if (gap !== "") fragments.push(new RichText(gap));
    fragments.push(cell);
  }
  const preview = RichText.fromFragments(fragments);
  preview.overflow = "ignore";
  preview.end = "";
  return preview;
}

export function themePreviewFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    themePreview: {
      fn: () =>
        renderThemePreview(
          runtime.palette,
          runtime.decor,
          activeSegment.drawnAt(),
          ledRowBudget(runtime),
        ),
      argTypes: [],
      arity: { kind: "exact" },
      returnType: "T",
    },
  };
}
