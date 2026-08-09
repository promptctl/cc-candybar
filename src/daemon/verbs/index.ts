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
import {
  listStateKeys,
  rangeParamsFor,
  validateStateWrite,
} from "./state-validators";
import {
  listConfigKeys,
  rangeParamsForConfig,
  validateConfigWrite,
} from "./config-validators";
import {
  clearConfigOverride,
  coerceGlobalsValue,
  isGlobalsField,
  loadConfigOverrides,
  writeConfigOverride,
} from "../config-overrides-store";
import { configOverridesPath } from "../paths";
import {
  decodeSegments,
  parseEffects,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
  VERB_LOAD_CONFIG,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
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

// [LAW:types-are-the-program] A single-argument verb (copy/open/toolbar/show-
// config) carries ONE argument: the WHOLE value, decoded once. It must NOT split
// on "/" the way the multi-arg set-state does — a single-arg value legitimately
// contains "/" (a copy of "a/b", an open path), and an old direct `copy/a/b`
// scrollback link would be truncated at the first slash if split. The verb's
// arity picks the codec: 1 arg → decode the whole tail; N args → decodeSegments.
// parseHandlerUrl no longer decodes the value, so the decode lives with the verb
// that knows its shape [LAW:single-enforcer].
function oneArg(value: string): string {
  return decodeWire(() => decodeURIComponent(value));
}

// [LAW:single-enforcer] One boundary reclassifies malformed wire encoding.
// percent-decoding untrusted wire input throws a raw URIError on a bad escape
// (`%ZZ`, a lone `%`); that is an argument-shape failure, not an operational
// one, so it must reach the dispatcher as BadVerbArgs (→ BAD_REQUEST) like every
// other bad-input shape. Both verb codecs (single-arg whole-value, multi-seg
// set-state) funnel their decode through here so the reclassification lives once.
function decodeWire<T>(decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (err instanceof URIError)
      throw new BadVerbArgs(`malformed wire encoding: ${err.message}`);
    throw err;
  }
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
//   decodes each segment — a CODEC property: a `/` inside a segment rides as
//   `%2F` and is never read as a separator, so the wire itself is slash-safe.
//   This is NOT an end-to-end "slash-bearing state keys are supported" claim:
//   the loader and the state-validator factories reject slash-bearing keys and
//   option values upstream, so a slash never reaches here in practice. The N=1
//   form is the degenerate single-pair case — the parser walks pairs uniformly.
const setState: VerbHandler = (rawValue, ctx) => {
  // [LAW:single-enforcer] Decode the whole encoded tail at this boundary; the
  // session id is the head, the rest are the (key,value) pairs. A malformed
  // escape in any segment is bad input, not a handler failure (decodeWire).
  const [sessionId = "", ...rest] = decodeWire(() => decodeSegments(rawValue));
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

// [LAW:single-enforcer] One integer-shape boundary, mirroring the range
// validator's canonical `^-?\d+$`: the `by` delta and a stored current value are
// integers or they are not values. Only an integer-shaped stored value is a
// current value; absence (or a non-integer) is the genuine "unset" state, seeded
// from the registry's configured default.
const STEP_INT_RE = /^-?\d+$/;

// [LAW:no-ambient-temporal-coupling] Stepping past a bound WRAPS to the other end
// — the navigation owner is THIS handler (moved off the render side, which is no
// longer the timing authority for the value). The range gate still owns the
// [min,max] CLAMP; wrap is navigation, clamp is enforcement.
function wrapStep(n: number, min: number, max: number): number {
  return n > max ? min : n < min ? max : n;
}

// [LAW:one-source-of-truth] A RELATIVE nudge to a bounded state key. The link
// carries ONLY the irreducible intent `[sessionId, key, by]` (no `current`
// snapshot), so the SAME link string fires every render and N rapid clicks each
// re-read live state and accumulate — the idempotent absolute-write bug is gone.
// The absolute target is computed HERE: read the live value (seed an unset key
// from the registry's configured default, NOT silently from min), wrap by the
// signed delta against the registry's bounds, then route the result through
// validateStateWrite so the one range gate owns the [min,max] clamp and the
// canonical decimal form that persists.
const stepState: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", byRaw = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      "step-state: <key> is required (shape: <sessionId>/<key>/<by>)",
    );
  }
  if (!STEP_INT_RE.test(byRaw)) {
    throw new BadVerbArgs(
      `step-state: delta must be an integer, got "${byRaw}"`,
    );
  }
  const by = parseInt(byRaw, 10);
  // [LAW:no-silent-fallbacks] A key with no range registration is not a stepper —
  // reject loudly rather than fabricate bounds or silently no-op.
  const params = rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-state: key "${key}" is not a bounded (range) state key ` +
        `(have keys: ${listStateKeys().join(", ")})`,
    );
  }
  // [LAW:no-defensive-null-guards] "unset" is a real state — seed from the
  // configured default; only an integer-shaped stored value is a current value.
  const stored = ctx.sessionState.get(sid, key);
  const current =
    stored && STEP_INT_RE.test(stored)
      ? Math.max(params.min, Math.min(params.max, parseInt(stored, 10)))
      : params.seed;
  const next = wrapStep(current + by, params.min, params.max);
  const result = validateStateWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-state: ${result.reason}`);
  ctx.sessionState.set(sid, key, result.value);
  ctx.dlog(
    "info",
    `step-state: ${key} ${current}→${result.value} (by ${by}, session=${sid})`,
  );
};

