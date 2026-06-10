// Pure mapping from ClientOutcome to a render plan: what to write, whether
// to kick a fresh daemon, and (if relevant) the debug message that describes
// why. All variability lives in the returned value — including the debug
// string — so this module has no observable side effects. The runtime
// composition in src/index.ts consumes the plan and owns every side effect
// (debug logging, kick, write, exit).
//
// [LAW:dataflow-not-control-flow] Variability lives in the returned values
// (output string, kick flag, debug message). The caller's debug/kick/write/
// exit run unconditionally against those values — no caller-side branching
// on outcome.kind.
//
// [LAW:types-are-the-program] Exhaustive over ClientOutcome.kind. Adding a
// new variant fails typecheck rather than silently falling out the bottom
// of the switch.

import { formatPermanentGlyph } from "./error-glyph";
import type { ClientOutcome } from "../daemon/client";

export interface OutcomePlan {
  output: string;
  kick: boolean;
  // Debug message the caller should log, or null when there is nothing
  // worth logging (the "ok" path). Held as data so this module stays pure.
  debug: string | null;
}

export function planOutcome(outcome: ClientOutcome): OutcomePlan {
  switch (outcome.kind) {
    case "ok":
      return { output: outcome.value, kick: false, debug: null };
    case "transient":
      return {
        output: "\n",
        kick: true,
        debug: `daemon unavailable (transient: ${outcome.cause}: ${outcome.message}) — kicking daemon`,
      };
    case "permanent":
      return {
        output: formatPermanentGlyph(outcome),
        kick: false,
        debug: `daemon refused request (permanent: ${outcome.cause}) — not kicking`,
      };
  }
}
