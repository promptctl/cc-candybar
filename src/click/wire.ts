// [LAW:single-enforcer] THE click-wire codec. A click is an ordered list of
// effects; this module is the one place that serializes that list to a URL and
// parses it back. The renderer (every click emitter) calls effectsUrl; the
// daemon's `dispatch` verb calls parseEffects. Encode and decode live together
// so the format cannot drift between the two halves [LAW:one-source-of-truth].
//
// [LAW:dataflow-not-control-flow] N effects ride one URL the SAME way for N=1 and
// N=100 — a lone click is the degenerate one-element list. There is no
// plain-vs-compound mode: every URL effectsUrl emits is `dispatch/does=…&e=…`, and the
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
// payload follows the verb after a `/` (`dispatch/does=…&e=…`), NOT a `?`, so
// `/` stays the one verb delimiter and `?` remains ordinary data in a bare-copy
// value (`cc-candybar://hello?world`).
//
// A link says in words what its click does, as a `does` param ahead of the
// effects: `dispatch/does=set+theme+to+dracula&e=…`. It leads because a terminal
// that cuts a long URL on hover keeps its start, and it is a param rather than
// a `#fragment` because URLSearchParams reads a fragment into the last effect.
// parseEffects never reads it, so it is advisory: only a mac proves a link.

import { URLSearchParams } from "node:url";

import { DISCLOSURE_CLOSED, DISCLOSURE_OPEN } from "../config/disclosure.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import { MENU_NS, MENU_PAGE_NS } from "../config/loader/reserved-namespace.js";

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
// [LAW:effects-at-boundaries] A daemon-global config override: the verb writes
// the override path (or clears it with an empty value); the render pipeline
// reads it at the cache-lookup boundary. Clicking a different config is a
// side-effect isolated to the verb handler; the renderer only sees the result.
export const VERB_LOAD_CONFIG = "load-config";
// [LAW:one-source-of-truth] `persist`'s twin of set-state/step-state: writes
// land in the session's config FILE (candybar-config-dqe — the one durable
// store), spliced in place so comments survive, and reach the bar through
// the SAME file-watcher path a hand edit already takes. Args: `[sessionId, key, value]` — the
// sessionId is carried only for click.error surfacing, exactly like
// set-state; the write itself is daemon-global, not session-scoped.
export const VERB_SET_CONFIG = "set-config";
// [LAW:types-are-the-program] A RELATIVE nudge to a bounded config-file
// key (e.g. a padding stepper) — the config twin of step-state. Args:
// `[sessionId, key, by]`.
export const VERB_STEP_CONFIG = "step-config";
// [LAW:no-ambient-temporal-coupling] Write every one of the session's unsaved
// settings (src/daemon/setting-drafts.ts) to its config file, then release
// them from the session — one handler, so a refused write keeps every draft.
// Args: `[sessionId]`: which settings are drafts, and their values, are read
// at click time from the session itself, never carried by the URL.
export const VERB_SAVE = "save";
// Save as preset (brandon-save-undo-bwi.o6u): write the bar the session
// renders into the config file as a new `presets.custom-N`, then switch the
// session to it. Args: `[sessionId]` — the name, the arrangement and the
// settings are all read at click time, like `save`'s drafts.
export const VERB_SAVE_PRESET = "save-preset";
// Save the look the session draws as the active theme's default
// (candybar-theme-colours-6fq5.ix8): write its shade, variation and style into
// `themeDefaults.<theme>` in the config file, then release those picks. Args:
// `[sessionId]` — the theme and the look are read at click time.
export const VERB_SAVE_THEME_DEFAULT = "save-theme-default";
// Delete a preset the config file authors (never a bundled one). Args:
// `[sessionId, name]` — the name the bar showed, so the click removes the
// preset its label named, and a name the file no longer declares is refused.
export const VERB_DELETE_PRESET = "delete-preset";
// [LAW:one-source-of-truth] Return each named config key to its bundled
// default at every layer that holds it — its paths in the config file, in one
// write, and the session's pick (resetLayers, src/daemon/setting-drafts.ts).
// Args: `[sessionId, key, …key]`.
export const VERB_RESET_CONFIG = "reset-config";
// [LAW:one-type-per-behavior] brandon-layout-edit-2gc.1's structural-edit
// verb — a THIRD write semantic beside set-config's plain overwrite and
// step-config's numeric read-modify-write: apply one tree op to the layout
// the config file authors at `key` (a "presets.<name>.root" target). Args:
// `[sessionId, key, op]` — `op` is one opaque token from
// src/config/layout-ops.ts's codec, the SAME shape a `persist … to` literal's
// value would be, gated the SAME way (configGate) — only the write's
// SHAPE (a tree edit vs. a value) differs, which is exactly why this is its
// own verb rather than another VERB_SET_CONFIG value.
export const VERB_APPLY_LAYOUT_OP = "apply-layout-op";
// [LAW:one-source-of-truth] A step of the session's settings history
// (src/daemon/settings-history.ts) — the fine-grained sibling of
// VERB_RESET_CONFIG's coarse "back to the bundled default". Args: `[sessionId]` — there is
// no key: the history is one stack of clicks per session, not a per-key log.
// An empty stack, or a target changed since the step, is a loud BAD_REQUEST
// surfaced through click.error like any other verb failure, never a silent
// no-op.
export const VERB_UNDO = "undo";
export const VERB_REDO = "redo";
// Restore what the session's last navigating click opened or closed
// (src/daemon/navigation-history.ts). Args: `[sessionId]`, like undo. An empty
// history is a loud BAD_REQUEST, never a silent no-op.
export const VERB_BACK = "back";
// [LAW:one-source-of-truth] Cancel for edit mode: put back everything the
// session changed since edit mode opened, from the savepoint it took then
// (src/daemon/settings-history.ts `rewind`). Args: `[sessionId]`, like undo.
// Saving is the settings menu's `save`; leaving edit mode releases the
// savepoint.
export const VERB_REWIND = "rewind";
// [LAW:effects-at-boundaries] The update notice's act (brandon-build-notice-
// 5d6): rebuild a source checkout, or stage the newer release over an
// install. Args: `[sessionId]` — carried for click.error surfacing only. The
// verb takes NO command and NO version: the daemon runs the act its own
// provenance implies (src/daemon/update-notice.ts), so nothing a URL carries
// ever reaches a shell.
export const VERB_APPLY_UPDATE = "apply-update";

