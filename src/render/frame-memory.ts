// What a surface's last drawn frame of a session showed
// (brandon-unfiled-3248.8ro6): each placement's drawing — or that it drew
// nothing — and the name each globals rule settled on. A frame is otherwise a
// pure reading of the view's values; this record is part of the motion memory
// a draw returns beside its frame (`SessionMotion`), kept by the turn that
// drew it, and nothing reads it but that surface's next draw.
//
// [LAW:one-source-of-truth] It is THE record of what a placement last drew. A
// placement whose value is not answered yet draws its loading cell from it,
// at the width it held; a placement that appears fades in, and one that leaves
// dissolves out replaying its rows, by comparing against it
// (`SessionEffects.motion`). It is kept whatever `globals.transitions` says,
// and it is no observable: writing it wakes nothing.

import type { ColorRgba } from "@promptctl/rich-js";
import type { ExpressionSlot } from "../themes/policy.js";

// What a frame is drawn from. A placement appears only between two frames
// drawn from the same config — one object per load, so a reload is another,
// named by its generation (`configGeneration`) — the same preset, the same revision of the session's state
// (`SessionStateReader.revision`), so whatever a write to it reveals — a
// click opening a menu, leaving arrange mode, an undo — shows at once, and the
// same width, which a row held from the last frame was sized for. Not the
// palette: a rule-chosen theme or style moves on the very payload that hides a
// placement, and a held row keeps the colours it was drawn in as it dissolves.
export interface FrameSource {
  readonly generation: number;
  readonly preset: string;
  readonly revision: number;
  readonly width: number;
}

// [LAW:types-are-the-program] What a placement drew in one frame: its own
// rows, whether a menu it dropped or a body it opened hangs under them — a
// placement that leaves with one open goes at once with what it opened rather
// than leaving an open trigger over nothing — and the ground it fades in from
// and dissolves into (`CellPlacement.ground`).
export interface Drawing<Line> {
  readonly own: readonly Line[];
  readonly opened: boolean;
  readonly ground: ColorRgba;
}

// [LAW:types-are-the-program] The lines a placement returned, divided: what
// it drew of its own, or nothing when it laid no cell, and the lines of deeper
// bands hung under it — a menu it dropped, a body it opened — which are never
// held. While it leaves, its held rows take the place of its own rows (one
// that renders empty still returns an empty one), and only the deeper lines
// are drawn beside them.
export interface Returned<Line> {
  readonly drawing: Drawing<Line> | null;
  readonly deeper: readonly Line[];
}

// What the bar showed of one placement: a drawing, or nothing — hidden, gated
// off, or under a parent that was. A placement the walk never reached (inside
// a closed body) has no record at all.
export type PlacementRecord<Line> =
  | { readonly kind: "drew"; readonly drawing: Drawing<Line> }
  | { readonly kind: "hidden" };

export interface FrameRecord<Line> {
  readonly source: FrameSource;
  readonly placements: ReadonlyMap<string, PlacementRecord<Line>>;
  // Each globals rule's settled name, by slot.
  readonly rules: ReadonlyMap<ExpressionSlot, string>;
}

// One draw's record as the walk writes it.
export interface FrameWrite<Line> {
  // Records what the bar shows of the placement `id`, and returns it.
  readonly placed: (id: string, lines: readonly Line[]) => readonly Line[];
  readonly rule: (slot: ExpressionSlot, name: string) => void;
  // [LAW:no-ambient-temporal-coupling] Read after the rows serialize: a row's
  // fill grows its cells in place, so a drawing is the width it was drawn at
  // only then.
  readonly record: () => FrameRecord<Line>;
}

// [LAW:single-enforcer] The last frame's record if it was drawn from `source`,
// or none. A frame drawn from another config, preset, state revision or width
// says nothing of where a placement stands in this one — its ids may name
// other placements, its rows were sized for another width, and a write to the
// session's state shows what it reveals at once — so it is no frame to draw
// from or compare against.
export function recordFrom<Line>(
  last: FrameRecord<Line> | null,
  source: FrameSource,
): FrameRecord<Line> | null {
  return last !== null &&
    last.source.generation === source.generation &&
    last.source.preset === source.preset &&
    last.source.revision === source.revision &&
    last.source.width === source.width
    ? last
    : null;
}

// One draw's record as its walk writes it.
export function beginRecord<Line>(
  source: FrameSource,
  returned: (id: string, lines: readonly Line[]) => Returned<Line>,
): FrameWrite<Line> {
  const placements = new Map<string, PlacementRecord<Line>>();
  const rules = new Map<ExpressionSlot, string>();
  return {
    placed: (id, lines) => {
      const { drawing } = returned(id, lines);
      placements.set(
        id,
        drawing === null ? HIDDEN_RECORD : { kind: "drew", drawing },
      );
      return lines;
    },
    rule: (slot, name) => rules.set(slot, name),
    record: () => ({ source, placements, rules }),
  };
}

// [LAW:one-source-of-truth] A loaded config's generation, one number per
// config object: what a kept record names its config by, so it never holds a
// retired config alive.
const generations = new WeakMap<object, number>();
let nextGeneration = 0;
export function configGeneration(config: object): number {
  const held = generations.get(config);
  if (held !== undefined) return held;
  const minted = nextGeneration++;
  generations.set(config, minted);
  return minted;
}

const HIDDEN_RECORD: PlacementRecord<never> = { kind: "hidden" };
