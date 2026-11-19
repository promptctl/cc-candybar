// [LAW:single-enforcer] THE click-wire codec. A click is an ordered list of
// effects; this module is the one place that serializes that list to a URL and
// parses it back. The frame publisher calls effectsUrl for typed targets,
// and existing URL producers use the same codec. Encode and decode live
// together so the format cannot drift [LAW:one-source-of-truth].
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
import { DIAGNOSTICS_CLOSED, DIAGNOSTICS_VIEWING } from "../config/door.js";
import { REPO_ANSWERS, type RepoAnswer } from "../config/loader/repo-gate.js";
import {
  isReservedName,
  MENU_NS,
  MENU_PAGE_NS,
} from "../config/reserved-names.js";
import { BadVerbArgs, decodeWire } from "../daemon/foundations/verb-error";
import {
  parseSessionId,
  type SessionId,
} from "../daemon/foundations/session-id";
import type { LinkSigner, SignedFields } from "./link-signer.js";

// [LAW:one-source-of-truth] The scheme string lives here, with the codec that
// emits it; install/ (Launch Services registration) imports it.
export const URL_SCHEME = "cc-candybar";

// A link outside the cc-candybar scheme (a repo page, a PR) is the
// terminal's to open; the daemon never sees a click on it.
export const isBarLink = (url: string): boolean =>
  url.startsWith(`${URL_SCHEME}://`);

// The app Launch Services starts for the scheme: its bundle, binary and
// process all carry this name. Beside the scheme because it is the same fact,
// which app a click reaches, and a reader of it (the bench) wants nothing of
// the installer.
export const APP_NAME = "CCCandybarURLHandler";

// [LAW:one-source-of-truth] The verb vocabulary used by emitters, the host's
// admission and the renderer's handler table.
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
// Every config write's args begin `[sessionId, layer]`: the session whose
// chain the write resolves in, and the role of the layer it writes there
// (configWire, src/renderer/verbs/index.ts).
// [LAW:one-source-of-truth] `persist`'s twin of set-state/step-state: writes
// land in a config FILE of the session's chain (the one durable store),
// spliced in place so comments survive, and reach the bar through the SAME
// file-watcher path a hand edit already takes. Args: `[sessionId, layer, key,
// value]`.
export const VERB_SET_CONFIG = "set-config";
// [LAW:types-are-the-program] A RELATIVE nudge to a bounded config-file
// key (e.g. a padding stepper) — the config twin of step-state. Args:
// `[sessionId, layer, key, by]`.
export const VERB_STEP_CONFIG = "step-config";
// [LAW:no-ambient-temporal-coupling] Write every one of the session's unsaved
// settings (src/renderer/setting-drafts.ts) to its config file, then release
// them from the session — one handler, so a refused write keeps every draft.
// Args: `[sessionId, layer]`: which settings are drafts, and their values, are
// read at click time from the session itself, never carried by the URL.
export const VERB_SAVE = "save";
// Save as preset (brandon-save-undo-bwi.o6u): write the bar the session
// renders into the config file as a new `presets.custom-N`, then switch the
// session to it. Args: `[sessionId, layer]` — the name, the arrangement and
// the settings are all read at click time, like `save`'s drafts.
export const VERB_SAVE_PRESET = "save-preset";
// Save the look the session draws as the active theme's default
// (candybar-theme-colours-6fq5.ix8): write its shade, variation and style into
// `themeDefaults.<theme>` in the config file, then release those picks. Args:
// `[sessionId, layer]` — the theme and the look are read at click time.
export const VERB_SAVE_THEME_DEFAULT = "save-theme-default";
// Delete a preset the written file authors (never one it inherits). Args:
// `[sessionId, layer, name]` — the name the bar showed, so the click removes
// the preset its label named, and a name the file no longer declares is
// refused.
export const VERB_DELETE_PRESET = "delete-preset";
// [LAW:one-source-of-truth] Return each named config key to what the
// written layer inherits — its paths in that layer's file, in one write, and
// the session's pick (resetLayers, src/renderer/setting-drafts.ts). Args:
// `[sessionId, layer, key, …key]`.
export const VERB_RESET_CONFIG = "reset-config";
// [LAW:one-type-per-behavior] brandon-layout-edit-2gc.1's structural-edit
// verb — a THIRD write semantic beside set-config's plain overwrite and
// step-config's numeric read-modify-write: apply one tree op to the layout
// the config file authors at `key` (a "presets.<name>.root" target). Args:
// `[sessionId, layer, key, op]` — `op` is one opaque token from
// src/config/layout-ops.ts's codec, the SAME shape a `persist … to` literal's
// value would be, gated the SAME way (configGate) — only the write's
// SHAPE (a tree edit vs. a value) differs, which is exactly why this is its
// own verb rather than another VERB_SET_CONFIG value.
export const VERB_APPLY_LAYOUT_OP = "apply-layout-op";
// [LAW:one-source-of-truth] A step of the session's settings history
// (src/renderer/settings-history.ts) — the fine-grained sibling of
// VERB_RESET_CONFIG's coarse "back to the bundled default". Args: `[sessionId]` — there is
// no key: the history is one stack of clicks per session, not a per-key log.
// An empty stack, or a target changed since the step, is a loud BAD_REQUEST
// surfaced through click.error like any other verb failure, never a silent
// no-op.
export const VERB_UNDO = "undo";
export const VERB_REDO = "redo";
// Restore what the session's last navigating click opened or closed
// (src/renderer/navigation-history.ts). Args: `[sessionId]`, like undo. An empty
// history is a loud BAD_REQUEST, never a silent no-op.
export const VERB_BACK = "back";
// [LAW:one-source-of-truth] Cancel for edit mode: put back everything the
// session changed since edit mode opened, from the savepoint it took then
// (src/renderer/settings-history.ts `rewind`). Args: `[sessionId]`, like undo.
// Saving is the settings menu's `save`; leaving edit mode releases the
// savepoint.
export const VERB_REWIND = "rewind";

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
// so only an answer the bar drew is recorded.
export const VERB_REPO_CONFIG = "repo-config";

