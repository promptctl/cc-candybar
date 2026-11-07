import { compareStructural } from "mobx";
import { restamp, type Fact } from "../facts/fact";
import {
  FACTS_VERSION,
  type BuiltinFacts,
  type RunFact,
  type SessionFacts,
  type SourceValue,
  type UpdateNotice,
} from "../facts/session-facts";
import type { Instant } from "../utils/instant";
import type { Reading } from "../utils/outcome";
import type { SessionId } from "./session-id";
import type { Readings } from "./render-payload";

// The same keys, each holding the very fact it held.
const sameFacts = <T extends object>(now: T, held: T): boolean => {
  const entries = Object.entries(now);
  return (
    entries.length === Object.keys(held).length &&
    entries.every(([key, fact]) => Object.is(fact, Reflect.get(held, key)))
  );
};

// [LAW:single-enforcer] The one definition of a session's facts document: every
// owner's reading of this turn folded into its fact, each stamped by `restamp`
// against the document it replaces. A turn in which nothing moved returns that
// document itself, so nothing holding it, and no observer of it, is touched.
//
// [LAW:effects-at-boundaries] Pure: `at` is the instant of the turn, taken by
// the caller, and the prior document is the caller's to hold.
export function assembleFacts(
  prior: SessionFacts | undefined,
  session: SessionId,
  readings: Readings,
  update: Fact<UpdateNotice>,
  at: Instant,
): SessionFacts {
  // [LAW:dataflow-not-control-flow] Every built-in and every source the
  // renderer declared has a reading, so a key; one it did not declare has
  // neither.
  const stampAll = (
    now: Iterable<readonly [string, Reading<unknown>]>,
    held: Readonly<Record<string, Fact<unknown> | undefined>> | undefined,
  ): Record<string, Fact<unknown>> =>
    Object.fromEntries(
      [...now].map(([name, reading]) => [
        name,
        restamp(held?.[name], reading, at),
      ]),
    );
  // [LAW:types-are-the-program] Each fact is stamped from its own built-in's
  // reading, so it holds that built-in's type: the one cast is that claim.
  const builtins = stampAll(
    Object.entries(readings.builtins) as Array<[string, Reading<unknown>]>,
    prior?.builtins,
  ) as BuiltinFacts;
  const sources = stampAll(readings.sources, prior?.sources) as Record<
    string,
    Fact<SourceValue>
  >;

  // A run keeps its prior entry whole while neither its reading nor its fault
  // moved, so the sameness below is identity, as for the sources.
  const runs: Record<string, RunFact> = Object.fromEntries(
    [...readings.runs].map(([digest, { reading, fault }]) => {
      const held = prior?.runs[digest];
      const fact = restamp(held?.reading, reading as Reading<SourceValue>, at);
      return [
        digest,
        held !== undefined && held.reading === fact && held.fault === fault
          ? held
          : { reading: fact, fault },
      ];
    }),
  );

  const parts = {
    builtins,
    sources,
    runs,
    update,
    diagnostics: readings.faults,
  };
  // [LAW:single-enforcer] `restamp` is the one judge of whether a fact moved,
  // and it returns the prior fact itself when not, so the document is
  // unmoved when every fact is the prior's own. The builtins and sources are
  // compared by that identity, never walked again (a source's value can be
  // large JSON); the update and diagnostics are small and not restamped here.
  if (
    prior !== undefined &&
    sameFacts(builtins, prior.builtins) &&
    sameFacts(sources, prior.sources) &&
    sameFacts(runs, prior.runs) &&
    compareStructural(
      { update, diagnostics: readings.faults },
      { update: prior.update, diagnostics: prior.diagnostics },
    )
  ) {
    return prior;
  }
  return {
    v: FACTS_VERSION,
    session,
    seq: prior === undefined ? 1 : prior.seq + 1,
    ...parts,
  };
}