// [LAW:no-defensive-null-guards] validateConfigWrite already proved `key` is
// a registered config-writable key and `key`'s registration only ever comes
// from config-validators.ts's deriveConfigActionValidators, which reads the
// key from a `persist` action's own `.persist` field — a value the action
// LOADER (loader/actions.ts) validated is a real Globals field name at
// config-load time (via the SAME isGlobalsField check). So a validated write
// reaching here is a real Globals field by construction; this assertion is
// the type-narrowing boundary, not a runtime possibility.
function assertGlobalsField(
  key: string,
): asserts key is Parameters<typeof coerceGlobalsValue>[0] {
  if (!isGlobalsField(key)) {
    throw new Error(
      `set-config: "${key}" validated as a config-writable key but is not a ` +
        `Globals field — registration/loader invariant broken`,
    );
  }
}

// [LAW:single-enforcer] `persist`'s twin of setState: the SAME validate-then-
// write shape, writing through config-overrides-store instead of
// SessionState. The write is DURABLE — RenderCache's file watcher on
// configOverridesPath() (src/daemon/cache/render.ts) picks it up on the next
// reload, exactly as an edit to the hand-authored config file would.
// [LAW:no-silent-fallbacks] Unknown key or out-of-domain value is a loud
// BAD_REQUEST — the SAME gate `set-state` uses (validateConfigWrite),
// derived from the SAME action table (deriveConfigActionValidators).
const setConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", incoming = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      `set-config: <key>/<value> is required (have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  const result = validateConfigWrite(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-config: ${result.reason}`);
  assertGlobalsField(key);
  const typed = coerceGlobalsValue(key, result.value);
  writeConfigOverride(configOverridesPath(), key, typed, ctx.dlog);
  ctx.dlog("info", `set-config: ${key}=${result.value} (session=${sid})`);
};

// [LAW:one-source-of-truth] `persist`'s twin of stepState: a RELATIVE nudge
// against the current override (or the merged config's own value when
// unset — rangeParamsForConfig's seed), wrapped and re-validated through the
// SAME range gate, then written durably.
const stepConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", byRaw = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      "step-config: <key> is required (shape: <sessionId>/<key>/<by>)",
    );
  }
  if (!STEP_INT_RE.test(byRaw)) {
    throw new BadVerbArgs(
      `step-config: delta must be an integer, got "${byRaw}"`,
    );
  }
  const by = parseInt(byRaw, 10);
  const params = rangeParamsForConfig(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  assertGlobalsField(key);
  const overrides = loadConfigOverrides(configOverridesPath(), ctx.dlog);
  const stored = overrides[key];
  const current =
    typeof stored === "number"
      ? Math.max(params.min, Math.min(params.max, stored))
      : params.seed;
  const next = wrapStep(current + by, params.min, params.max);
  const result = validateConfigWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-config: ${result.reason}`);
  const typed = coerceGlobalsValue(key, result.value);
  writeConfigOverride(configOverridesPath(), key, typed, ctx.dlog);
  ctx.dlog(
    "info",
    `step-config: ${key} ${current}→${result.value} (by ${by}, session=${sid})`,
  );
};

// [LAW:one-source-of-truth] The gated undo for `persist`: clears one
// config-overrides key, restoring the user-file/bundled-default value on the
// next reload. Gated by key MEMBERSHIP (listConfigKeys) rather than a value
// domain — there is no value to validate, only a legitimate target to clear.
const resetConfig: VerbHandler = (value, ctx) => {
  const [sessionId = "", key = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  if (!key || !listConfigKeys().includes(key)) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${key}" (have: ${listConfigKeys().join(", ")})`,
    );
  }
  clearConfigOverride(configOverridesPath(), key, ctx.dlog);
  ctx.dlog("info", `reset-config: ${key} (session=${sid})`);
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
// [LAW:effects-at-boundaries] Per-session config override stored in SessionState.
// Wire value: `<sessionId>/<percent-encoded-path>`. An empty path clears the
// override, restoring the request-derived config for that session only.
// Split at the FIRST slash — the session ID is slash-free (requireSessionId),
// and the path contains slashes that must not be split.
// [LAW:no-silent-failure] Path validation is at the verb boundary so a bad path
// fails the click (BAD_REQUEST), not the next render.
export const SESSION_CONFIG_OVERRIDE_KEY = "config-override";
const loadConfig: VerbHandler = (value, ctx) => {
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new BadVerbArgs(
      "load-config: expected <sessionId>/<path> (missing separator)",
    );
  }
  const sid = requireSessionId(
    decodeWire(() => decodeURIComponent(value.slice(0, slash))),
  );
  const p = decodeWire(() => decodeURIComponent(value.slice(slash + 1))).trim();
  if (p !== "") {
    if (!p.startsWith("/")) {
      throw new BadVerbArgs(`load-config: path must be absolute, got "${p}"`);
    }
    if (!/\.(json5?|json)$/.test(p)) {
      throw new BadVerbArgs(
        `load-config: path must end with .json5 or .json, got "${p}"`,
      );
    }
  }
  if (p === "") {
    ctx.sessionState.clear(sid, SESSION_CONFIG_OVERRIDE_KEY);
    ctx.dlog("info", `load-config: override cleared (session=${sid})`);
  } else {
    ctx.sessionState.set(sid, SESSION_CONFIG_OVERRIDE_KEY, p);
    ctx.dlog("info", `load-config: ${p} (session=${sid})`);
  }
};