// [LAW:single-enforcer] The same fields sign a drawn decision and verify an
// answer from a terminal. Their spelling preserves already-issued links.
export function repoAnswerFields(
  sessionId: SessionId,
  dir: string,
  answer: RepoAnswer,
): SignedFields {
  return {
    sessionId,
    action: VERB_REPO_CONFIG,
    declaration: dir,
    evaluated: answer,
  };
}

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

// [LAW:types-are-the-program] Keep the precise legacy bytes the host verifies.
// The declaration to check is supplied by the renderer's current config.
export interface RunEvidence {
  readonly session: SessionId;
  readonly action: string;
  readonly evaluated: string;
  readonly mac: string;
}

// [LAW:single-enforcer] Publication and authorization use the same field
// projection, preserving the legacy signatures.
export function runLinkFields(
  {
    session,
    action,
    declaration,
  }: {
    readonly session: SessionId;
    readonly action: string;
    readonly declaration: string;
  },
  evaluated: string,
): SignedFields {
  return { sessionId: session, action, declaration, evaluated };
}

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
// numbers from 1; the rest read as the key they set. Disclosures are synthesized,
// so an authored key's `closed` is its own data. The viewer's key holds a
// message's identity, which no reader can use, so its write says what it does.
function sayWrite(key: string, value: string): string {
  if (key === DIAGNOSTICS_VIEWING)
    return `${value === DIAGNOSTICS_CLOSED ? "close" : "open"} diagnostics`;
  const set = `set ${key} to ${value}`;
  if (!isReservedName(key)) return set;
  const menu = withoutNs(withoutNs(key, MENU_PAGE_NS), MENU_NS);
  if (key.startsWith(MENU_PAGE_NS))
    return `turn ${menu} to page ${Number(value) + 1}`;
  if (value === DISCLOSURE_CLOSED) return `close ${menu}`;
  if (value === DISCLOSURE_OPEN) return `open ${menu}`;
  return key.startsWith(MENU_NS) ? `open ${value}` : set;
}

