// The doctor: checks over the user's setup, each landing in ok or failed, a
// failed check carrying a reason and — when one exists — a typed fix.
//
// [LAW:effects-at-boundaries] Everything here is pure over a `DoctorFacts`
// record. The edge (src/doctor/edge.ts) assembles the facts (the recorded
// client hint, the tmux query, the settings.json read) and performs a `Fix`;
// a probe only decides, so every verdict is unit-testable over a fixture with
// no mocks (test/doctor-checks.test.ts).
//
// [LAW:one-type-per-behavior] Checks are DATA in one `CHECKS` list and the
// doctor is a fold over it: the second check is one more row here (and one
// more label), no logic edit anywhere — the settings menu mints its report row
// from this list, the CLI prints one line per entry, the verbs gate `[fix]` by
// membership in it.

import type { TmuxHint } from "../tmux-hint.js";
import type { Outcome } from "../utils/outcome.js";

// [LAW:types-are-the-program] tmux's own verdict on the attached terminal's
// features (`#{client_termfeatures}`), or why it could not be asked. No
// `absent` arm: the query either answers or fails — there is no "tmux has no
// opinion", so a probe never has to decide what an absent list would mean.
export type TermFeatures = Extract<
  Outcome<readonly string[]>,
  { kind: "ok" | "failed" }
>;

// [LAW:types-are-the-program] The tmux facts have THREE states and each is a
// different truth the check must say: the client that rendered last carried
// no tmux hint at all (too old — the staged native binary does not turn over
// with the npm package), it reported "not in tmux", or it reported the facts.
// Collapsing `unreported` into `outside` would make a stale client look like a
// healthy setup ([LAW:no-silent-failure]).
export type TmuxFacts =
  | { readonly kind: "unreported" }
  | { readonly kind: "outside" }
  | {
      readonly kind: "inside";
      readonly hint: TmuxHint;
      readonly termfeatures: TermFeatures;
    };

export interface DoctorFacts {
  readonly tmux: TmuxFacts;
  // The `env` block of ~/.claude/settings.json as read — a second, daemon-
  // observable fact beside the client-observed env, so a verdict can say the
  // truthful thing after a fix has landed but Claude Code has not restarted.
  readonly claudeSettingsEnv: Readonly<Record<string, unknown>>;
}

// [LAW:types-are-the-program] A fix is a DESCRIPTION of an edit the edge
// performs, discriminated by kind so a second repair shape is one more arm
// here and one more case at the edge, never a callback smuggled in a verdict.
export interface Fix {
  readonly kind: "claude-settings-env";
  readonly name: string;
  readonly value: string;
}

// A check never has a third state: the reason string and the optional fix
// carry every difference between one failure and another.
export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly fix?: Fix };

export interface Check {
  // camelCase: the name splices into state-variable and action names
  // (`settings.doctor.<name>.verdict`), where a hyphen is not an identifier.
  readonly name: string;
  readonly label: string;
  readonly probe: (facts: DoctorFacts) => Verdict;
}

export interface CheckReport {
  readonly check: Check;
  readonly verdict: Verdict;
}

export const TMUX_TRUECOLOR_VAR = "CLAUDE_CODE_TMUX_TRUECOLOR";

// Diagnosed 2026-09-04 (brandon-doctor-b6a): Claude Code re-encodes the
// statusline at 256 colours whenever TMUX is in its environment, unless its own
// CLAUDE_CODE_TMUX_TRUECOLOR switch is truthy. The bar's daemon emits identical
// truecolor in and out of tmux, so this is a setup fault outside cc-candybar
// that makes cc-candybar look broken — which is why the bar is where it is
// diagnosed and repaired.
//
// "tmux and the outer terminal support truecolor" is ONE fact: `RGB` in
// `#{client_termfeatures}` is tmux's verdict for both layers at once.
const tmuxTruecolor: Check = {
  name: "tmuxTruecolor",
  label: "tmux truecolor",
  probe: ({ tmux, claudeSettingsEnv }) => {
    switch (tmux.kind) {
      case "unreported":
        return {
          ok: false,
          reason:
            "the client reported no tmux facts — re-run `cc-candybar install` to stage a current client",
        };
      case "outside":
        return { ok: true };
      case "inside": {
        if (tmux.termfeatures.kind === "failed") {
          return {
            ok: false,
            reason: `tmux could not be asked: ${tmux.termfeatures.reason}`,
          };
        }
        // Not applicable is not a failure: without RGB there is nothing for
        // Claude Code to be told about.
        if (!tmux.termfeatures.value.includes("RGB")) return { ok: true };
        if (tmux.hint.truecolor !== null) return { ok: true };
        // [LAW:one-source-of-truth] The same truthiness Claude Code applies to
        // its env: a non-empty string. Anything else in settings.json — absent,
        // empty, a non-string — is "not told", and the fix overwrites it.
        const staged = claudeSettingsEnv[TMUX_TRUECOLOR_VAR];
        if (typeof staged === "string" && staged !== "") {
          return {
            ok: false,
            reason: `${TMUX_TRUECOLOR_VAR} is set in ~/.claude/settings.json — restart Claude Code to apply`,
          };
        }
        return {
          ok: false,
          reason: "Claude Code renders the bar in 256 colours inside tmux",
          fix: {
            kind: "claude-settings-env",
            name: TMUX_TRUECOLOR_VAR,
            value: "1",
          },
        };
      }
    }
  },
};

export const CHECKS: readonly Check[] = [tmuxTruecolor];

// [LAW:single-enforcer] THE fold. The bar's 🩺 click and `cc-candybar doctor`
// both call this over facts their own edge gathered, so the two surfaces
// cannot disagree about what a healthy setup is.
export function runDoctor(facts: DoctorFacts): readonly CheckReport[] {
  return CHECKS.map((check) => ({ check, verdict: check.probe(facts) }));
}

// [LAW:parse-dont-validate] A wire-supplied check name becomes a `Check` or
// nothing — the `[fix]` verb and the action loader both gate through this, so
// a name the list does not carry is refused at load (an authored action) or at
// click (a stale URL), never looked up twice.
export function checkByName(name: string): Check | undefined {
  return CHECKS.find((c) => c.name === name);
}