const LEAF_VERBS = new Map<string, VerbHandler>([
  [VERB_COPY, copy],
  [VERB_LOAD_CONFIG, loadConfig],
  [VERB_OPEN_VSCODE, openVscode],
  [VERB_SET_STATE, setState],
  [VERB_STEP_STATE, stepState],
  [VERB_SET_CONFIG, setConfig],
  [VERB_STEP_CONFIG, stepConfig],
  [VERB_RESET_CONFIG, resetConfig],
  [VERB_SHOW_CONFIG_ERROR, showConfigError],
  [VERB_SHOW_CONFIG_WARNING, showConfigWarning],
  [VERB_TOOLBAR_TOGGLE, toolbarToggle],
]);

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects; the
// dispatcher folds the list, running EVERY effect through the leaf table. The
// effect count is data — N=1 and N=100 walk the identical loop, no plain-vs-
// compound branch. [LAW:no-silent-fallbacks] Every effect runs even if an
// earlier one failed; failures accumulate in `errors`. An unknown or
// non-leaf (e.g. nested `dispatch`) verb is a miss in LEAF_VERBS — reported,
// never executed.
//
// [LAW:types-are-the-program] The aggregate PRESERVES the dispatcher's
// input-vs-operational error classification: a leaf throws BadVerbArgs for bad
// input (→ BAD_REQUEST) and a plain Error for an operational failure (e.g. a
// pbcopy/open launch failure → RENDER_FAILED). If ANY effect failed
// operationally, the whole click failed operationally (plain Error); only when
// every failure is an input error does the aggregate stay BadVerbArgs. An
// unknown verb is bad input — it does not flip the classification.
//
// [LAW:one-source-of-truth] Per-effect errors are written to session state
// under 'click.error' so the next render shows WHICH effect(s) failed in the
// bar transiently (one render, then cleared). Only possible when a session ID
// is available from a set-state or toolbar-toggle effect in the same click.
const dispatch: VerbHandler = (rawValue, ctx) => {
  const errors: string[] = [];
  let operational = false;
  let sessionId: string | null = null;
  for (const { verb, value } of parseEffects(rawValue)) {
    // Extract session ID from the first session-bearing effect for error display.
    // set-state, step-state, set-config, step-config, reset-config, and
    // toolbar-toggle all carry the session id as their first segment, so a
    // failing step surfaces in the bar like any other.
    if (
      !sessionId &&
      (verb === VERB_SET_STATE ||
        verb === VERB_STEP_STATE ||
        verb === VERB_SET_CONFIG ||
        verb === VERB_STEP_CONFIG ||
        verb === VERB_RESET_CONFIG ||
        verb === VERB_TOOLBAR_TOGGLE)
    ) {
      const parts = decodeSegments(value);
      if (parts.length > 0 && parts[0]) sessionId = parts[0];
    }
    const handler = LEAF_VERBS.get(verb);
    if (!handler) {
      errors.push(`unknown effect verb "${verb}"`);
      continue;
    }
    try {
      handler(value, ctx);
    } catch (e) {
      if (!(e instanceof BadVerbArgs)) operational = true;
      errors.push(`${verb}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length > 0) {
    if (sessionId) {
      ctx.sessionState.set(sessionId, "click.error", errors.join("\n"));
    }
    const message = `dispatch: ${errors.join("; ")}`;
    throw operational ? new Error(message) : new BadVerbArgs(message);
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
