// [LAW:dataflow-not-control-flow] Every variability, the debug string included,
// rides in the returned value, so the caller's effects run unconditionally.
// [LAW:types-are-the-program] Exhaustive: a new variant fails typecheck.

import { formatPermanentGlyph } from "./error-glyph";
import type { ClientOutcome } from "../daemon/client";

export interface OutcomePlan {
  output: string;
  kick: boolean;
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
