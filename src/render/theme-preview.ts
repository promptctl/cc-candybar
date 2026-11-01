// [LAW:one-source-of-truth] `{{ themePreview }}` — a small sample of the theme
// the bar is wearing, drawn from the colours the bar itself is drawn from
// (brandon-theme-picker-bgw.ef6): the decorations a closed cell wears under the
// render's decor at the depth drawn (each of its variation's roles at the
// tones of that role's window there, the roles side by side), the state/plane
// pair of the band the preview's own lineage opens from the bar — inside the
// settings menu, the door's, so "▾ open" is the colour the open door wears —
// and the two alerts. Nothing here computes a colour. Each swatch is a call to
// the SAME function the render walk calls for that kind of cell
// (`decorEntryColour` over the window, `bandFor`, the role lookup), on the
// SAME palette object the walk colours every unpinned segment from
// (the look drawDsl publishes, `renderLook`), with its text the one the
// walk draws there — the shade's for a closed cell, `textOn` for the rest — so
// a preview shows only colours its theme names, in the shades the bar deals.
// Where one role's swatches meet the next's they are held apart by the rule a
// bar row turning hue is (`vocabularyOf`), so a swatch there can wear another
// tone or a rung past its role's window in place of the tone it was dealt, as
// a cell either side of a turn on the bar can.
//
// The palette sampled is the render's own, not the active segment's: a segment
// pinned to another theme by `palette:` still previews the bar's theme, which
// is what a theme or style control is choosing. Named an option action
// (`{{ themePreview "applyAction" }}`), it samples instead the palette the
// option that action's key holds puts in force — the domain's own `paletteOf`,
// the palette its swatch is drawn from — so the theme picker demos the theme
// it has selected, whichever placement it is choosing for.
//
// [LAW:one-way-deps] Lives in render/, injected into the engine as data by
// registerDslConfig; the generic engine never imports it.

import { RichText } from "@promptctl/rich-js";
import type { ColorRgba, ColorDepth, Palette } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  bandFor,
  decorEntryColour,
  textOn,
  vocabularyOf,
  type Decor,
  type Disclosure,
} from "../themes/decor.js";
import { renderLook, type ActionRuntime } from "./action.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";
import { decoratedCell } from "./band-style.js";
import { ledRowBudget } from "./picker.js";
import { optionPalette } from "./swatches.js";
import { refuseSurplus } from "../template-engine/optional-tail.js";

// What the closed swatches say: words a bar actually carries, so the sample
// reads as a bar rather than a colour chart. Dealt to the vocabulary in order
// and repeated if the vocabulary outgrows them — the words are decoration too.
const BAR_WORDS = ["~/code", "main", "opus", "42%", "5m", "$1.20"] as const;

/** One swatch of the preview: what it says, the colour it is drawn on, and the text colour it is written in. */
interface Swatch {
  readonly text: string;
  readonly colour: ColorRgba;
  readonly ink: ColorRgba;
}

// [LAW:dataflow-not-control-flow] The preview as data, in the order it is
// drawn: two rows — the theme picker's "two-row theme preview, so users can
// get a good look before choosing" (brandon-theme-swatch-8v9r) — each a list of
// groups, one group per kind of cell. The first row is what the closed bar
// wears; the second what opens from it, and the alerts.
function previewRows(
  palette: Palette,
  decor: Decor,
  opens: Disclosure,
  drawnAt: ColorDepth,
): ReadonlyArray<ReadonlyArray<readonly Swatch[]>> {
  const band = bandFor(palette, opens, drawnAt);
  // A cell chosen its text the way the walk chooses it off its decoration.
  const chosen = (text: string, colour: ColorRgba): Swatch => ({
    text,
    colour,
    ink: textOn(palette, colour, drawnAt),
  });
  return [
    [
      vocabularyOf(palette, decor, drawnAt).map((entry, i) => {
        const colour = decorEntryColour(palette, entry);
        return {
          text: BAR_WORDS[i % BAR_WORDS.length]!,
          colour,
          ink: decor.shade.text(palette, entry.hue, colour, drawnAt),
        };
      }),
    ],
    [
      [chosen("▾ open", band.state), chosen("menu", band.plane)],
      [
        chosen("warn", palette.get("warning")),
        chosen("error", palette.get("error")),
      ],
    ],
  ];
}

// [LAW:dataflow-not-control-flow] Each row fits the row it sits on the way a
// picker does (`ledRowBudget`): whole swatches, in drawing order,
// while they fit — a narrow terminal shows fewer swatches, never a line the
// terminal breaks away from its ✕. Swatches in a group touch, like
// neighbouring bar cells; groups are set apart by one space of whatever the
// preview sits on.
function renderRow(
  groups: ReadonlyArray<readonly Swatch[]>,
  available: number,
): RichText[] {
  const cells = groups.flatMap((group, g) =>
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
  return fragments;
}

/** The preview: its two rows, as one value carrying the line break between them. */
export function renderThemePreview(
  palette: Palette,
  decor: Decor,
  opens: Disclosure,
  drawnAt: ColorDepth,
  available: number,
): RichText {
  const rows = previewRows(palette, decor, opens, drawnAt).map((row) =>
    renderRow(row, available),
  );
  const preview = RichText.fromFragments(
    rows.flatMap((row, i) => (i === 0 ? row : [new RichText("\n"), ...row])),
  );
  preview.overflow = "ignore";
  preview.end = "";
  return preview;
}

export function themePreviewFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    // `{{ themePreview }}` samples the palette the bar is drawn in;
    // `{{ themePreview "applyAction" }}` the palette the option that action's
    // key holds puts in force — the theme picker's demo of the selected theme.
    themePreview: {
      fn: (...args: unknown[]) => {
        const [applyName, ...extra] = args;
        refuseSurplus("themePreview", ["applyAction"], extra);
        if (applyName !== undefined && typeof applyName !== "string") {
          throw new Error(
            `themePreview: applyAction must name a declared action, got ${JSON.stringify(applyName)}`,
          );
        }
        const { palette, decor } = renderLook(runtime, "{{ themePreview }}");
        return renderThemePreview(
          applyName === undefined
            ? palette
            : optionPalette(runtime, applyName, "themePreview"),
          decor,
          // The bar trigger's band of the lineage the preview stands in: a
          // band is coloured from the row its trigger stands in, which only
          // the trigger's own region knows (decor.ts `decorationFor`).
          {
            ...requireActiveSegment(activeSegment, "{{ themePreview }}")
              .disclosure,
            depth: 0,
          },
          activeSegment.drawnAt(),
          ledRowBudget(runtime),
        );
      },
      argTypes: ["value"],
      arity: { kind: "variadic" },
      returnType: "T",
    },
  };
}
