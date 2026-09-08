// [LAW:effects-at-boundaries] Pure over `DoctorFacts`: a probe only decides;
// the edge assembles the facts and performs a `Fix`.
// [LAW:one-type-per-behavior] Checks are DATA and the doctor is a fold, so a
// second check is one more row here and no logic edit anywhere.

import { TMUX_ENV, type TmuxHint } from "../tmux-hint.js";
import type { Outcome } from "../utils/outcome.js";

export type TermFeatures = Extract<
  Outcome<readonly string[]>,
  { kind: "ok" | "failed" }
>;

// [LAW:no-silent-failure] Collapsing `unreported` (a client too old to send the hint) into `outside` would make a stale client look healthy.
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
  readonly claudeSettingsEnv: Readonly<Record<string, unknown>>;
}

export interface Fix {
  readonly kind: "claude-settings-env";
  readonly name: string;
  readonly value: string;
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly fix?: Fix };

export interface Check {
  // camelCase: it splices into state-variable and action names, where a hyphen is not an identifier.
  readonly name: string;
  readonly label: string;
  readonly probe: (facts: DoctorFacts) => Verdict;
}

export interface CheckReport {
  readonly check: Check;
  readonly verdict: Verdict;
}

export const TMUX_TRUECOLOR_VAR = TMUX_ENV.truecolor;

// Claude Code re-encodes the statusline at 256 colours whenever TMUX is in its env, unless CLAUDE_CODE_TMUX_TRUECOLOR is truthy.
// `RGB` in `#{client_termfeatures}` is tmux's verdict for tmux and the outer terminal at once.
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
        if (!tmux.termfeatures.value.includes("RGB")) return { ok: true };
        if (tmux.hint.truecolor !== null) return { ok: true };
        // [LAW:one-source-of-truth] The truthiness Claude Code applies to its env: a non-empty string.
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

// [LAW:single-enforcer] The bar's click and the CLI both fold through here, so they cannot disagree about a healthy setup.
export function runDoctor(facts: DoctorFacts): readonly CheckReport[] {
  return CHECKS.map((check) => ({ check, verdict: check.probe(facts) }));
}

// [LAW:parse-dont-validate] A wire-supplied name becomes a `Check` or nothing, so an unknown name is refused once.
export function checkByName(name: string): Check | undefined {
  return CHECKS.find((c) => c.name === name);
}
