// [LAW:one-source-of-truth] `{{ themePreview }}` — a small sample of the theme
// the bar is wearing, drawn from the colours the bar itself is drawn from
// (brandon-theme-picker-bgw.ef6): every decoration a closed cell can wear, the
// state/plane pair an open disclosure wears, and the two alerts. Nothing here
// computes a colour. Each swatch is a call to the SAME function the render walk
// calls for that kind of cell (`decorEntryColour`, `bandFor`, the role lookup),
// on the SAME palette object the walk colours every unpinned segment from
// (`ActionRuntime.palette`, published by renderDsl), with text chosen by the
// same `stateCell`/`textOn` rule — so a preview cannot show a colour the bar
// under that theme would not draw.
//
// The palette sampled is the render's own, not the active segment's: a segment
// pinned to another theme by `palette:` still previews the bar's theme, which
// is what a theme or look control is choosing.
//
// [LAW:one-way-deps] Lives in render/, injected into the engine as data by
// registerDslConfig; the generic engine never imports it.

import { RichText } from "@promptctl/rich-js";
import type { ColorRgba, ColorDepth, Palette } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  bandFor,
  DECOR_VOCABULARY,
  decorEntryColour,
  OPEN_HUE,
  paletteRole,
} from "../themes/decor.js";
import type { ActionRuntime } from "./action.js";
import type { ActiveSegmentRef } from "./active-segment.js";
import { stateCell } from "./band-style.js";

// What the closed swatches say: words a bar actually carries, so the sample
// reads as a bar rather than a colour chart. Dealt to the vocabulary in order
// and repeated if the vocabulary outgrows them — the words are decoration too.
const BAR_WORDS = ["~/code", "main", "opus", "42%", "5m", "$1.20"] as const;

/** One swatch of the preview: what it says and the colour it is drawn on. */
export interface Swatch {
  readonly text: string;
  readonly colour: ColorRgba;
}

// [LAW:dataflow-not-control-flow] The preview as data, in the order it is
// drawn: one group per kind of cell. Exported so a test can hold every swatch
// against the cell the bar renders, rather than re-reading them off bytes.
export function previewSwatches(palette: Palette): readonly Swatch[][] {
  const band = bandFor(palette, { hue: OPEN_HUE, depth: 0 });
  return [
    DECOR_VOCABULARY.map((entry, i) => ({
      text: BAR_WORDS[i % BAR_WORDS.length]!,
      colour: decorEntryColour(palette, entry),
    })),
    [
      { text: "▾ open", colour: band.state },
      { text: "menu", colour: band.plane },
    ],
    [
      { text: "warn", colour: paletteRole(palette, "warning") },
      { text: "error", colour: paletteRole(palette, "error") },
    ],
  ];
}

export function renderThemePreview(
  palette: Palette,
  drawnAt: ColorDepth,
): RichText {
  // Swatches in a group touch, like neighbouring bar cells; groups are set
  // apart by one space of whatever the preview sits on.
  const groups = previewSwatches(palette).map((group) =>
    group.map(
      ({ text, colour }) =>
        new RichText(` ${text} `, {
          style: stateCell(palette, colour, drawnAt),
        }),
    ),
  );
  const fragments = groups.flatMap((group, i) =>
    i === 0 ? group : [new RichText(" "), ...group],
  );
  const preview = RichText.fromFragments(fragments);
  preview.noWrap = true;
  preview.end = "";
  return preview;
}

export function themePreviewFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    themePreview: {
      fn: () => renderThemePreview(runtime.palette, activeSegment.drawnAt()),
      argTypes: [],
      returnType: "T",
    },
  };
}
