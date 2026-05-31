// [LAW:single-enforcer] One registry that maps click verb names to their
// handlers. Adding a new verb is one entry — no branching in handleClick,
// no scattered if/else in server.ts. The dispatcher does table lookup
// only; verb semantics live in the per-verb handler functions.
//
// [LAW:dataflow-not-control-flow] The verb is data, the lookup is data;
// the dispatcher runs the same operation every call (find handler, invoke
// it). Variability lives entirely in the verb-name argument and in the
// per-verb handler body — never in whether dispatch happens.
//
// [LAW:one-source-of-truth] The verb table is the single canonical list of
// click verbs in the daemon. Tests assert against this table directly so
// the live registry and the test enumeration cannot drift.
//
// Multi-arg verbs (set-state) carry their args as a single slash-delimited
// `value` string on the wire — keeping ClickRequest shape-stable at
// protocol v3 ({verb, value}). The per-verb handler parses its own value
// into the typed args it needs. URL format mirrors:
//   cc-candybar://<verb>/<value>   where <value> may itself contain `/`.

import { launchSync } from "../../proc/launch";
import type { SessionStateRW } from "../session-state";
import { listStateKeys, validateStateWrite } from "./state-validators";
import {
  decodeSegments,
  parseEffects,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
  VERB_SET_STATE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_TOOLBAR_TOGGLE,
} from "../../click/wire";

export interface VerbContext {
  readonly sessionState: SessionStateRW;
  readonly dlog: (level: "info" | "warn" | "error", msg: string) => void;
}

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// raw wire-level `value` string and the daemon's verb context; it returns
// nothing (clicks have no payload). User-facing failures throw an Error;
// the dispatcher in server.ts converts that to a RENDER_FAILED response.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error which the dispatcher surfaces as BAD_REQUEST.
export type VerbHandler = (value: string, ctx: VerbContext) => void;

// [LAW:types-are-the-program] Argument-shape failures are structurally
// distinct from operational failures. The dispatcher uses `instanceof` to
// route BadVerbArgs to BAD_REQUEST and any other Error to RENDER_FAILED.
export class BadVerbArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadVerbArgs";
  }
}

// ─── Argument decoders ───────────────────────────────────────────────────────

// [LAW:single-enforcer] One place that validates "this string is a usable
// session id." A session id has come from an untrusted URL; rejecting `/`
// and `..` keeps it usable as a key in the SessionState map and forbids
// path-traversal through any downstream code that ever joins it with fs
// paths (the legacy flag-file path, now removed, was the original reason).
function requireSessionId(value: string): string {
  if (!value) throw new BadVerbArgs("session id is required");
  if (value.includes("/") || value.includes(".."))
    throw new BadVerbArgs(`invalid session id "${value}"`);
  return value;
}

// [LAW:single-enforcer] A single-segment verb (copy/open/toolbar/show-config)
// carries one percent-encoded segment as its value; decode it here, at the
// verb's boundary. Absent (empty value) yields "" — the degenerate case, parsed
// not guarded. parseHandlerUrl no longer decodes the value, so the decode lives
// with the verb that knows its shape [LAW:one-source-of-truth].
function oneArg(value: string): string {
  return decodeSegments(value)[0] ?? "";
}

// ─── Verb handlers ───────────────────────────────────────────────────────────

// [LAW:single-enforcer] One clipboard primitive, no decode — both the `copy`
// verb (decodes a wire segment) and the diagnostic verbs (already hold a plain
// message) funnel here so the launch + rate-limit handling lives in one place.
function pbcopy(text: string, ctx: VerbContext): void {
  const result = launchSync({
    bin: "/usr/bin/pbcopy",
    stdinInput: text,
    category: "click.pbcopy",
  });
  // [LAW:dataflow-not-control-flow] Rate-limit rejection is one outcome among
  // many — the click is acknowledged and the rejection is logged. Other
  // failures are genuine errors that surface as RENDER_FAILED.
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      ctx.dlog("warn", `click.pbcopy rate-limited: ${result.error ?? ""}`);
      return;
    }
    throw new Error(
      `pbcopy failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
}

const copy: VerbHandler = (value, ctx) => pbcopy(oneArg(value), ctx);

const openVscode: VerbHandler = (value, ctx) => {
  const result = launchSync({
    bin: "/usr/bin/open",
    args: ["-a", "Visual Studio Code", oneArg(value)],
    category: "click.open",
  });
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      ctx.dlog("warn", `click.open rate-limited: ${result.error ?? ""}`);
      return;
    }
    throw new Error(
      `open -a "Visual Studio Code" failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
};

