// [LAW:single-enforcer][LAW:one-source-of-truth] Encode and decode live together.
// [LAW:dataflow-not-control-flow] The effect count is data, never a mode; a direct
// `cc-candybar://<verb>/…` URL is still ACCEPTED. Query params after `dispatch/`,
// not `?`, so each `e` survives one decode and `/` stays the one verb delimiter.

import { URLSearchParams } from "node:url";

export const URL_SCHEME = "cc-candybar";

// [LAW:one-source-of-truth] Emitter and handler cannot name-drift.
export const VERB_DISPATCH = "dispatch";
export const VERB_SET_STATE = "set-state";
// [LAW:types-are-the-program] `[sessionId, key, by]`: RELATIVE, resolved at apply.
export const VERB_STEP_STATE = "step-state";
export const VERB_COPY = "copy";
export const VERB_OPEN_VSCODE = "open-vscode";
export const VERB_TOOLBAR_TOGGLE = "toolbar-toggle";
export const VERB_SHOW_CONFIG_ERROR = "show-config-error";
export const VERB_SHOW_CONFIG_WARNING = "show-config-warning";
// [LAW:effects-at-boundaries] The daemon-global override path; empty clears it.
export const VERB_LOAD_CONFIG = "load-config";
// [LAW:one-source-of-truth] `[sessionId, key, value, releaseKey?]`: spliced into the
// config FILE, read back through the SAME watcher a hand edit trips. `releaseKey`
// rides the write, never a second effect a rejected write could leave applied.
export const VERB_SET_CONFIG = "set-config";
// [LAW:types-are-the-program] `[sessionId, key, by, releaseKey?]`.
export const VERB_STEP_CONFIG = "step-config";
// [LAW:one-source-of-truth] `[sessionId, key]`: deletes it, restoring the default.
export const VERB_RESET_CONFIG = "reset-config";
// [LAW:one-type-per-behavior] `[sessionId, key, op]`: a tree edit, not a value.
export const VERB_APPLY_LAYOUT_OP = "apply-layout-op";
// [LAW:one-source-of-truth] `[sessionId]`: whole-file snapshots; an empty stack or
// a hand-edited file is a loud BAD_REQUEST.
export const VERB_UNDO = "undo";
export const VERB_REDO = "redo";
// [LAW:effects-at-boundaries] `[sessionId]` only: nothing a URL carries hits a shell.
export const VERB_APPLY_UPDATE = "apply-update";

// [LAW:effects-at-boundaries] `[sessionId, checkName?]` gated by `CHECKS`; no command in the URL.
export const VERB_DOCTOR_RUN = "doctor-run";
export const VERB_DOCTOR_FIX = "doctor-fix";

// [LAW:types-are-the-program] Raw args: the wire owns all encoding.
export interface Effect {
  readonly verb: string;
  readonly args: readonly string[];
}

// [LAW:types-are-the-program] The tail stays encoded; each handler decodes its own.
export interface ParsedEffect {
  readonly verb: string;
  readonly value: string;
}

// [LAW:single-enforcer] Per-segment, so a segment's own `/` never separates.
export function encodeSegments(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

export function decodeSegments(value: string): string[] {
  return value.length === 0 ? [] : value.split("/").map(decodeURIComponent);
}

export function effectsUrl(effects: readonly Effect[]): string {
  const qs = effects
    .map(
      (e) => `e=${encodeURIComponent(`${e.verb}/${encodeSegments(e.args)}`)}`,
    )
    .join("&");
  return `${URL_SCHEME}://${VERB_DISPATCH}/${qs}`;
}

// [LAW:dataflow-not-control-flow] Decodes once, preserving insertion order.
export function parseEffects(rawValue: string): ParsedEffect[] {
  return new URLSearchParams(rawValue).getAll("e").map(splitVerb);
}

// [LAW:types-are-the-program] No args is an empty tail — degenerate, not a guard.
export function splitVerb(s: string): ParsedEffect {
  const i = s.indexOf("/");
  return i === -1
    ? { verb: s, value: "" }
    : { verb: s.slice(0, i), value: s.slice(i + 1) };
}
