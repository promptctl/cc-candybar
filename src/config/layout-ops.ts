// [LAW:one-type-per-behavior] The seam brandon-layout-edit-2gc.1 opens: a
// bounded, statically-enumerable vocabulary for editing a layout tree —
// remove the placement with id X, insert a segment before/after an existing
// placement. No third LayoutNode kind, no free-form tree editing: a
// placement's ID is the stable position (brandon-segment-settings-i4n —
// `placementId`, unaffected by a sibling being added or removed elsewhere in
// the tree), so there is no sibling-index to invalidate between the render
// that offered the click and the click.
//
// [LAW:one-source-of-truth] An op is applied ONCE, to the authored tree in
// the config file (candybar-config-dqe: src/renderer/config-file-store.ts over
// src/config/json5-edit.ts's removeSegmentRef/insertSegmentRef) — the file
// then IS the edited tree, and every reload reads it like any hand-written
// root. This module owns only the op's shape, its wire codec, and the id an
// insertion mints.

import { placementIds, type LayoutNode } from "./dsl-types.js";

// [LAW:types-are-the-program] The two operations brandon-layout-edit-2gc.1
// ships. Both address position by placement ID, never by index: `target` and
// `anchor` are ids, `segment` is the segment an insertion places. A future op
// (e.g. "move") is a new arm here, not a new node kind or a new codec.
export type LayoutOp =
  | { readonly op: "remove"; readonly target: string }
  | {
      readonly op: "insert";
      readonly segment: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
    };

// [LAW:single-enforcer] THE codec for a LayoutOp crossing the click wire as
// one opaque string. `:` is the delimiter
// (loader/actions.ts's segmentNameSpec rejects `:` and `/` in every name an
// op can carry, so decode is unambiguous — a plain split, no escaping).
// Encode and decode live together so the format cannot drift between the
// validator gate (config-validators.ts, which encodes the ONE token a
// declared action allows), the render side (which emits that same token),
// and the daemon (which decodes it back).
export function encodeLayoutOp(op: LayoutOp): string {
  return op.op === "remove"
    ? `remove:${op.target}`
    : `insert:${op.segment}:${op.anchor}:${op.relation}`;
}

// [LAW:parse-dont-validate] Returns the typed op, or null for anything that
// doesn't decode — the boundary the apply-layout-op verb stamps a wire token
// through before trusting its shape.
export function decodeLayoutOp(token: string): LayoutOp | null {
  const parts = token.split(":");
  if (parts[0] === "remove" && parts.length === 2 && parts[1]) {
    return { op: "remove", target: parts[1] };
  }
  if (
    parts[0] === "insert" &&
    parts.length === 4 &&
    parts[1] &&
    parts[2] &&
    (parts[3] === "before" || parts[3] === "after")
  ) {
    return {
      op: "insert",
      segment: parts[1],
      anchor: parts[2],
      relation: parts[3],
    };
  }
  return null;
}

// What an insertion writes into the layout: the segment under an explicit id
// of its own.
export interface NewPlacement {
  readonly seg: string;
  readonly id: string;
}

// [LAW:single-enforcer] THE id an insertion mints: the segment's name and a
// fresh suffix, free in every tree the insertion reaches. Session state (an
// open menu, a configure panel, a draft, a `✚` beside it) is keyed by
// placement id in every session sharing the config, so a placement added
// after another went away, by a click, an undo or a hand edit, should not take
// that one's id and wear what it left; nothing releases state on removal, so
// identity is what keeps them apart. Only live ids are checked: a removed
// one is avoided because the suffix is random, which makes meeting one rare,
// not impossible. The layer it writes (`root.rows.<row>`, a
// shared fragment) can reach presets other than the one clicked, and the new
// placement lands beside `anchor`, so the trees it reaches are exactly the
// trees that hold `anchor`.
// [LAW:effects-at-boundaries] The suffix is the caller's: a click draws it at
// random, a test hands its own.
export function mintPlacement(
  segment: string,
  anchor: string,
  trees: readonly LayoutNode[],
  suffix: () => string,
): NewPlacement {
  const taken = new Set(
    trees
      .map(placementIds)
      .filter((held) => held.includes(anchor))
      .flat(),
  );
  return { seg: segment, id: mintPlacementId(segment, taken, suffix) };
}

// Suffixes drawn before a mint gives up: three random bytes give 16,777,216
// suffixes, so a draw meets a taken one this often only from a source that
// is not random.
const MINT_TRIES = 16;

// [LAW:single-enforcer] THE spelling of a new placement's id, free of `taken`.
// [LAW:no-silent-failure] A source that keeps meeting taken ids fails loudly
// rather than spinning.
export function mintPlacementId(
  segment: string,
  taken: ReadonlySet<string>,
  suffix: () => string,
): string {
  for (let tries = 0; tries < MINT_TRIES; tries++) {
    const id = `${segment}-${suffix()}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(
    `no free id for a placement of "${segment}" after ${MINT_TRIES} suffixes`,
  );
}
