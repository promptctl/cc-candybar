// [LAW:effects-at-boundaries][LAW:types-are-the-program] An effect: what a
// turn asks the world to do, as data. A handler describes one inside its turn
// and never performs it; the performer (src/daemon/apply.ts) runs each after
// the turn commits and reports how it went as an event of its own. The union
// is closed, so a new kind of effect fails to build until it has a performer.

import type { SlashLine } from "../claude-input/slash-line.js";
import type { Check, DoctorFacts, GlyphMark } from "../doctor/checks.js";
import type { DoctorEdge, gatherFacts } from "../doctor/edge.js";
import type { ClickArrival } from "../doctor/sightings.js";
import type { LaunchOpts } from "../proc/launch.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { SessionStateReader } from "./session-state.js";

// What a launch effect starts: the bound is the performer's, the same for
// every click launch.
export type LaunchSpec = Omit<LaunchOpts, "timeoutMs">;

export type Effect =
  // A program the click waits out (the clipboard, an editor): `what` names it
  // where a failure is shown.
  | {
      readonly kind: "launch";
      readonly spec: LaunchSpec;
      readonly what: string;
    }
  // A line typed into the session's Claude Code pane
  // (src/claude-input/edge.ts): the pane is one the click found, never a maybe.
  | {
      readonly kind: "type-slash";
      readonly pane: TmuxHint;
      readonly line: SlashLine;
    }
  // The update watch's act (src/daemon/update-notice.ts), which decides for
  // itself what runs.
  | { readonly kind: "apply-update" }
  | DoctorEffect;

// A doctor click's step (src/daemon/verbs/index.ts): its probes gathered after
// the click's turn, and its answer landed with the outcome. `arrival` is how
// the click came, which the doctor reasons over.
export interface DoctorEffect {
  readonly kind: "doctor";
  readonly session: string;
  readonly step: DoctorStep;
  readonly arrival: ClickArrival;
}

// What the step does with its facts: report them, perform the fix the check's
// fresh verdict carries, or file what the user saw of its glyphs.
export type DoctorStep =
  | { readonly kind: "run" }
  | { readonly kind: "fix"; readonly check: Check }
  | { readonly kind: "mark"; readonly check: Check; readonly mark: GlyphMark };

// [LAW:one-source-of-truth] What a gather read that a turn can change: the
// config it loaded, and each input of session state as it read it (`what`
// names it), with how to read it again.
export interface DoctorStamp {
  readonly load: ReturnType<DoctorEdge["loadConfig"]>;
  readonly reads: ReadonlyArray<{
    readonly what: string;
    readonly value: string | null;
    readonly again: (state: SessionStateReader) => string | null;
  }>;
}

// A doctor gather's facts, and what they were gathered from.
export interface DoctorGathered {
  readonly facts: Awaited<ReturnType<typeof gatherFacts>>;
  readonly install: DoctorFacts["install"];
  readonly stamp: DoctorStamp;
}

// How an effect went. `said` is the sentence a person reads: for a failure,
// the whole of it (what failed, and why, in the edge's own words), and for a
// success the fact worth keeping, if any (the pane typed into).
export type EffectOutcome =
  | { readonly kind: "ok"; readonly said: string }
  | { readonly kind: "failed"; readonly said: string };

export const PERFORMED: EffectOutcome = { kind: "ok", said: "" };

// [LAW:types-are-the-program] What performing each kind of effect answers: an
// act answers how it went, a doctor's gather the facts it gathered, which its
// landing turns into how it went (src/daemon/apply.ts).
interface Outcomes {
  readonly launch: EffectOutcome;
  readonly "type-slash": EffectOutcome;
  readonly "apply-update": EffectOutcome;
  readonly doctor:
    | Extract<EffectOutcome, { readonly kind: "failed" }>
    | { readonly kind: "gathered"; readonly gathered: DoctorGathered };
}
export type OutcomeOf<K extends Effect["kind"]> = Outcomes[K];

// An effect and what performing it answered, paired by kind.
export type EffectDone = {
  readonly [K in Effect["kind"]]: {
    readonly effect: Extract<Effect, { readonly kind: K }>;
    readonly outcome: OutcomeOf<K>;
  };
}[Effect["kind"]];

export const failed = (
  said: string,
): Extract<EffectOutcome, { readonly kind: "failed" }> => ({
  kind: "failed",
  said,
});

// An effect as a log field names it.
const DESCRIBE: {
  readonly [K in Effect["kind"]]: (
    e: Extract<Effect, { readonly kind: K }>,
  ) => string;
} = {
  launch: ({ what }) => `launch:${what}`,
  "type-slash": ({ line }) => `type-slash:${line}`,
  "apply-update": () => "apply-update",
  doctor: ({ step }) => `doctor:${step.kind}`,
};

export function describeEffect<K extends Effect["kind"]>(
  effect: Extract<Effect, { readonly kind: K }>,
): string {
  const describe: (typeof DESCRIBE)[K] = DESCRIBE[effect.kind];
  return describe(effect);
}