// Click on the ⚠ in the bar copies the parse error to clipboard.
const showConfigError: VerbHandler = (value, ctx) => pbcopy(oneArg(value), ctx);

// [LAW:one-type-per-behavior] Warnings (advisory diagnostics — e.g. config
// extension collision) and errors (load-fatal) are surfaced as distinct
// icons in the bar so the operator can tell them apart at a glance. The
// click behavior is the same — copy the message — but the diagnostic
// categories are kept in separate channels through the render pipeline.
const showConfigWarning: VerbHandler = (value, ctx) =>
  pbcopy(oneArg(value), ctx);

// [LAW:one-source-of-truth] SessionState is the canonical store for
// toolbar-expanded state (eir merge). Toggle via set/clear; the file-backed
// storage owned by the daemon process persists the change automatically.
const toolbarToggle: VerbHandler = (value, ctx) => {
  const sessionId = requireSessionId(oneArg(value));
  const expanded = ctx.sessionState.get(sessionId, "toolbar-expanded");
  if (expanded) ctx.sessionState.clear(sessionId, "toolbar-expanded");
  else ctx.sessionState.set(sessionId, "toolbar-expanded", "1");
};

// [LAW:single-enforcer] One verb writes SessionState — for every
// registered key, for every pair in a batch. The per-key validator
// registry in ./state-validators.ts is the single place that decides
// what is a legal value for a given key; the body here is residue:
// split args into pairs, validate each, write atomically, log.
//
// [LAW:dataflow-not-control-flow] The key is data flowing across the
// boundary, not a discriminator that selects between verb handlers.
// The pair count is data too — N=1 (single write) is the degenerate
// form of the N≥2 batch; the parser walks pairs uniformly. A new
// state-writable key is a registry row, not a new verb; a multi-write
// click (e.g. menu action that writes the chosen value AND collapses
// the menu) is one URL with multiple pairs, not multiple URLs.
//
// [LAW:types-are-the-program] The validator returns a discriminated
// `ValidateResult`. The body cannot fabricate a value (the `ok: true`
// branch's `value` is the only thing it may write) and cannot proceed
// on `ok: false` (it throws BadVerbArgs with the reason verbatim,
// naming the failing pair so the operator can localize the typo). The
// dispatcher in server.ts maps BadVerbArgs to BAD_REQUEST.
//
// [LAW:no-silent-fallbacks] Batch atomicity: every pair is validated
// BEFORE any write happens. Any single failure rejects the whole
// batch — no half-applied state, no "first three writes landed and
// the fourth failed." A widget click is one transactional intent;
// partial application would leave the UI in a state no author wrote.
//
// Value shape (the raw tail after the verb): the percent-encoded segment run
//   <sessionId>/<k1>/<v1>[/<k2>/<v2>/...]. decodeSegments splits on `/` and
//   decodes each segment, so a key or value containing `/` round-trips intact
//   (it rides as `%2F`, never read as a separator). The N=1 form is the
//   degenerate single-pair case — the parser walks pairs uniformly.
const setState: VerbHandler = (rawValue, ctx) => {
  // [LAW:single-enforcer] Decode the whole encoded tail at this boundary; the
  // session id is the head, the rest are the (key,value) pairs.
  const [sessionId = "", ...rest] = decodeSegments(rawValue);
  const sid = requireSessionId(sessionId);
  if (rest.length === 0)
    throw new BadVerbArgs(
      `set-state: <key>/<value> is required (have keys: ${listStateKeys().join(", ")})`,
    );
  // [LAW:dataflow-not-control-flow] The pair count emerges from the data. The
  // loop walks the same path for N=1 and N=K — no branch on "is this a batch."
  if (rest.length % 2 !== 0) {
    throw new BadVerbArgs(
      `set-state: expected even-count <key>/<value> pairs, got ${rest.length} ` +
        `segment(s) after session id (have keys: ${listStateKeys().join(", ")})`,
    );
  }
  // [LAW:types-are-the-program] Validate the entire batch before any
  // write. The "validated pairs" array IS the proof that every write
  // about to happen is legal — once it's built, the write loop is
  // forced (no branches, no failures possible).
  const validated: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const incoming = rest[i + 1]!;
    // [LAW:types-are-the-program] An empty key is a structural error
    // (missing segment), not a semantic one (validator rejection of an
    // unknown key). Routing it to the unknown-key validator message
    // ("unknown state key \"\"") would mislead the operator about
    // where their mistake was. Catch it here, name the pair index so
    // batches are localizable.
    if (!key) {
      throw new BadVerbArgs(
        `set-state: empty key at pair ${i / 2 + 1} ` +
          `(expected <sessionId>/<key>/<value>[/<key>/<value>...] segments)`,
      );
    }
    const result = validateStateWrite(key, incoming);
    if (!result.ok) {
      throw new BadVerbArgs(`set-state: pair ${i / 2 + 1}: ${result.reason}`);
    }
    validated.push({ key, value: result.value });
  }
  // [LAW:single-enforcer] One write call, one log line format. setBatch
  // is the seam that owns reactive atomicity — every pair lands before
  // observers fire, so an autorun never sees half-applied batch state.
  // Partial application is unrepresentable: validation already passed,
  // and the seam guarantees the writes ship as one transaction.
  ctx.sessionState.setBatch(sid, validated);
  const summary = validated.map((p) => `${p.key}=${p.value}`).join(" ");
  ctx.dlog("info", `set-state: ${summary} (session=${sid})`);
};