// How much of a copied text a link says, and the mark where it was cut. Only a
// copy is cut, because it alone has no natural length: the rest are names, paths
// and what an author wrote. Both ends stay, by code point: a path differs at its
// end, and half a surrogate pair cannot be encoded.
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
// list these ride in, so dispatch is never an effect.
const SAYS = {
  [VERB_SET_STATE]: ([, ...pairs]) =>
    pairs.flatMap((key, i) =>
      i % 2 === 0 ? [sayWrite(key, pairs[i + 1]!)] : [],
    ),
  [VERB_STEP_STATE]: ([, key, by]) => [sayStep(key!, by!)],
  [VERB_COPY]: ([text]) => [`copy ${saidCopy(text!)}`],
  [VERB_OPEN_VSCODE]: ([target]) => [`open ${target} in vs code`],
  // A config write says the layer of the session's chain it writes.
  [VERB_SET_CONFIG]: ([, layer, key, value]) => [
    `save ${key} as ${value} in ${layer} config`,
  ],
  [VERB_STEP_CONFIG]: ([, layer, key, by]) => [
    `save ${sayStep(key!, by!)} in ${layer} config`,
  ],
  [VERB_SAVE]: ([, layer]) => [`save settings to ${layer} config`],
  [VERB_SAVE_PRESET]: ([, layer]) => [
    `save as a new preset in ${layer} config`,
  ],
  [VERB_SAVE_THEME_DEFAULT]: ([, layer]) => [
    `save this look for the theme in ${layer} config`,
  ],
  [VERB_DELETE_PRESET]: ([, layer, name]) => [
    `delete preset ${name} from ${layer} config`,
  ],
  [VERB_RESET_CONFIG]: ([, layer, ...keys]) =>
    keys.map((key) => `reset ${key} in ${layer} config`),
  [VERB_APPLY_LAYOUT_OP]: ([, layer, key, op]) => [
    `edit ${op} in ${key} of ${layer} config`,
  ],
  [VERB_UNDO]: () => ["undo"],
  [VERB_REDO]: () => ["redo"],
  [VERB_BACK]: () => ["go back"],
  [VERB_REWIND]: () => ["cancel edits"],
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

// A parsed link effect with its encoded argument tail. Admission decodes
// the tail using the same argument layout for direct and dispatch links.
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
// different verb or a different head starts a new run rather than borrowing
// the previous one's. The head is what a run's members share: a session
// write's session, and a config write's session and the layer it writes, so
// two layers are never one write. The tail stays encoded, so its segments
// split at `/`, and joining encoded runs is the codec's own join.
// [LAW:dataflow-not-control-flow] Each batched verb's head width, as data.
const BATCHED_VERBS: ReadonlyMap<string, number> = new Map([
  [VERB_SET_STATE, 1],
  [VERB_RESET_CONFIG, 2],
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
// verb with the same head.
function joinWrites(
  a: ParsedEffect,
  b: ParsedEffect,
): ParsedEffect | undefined {
  const width = BATCHED_VERBS.get(a.verb);
  if (a.verb !== b.verb || width === undefined) return undefined;
  const [x, y] = [a.value.split("/"), b.value.split("/")];
  const head = x.slice(0, width).join("/");
  return head === y.slice(0, width).join("/")
    ? { verb: a.verb, value: [...x, ...y.slice(width)].join("/") }
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

// [LAW:parse-dont-validate] A whole `cc-candybar://` link as a click, or why
// it is not one: the daemon reads every link this way, whether the URL
// handler app forwarded it raw.
export type HandlerUrl =
  | { readonly ok: true; readonly verb: string; readonly value: string }
  | { readonly ok: false; readonly problem: string };

// [LAW:dataflow-not-control-flow] Parse the URL into a {verb, value} pair
// without using `new URL`, which lowercases hosts (would mangle case-sensitive
// session ids). Format: cc-candybar://<verb>/<tail> | cc-candybar://<value>
// (bare → copy). The verb ends at the FIRST `/`; everything after is the raw
// value. The dispatch effect list rides as `dispatch/does=…&e=…`, so its query-
// style payload is just the tail — `?` is NOT a delimiter, it is ordinary data
// in a bare-copy value (`cc-candybar://hello?world` copies "hello?world").
//
// [LAW:single-enforcer] Only the VERB is decoded here. The value is passed RAW
// to admission, where the verb determines its argument layout. A
// whole-value decode here would
// un-escape structural separators inside a nested value — the exact hazard that
// made compound clicks unrepresentable — so it is deliberately absent.
export function parseHandlerUrl(rawUrl: string): HandlerUrl {
  const prefix = `${URL_SCHEME}://`;
  if (!rawUrl.startsWith(prefix)) {
    return { ok: false, problem: `expected a ${prefix} link, got: ${rawUrl}` };
  }
  const rest = rawUrl.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { ok: true, verb: VERB_COPY, value: rest };
  }
  const encoded = rest.slice(0, slash);
  try {
    return {
      ok: true,
      verb: decodeURIComponent(encoded),
      value: rest.slice(slash + 1),
    };
  } catch {
    return { ok: false, problem: `the link's verb is malformed: ${encoded}` };
  }
}

// [LAW:one-source-of-truth] The verbs whose handler splits its value into
// `/`-separated segments (decodeSegments); every other verb decodes its whole
// value as one argument (oneArg).
// It is what src/click/read.ts decodes a click's effects by, to describe them
// as the handler will read them; a handler that changes codec changes its row.
export const SEGMENTED_VERBS: ReadonlySet<string> = new Set([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_SAVE_THEME_DEFAULT,
  VERB_DELETE_PRESET,
  VERB_APPLY_LAYOUT_OP,
  VERB_UNDO,
  VERB_REDO,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_COPY_DIAGNOSTIC,
]);

// [LAW:types-are-the-program] Only copy and open carry no session of their own.
type GlobalVerb = typeof VERB_COPY | typeof VERB_OPEN_VSCODE;
export type SessionVerb = Exclude<EffectVerb, GlobalVerb>;

interface RejectedStep {
  readonly kind: "invalid";
  readonly reason: string;
}

export type GlobalStep =
  | RejectedStep
  | {
      readonly kind: "global";
      readonly verb: GlobalVerb;
      readonly value: string;
    };

export type ClickStep =
  | GlobalStep
  | {
      readonly kind: "session";
      readonly verb: Exclude<
        SessionVerb,
        typeof VERB_REPO_CONFIG | typeof VERB_RUN
      >;
      readonly args: readonly string[];
    }
  | {
      readonly kind: "repo-answer";
      readonly verb: typeof VERB_REPO_CONFIG;
      readonly dir: string;
      readonly answer: RepoAnswer;
    }
  | {
      readonly kind: "run";
      readonly verb: typeof VERB_RUN;
      readonly action: string;
      readonly capture: number;
    };

export type AdmittedClick =
  | {
      readonly scope: "global";
      readonly verb: string;
      readonly steps: readonly GlobalStep[];
    }
  | {
      readonly scope: "session";
      readonly verb: string;
      readonly session: SessionId;
      readonly steps: readonly ClickStep[];
    };

// [LAW:effects-at-boundaries] Only the click crosses into the renderer.
// Its capture index refers to evidence the host holds in this turn.
export interface ClickAdmission {
  readonly click: AdmittedClick;
  readonly runEvidence: readonly RunEvidence[];
}

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...Object.keys(SAYS),
  VERB_DISPATCH,
]);

function isEffectVerb(verb: string): verb is EffectVerb {
  return Object.hasOwn(SAYS, verb);
}

// [LAW:parse-dont-validate] A direct URL and a dispatch both become ordered
// steps. Only this boundary decodes the URL's arguments and admits its session.
// An invalid session cannot reach a renderer. An invalid argument after a
// valid session is that step's failure, so the bar can report it and the
// other steps still run in order.
export function admitClick(
  verb: string,
  value: string,
  signer: Pick<LinkSigner, "verify">,
): ClickAdmission {
  if (verb !== VERB_DISPATCH && !isEffectVerb(verb))
    throw new BadVerbArgs(`unknown click verb: ${verb}`);

  const raw = verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
  const global: GlobalStep[] = [];
  const runEvidence: RunEvidence[] = [];
  let scoped: { id: SessionId; steps: ClickStep[] } | undefined;

  for (const step of batchAdjacentWrites(raw)) {
    const name = step.verb;
    if (!isEffectVerb(name)) {
      (scoped?.steps ?? global).push({
        kind: "invalid",
        reason: `unknown effect verb "${name}"`,
      });
      continue;
    }
    if (name === VERB_COPY || name === VERB_OPEN_VSCODE) {
      try {
        (scoped?.steps ?? global).push({
          kind: "global",
          verb: name,
          value: decodeWire(() => decodeURIComponent(step.value)),
        });
      } catch (e) {
        if (!(e instanceof BadVerbArgs)) throw e;
        (scoped?.steps ?? global).push({
          kind: "invalid",
          reason: `${name}: ${e.message}`,
        });
      }
      continue;
    }

    // Back and Cancel take only the session as their whole value. The other
    // session verbs delimit arguments with slashes before percent decoding.
    const segmented = SEGMENTED_VERBS.has(name);
    const claimed = decodeWire(() =>
      segmented
        ? decodeFirstSegment(step.value)
        : decodeURIComponent(step.value),
    );
    if (scoped === undefined) {
      const parsed = parseSessionId(claimed);
      if (!parsed.ok) throw new BadVerbArgs(`session id ${parsed.problem}`);
      scoped = { id: parsed.id, steps: [...global] };
    } else if (scoped.id !== claimed) {
      throw new BadVerbArgs("a click cannot name more than one session");
    }

    const separator = segmented ? step.value.indexOf("/") : -1;
    try {
      const args =
        separator === -1
          ? []
          : decodeWire(() =>
              step.value
                .slice(separator + 1)
                .split("/")
                .map(decodeURIComponent),
            );
      switch (name) {
        case VERB_REPO_CONFIG:
          scoped.steps.push(admitRepoAnswer(scoped.id, args, signer));
          break;
        case VERB_RUN: {
          const [action = "", evaluated = "", mac = ""] = args;
          const capture = runEvidence.length;
          runEvidence.push({ session: scoped.id, action, evaluated, mac });
          scoped.steps.push({
            kind: "run",
            verb: name,
            action,
            capture,
          });
          break;
        }
        default:
          scoped.steps.push({ kind: "session", verb: name, args });
      }
    } catch (e) {
      if (!(e instanceof BadVerbArgs)) throw e;
      scoped.steps.push({ kind: "invalid", reason: `${name}: ${e.message}` });
    }
  }
  const click: AdmittedClick =
    scoped === undefined
      ? { scope: "global", verb, steps: global }
      : { scope: "session", verb, session: scoped.id, steps: scoped.steps };
  return { click, runEvidence };
}

// [LAW:parse-dont-validate] An outer signature is also given to authored URLs.
// Only a valid inner proof projects a repository answer into the typed event.
function admitRepoAnswer(
  session: SessionId,
  [dir = "", value = "", mac = ""]: readonly string[],
  signer: Pick<LinkSigner, "verify">,
): Extract<ClickStep, { kind: "repo-answer" }> {
  const answer = REPO_ANSWERS.find((known) => known === value);
  if (
    answer === undefined ||
    !signer.verify(repoAnswerFields(session, dir, answer), mac)
  ) {
    throw new BadVerbArgs(
      "the answer's signature does not match what it carries: it was not drawn by this daemon",
    );
  }
  return { kind: "repo-answer", verb: VERB_REPO_CONFIG, dir, answer };
}
