// [LAW:one-source-of-truth] What a view draws from beside its config
// (brandon-unfiled-3248.8ro6, step 4): the payload its inputs are derived
// from, what the host read for its sources, and the theme, style and
// effect selections its slots settle. Each is
// read as it stands, so a view whose source reads observables — the daemon's
// session view — is recomputed in the turn they move, and no draw writes
// either.

import type { EffectiveGlobals } from "../config/effective-globals.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { UNREAD_RUN, type RunFact } from "../facts/world-state.js";
import { pendingOf } from "../utils/outcome.js";
import type { Fact } from "../facts/fact.js";

// The selections whose config rung may hold a rule, as the resolution left
// them: a decided name, or the rule the view's slot settles.
export type Selections = Pick<EffectiveGlobals, "theme" | "style" | "effect">;

// [LAW:locality-or-seam] What the host read for a view, as it last read it:
// the run a `shell` or `file` source names, by digest, and a variable of the
// session's environment an `env` source names.
export interface HostReadings {
  readonly run: (digest: string) => RunFact;
  readonly env: (name: string) => Fact<string>;
}

// What a view reads when the host read nothing for it: every run and every
// variable still unread.
export const NOTHING_READ: HostReadings = {
  run: () => UNREAD_RUN,
  env: () => pendingOf("unread"),
};

export type ViewSource = ViewInputs & HostReadings;
interface ViewInputs {
  // [LAW:parse-dont-validate] The session the view draws for, as the hook
  // door checked it: every `state` read and every click URL keys by this,
  // never by a variable a config can redeclare.
  readonly session: SessionId;
  readonly payload: () => unknown;
  readonly selections: () => Selections;
}

// A source that answers one payload and one resolution for good, and its
// caller's readings: what a caller drawing a fixed payload binds
// (`cc-candybar check`, a test), so its draws read the same seam a session's
// do.
export function fixedSource(
  payload: unknown,
  selections: Selections,
  session: SessionId,
  readings: HostReadings,
): ViewSource {
  return {
    session,
    payload: () => payload,
    ...readings,
    selections: () => selections,
  };
}