// ─── Registry ───────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The LEAF verbs — every click effect that does real
// work. `dispatch` (below) is NOT here: it folds an effect list back through
// THIS map, so a dispatch effect can never resolve to dispatch and nesting is
// structurally impossible [LAW:types-are-the-program] — no recursion guard, the
// shape forbids it.
//
// [LAW:types-are-the-program] `Map` is the dispatch type whose lookup is
// `(verb) → VerbHandler | undefined` with no prototype chain. The wire-level
// `verb` field is untrusted input; a `__proto__` or `constructor` value over a
// plain object would be a truthy hit on Object.prototype that then throws on
// invocation (RENDER_FAILED instead of BAD_REQUEST). Map makes the wrong
// dispatch unrepresentable, matching src/daemon/session-state.ts.
const LEAF_VERBS = new Map<string, VerbHandler>([
  [VERB_COPY, copy],
  [VERB_OPEN_VSCODE, openVscode],
  [VERB_SET_STATE, setState],
  [VERB_SHOW_CONFIG_ERROR, showConfigError],
  [VERB_SHOW_CONFIG_WARNING, showConfigWarning],
  [VERB_TOOLBAR_TOGGLE, toolbarToggle],
]);

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects; the
// dispatcher folds the list, running EVERY effect through the leaf table. The
// effect count is data — N=1 and N=100 walk the identical loop, no plain-vs-
// compound branch. [LAW:no-silent-fallbacks] Every effect runs even if an
// earlier one failed; failures accumulate and surface as ONE aggregated error
// (temporary per-effect error display is a follow-up). An unknown or
// non-leaf (e.g. nested `dispatch`) verb is a miss in LEAF_VERBS — reported,
// never executed.
const dispatch: VerbHandler = (rawValue, ctx) => {
  const errors: string[] = [];
  for (const { verb, value } of parseEffects(rawValue)) {
    const handler = LEAF_VERBS.get(verb);
    if (!handler) {
      errors.push(`unknown effect verb "${verb}"`);
      continue;
    }
    try {
      handler(value, ctx);
    } catch (e) {
      errors.push(`${verb}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length > 0) {
    throw new BadVerbArgs(`dispatch: ${errors.join("; ")}`);
  }
};

// [LAW:one-source-of-truth] The full dispatch table the daemon looks up against:
// every leaf verb plus the one `dispatch` wrapper. Old scrollback links that
// name a leaf verb directly still resolve here; new renders all emit `dispatch`.
export const VERBS: ReadonlyMap<string, VerbHandler> = new Map<
  string,
  VerbHandler
>([...LEAF_VERBS, [VERB_DISPATCH, dispatch]]);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];
