// [LAW:effects-at-boundaries][LAW:types-are-the-program] An effect: what a
// turn asks the world to do, as data. A handler describes one inside its turn
// and never performs it; the performer (src/daemon/apply.ts) runs each after
// the turn commits and reports how it went as an event of its own. The union
// is closed, so a new kind of effect fails to build until it has a performer.

import type { SlashLine } from "../claude-input/slash-line.js";
import type { LaunchOpts } from "../proc/launch.js";
import type { TmuxHint } from "../tmux-hint.js";

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
  | { readonly kind: "apply-update" };

// How an effect went. `said` is the sentence a person reads: for a failure,
// the whole of it (what failed, and why, in the edge's own words), and for a
// success the fact worth keeping, if any (the pane typed into).
export type EffectOutcome =
  | { readonly kind: "ok"; readonly said: string }
  | { readonly kind: "failed"; readonly said: string };

export const PERFORMED: EffectOutcome = { kind: "ok", said: "" };

export const failed = (said: string): EffectOutcome => ({
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
};

export function describeEffect<K extends Effect["kind"]>(
  effect: Extract<Effect, { readonly kind: K }>,
): string {
  const describe: (typeof DESCRIBE)[K] = DESCRIBE[effect.kind];
  return describe(effect);
}
