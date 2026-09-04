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
  applyLayoutOp as applyLayoutOpToFile,
  deleteValue,
  readValue,
  redoEdit,
  undoEdit,
  writeValue,
  type EditStore,
} from "../config-file-store";
import { configEditHistoryPath } from "../paths";
import { durableConfigPath } from "../../config/loader/discovery";
import { decodeLayoutOp } from "../../config/layout-ops";
import {
  decodeSegments,
  parseEffects,
  VERB_APPLY_LAYOUT_OP,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
  VERB_LOAD_CONFIG,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
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

import { BadVerbArgs } from "../verb-error";
export { BadVerbArgs };

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

// [LAW:no-ambient-temporal-coupling] The RELEASE half of a durable write, run
// by the durable handlers themselves AFTER their own write succeeded — never
// as a separate effect beside them.
//
// A dual-destination control commits "make this the durable default AND stop
// overriding it in this session". Those are one intent, and the session half
// is destructive: dropping the session pick is only correct if the durable
// value actually landed. Emitted as two effects, `dispatch` would run the
// clear even when the persist failed (it runs every effect in a click by
// design, for independent ones like "write value + close menu") — wiping the
// user's pick with nothing durable in its place, a lost update whose error
// message would not even mention it. Ordering that matters belongs inside one
// handler, not in a hope about the dispatcher.
//
// Gated by key MEMBERSHIP (listStateKeys), exactly as reset-config is over the
// config keyspace: there is no value to validate, only a legitimate target to
// clear. Absent segment = nothing to release, which is every ordinary persist
// click [LAW:dataflow-not-control-flow].
// [LAW:no-ambient-temporal-coupling] The release key is checked BEFORE the
// durable write and cleared AFTER it — one handler owns that order. A dual's
// `set` half renamed by a reload between render and click would otherwise
// refuse only after the file had already changed: a click reported failed
// whose write landed, with the session pick left shadowing the new default.
function parseRelease(release: string, verb: string): string | null {
  if (!release) return null;
  if (!listStateKeys().includes(release)) {
    throw new BadVerbArgs(
      `${verb}: unknown session key "${release}" to release (have: ${listStateKeys().join(", ")})`,
    );
  }
  return release;
}

function releaseSessionKey(
  release: string | null,
  sid: string,
  ctx: VerbContext,
  verb: string,
): void {
  if (release === null) return;
  ctx.sessionState.clear(sid, release);
  ctx.dlog("info", `${verb}: released session key ${release} (session=${sid})`);
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

// ─── The durable store: which file, and the history over it ─────────────────

// [LAW:one-source-of-truth] The config FILE is the one durable store
// (candybar-config-dqe). A click carries only a session id, so the render
// records — under this daemon-internal key, the SESSION_CONFIG_OVERRIDE_KEY
// precedent — the INPUTS its config resolution ran on, and a durable verb
// runs the same resolution over them at click time (durableConfigPath). The
// file it lands in is the one the NEXT reload reads, not a snapshot of the
// one the last render read: RenderCache re-resolves the same chain whenever
// a candidate appears (a higher-precedence file supersedes a lower one), so
// a recorded resolved path would be a second clock — a write to a file the
// bar has already stopped reading. No re-derivation from the daemon's own
// cwd either, which describes whichever shell spawned it.
export const SESSION_RENDER_ORIGIN_KEY = "render-origin";

// [LAW:types-are-the-program] Exactly the three inputs resolveDslConfigPath
// takes. `configFile` is the session's explicit override (`--config` or a
// load-config pick) or null.
export interface RenderOrigin {
  readonly projectDir: string;
  readonly cwd: string;
  readonly configFile: string | null;
}

export function encodeRenderOrigin(origin: RenderOrigin): string {
  return JSON.stringify(origin);
}

// [LAW:parse-dont-validate] The one boundary that lifts the stored string
// back into a RenderOrigin; a wrong shape is a loud BadVerbArgs, never a
// guessed path.
function parseRenderOrigin(raw: string): RenderOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadVerbArgs(`render origin is not JSON: ${raw}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BadVerbArgs(`render origin is not an object: ${raw}`);
  }
  const { projectDir, cwd, configFile } = parsed as Record<string, unknown>;
  if (
    typeof projectDir !== "string" ||
    typeof cwd !== "string" ||
    (configFile !== null && typeof configFile !== "string")
  ) {
    throw new BadVerbArgs(`render origin has the wrong shape: ${raw}`);
  }
  return { projectDir, cwd, configFile };
}

// [LAW:no-silent-failure] A session that has never rendered has no origin
// and therefore no file to write — a loud BadVerbArgs, not the daemon's
// own XDG guess.
function sessionConfigFile(ctx: VerbContext, sid: string): string {
  const raw = ctx.sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
  if (raw === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no config file to write`,
    );
  }
  const origin = parseRenderOrigin(raw);
  return durableConfigPath(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
}

function editStore(ctx: VerbContext): EditStore {
  return { historyPath: configEditHistoryPath(), logger: ctx.dlog };
}

// [LAW:single-enforcer] `persist`'s twin of setState: the SAME validate-then-
// write shape, writing into the session's config file instead of
// SessionState. The write is DURABLE — RenderCache's watcher on that file
// (src/daemon/cache/render.ts) picks it up on the next reload, exactly as a
// hand edit would; the two are indistinguishable by design.
// [LAW:no-silent-fallbacks] Unknown key or out-of-domain value is a loud
// BAD_REQUEST — the SAME gate `set-state` uses (validateConfigWrite),
// derived from the SAME action table (deriveConfigActionValidators).
const setConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", incoming = "", release = ""] = decodeWire(
    () => decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      `set-config: <key>/<value> is required (have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  const result = validateConfigWrite(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-config: ${result.reason}`);
  const releaseKey = parseRelease(release, "set-config");
  const file = sessionConfigFile(ctx, sid);
  writeValue(editStore(ctx), file, key, result.value);
  ctx.dlog(
    "info",
    `set-config: ${key}=${result.value} → ${file} (session=${sid})`,
  );
  releaseSessionKey(releaseKey, sid, ctx, "set-config");
};