// [LAW:effects-at-boundaries] The doctor (brandon-doctor-b6a). `doctor-run`
// args: `[sessionId]` — runs every check over the session's RECORDED client
// hints and writes the report into that session's state. `doctor-fix` args:
// `[sessionId, checkName]` — re-probes that one check and performs the fix its
// verdict carries, then re-runs. The check name is gated by membership in
// `CHECKS` (src/doctor/checks.ts); no command, path, or value ever rides the
// URL — the fix is whatever the check's own verdict describes. `doctor-mark`
// args: `[sessionId, checkName, mark]` — records the user's mark on the glyphs
// that check's fresh verdict shows, under the sighting they are, then re-runs.
export const VERB_DOCTOR_RUN = "doctor-run";
export const VERB_DOCTOR_FIX = "doctor-fix";
export const VERB_DOCTOR_MARK = "doctor-mark";
// A link `cc-candybar doctor` opens to learn whether the URL handler delivers
// it. Arg: the nonce the CLI will look for among the daemon's arrivals.
export const VERB_DOCTOR_PROBE = "doctor-probe";

// [LAW:effects-at-boundaries] Type a slash command into the session's Claude
// Code prompt through its tmux pane. Args: `[sessionId, line]` — the line must
// be one a `slash` action in the session's config declares.
export const VERB_SLASH = "slash";

// [LAW:effects-at-boundaries] Run a `run` action's program for a session.
// Args: `[sessionId, action, evaluated, mac]` — `evaluated` is the JSON of the
// program, arguments and environment the draw evaluated (EvaluatedRun), and
// `mac` signs the first three (src/click/link-signer.ts). The action must be
// a `run` the session's config declares; the directory it runs in and the
// sources it refreshes come from that declaration, never the URL.
export const VERB_RUN = "run";

// [LAW:effects-at-boundaries] Answer the bar's question about a repository's
// cc-candybar config. Args: `[sessionId, dir, answer, mac]` — `answer` is
// approved or declined, and `mac` signs the session, directory and answer
// (src/daemon/repo-configs.ts), so only an answer the bar drew is recorded.
export const VERB_REPO_CONFIG = "repo-config";

// Copy what a diagnostic message copies (src/render/diagnostics.ts): its text,
// or the prompt that fixes what it reports. Args: `[sessionId, by, key]` — the
// renderer that drew the link and the key the viewer opens the message by, so a
// frame's bytes never grow with what it copies; the text is read at click time
// from that renderer's last delivered frame, and a message no longer listed is
// refused loudly.
export const VERB_COPY_DIAGNOSTIC = "copy-diagnostic";

