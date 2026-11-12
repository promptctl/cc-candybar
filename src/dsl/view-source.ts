// [LAW:one-source-of-truth] What a view draws from beside its config
// (brandon-unfiled-3248.8ro6, step 4): the payload its inputs are derived
// from, the reading of each run its sources name, and the theme, style and
// effect selections its slots settle. Each is
// read as it stands, so a view whose source reads observables — the daemon's
// session view — is recomputed in the turn they move, and no draw writes
// either.

import type { EffectiveGlobals } from "../config/effective-globals.js";
import type { SessionId } from "../daemon/session-id.js";
import type { RunFact } from "../facts/world-state.js";

// The selections whose config rung may hold a rule, as the resolution left
// them: a decided name, or the rule the view's slot settles.
export type Selections = Pick<EffectiveGlobals, "theme" | "style" | "effect">;

export interface ViewSource {
  // [LAW:parse-dont-validate] The session the view draws for, as the hook
  // door checked it: every `state` read and every click URL keys by this,
  // never by a variable a config can redeclare.
  readonly session: SessionId;
  readonly payload: () => unknown;
  // The run a `shell` or `file` source names, by digest, as the host last
  // read it.
  readonly run: (digest: string) => RunFact;
  readonly selections: () => Selections;
}

// A source that answers one payload and one resolution for good, and its
// caller's runs: what a caller drawing a fixed payload binds (`cc-candybar
// check`, the demo, a test), so its draws read the same seam a session's do.
export function fixedSource(
  payload: unknown,
  selections: Selections,
  session: SessionId,
  run: (digest: string) => RunFact,
): ViewSource {
  return {
    session,
    payload: () => payload,
    run,
    selections: () => selections,
  };
}
