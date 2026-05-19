// Pure mapping from ClientOutcome to a render plan (what to write + whether
// to kick a fresh daemon). The runtime composition in src/index.ts owns the
// side effects; this module owns the per-variant data.
//
// [LAW:dataflow-not-control-flow] Variability lives in the returned values
// (output string, kick flag). The caller's write/kick/exit run unconditionally
// against those values — no caller-side branching on outcome.kind.
//
// [LAW:types-are-the-program] Exhaustive over ClientOutcome.kind. Adding a
// new variant fails typecheck rather than silently falling out the bottom of
// the switch.

import { debug } from "../utils/logger";
import { formatPermanentGlyph } from "./error-glyph";
import type { ClientOutcome } from "../daemon/client";

export interface OutcomePlan {
  output: string;
  kick: boolean;
}

export function planOutcome(outcome: ClientOutcome): OutcomePlan {
  switch (outcome.kind) {
    case "ok":
      return { output: outcome.output, kick: false };
    case "transient":
      debug(
        `daemon unavailable (transient: ${outcome.cause}: ${outcome.message}) — kicking daemon`,
      );
      return { output: "\n", kick: true };
    case "permanent":
      debug(
        `daemon refused request (permanent: ${outcome.cause}) — not kicking`,
      );
      return { output: formatPermanentGlyph(outcome), kick: false };
  }
}
