// [LAW:single-enforcer] THE click-wire codec. A click is an ordered list of
// effects; this module is the one place that serializes that list to a URL and
// parses it back. The renderer (every click emitter) calls effectsUrl; the
// daemon's `dispatch` verb calls parseEffects. Encode and decode live together
// so the format cannot drift between the two halves [LAW:one-source-of-truth].
//
// [LAW:dataflow-not-control-flow] N effects ride one URL the SAME way for N=1 and
// N=100 — a lone click is the degenerate one-element list. There is no
// plain-vs-compound mode: every URL effectsUrl emits is `dispatch/e=…`, and the
// effect COUNT is data the dispatcher folds over, never a branch that selects a
// wire. (The wire still ACCEPTS direct `cc-candybar://<verb>/…` URLs — old
// scrollback links, a hand-authored `link` template — so a direct verb is the
// degenerate one-effect case on the parse side; only emission is unified here.)
//
// Why query params (not slashes, not base64): the value handed to the daemon is
// passed RAW (parseHandlerUrl decodes only the verb), so each `e` param survives
// exactly one URLSearchParams decode and an effect's own slash-bearing value
// (a path, a set-state key/value tail) round-trips untouched. base64 was
// rejected as opaque; a slash-nested payload is unsafe under any single
// whole-value decode (a `%2F` would un-escape into a structural separator). The
// `e=…&e=…` payload follows the verb after a `/` (`dispatch/e=…`), NOT a `?`, so
// `/` stays the one verb delimiter and `?` remains ordinary data in a bare-copy
// value (`cc-candybar://hello?world`).

import { URLSearchParams } from "node:url";

// [LAW:one-source-of-truth] The scheme string lives here, with the codec that
// emits it; install/ (Launch Services registration) imports it.
export const URL_SCHEME = "cc-candybar";

// [LAW:one-source-of-truth] The verb vocabulary. The daemon's VERBS registry
// keys off these and every emitter builds effects with them, so the emitted
// verb and the dispatched handler cannot name-drift.
export const VERB_DISPATCH = "dispatch";
export const VERB_SET_STATE = "set-state";
// [LAW:types-are-the-program] A RELATIVE state nudge: its args are
// `[sessionId, key, by]` where `by` is the signed integer delta. Distinct from
// set-state because the click intent is "step from whatever the value IS now",
// not "set to this fixed value" — the absolute target is computed at APPLY time
// from live state, so the link carries no `current` snapshot and N rapid clicks
// each re-read-and-write. Additive: old set-state links still resolve.
export const VERB_STEP_STATE = "step-state";
export const VERB_COPY = "copy";
export const VERB_OPEN_VSCODE = "open-vscode";
export const VERB_TOOLBAR_TOGGLE = "toolbar-toggle";
export const VERB_SHOW_CONFIG_ERROR = "show-config-error";
export const VERB_SHOW_CONFIG_WARNING = "show-config-warning";
// [LAW:effects-at-boundaries] A daemon-global config override: the verb writes
// the override path (or clears it with an empty value); the render pipeline
// reads it at the cache-lookup boundary. Clicking a different config is a
// side-effect isolated to the verb handler; the renderer only sees the result.
export const VERB_LOAD_CONFIG = "load-config";

// [LAW:types-are-the-program] An effect to EMIT: a verb plus its raw (unencoded)
// positional args. The wire owns all encoding — callers never percent-encode.
// set-state's args are `[sessionId, key, value, …]`; copy/open carry one arg.
export interface Effect {
  readonly verb: string;
  readonly args: readonly string[];
}

// [LAW:types-are-the-program] A parsed effect as the dispatcher sees it: the verb
// and the still-encoded segment tail. The tail stays encoded because the target
// verb's handler decodes its own segments at its boundary (single-enforcer per
// verb) — the same contract a direct (non-dispatch) click URL hands a handler.
export interface ParsedEffect {
  readonly verb: string;
  readonly value: string;
}

// [LAW:single-enforcer] The segment codec. A verb's args serialize to a
// slash-joined run of percent-encoded segments; the handler decodes the inverse.
// Encoding each segment means a segment's own `/` becomes `%2F` and never reads
// as a separator — the slash-safety the old whole-value decode could not give.
export function encodeSegments(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

export function decodeSegments(value: string): string[] {
  return value.length === 0 ? [] : value.split("/").map(decodeURIComponent);
}

// Serialize an effect list to its dispatch URL. Each effect becomes one ordered
// `e` query param carrying `verb/<encoded-args>`, percent-encoded whole so its
// internal `/`, `&`, `=` survive as data. The payload follows `dispatch/` (not
// `dispatch?`) so `/` is the only verb delimiter parseHandlerUrl needs.
export function effectsUrl(effects: readonly Effect[]): string {
  const qs = effects
    .map(
      (e) => `e=${encodeURIComponent(`${e.verb}/${encodeSegments(e.args)}`)}`,
    )
    .join("&");
  return `${URL_SCHEME}://${VERB_DISPATCH}/${qs}`;
}

// [LAW:dataflow-not-control-flow] Parse the dispatch verb's raw value (an
// `e=…&e=…` query string) into the ordered effect list. URLSearchParams decodes
// each param exactly once and preserves insertion order; splitting each on the
// FIRST `/` recovers (verb, still-encoded tail) — the same split parseHandlerUrl
// applies at the top level, one level down.
export function parseEffects(rawValue: string): ParsedEffect[] {
  return new URLSearchParams(rawValue).getAll("e").map(splitVerb);
}

// [LAW:types-are-the-program] Split a `verb/tail` string at the first `/`. A
// verb with no args (no slash) yields an empty tail — the degenerate case, not a
// guard. The tail keeps its slashes (further segments) for the handler to decode.
export function splitVerb(s: string): ParsedEffect {
  const i = s.indexOf("/");
  return i === -1
    ? { verb: s, value: "" }
    : { verb: s.slice(0, i), value: s.slice(i + 1) };
}
