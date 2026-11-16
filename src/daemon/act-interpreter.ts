// [LAW:single-enforcer] Where every act a renderer returns is performed: one
// performer per kind, each answering the act's outcome, so the renderer
// decides what is done and the host alone does it. A performer that throws
// has its act's outcome classified here as the throw was; none rejects.
//
// [LAW:no-ambient-temporal-coupling] Every act starts as its turn's output
// reaches the host, in the order the turn returned them, so a run supersedes
// its sources before its click is answered. An act that ends in its turn
// holds the click that returned it until its outcome is in; one that outlives
// it (a run, a restart, a surface) answers when it ends.
//
// Only what must not interleave waits behind another: whatever types into a
// session's pane (a slash line, a lane setup) waits for the pane
// (src/daemon/daemon.ts). A copy never waits behind a restart.

import type { Act, EffectOutcome } from "../renderer-interface/interface.js";
import type { DaemonLogger } from "../utils/logger.js";
import { eventLine } from "../utils/logfmt.js";
import { elapsedMs, type Timekeeper } from "../time.js";
import { failureOf } from "./foundations/verb-error.js";

// [LAW:types-are-the-program] Exhaustive over the act kinds: an act added to
// the renderer's vocabulary is a compile error here until the host says how
// it is performed and whether its click waits for it.
export type ActPerformers = {
  readonly [K in Act["kind"]]: {
    readonly endsInTurn: boolean;
    readonly perform: (
      act: Extract<Act, { kind: K }>,
    ) => Promise<EffectOutcome>;
  };
};

export interface ActInterpreter {
  // Starts `act` at once, answering its outcome.
  perform(act: Act): Promise<EffectOutcome>;
  // Whether the turn that returned `act` waits for its outcome.
  endsInTurn(act: Act): boolean;
}

// [LAW:single-enforcer] A performer's throw as its act's outcome, by the
// class it was thrown as: bad input refused, the daemon's close closing, and
// anything else failed.
function thrownOutcome(thrown: unknown): EffectOutcome {
  const { kind, message } = failureOf(thrown);
  return {
    kind:
      kind === "bad-request"
        ? "refused"
        : kind === "closing"
          ? "closing"
          : "failed",
    reason: message,
  };
}

export function actInterpreter(
  performers: ActPerformers,
  clock: Pick<Timekeeper, "monotonic">,
  log: DaemonLogger,
): ActInterpreter {
  const performerOf = <K extends Act["kind"]>(
    act: Extract<Act, { kind: K }>,
  ): ActPerformers[K] => performers[act.kind as K];
  return {
    perform: async (act) => {
      const from = clock.monotonic();
      let outcome: EffectOutcome;
      // A performer that throws before it returns its promise is caught as
      // one whose promise rejected.
      try {
        outcome = await performerOf(act)
          // [LAW:types-are-the-program] exception: the kind indexes the
          // performer of the same kind, which the compiler cannot carry
          // across the union.
          .perform(act as never);
      } catch (thrown) {
        outcome = thrownOutcome(thrown);
      }
      // [LAW:nothing-unseen] One line per act performed, its outcome named.
      log(
        outcome.kind === "ok" || outcome.kind === "closing" ? "info" : "warn",
        eventLine("effect", [
          ["kind", act.kind],
          ["sid", act.session ?? "-"],
          ["id", String(act.id)],
          ["outcome", outcome.kind],
          ["took", `${elapsedMs(clock, from)}ms`],
          ...(outcome.kind === "ok"
            ? []
            : ([["reason", outcome.reason]] as const)),
        ]),
      );
      return outcome;
    },
    endsInTurn: (act) => performerOf(act).endsInTurn,
  };
}
