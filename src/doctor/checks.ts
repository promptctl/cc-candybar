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

import { TMUX_ENV, type TmuxHint } from "../tmux-hint.js";
import type { Outcome } from "../utils/outcome.js";
import type { DeclKind, UnusedDecl } from "../config/unused.js";

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

// [LAW:types-are-the-program] What loading the session's config found. The
// two arms are the loader's own: a config that did not load has an error and
// nothing to analyse (the bar is rendering an older config, or the bundled
// default, under it), and one that loaded has no error. `path` null is the
// bundled default — no file was found. `warnings` are the advisories the load
// earned on the way, in either arm.
export type ConfigFacts = {
  readonly path: string | null;
  readonly warnings: readonly string[];
} & (
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "loaded";
      // Config files at later locations of the search order, never read.
      readonly shadowed: readonly string[];
      // What the file declares that nothing uses.
      readonly unused: readonly UnusedDecl[];
    }
);

export interface DoctorFacts {
  readonly tmux: TmuxFacts;
  readonly config: ConfigFacts;
  // The session's Claude Code settings file and the `env` block read from it
  // — a second, daemon-observable fact beside the client-observed env, so a
  // verdict can say the truthful thing after a fix has landed but Claude Code
  // has not restarted, naming the file it landed in.
  readonly claudeSettings: {
    readonly path: string;
    readonly env: Readonly<Record<string, unknown>>;
  };
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
// carry every difference between one failure and another. A check that found
// several problems leads with one as its `reason` and lists the rest in `more`:
// the bar's row has room for one and counts the others, the CLI prints them all.
export type Verdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly more?: readonly string[];
      readonly fix?: Fix;
    };

function problemsVerdict(problems: readonly string[]): Verdict {
  const [reason, ...more] = problems;
  return reason === undefined ? { ok: true } : { ok: false, reason, more };
}

export interface Check {
  // camelCase: the name splices into state-variable and action names
  // (`candybar.doctor.<name>.verdict`), where a hyphen is not an identifier.
  readonly name: string;
  readonly label: string;
  readonly probe: (facts: DoctorFacts) => Verdict;
}

export interface CheckReport {
  readonly check: Check;
  readonly verdict: Verdict;
}

export const TMUX_TRUECOLOR_VAR = TMUX_ENV.truecolor;

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
  probe: ({ tmux, claudeSettings }) => {
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
        const staged = claudeSettings.env[TMUX_TRUECOLOR_VAR];
        if (typeof staged === "string" && staged !== "") {
          return {
            ok: false,
            reason: `${TMUX_TRUECOLOR_VAR} is set in ${claudeSettings.path} — restart Claude Code to apply`,
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

const UNUSED: Readonly<Record<DeclKind, string>> = {
  variable: "is never read",
  action: "is never clicked",
  helper: "is never called",
  segment: "is in no preset",
};

// "The config is correct" (brandon-doctor-v62x.e91): it loads, the load earned
// no advisory (a duplicate key, a `.json`/`.json5` collision, a location the
// search could not check, a variable that failed to declare), no other config
// file sits unread behind it, and everything the file declares is used. A
// threshold whose knobs do not ascend is a load error, so it is the first of
// those.
const config: Check = {
  name: "config",
  label: "config",
  probe: ({ config }) => {
    switch (config.kind) {
      case "failed":
        return problemsVerdict([
          ...config.error
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
          ...config.warnings,
        ]);
      case "loaded":
        return problemsVerdict([
          ...config.warnings,
          ...config.shadowed.map(
            (file) =>
              `${file} is never read — ${config.path ?? "another config"} is found first`,
          ),
          ...config.unused.map(
            ({ kind, name }) => `${kind} "${name}" ${UNUSED[kind]}`,
          ),
        ]);
    }
  },
};

export const CHECKS: readonly Check[] = [config, tmuxTruecolor];

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