// [LAW:one-source-of-truth] `persist`'s twin of stepState: a RELATIVE nudge
// against the value the file declares (or the merged config's own value when
// it declares none — rangeParamsForConfig's seed), wrapped and re-validated
// through the SAME range gate, then written durably.
const stepConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", byRaw = "", release = ""] = decodeWire(() =>
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
  const releaseKey = parseRelease(release, "step-config");
  const params = rangeParamsForConfig(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  const stored = readValue(file, key);
  const current =
    typeof stored === "number"
      ? Math.max(params.min, Math.min(params.max, stored))
      : params.seed;
  const next = wrapStep(current + by, params.min, params.max);
  const result = validateConfigWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-config: ${result.reason}`);
  writeValue(editStore(ctx), file, key, result.value);
  ctx.dlog(
    "info",
    `step-config: ${key} ${current}→${result.value} (by ${by}) → ${file} (session=${sid})`,
  );
  releaseSessionKey(releaseKey, sid, ctx, "step-config");
};

// [LAW:one-source-of-truth] `reset`: delete the key's path from the session's
// config file, so the next reload falls back to the bundled default (or,
// for a preset root, the config's own root). Gated by key MEMBERSHIP
// (listConfigKeys) rather than a value domain — there is no value to
// validate, only a legitimate target to clear.
const resetConfig: VerbHandler = (value, ctx) => {
  const [sessionId = "", key = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  if (!key || !listConfigKeys().includes(key)) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${key}" (have: ${listConfigKeys().join(", ")})`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  deleteValue(editStore(ctx), file, key);
  ctx.dlog("info", `reset-config: ${key} ← ${file} (session=${sid})`);
};

// [LAW:one-source-of-truth] brandon-layout-edit-2gc.1's structural edit:
// the validated op token is applied ONCE, to the authored tree in the
// session's config file (config-file-store.ts over json5-edit.ts), so the
// file IS the edited layout and its comments survive. Gated by the SAME
// allow-list machinery setConfig uses (validateConfigWrite, derived from a
// config's declared removeSegment/insertSegment actions) — an op token no
// action declares is a loud BAD_REQUEST. [LAW:parse-dont-validate] The
// gate proves the VALUE is one an action allows; decodeLayoutOp stamps its
// shape, and the store proves the KEY is a preset-root target — a globals
// or segment-palette key smuggled through this verb is refused there.
const applyLayoutOp: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", opToken = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      `apply-layout-op: <key>/<op> is required (have: ${listConfigKeys().join(", ")})`,
    );
  }
  const result = validateConfigWrite(key, opToken);
  if (!result.ok) throw new BadVerbArgs(`apply-layout-op: ${result.reason}`);
  const op = decodeLayoutOp(result.value);
  if (op === null) {
    throw new BadVerbArgs(
      `apply-layout-op: "${result.value}" is not a layout op token`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  applyLayoutOpToFile(editStore(ctx), file, key, op);
  ctx.dlog(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${file} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] `reset`'s fine-grained sibling: step the history
// of edits to the session's config file back one entry — the file the
// session's render resolved, so one project's undo can never revert a write
// made to another's. No key, no value — the history (config-file-store.ts)
// owns which entry moves and what it restores; this handler is pure plumbing
// between the wire and it.
// [LAW:no-silent-failure] An empty stack is a loud BAD_REQUEST (dispatch's
// aggregator turns it into a transient click.error), never a silent no-op —
// the ticket's own done-gate. A file hand-edited since the entry is a loud
// refusal from the store, surfaced the same way.
const undoConfig: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const file = sessionConfigFile(ctx, sid);
  if (undoEdit(editStore(ctx), file) === null) {
    throw new BadVerbArgs("undo: history is empty, nothing to undo");
  }
  ctx.dlog("info", `undo: ${file} (session=${sid})`);
};

// [LAW:one-source-of-truth] undo's mirror — steps the same history forward
// one entry.
const redoConfig: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const file = sessionConfigFile(ctx, sid);
  if (redoEdit(editStore(ctx), file) === null) {
    throw new BadVerbArgs("redo: nothing to redo");
  }
  ctx.dlog("info", `redo: ${file} (session=${sid})`);
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
  [VERB_APPLY_LAYOUT_OP, applyLayoutOp],
  [VERB_UNDO, undoConfig],
  [VERB_REDO, redoConfig],
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
    // set-state, step-state, set-config, step-config, reset-config,
    // apply-layout-op, undo, redo, and toolbar-toggle all carry the session id
    // as their first segment, so a failing step surfaces in the bar like any
    // other.
    if (
      !sessionId &&
      (verb === VERB_SET_STATE ||
        verb === VERB_STEP_STATE ||
        verb === VERB_SET_CONFIG ||
        verb === VERB_STEP_CONFIG ||
        verb === VERB_RESET_CONFIG ||
        verb === VERB_APPLY_LAYOUT_OP ||
        verb === VERB_UNDO ||
        verb === VERB_REDO ||
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
