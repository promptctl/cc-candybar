// [LAW:types-are-the-program] What a subsequent draw can read of a surface's
// layout. Pending placements measure the post-fill content of each cell.
// Dissolving placements replay these pre-effect rows with all controls gone.
import {
  ColorDepth,
  ColorRgba,
  ColorSpec,
  RichText,
  Style,
  type RichTextOptions,
  type TextStyle,
} from "@promptctl/rich-js";
import type { RenderedLine, Line } from "../dsl/node-registry.js";
import type { LaidCell } from "../template-engine/layout.js";
import type { ExpressionSlot, PlacementEffect } from "../themes/policy.js";
import {
  rgbaOf,
  type Rgba,
  type FrameRecord,
  type Passage,
  type PlacementRecord,
} from "./frame-memory.js";
import { resolvedStyle } from "./rich-theme.js";

// Indexed colours and theme-relative blends have parseable catalogue names.
// A truecolour's alpha may lie between two byte values.
type HeldColor = string | Rgba;
function colorOf(color: ColorSpec): HeldColor {
  return color.type === ColorDepth.TRUECOLOR && color.fixedValue
    ? rgbaOf(color.fixedValue)
    : color.name;
}
function restoreColor(value?: HeldColor): ColorSpec | undefined {
  return value === undefined
    ? undefined
    : typeof value === "string"
      ? ColorSpec.parse(value)
      : ColorSpec.fromRgba(new ColorRgba(...value));
}

interface HeldStyle {
  readonly fg?: HeldColor;
  readonly bg?: HeldColor;
  readonly attributes?: Partial<Style["attributes"]>;
  readonly hold?: readonly [last: number | null, next: number | null];
}

// [LAW:effects-at-boundaries] Strip coordinates and click proofs belong to
// the draw that made them. The next strip assigns its own owners and anchors.
function styleOf(input: TextStyle): HeldStyle {
  const style = resolvedStyle(input);
  const attributes = Object.entries(style.attributes).filter(
    ([, value]) => value !== undefined,
  );
  const { lastChange, nextChange } = style.hold;
  return {
    ...(style.color && { fg: colorOf(style.color) }),
    ...(style.bgcolor && { bg: colorOf(style.bgcolor) }),
    ...(attributes.length && { attributes: Object.fromEntries(attributes) }),
    ...(lastChange !== -Infinity || nextChange !== Infinity
      ? {
          hold: [
            lastChange === -Infinity ? null : lastChange,
            nextChange === Infinity ? null : nextChange,
          ] as const,
        }
      : {}),
  };
}

function restoreStyle(held: HeldStyle): Style {
  return new Style({
    color: restoreColor(held.fg),
    bgcolor: restoreColor(held.bg),
    ...held.attributes,
    ...(held.hold && {
      hold: {
        lastChange: held.hold[0] ?? -Infinity,
        nextChange: held.hold[1] ?? Infinity,
      },
    }),
  });
}

interface HeldText extends Pick<
  RichTextOptions,
  "end" | "justify" | "overflow" | "noWrap"
> {
  readonly plain: string;
  readonly style: HeldStyle;
  readonly spans: ReadonlyArray<readonly [number, number, HeldStyle]>;
}
function textOf(text: RichText): HeldText {
  return {
    plain: text.plain,
    style: styleOf(text.style),
    spans: text.spans.map(({ start, end, style }) => [
      start,
      end,
      styleOf(style),
    ]),
    end: text.end,
    ...(text.justify !== undefined && { justify: text.justify }),
    ...(text.overflow !== undefined && { overflow: text.overflow }),
    noWrap: text.noWrap,
  };
}
function restoreText({ plain, style, spans, ...format }: HeldText): RichText {
  const text = new RichText(plain, { ...format, style: restoreStyle(style) });
  for (const [start, end, span] of spans)
    text.stylize(restoreStyle(span), start, end);
  return text;
}

interface HeldCell {
  readonly text: HeldText;
  readonly placement: {
    readonly id: string;
    readonly effect: PlacementEffect;
    readonly ground: Rgba;
  };
  readonly lead?: HeldText;
  readonly trail?: HeldText;
}
function cellOf({ text, placement, lead, trail }: LaidCell): HeldCell {
  return {
    text: textOf(text),
    placement: { ...placement, ground: rgbaOf(placement.ground) },
    ...(lead && { lead: textOf(lead) }),
    ...(trail && { trail: textOf(trail) }),
  };
}
function restoreCell({ text, placement, lead, trail }: HeldCell): LaidCell {
  return {
    text: restoreText(text),
    placement: { ...placement, ground: new ColorRgba(...placement.ground) },
    ...(lead && { lead: restoreText(lead) }),
    ...(trail && { trail: restoreText(trail) }),
  };
}

type HeldPlacement =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "drew";
      readonly opened: boolean;
      readonly ground: Rgba;
      readonly own: ReadonlyArray<Line<HeldCell>>;
    };

function placementOf(value: PlacementRecord<RenderedLine>): HeldPlacement {
  if (value.kind === "hidden") return value;
  const { opened, ground, own } = value.drawing;
  return {
    kind: "drew",
    opened,
    ground: rgbaOf(ground),
    own: own.map((line) => ({ ...line, cells: line.cells.map(cellOf) })),
  };
}

function restorePlacement(value: HeldPlacement): PlacementRecord<RenderedLine> {
  if (value.kind === "hidden") return value;
  return {
    kind: "drew",
    drawing: {
      opened: value.opened,
      ground: new ColorRgba(...value.ground),
      own: value.own.map((line) => ({
        ...line,
        cells: line.cells.map(restoreCell),
      })),
    },
  };
}

export interface HeldLayout {
  readonly config: string;
  readonly preset: string;
  readonly revision: number;
  readonly width: number | null;
  readonly placements: ReadonlyArray<readonly [string, HeldPlacement]>;
  readonly rules: ReadonlyArray<readonly [ExpressionSlot, string]>;
  readonly passages: ReadonlyArray<readonly [string, Passage]> | null;
}

export function holdLayout(
  record: FrameRecord<RenderedLine>,
  loadKey: string,
  revision: number = record.source.revision,
): HeldLayout {
  return {
    config: loadKey,
    preset: record.source.preset,
    revision,
    width: record.source.width === Infinity ? null : record.source.width,
    placements: [...record.placements].map(([id, placement]) => [
      id,
      placementOf(placement),
    ]),
    rules: [...record.rules],
    passages: record.passages && [...record.passages],
  };
}

export function restoreLayout(
  held: HeldLayout,
  { config, loadKey }: { config: object; loadKey: string },
  revision: number = held.revision,
): FrameRecord<RenderedLine> | undefined {
  if (held.config !== loadKey) return undefined;
  return {
    source: {
      config,
      preset: held.preset,
      revision,
      width: held.width ?? Infinity,
    },
    placements: new Map(
      held.placements.map(([id, value]) => [id, restorePlacement(value)]),
    ),
    rules: new Map(held.rules),
    passages: held.passages && new Map(held.passages),
  };
}
