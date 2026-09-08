// [LAW:effects-at-boundaries] Every effect the doctor has lives behind one
// DoctorEdge: checks.ts never sees one, and this file never decides a verdict.

import fs from "node:fs";
import path from "node:path";
import { claudeSettingsPath } from "../claude-settings.js";
import { JSON_DIALECT, setValue } from "../config/json5-edit.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { ClientHints } from "../daemon/protocol.js";
import { launchSync } from "../proc/launch.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { DoctorFacts, Fix, TermFeatures, TmuxFacts } from "./checks.js";

export interface DoctorEdge {
  readonly probeTmux: (hint: TmuxHint) => TermFeatures;
  readonly claudeSettingsPath: string;
}

// `RGB` in client_termfeatures is tmux saying it and the outer terminal do truecolor.
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

// [LAW:no-silent-failure] A missing file is an empty env; an unparseable one throws.
function readSettingsText(edge: DoctorEdge): string {
  return fs.existsSync(edge.claudeSettingsPath)
    ? fs.readFileSync(edge.claudeSettingsPath, "utf8")
    : "";
}

function settingsEnv(text: string): Readonly<Record<string, unknown>> {
  if (/^\s*$/.test(text)) return {};
  const parsed: unknown = JSON_DIALECT.parse(text);
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

// [LAW:dataflow-not-control-flow] The hint's three wire states become three arms.
function tmuxFacts(edge: DoctorEdge, hint: ClientHints["tmux"]): TmuxFacts {
  if (hint === undefined) return { kind: "unreported" };
  if (hint === null) return { kind: "outside" };
  return { kind: "inside", hint, termfeatures: edge.probeTmux(hint) };
}

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

// [LAW:one-source-of-truth] A SPLICE, not a rewrite, in the JSON dialect — Claude
// Code parses settings.json strictly. Returns the facts with the changed one re-read.
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
      writeAtomic(edge.claudeSettingsPath, next);
      return { ...facts, claudeSettingsEnv: readClaudeSettingsEnv(edge) };
    }
    default: {
      const _exhaustive: never = fix.kind;
      return _exhaustive;
    }
  }
}
