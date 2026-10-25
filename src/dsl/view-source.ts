// [LAW:one-source-of-truth] What a view draws from beside its config
// (brandon-unfiled-3248.8ro6, step 4): the payload its inputs are derived
// from, and the theme, style and effect selections its slots settle. Each is
// read as it stands, so a view whose source reads observables — the daemon's
// session view — is recomputed in the turn they move, and no draw writes
// either.

import type { EffectiveGlobals } from "../config/effective-globals.js";

// The selections whose config rung may hold a rule, as the resolution left
// them: a decided name, or the rule the view's slot settles.
export type Selections = Pick<EffectiveGlobals, "theme" | "style" | "effect">;

export interface ViewSource {
  readonly payload: () => unknown;
  readonly selections: () => Selections;
}

// A source that answers one payload and one resolution for good: what a
// caller drawing a fixed payload binds (`cc-candybar check`, the demo, a
// test), so its draws read the same seam a session's do.
export function fixedSource(
  payload: unknown,
  selections: Selections,
): ViewSource {
  return { payload: () => payload, selections: () => selections };
}
