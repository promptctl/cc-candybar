// The doctor's edge: where the facts are GATHERED and a fix is PERFORMED.
//
// [LAW:effects-at-boundaries] Every effect the doctor has — the tmux query,
// the settings.json read, the settings.json write — lives in this module,
// behind one `DoctorEdge` record the daemon and the CLI both construct with
// `productionEdge()` and a test constructs with fakes. checks.ts never sees an
// effect; this file never decides a verdict.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { claudeSettingsPath } from "../claude-settings.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import type { ClientHints } from "../daemon/protocol.js";
import { launchSync } from "../proc/launch.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { DoctorFacts, Fix, TermFeatures, TmuxFacts } from "./checks.js";

export interface DoctorEdge {
  // tmux's own verdict on the attached client's terminal, asked of THE server
  // the hint names — `-S socket` and `-t pane` are why the hint carries them.
  readonly probeTmux: (hint: TmuxHint) => TermFeatures;
  readonly claudeSettingsPath: string;
}

// `#{client_termfeatures}` lists terminal-features + overrides + terminfo for
// the client attached to the pane — `RGB` in it is tmux saying both it and the
// outer terminal do truecolor (verified on tmux 3.6a: `…,osc7,RGB,sixel,…`).
function probeTmux(hint: TmuxHint): TermFeatures {
  const result = launchSync({
    bin: "tmux",
    args: [
      "-S",
      hint.socket,
      "display",
      "-p",
      "-t",
      hint.pane,
      "#{client_termfeatures}",
    ],
    timeoutMs: 2000,
    category: "doctor.tmux",
  });
  if (!result.ok) {
    // `error` is a whole sentence when present (rate-limited, timeout, spawn);
    // a non-zero exit has only its stderr to say.
    const detail =
      result.error ??
      [result.reason, result.stderr.trim()].filter((s) => s !== "").join(": ");
    return { kind: "failed", reason: `tmux display -p failed (${detail})` };
  }
  return {
    kind: "ok",
    value: result.stdout
      .trim()
      .split(",")
      .filter((f) => f !== ""),
  };
}

export function productionEdge(): DoctorEdge {
  return { probeTmux, claudeSettingsPath: claudeSettingsPath() };
}

// [LAW:no-silent-failure] A missing settings file is the one absence with a
// meaning ("Claude Code has written nothing yet" — an empty env); an
// unparseable one is thrown, never read as empty, because the fix would then
// splice into a file it cannot parse either.
function readSettingsText(edge: DoctorEdge): string {
  return fs.existsSync(edge.claudeSettingsPath)
    ? fs.readFileSync(edge.claudeSettingsPath, "utf8")
    : "";
}

function settingsEnv(text: string): Readonly<Record<string, unknown>> {
  if (/^\s*$/.test(text)) return {};
  const parsed: unknown = JSON5.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  const env = (parsed as Record<string, unknown>).env;
  if (env === undefined) return {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("`env` is not an object");
  }
  return env as Record<string, unknown>;
}

// [LAW:dataflow-not-control-flow] The three wire states of the recorded hint
// become the three arms of TmuxFacts — a total projection, and the ONLY place
// the tmux query runs: once, exactly when there is a server to ask.
function tmuxFacts(edge: DoctorEdge, hint: ClientHints["tmux"]): TmuxFacts {
  if (hint === undefined) return { kind: "unreported" };
  if (hint === null) return { kind: "outside" };
  return { kind: "inside", hint, termfeatures: edge.probeTmux(hint) };
}

// The one place that names the file: every failure — a JSON5 parse error,
// a non-object document, a non-object `env` — surfaces as "cannot read <the
// path this edge was built with>", so a test's temp path and the real
// ~/.claude/settings.json are reported the same way.
function readClaudeSettingsEnv(
  edge: DoctorEdge,
): DoctorFacts["claudeSettingsEnv"] {
  try {
    return settingsEnv(readSettingsText(edge));
  } catch (e) {
    throw new Error(
      `cannot read ${edge.claudeSettingsPath}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

export function gatherFacts(
  edge: DoctorEdge,
  tmuxHint: ClientHints["tmux"],
): DoctorFacts {
  return {
    tmux: tmuxFacts(edge, tmuxHint),
    claudeSettingsEnv: readClaudeSettingsEnv(edge),
  };
}

// [LAW:one-source-of-truth] The fix is a SPLICE, not a rewrite: the same
// span-tracking editor the cc-candybar config uses (JSON ⊂ JSON5) replaces one
// value span or appends one entry, creating `env` only when absent, and every
// other byte of the user's file survives — comments, ordering, indentation.
// In the JSON dialect: Claude Code parses settings.json strictly, so a bare
// key or a trailing comma here would break every Claude Code launch.
//
// Returns the facts with the one this fix changed re-read — the performer of
// an effect is the one place that knows what it touched, so a post-fix report
// cannot reuse a stale fact or re-probe an unchanged one.
export function applyFix(
  edge: DoctorEdge,
  fix: Fix,
  facts: DoctorFacts,
): DoctorFacts {
  switch (fix.kind) {
    case "claude-settings-env": {
      const text = readSettingsText(edge);
      const next = setValue(
        text,
        ["env", fix.name],
        JSON.stringify(fix.value),
        JSON_DIALECT,
      );
      fs.mkdirSync(path.dirname(edge.claudeSettingsPath), { recursive: true });
      fs.writeFileSync(edge.claudeSettingsPath, next);
      return { ...facts, claudeSettingsEnv: readClaudeSettingsEnv(edge) };
    }
    default: {
      const _exhaustive: never = fix.kind;
      return _exhaustive;
    }
  }
}