// [LAW:types-are-the-program] What a `run` link carries of the draw's
// evaluation: the argv, program first, and the variables laid over the
// session's process environment.
export interface EvaluatedRun {
  readonly run: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

// A click on one of the ranges the daemon draws in a tmux status line (lane
// C, src/daemon/tmux-status.ts), as the server's MouseDown1Status binding
// sends it. Args: `[socket, pane number, range]` — the daemon looks the range
// up in the frame it drew there and runs the link it marks, so no link rides
// the URL. Not a leaf verb: the link's own verb is the click's.
export const VERB_TMUX_STATUS_CLICK = "tmux-status-click";

// [LAW:types-are-the-program] An effect to EMIT: a verb plus its raw (unencoded)
// positional args. The wire owns all encoding — callers never percent-encode.
// set-state's args are `[sessionId, key, value, …]`; copy/open carry one arg.
export interface Effect {
  readonly verb: EffectVerb;
  readonly args: readonly string[];
}

const sayStep = (key: string, by: string): string =>
  `step ${key} ${by.startsWith("-") ? "down" : "up"} by ${by.replace("-", "")}`;

const withoutNs = (key: string, ns: string): string =>
  key.startsWith(ns) ? key.slice(ns.length) : key;

// One session write in words. A disclosure's state keys read as the menu they
// open or close, and a page cursor, which counts from 0, as the page the bar
// numbers from 1; the rest read as the key they set. The viewer's key holds a
// message's identity, which no reader can use, so its write says what it opens.
function sayWrite(key: string, value: string): string {
  if (key === DIAGNOSTICS_VIEWING) return "open diagnostics";
  const menu = withoutNs(withoutNs(key, MENU_PAGE_NS), MENU_NS);
  if (key.startsWith(MENU_PAGE_NS))
    return `turn ${menu} to page ${Number(value) + 1}`;
  if (value === DISCLOSURE_CLOSED) return `close ${menu}`;
  if (value === DISCLOSURE_OPEN) return `open ${menu}`;
  return key.startsWith(MENU_NS) ? `open ${value}` : `set ${key} to ${value}`;
}

// How much of a copied text a link says, and the mark where it was cut. Copied
// text is the one free text a click carries; the rest are names and paths. Both
// ends stay, by code point: a path differs at its end, and half a surrogate pair
// cannot be encoded.
const COPIED_LENGTH = 60;
const ELISION = "...";
function saidCopy(text: string): string {
  const chars = [...text];
  const kept = Math.floor((COPIED_LENGTH - ELISION.length) / 2);
  return chars.length <= COPIED_LENGTH
    ? text
    : `${chars.slice(0, kept).join("")}${ELISION}${chars.slice(-kept).join("")}`;
}

// [LAW:one-source-of-truth] Every verb a click can fire, and what it does in
// words, read off the args the click carries, so the text cannot say anything
// the click does not do. A verb says a phrase per write. VERB_DISPATCH is the
// list these ride in, and doctor-probe and tmux-status-click arrive as whole
// URLs from outside a draw, so none of those three is ever an effect.
const SAYS = {
  [VERB_SET_STATE]: ([, ...pairs]) =>
    pairs.flatMap((key, i) =>
      i % 2 === 0 ? [sayWrite(key, pairs[i + 1]!)] : [],
    ),
  [VERB_STEP_STATE]: ([, key, by]) => [sayStep(key!, by!)],
  [VERB_COPY]: ([text]) => [`copy ${saidCopy(text!)}`],
  [VERB_OPEN_VSCODE]: ([target]) => [`open ${target} in vs code`],
  [VERB_TOOLBAR_TOGGLE]: () => ["toggle the toolbar"],
  [VERB_LOAD_CONFIG]: ([, path]) => [`load config ${path}`],
  [VERB_SET_CONFIG]: ([, key, value]) => [`save ${key} as ${value}`],
  [VERB_STEP_CONFIG]: ([, key, by]) => [`save ${sayStep(key!, by!)}`],
  [VERB_SAVE]: () => ["save settings"],
  [VERB_SAVE_PRESET]: () => ["save as a new preset"],
  [VERB_SAVE_THEME_DEFAULT]: () => ["save this look for the theme"],
  [VERB_DELETE_PRESET]: ([, name]) => [`delete preset ${name}`],
  [VERB_RESET_CONFIG]: ([, ...keys]) => keys.map((key) => `reset ${key}`),
  [VERB_APPLY_LAYOUT_OP]: ([, key, op]) => [`edit ${op} in ${key}`],
  [VERB_UNDO]: () => ["undo"],
  [VERB_REDO]: () => ["redo"],
  [VERB_BACK]: () => ["go back"],
  [VERB_REWIND]: () => ["cancel edits"],
  [VERB_APPLY_UPDATE]: () => ["update cc-candybar"],
  [VERB_DOCTOR_RUN]: () => ["run doctor"],
  [VERB_DOCTOR_FIX]: ([, check]) => [`fix ${check}`],
  [VERB_DOCTOR_MARK]: ([, check, mark]) => [`mark ${check} ${mark}`],
  [VERB_SLASH]: ([, line]) => [`type ${line}`],
  [VERB_RUN]: ([, action]) => [`run ${action}`],
  [VERB_REPO_CONFIG]: ([, dir, answer]) => [`mark config in ${dir} ${answer}`],
  [VERB_COPY_DIAGNOSTIC]: () => ["copy diagnostic"],
} satisfies Record<string, (args: readonly string[]) => string[]>;

// [LAW:types-are-the-program] A verb the table does not say is no effect, so a
// new verb cannot ride unsaid.
export type EffectVerb = keyof typeof SAYS;

// [LAW:single-enforcer] Form encoding, with `/` and `:` left as themselves so a
// path or a layout op reads as it is written. Every character of the words
// survives. OSC 8 URIs are printable ASCII, which is what the escapes are for.
const spell = (text: string): string =>
  encodeURIComponent(text)
    .replaceAll("%20", "+")
    .replaceAll("%2F", "/")
    .replaceAll("%3A", ":");

// A click's words: its face, then a count of what else it does. Session writes
// are the bar's own housekeeping, so whatever else the click does is its face:
// a confirm disarms first, but what it does is what it fires.
function clickDoes(effects: readonly Effect[]): string {
  const writesSession = (e: Effect): boolean =>
    e.verb === VERB_SET_STATE || e.verb === VERB_STEP_STATE;
  const [face = "nothing", ...rest] = [
    ...effects.filter((e) => !writesSession(e)),
    ...effects.filter(writesSession),
  ].flatMap((e) => SAYS[e.verb](e.args));
  return rest.length > 0 ? `${face} and ${rest.length} more` : face;
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

// The first of `value`'s segments, decoded alone, so a reader of the leading
// segment is never failed by a malformed one after it.
export function decodeFirstSegment(value: string): string {
  return decodeURIComponent(value.split("/", 1)[0]!);
}

// Serialize an effect list to its dispatch URL: the words of what the click does,
// then one ordered `e` query param per effect carrying `verb/<encoded-args>`,
// percent-encoded whole so its internal `/`, `&`, `=` survive as data. The
// payload follows `dispatch/` (not `dispatch?`) so `/` is the only verb delimiter
// parseHandlerUrl needs. The words are the effects' own unless the draw holds a
// fact they do not carry, such as the position it shows a key's message at.
export function effectsUrl(
  effects: readonly Effect[],
  says: string = clickDoes(effects),
): string {
  const params = effects.map(
    (e) => `e=${encodeURIComponent(`${e.verb}/${encodeSegments(e.args)}`)}`,
  );
  const qs = [`does=${spell(says)}`, ...params].join("&");
  return `${URL_SCHEME}://${VERB_DISPATCH}/${qs}`;
}

// [LAW:dataflow-not-control-flow] Parse the dispatch verb's raw value (an
// `does=…&e=…&e=…` query string) into the ordered effect list. URLSearchParams decodes
// each param exactly once and preserves insertion order; splitting each on the
// FIRST `/` recovers (verb, still-encoded tail) — the same split parseHandlerUrl
// applies at the top level, one level down.
export function parseEffects(rawValue: string): ParsedEffect[] {
  return new URLSearchParams(rawValue).getAll("e").map(splitVerb);
}

// [LAW:single-enforcer] One click's consecutive writes of one kind are one
// write. A run of ADJACENT effects of a batched verb for one session becomes a
// single effect whose tail carries every member's arguments: set-state's pairs,
// which its handler validates whole before writing any of them, so a `do`
// action's session members, or a picker option and its close writes, land
// together or not at all; and reset-config's keys, which its handler clears in
// one file write and one reload, so `⟲ reset all` is one write however many
// settings it names. Only adjacency merges: effects still run in the order the
// click lists them, so an effect between two writes keeps its place, and a
// different verb or session id starts a new run rather than borrowing the
// previous one's. The tail stays encoded — splitVerb one level down splits
// `<sid>/<args…>`, and joining encoded runs is the codec's own join.
const BATCHED_VERBS: ReadonlySet<string> = new Set([
  VERB_SET_STATE,
  VERB_RESET_CONFIG,
]);

export function batchAdjacentWrites(
  effects: readonly ParsedEffect[],
): ParsedEffect[] {
  return effects.reduce<ParsedEffect[]>((out, e) => {
    const prev = out.at(-1);
    const joined = prev && joinWrites(prev, e);
    return joined ? [...out.slice(0, -1), joined] : [...out, e];
  }, []);
}

// Two effects as one batch, or undefined when they are not the same batched
// verb for the same session.
function joinWrites(
  a: ParsedEffect,
  b: ParsedEffect,
): ParsedEffect | undefined {
  if (a.verb !== b.verb || !BATCHED_VERBS.has(a.verb)) return undefined;
  const [x, y] = [splitVerb(a.value), splitVerb(b.value)];
  return x.verb === y.verb
    ? { verb: a.verb, value: `${x.verb}/${x.value}/${y.value}` }
    : undefined;
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
