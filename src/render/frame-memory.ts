// What a surface's last drawn frame of a view showed
// (brandon-unfiled-3248.8ro6): each placement's drawing — or that it drew
// nothing — the name each globals rule settled on, and the transitions in
// flight. A frame is otherwise a pure reading of the view's values. The draw
// receives its surface's last accepted record and returns a candidate for the
// renderer to keep when the host confirms delivery.
//
// [LAW:one-source-of-truth] It is THE record of what a placement last drew. A
// placement whose value is not answered yet draws its loading cell from it,
// at the width it held; a placement that appears fades in, and one that leaves
// dissolves out replaying its rows, by comparing against it
// (`SessionEffects.motion`). It is kept whatever `globals.transitions` says,
// and it is no observable: writing it wakes nothing. Each surface keeps its
// own: a request's answer and a feed's frames draw at their own widths and
// roots, so a frame compared against the other's would fade and dissolve
// what only one of them draws.

import type { AnimationTime } from "../utils/instant.js";
import type { ColorRgba, TransitionName } from "@promptctl/rich-js";
import type { ExpressionSlot } from "../themes/policy.js";

export type Rgba = readonly [
  red: number,
  green: number,
  blue: number,
  alpha: number,
];
export const rgbaOf = ({ red, green, blue, alpha }: ColorRgba): Rgba => [
  red,
  green,
  blue,
  alpha,
];

// What a frame is drawn from. A placement appears only between two frames
// drawn from the same config — one object per load, so a reload is another —
// the same preset, the same revision of the session's state
// (`SessionStateReader.revision`), so whatever a write to it reveals — a
// click opening a menu, leaving arrange mode, an undo — shows at once, and the
// same width, which a row held from the last frame was sized for. Not the
// palette: a rule-chosen theme or style moves on the very payload that hides a
// placement, and a held row keeps the colours it was drawn in as it dissolves.
export interface FrameSource {
  readonly config: object;
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

// A placement passing through a transition: a `fade` in as it appears, a
// `dissolve` out as it leaves. The original ground survives a palette
// change and all four channels survive a trip across the private wire.
export interface Passage {
  readonly name: TransitionName;
  readonly since: AnimationTime;
  readonly ground: Rgba;
  readonly z: number;
}

export interface FrameRecord<Line> {
  readonly source: FrameSource;
  readonly placements: ReadonlyMap<string, PlacementRecord<Line>>;
  // Each globals rule's settled name, by slot.
  readonly rules: ReadonlyMap<ExpressionSlot, string>;
  // [LAW:types-are-the-program] The transitions in flight at this frame, by
  // placement — what a placement's appearing and leaving go on from when the
  // next frame is drawn from the same source — or null: drawn with
  // transitions off, which nothing compares against. Here, beside the
  // placements they passed, because they go on only from this frame.
  readonly passages: ReadonlyMap<string, Passage> | null;
}

// One draw's record as the walk writes it.
export interface FrameWrite<Line> {
  // Records what the bar shows of the placement `id`, and returns it.
  readonly placed: (id: string, lines: readonly Line[]) => readonly Line[];
  readonly rule: (slot: ExpressionSlot, name: string) => void;
  // [LAW:no-ambient-temporal-coupling] Read after the rows serialize: a row's
  // fill grows its cells in place, so a drawing is the width it was drawn at
  // only then.
  readonly record: (
    passages: ReadonlyMap<string, Passage> | null,
  ) => FrameRecord<Line>;
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
    last.source.config === source.config &&
    last.source.preset === source.preset &&
    last.source.revision === source.revision &&
    last.source.width === source.width
    ? last
    : null;
}

// One draw's record, begun before its walk.
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
    record: (passages) => ({ source, placements, rules, passages }),
  };
}

const HIDDEN_RECORD: PlacementRecord<never> = { kind: "hidden" };
