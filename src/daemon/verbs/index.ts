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
  stateKeySeed,
  validateStateWrite,
} from "./state-validators";
import {
  configKeySeed,
  listConfigKeys,
  rangeParamsForConfig,
  validateConfigWrite,
} from "./config-validators";
import type { RangeParams } from "./validator-registry";
import {
  applyLayoutOp as applyLayoutOpToFile,
  deletePreset as deletePresetFromFile,
  deleteValues,
  readValue,
  writePreset,
  writeDrafts,
  writeValues,
  type EditStore,
} from "../config-file-store";
import {
  describeStep,
  type Journal,
  type SettingsHistory,
} from "../settings-history";
import type { NavigationHistory } from "../navigation-history";
import { durableConfigPath } from "../../config/loader/discovery";
import {
  placementId,
  settingSpelling,
  walkNodes,
  type DslConfig,
  type Globals,
  type SegmentNode,
} from "../../config/dsl-types";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  PLACEMENT_DRAFT_NS,
} from "../../config/loader/edit-mode";
import { ident } from "../../config/ident";
import {
  durableLanding,
  placementDrafts,
  placementPickProblems,
  presetSnapshot,
  type PlacementDraft,
  resetLayers,
  settingDrafts,
} from "../setting-drafts";
import {
  SETTING_PROJECTIONS,
  SETTINGS,
} from "../../config/setting-projections";
import { decodeLayoutOp } from "../../config/layout-ops";
import { presetNames, presetRoot } from "../../config/presets";
import {
  decodeSegments,
  batchAdjacentWrites,
  parseEffects,
  VERB_APPLY_LAYOUT_OP,
  VERB_APPLY_UPDATE,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
  VERB_LOAD_CONFIG,
  VERB_REDO,
  VERB_BACK,
  VERB_REWIND,
  VERB_RESET_CONFIG,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_DELETE_PRESET,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  VERB_CEILING,
  VERB_SLASH,
} from "../../click/wire";
import {
  ceilingMoveArgs,
  type CeilingAction,
  type SlashAction,
} from "../../config/action";
import type { CeilingMove } from "../../memento/edge";
import type { MementoProvider } from "../../segments/memento";
import { parseClientHints } from "../protocol";
import { checkByName, runDoctor, type DoctorFacts } from "../../doctor/checks";
import { doctorReportPairs } from "../../doctor/report";
import { applyFix, gatherFacts, type DoctorEdge } from "../../doctor/edge";
import { typeSlash, type ClaudeInputEdge } from "../../claude-input/edge";

export interface VerbContext {
  readonly sessionState: SessionStateRW;
  readonly dlog: (level: "info" | "warn" | "error", msg: string) => void;
  // [LAW:effects-at-boundaries] The update notice's act (src/daemon/
  // update-notice.ts), handed in by the daemon: the verb names the effect,
  // the watch that knows what is newer performs it.
  readonly applyUpdate: () => void;
  // [LAW:effects-at-boundaries] The doctor's edge (src/doctor/edge.ts): the
  // tmux query and the settings.json read/write, handed in so the handlers
  // below stay a fold over pure verdicts and a test drives them with fakes.
  readonly doctor: DoctorEdge;
  // [LAW:single-enforcer] The one owner of memento's ceiling reading, so the
  // move that makes a reading stale is the one that drops it.
  readonly memento: Pick<MementoProvider, "move">;
  // [LAW:effects-at-boundaries] The tmux pane read and the typing
  // (src/claude-input/edge.ts), handed in so a test drives them with fakes.
  readonly claudeInput: ClaudeInputEdge;
  // [LAW:one-source-of-truth] The one undo history over every settings change
  // (src/daemon/settings-history.ts). The verb table opens a journal on it
  // around each click, so a handler records by writing, never by remembering.
  readonly history: SettingsHistory;
  // [LAW:one-source-of-truth] The one back history over what a session has
  // open (src/daemon/navigation-history.ts), journaled around each click
  // beside the settings history.
  readonly navigation: NavigationHistory;
  // [LAW:effects-at-boundaries] The config a session renders with, looked up
  // by the inputs its last render resolved from (the render cache owns it), so
  // `save` compares the session against the same config the bar was drawn from.
  readonly configFor: (origin: RenderOrigin) => DslConfig;
  // Reload that config from disk now, so the next render reads what a click
  // just wrote rather than waiting on the file watcher.
  readonly reloadConfig: (origin: RenderOrigin) => void;
}

// What a handler runs with: the daemon's context, with `sessionState` the
// click's journaling view of it and `journal` where its file writes report.
// `navigating` is the view the navigating verbs write through: the same store,
// with what they change on screen recorded for `back` as well.
export interface ClickContext extends VerbContext {
  readonly journal: Journal;
  readonly navigating: SessionStateRW;
}

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// raw wire-level `value` string and the daemon's verb context; it returns
// nothing (clicks have no payload). User-facing failures throw an Error;
// the dispatcher in server.ts converts that to a RENDER_FAILED response.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error which the dispatcher surfaces as BAD_REQUEST.
export type VerbHandler = (value: string, ctx: ClickContext) => void;

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
  const expanded = ctx.navigating.get(sessionId, "toolbar-expanded");
  if (expanded) ctx.navigating.clear(sessionId, "toolbar-expanded");
  else ctx.navigating.set(sessionId, "toolbar-expanded", "1");
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
  refuseDisorderedPicks(ctx, sid, "set-state", validated);
  // [LAW:single-enforcer] One write call, one log line format. setBatch
  // is the seam that owns reactive atomicity — every pair lands before
  // observers fire, so an autorun never sees half-applied batch state.
  // Partial application is unrepresentable: validation already passed,
  // and the seam guarantees the writes ship as one transaction.
  ctx.navigating.setBatch(sid, validated);
  const summary = validated.map((p) => `${p.key}=${p.value}`).join(" ");
  ctx.dlog("info", `set-state: ${summary} (session=${sid})`);
};

// [LAW:single-enforcer] One integer-shape boundary, mirroring the range
// validator's canonical `^-?\d+$`: the `by` delta and a stored current value are
// integers or they are not values. Only an integer-shaped stored value is a
// current value; absence (or a non-integer) is the genuine "unset" state, which
// steps from what the session's config shows (stepFrom).
const STEP_INT_RE = /^-?\d+$/;

// [LAW:no-ambient-temporal-coupling] A step that would pass a bound STOPS on it,
// and only a step taken FROM the bound wraps to the other end — so a stride
// wider than 1 (a setting's `step`) still reaches both ends, and one click past
// a bound never lands a value no click was aimed at. The navigation owner is
// THIS handler (moved off the render side, which is no longer the timing
// authority for the value). The range gate still owns the [min,max] CLAMP;
// wrap is navigation, clamp is enforcement.
function stepWithin(
  current: number,
  by: number,
  min: number,
  max: number,
): number {
  const n = current + by;
  if (n > max) return current === max ? min : max;
  if (n < min) return current === min ? max : min;
  return n;
}

// [LAW:one-source-of-truth] A RELATIVE nudge to a bounded state key. The link
// carries ONLY the irreducible intent `[sessionId, key, by]` (no `current`
// snapshot), so the SAME link string fires every render and N rapid clicks each
// re-read live state and accumulate — the idempotent absolute-write bug is gone.
// The absolute target is computed HERE: read the live value (an unset key
// steps from what the session's config shows, NOT silently from min), wrap by
// the signed delta against the registry's bounds, then route the result through
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
  const stored = ctx.sessionState.get(sid, key);
  const clamped =
    stored && STEP_INT_RE.test(stored)
      ? clampTo(params, parseInt(stored, 10))
      : stepFrom(
          "step-state",
          key,
          params,
          stateKeySeed(
            ctx.configFor(sessionOrigin(ctx, sid)),
            (k) => ctx.sessionState.get(sid, k),
            key,
          ),
        );
  const next = stepWithin(clamped, by, params.min, params.max);
  const result = validateStateWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-state: ${result.reason}`);
  refuseDisorderedPicks(ctx, sid, "step-state", [{ key, value: result.value }]);
  ctx.navigating.set(sid, key, result.value);
  ctx.dlog(
    "info",
    `step-state: ${key} ${clamped}→${result.value} (by ${by}, session=${sid})`,
  );
};

// [LAW:no-silent-failure] An unsaved pick of a placement's setting lands only
// if the placement's settings still stand together (placementPickProblems) —
// a threshold stepped past its neighbour is refused here, in the bar, rather
// than written for the render's `ramp` to fail on. A write that holds no
// placement's setting asks nothing of the session's config.
function refuseDisorderedPicks(
  ctx: VerbContext,
  sid: string,
  verb: string,
  writes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): void {
  const picks = writes.filter((w) => w.key.startsWith(PLACEMENT_DRAFT_NS));
  if (picks.length === 0) return;
  const problems = placementPickProblems(
    ctx.configFor(sessionOrigin(ctx, sid)),
    (k) => ctx.sessionState.get(sid, k),
    picks,
  );
  if (problems.length > 0) {
    throw new BadVerbArgs(`${verb}: refused — ${problems.join("; ")}`);
  }
}

function clampTo(params: RangeParams, n: number): number {
  return Math.max(params.min, Math.min(params.max, n));
}

// [LAW:no-defensive-null-guards] "unset" is a real state: an unset key steps
// from the value its session's config shows before any click (`declared`,
// resolved per session — the registry merges every config, so it cannot hold
// it). A key whose config shows nothing steps from `min`; one that shows a
// non-integer is a stepper over a value that is no number, refused loudly
// rather than stepped from a guess.
function stepFrom(
  verb: string,
  key: string,
  params: RangeParams,
  declared: string | null,
): number {
  if (declared === null) return params.min;
  if (!STEP_INT_RE.test(declared)) {
    throw new BadVerbArgs(
      `${verb}: "${key}" shows ${JSON.stringify(declared)} before any click, not an integer to step`,
    );
  }
  return clampTo(params, parseInt(declared, 10));
}

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

// [LAW:types-are-the-program] Exactly the three inputs resolveDslConfig
// takes. `configFile` is the session's explicit path as server.ts composed
// it (load-config pick, `--config`, `configEnv` hint) or null.
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
// and therefore no config — a loud BadVerbArgs, not the daemon's own XDG
// guess.
function sessionOrigin(ctx: VerbContext, sid: string): RenderOrigin {
  const raw = ctx.sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
  if (raw === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no config to act on`,
    );
  }
  return parseRenderOrigin(raw);
}

function originConfigFile(origin: RenderOrigin): string {
  return durableConfigPath(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
}

function editStore(ctx: ClickContext, sid: string): EditStore {
  return {
    record: (file, before, after) => ctx.journal.file(sid, file, before, after),
    logger: ctx.dlog,
  };
}

// [LAW:single-enforcer] `persist`'s twin of setState: the SAME validate-then-
// write shape, writing into the session's config file instead of
// SessionState. The write is DURABLE, and the session's config reloads before
// the click answers, as save's does, so the next render draws it
// ([LAW:no-ambient-temporal-coupling] — not a bet on the fs watcher's latency).
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
  const origin = sessionOrigin(ctx, sid);
  const file = originConfigFile(origin);
  const landing = durableLanding(
    ctx.configFor(origin),
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  writeValues(editStore(ctx, sid), file, [[landing.key, result.value]]);
  ctx.reloadConfig(origin);
  ctx.dlog(
    "info",
    `set-config: ${landing.key}=${result.value} → ${file} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] `persist`'s twin of stepState: a RELATIVE nudge
// against the value the file declares at the layer the click lands in (or,
// when it declares none, what the bar renders there — configKeySeed), wrapped
// and re-validated through the SAME range gate, then written durably.
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
  const origin = sessionOrigin(ctx, sid);
  const file = originConfigFile(origin);
  const landing = durableLanding(
    ctx.configFor(origin),
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  const stored = readValue(file, landing.key);
  const current =
    typeof stored === "number"
      ? clampTo(params, stored)
      : stepFrom(
          "step-config",
          key,
          params,
          configKeySeed(landing.globals, key),
        );
  const next = stepWithin(current, by, params.min, params.max);
  const result = validateConfigWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-config: ${result.reason}`);
  writeValues(editStore(ctx, sid), file, [[landing.key, result.value]]);
  ctx.reloadConfig(origin);
  ctx.dlog(
    "info",
    `step-config: ${landing.key} ${current}→${result.value} (by ${by}) → ${file} (session=${sid})`,
  );
};

// Save (brandon-save-undo-bwi.hpi): every unsaved setting lands in the config
// file as ONE write. The drafts are derived at click time by the SAME function
// the render counts them with, over the config this session renders with, so
// the click writes exactly what the `💾 save N` cell counted.
// [LAW:no-ambient-temporal-coupling] One handler owns the order write → reload
// → release. The picks are released only once the session's config has
// reloaded the file that now holds them, so no render in between draws the old
// file without them; released, the session follows the file again — a later
// hand edit, another session's save, a reset — instead of pinning over it. A
// refused write throws before either, keeping every draft.
// [LAW:single-enforcer] Each value re-crosses the gate that admitted it as a
// session pick (validateStateWrite): a value the gate no longer admits is
// refused loudly here, never written to the file.
const save: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const pick = (key: string) => ctx.sessionState.get(sid, key);
  const drafts = settingDrafts(config, pick);
  const placements = placementDrafts(config, pick);
  // Nothing unsaved is the save's own postcondition already holding — a second
  // click on a bar drawn before the first save released its picks — so it is
  // a recorded no-op, never a failure on the diagnostic strip.
  if (drafts.length + placements.length === 0) {
    ctx.dlog("info", `save: nothing unsaved (session=${sid})`);
    return;
  }
  const pairs = drafts.map((d): readonly [string, string] => {
    const result = validateStateWrite(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save: ${result.reason}`);
    return [d.target, result.value];
  });
  gatePlacements("save", placements);
  const file = originConfigFile(origin);
  writeDrafts(editStore(ctx, sid), file, pairs, placements);
  ctx.reloadConfig(origin);
  for (const key of [
    ...drafts.map((d) => d.sessionKey),
    ...placements.map((p) => p.key),
  ]) {
    ctx.sessionState.clear(sid, key);
  }
  ctx.dlog(
    "info",
    `save: ${[
      ...pairs.map(([k, v]) => `${k}=${v}`),
      ...placements.map(placementLog),
    ].join(" ")} → ${file} (session=${sid})`,
  );
};

// [LAW:single-enforcer] A placement's value re-crosses the gate its control's
// click passed, as a display setting's does.
const placementLog = (p: PlacementDraft): string =>
  `${p.preset}/${p.id}.settings.${p.setting}=${settingSpelling(p.value)}`;

function gatePlacements(
  verb: string,
  placements: readonly PlacementDraft[],
): void {
  for (const p of placements) {
    const result = validateStateWrite(p.key, settingSpelling(p.value));
    if (!result.ok) throw new BadVerbArgs(`${verb}: ${result.reason}`);
  }
}

// Save as preset (brandon-save-undo-bwi.o6u): the bar the session renders
// becomes `presets.<name>` in its config file (presetSnapshot), and the
// session switches to it. Once the file holds every setting the session had
// picked, those picks are released — the preset now renders them — so the
// session is left with one pick: the preset itself.
// [LAW:no-ambient-temporal-coupling] Save's order: write, reload, then the
// session — the preset the pick names exists before the pick does.
// [LAW:single-enforcer] Each pinned value re-crosses the session gate that
// admitted it, as a save's do.
const savePreset: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const snapshot = presetSnapshot(ctx.configFor(origin), (key) =>
    ctx.sessionState.get(sid, key),
  );
  const picks = snapshot.picks.map((d): readonly [keyof Globals, string] => {
    const result = validateStateWrite(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save-preset: ${result.reason}`);
    return [d.configKey, result.value];
  });
  gatePlacements("save-preset", snapshot.placements);
  const file = originConfigFile(origin);
  const name = writePreset(
    editStore(ctx, sid),
    file,
    snapshot.from,
    snapshot.globals,
    picks,
    snapshot.placements,
  );
  ctx.reloadConfig(origin);
  for (const key of [
    ...SETTING_PROJECTIONS.map((p) => p.sessionKey),
    ...snapshot.placements.map((p) => p.key),
  ]) {
    ctx.sessionState.clear(sid, key);
  }
  ctx.sessionState.set(sid, SETTINGS.preset.sessionKey, name);
  ctx.dlog(
    "info",
    `save-preset: ${[`${name} from=${snapshot.from}`, ...picks.map(([k, v]) => `${k}=${v}`), ...snapshot.placements.map(placementLog)].join(" ")} → ${file} (session=${sid})`,
  );
};

// Delete a preset the session's config file authors. A session that was in
// it returns to the file's default arrangement; any other session in it
// falls to the floor, as it would for a name deleted by hand.
const deletePreset: VerbHandler = (value, ctx) => {
  const [sessionId = "", name = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  if (!name) {
    throw new BadVerbArgs(
      "delete-preset: <name> is required (shape: <sessionId>/<name>)",
    );
  }
  const origin = sessionOrigin(ctx, sid);
  const file = originConfigFile(origin);
  deletePresetFromFile(editStore(ctx, sid), file, name);
  ctx.reloadConfig(origin);
  const key = SETTINGS.preset.sessionKey;
  if (ctx.sessionState.get(sid, key) === name) ctx.sessionState.clear(sid, key);
  ctx.dlog("info", `delete-preset: ${name} ← ${file} (session=${sid})`);
};

// [LAW:one-source-of-truth] `reset`: return each key to its bundled default
// at every layer that can hold it (resetLayers) — their paths in the session's
// config file, as ONE write, and the session's own picks. A `do` over several
// resets arrives here as one effect (batchAdjacentWrites), so reset all is one
// write, one reload, and one undo step. Gated by key MEMBERSHIP
// (listConfigKeys) rather than a value domain — there is no value to
// validate, only a legitimate target to clear — and every key is checked
// before anything is written, so a batch lands whole or not at all.
// [LAW:no-ambient-temporal-coupling] Save's order, for the same reason: the
// file is written and reloaded before the picks are released, so no render in
// between draws a pick's absence over a file that still holds the value.
const resetConfig: VerbHandler = (value, ctx) => {
  const [sessionId = "", ...keys] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const known = listConfigKeys();
  const unknown =
    keys.length === 0 ? [""] : keys.filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${unknown.join('", "')}" (have: ${known.join(", ")})`,
    );
  }
  const origin = sessionOrigin(ctx, sid);
  const file = originConfigFile(origin);
  const layers = keys.map(resetLayers);
  const fileKeys = layers.flatMap((l) => l.fileKeys);
  const sessionKeys = layers.flatMap((l) => l.sessionKeys);
  deleteValues(editStore(ctx, sid), file, fileKeys);
  ctx.reloadConfig(origin);
  for (const k of sessionKeys) ctx.sessionState.clear(sid, k);
  ctx.dlog(
    "info",
    `reset-config: ${[...fileKeys, ...sessionKeys.map((k) => `session:${k}`)].join(" ")} ← ${file} (session=${sid})`,
  );
};

// Every placement an edit ended: a (preset, id) the config held before the
// edit and no longer holds after it. Measured over every preset, since a row
// can be shared — an edit made in one preset's layout can end a placement
// another renders. [LAW:dataflow-not-control-flow] No branch on the op: an
// insertion ends nothing, and the comparison says so.
function endedPlacements(
  before: DslConfig,
  after: DslConfig,
): ReadonlyArray<{ readonly member: string; readonly node: SegmentNode }> {
  const placed = (config: DslConfig, preset: string) =>
    [...walkNodes(presetRoot(config, preset).node)].filter(
      (n): n is SegmentNode => n.kind === "segment",
    );
  const survivors = new Set(
    presetNames(after.presets).flatMap((preset) =>
      placed(after, preset).map((n) =>
        configureMember(ident(preset), placementId(n)),
      ),
    ),
  );
  return presetNames(before.presets).flatMap((preset) =>
    placed(before, preset)
      .map((node) => ({
        member: configureMember(ident(preset), placementId(node)),
        node,
      }))
      .filter(({ member }) => !survivors.has(member)),
  );
}

// What an ended placement leaves in the session: its unsaved values, and the
// configure key while it names that placement — a later placement that takes
// its id is a new instance, and must inherit neither.
function endedSessionKeys(
  ended: ReturnType<typeof endedPlacements>,
  configuring: string | null,
): readonly string[] {
  return ended.flatMap(({ member, node }) => [
    ...Object.values(node.drafts ?? {}).map((slot) => slot.key),
    ...(member === configuring ? [EDIT_CONFIGURE_KEY] : []),
  ]);
}

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
  const origin = sessionOrigin(ctx, sid);
  const file = originConfigFile(origin);
  const before = ctx.configFor(origin);
  const placed = applyLayoutOpToFile(editStore(ctx, sid), file, key, op);
  // A removed placement's session state ends with it (endedSessionKeys).
  // Measured on the file as it now reads, and released in the same click, so
  // its undo brings the placement and its drafts back.
  ctx.reloadConfig(origin);
  // The session state the edit discards — the fact its log line carries.
  const released = endedSessionKeys(
    endedPlacements(before, ctx.configFor(origin)),
    ctx.sessionState.get(sid, EDIT_CONFIGURE_KEY),
  ).filter((key) => ctx.sessionState.get(sid, key) !== null);
  for (const key of released) ctx.sessionState.clear(sid, key);
  // The placement an insertion wrote — its id minted here, at click time — is
  // the one fact of the edit the op token does not already carry.
  ctx.dlog(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${file} placed=${JSON.stringify(placed)} released=${JSON.stringify(released)} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] Step the session's settings history
// (settings-history.ts) back one click — whatever that click changed, in the
// session or in a config file. No key, no value: the history owns which step
// moves and what it restores; this handler is plumbing between the wire and
// it. [LAW:no-silent-failure] An empty stack and a stale target are loud
// BAD_REQUESTs, surfaced as a transient click.error.
const undo: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  // The click's own earlier changes are a step of their own first, so one
  // click behaves exactly as the same clicks made one at a time.
  ctx.journal.commit();
  const step = ctx.history.undo(sid);
  ctx.reloadConfig(origin);
  ctx.dlog("info", `undo: restored ${describeStep(step)} (session=${sid})`);
};

// [LAW:single-enforcer] Back restores through the click's settings view, never
// a navigation journal, so going back is not itself a step it could return to.
const back: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  const { step, discarded } = ctx.navigation.back(sid, ctx.sessionState);
  const restored = step.map((c) => `${c.key}=${c.before ?? "∅"}`).join(" ");
  ctx.dlog("info", `back: ${restored} discarded=${discarded} (session=${sid})`);
};

// [LAW:single-enforcer] Cancel for edit mode. The history owns what changed
// since edit mode opened and how to put it back (SettingsHistory.rewind); this
// handler is plumbing between the wire and it, and says what it put back.
// [LAW:no-silent-failure] A session with no savepoint is a loud BAD_REQUEST
// with nothing written; a target changed since is one too, raised after every
// other target was put back, naming the target it kept.
const rewind: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  const origin = sessionOrigin(ctx, sid);
  // The click's own earlier changes are a step of their own first, as undo's.
  ctx.journal.commit();
  // A refused step may still have written: rewind puts back every target
  // but the one it keeps. So the reload runs whether or not it throws.
  let restored: ReturnType<typeof ctx.history.rewind>;
  try {
    restored = ctx.history.rewind(sid);
  } finally {
    ctx.reloadConfig(origin);
  }
  ctx.dlog(
    "info",
    `rewind: put back ${describeStep(restored) || "nothing"} as edit mode found it (session=${sid})`,
  );
};

// undo's mirror — steps the same history forward one click.
const redo: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  ctx.journal.commit();
  const step = ctx.history.redo(sid);
  ctx.reloadConfig(origin);
  ctx.dlog("info", `redo: re-applied ${describeStep(step)} (session=${sid})`);
};

// [LAW:effects-at-boundaries] The update notice's `[rebuild]` / `[upgrade]`
// click (brandon-build-notice-5d6). The wire carries only the session id (for
// click.error surfacing); the daemon's update watch decides what to run from
// its own provenance, so no command or version ever arrives from a URL.
const applyUpdate: VerbHandler = (value, ctx) => {
  requireSessionId(oneArg(value));
  ctx.applyUpdate();
};

// ─── Doctor (brandon-doctor-b6a) ────────────────────────────────────────────

// [LAW:one-source-of-truth] Where the daemon records each session's STAMPED
// client hints (server.ts writes `JSON.stringify(parseClientHints(req))` here
// on every render that changes them) — the SESSION_RENDER_ORIGIN_KEY move for
// client facts. A click carries no hints, so the doctor reasons over the facts
// of the session's last render, read back through the SAME checkpoint the live
// frame crossed (parseClientHints), never over the daemon's own env.
export const SESSION_CLIENT_HINTS_KEY = "client-hints";

// [LAW:no-silent-failure] A session that has never rendered has no hints —
// a loud BadVerbArgs, never a click that acts on a guessed "not in tmux".
function sessionHints(
  ctx: VerbContext,
  sid: string,
): ReturnType<typeof parseClientHints> {
  const raw = ctx.sessionState.get(sid, SESSION_CLIENT_HINTS_KEY);
  if (raw === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no client facts are recorded for it`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadVerbArgs(`client hints record is not JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BadVerbArgs(`client hints record is not an object: ${raw}`);
  }
  return parseClientHints(parsed as Record<string, unknown>);
}

// [LAW:single-enforcer] One write of the whole report, through setBatch — the
// row cap flips, the reason and fixable land, in one reactive transaction.
function writeReport(ctx: VerbContext, sid: string, facts: DoctorFacts): void {
  const reports = runDoctor(facts);
  ctx.sessionState.setBatch(sid, doctorReportPairs(reports));
  ctx.dlog(
    "info",
    `doctor: ${reports.map((r) => `${r.check.name}=${r.verdict.ok ? "ok" : "failed"}`).join(" ")} (session=${sid})`,
  );
}

const doctorRun: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  writeReport(ctx, sid, gatherFacts(ctx.doctor, sessionHints(ctx, sid)));
};

// Re-probe THIS check at click time and perform the fix its fresh verdict
// carries — never a fix cached from the render that drew the `[fix]`, because
// the world may have moved (the var got set, the tmux server went away). Then
// re-run over the post-fix facts, so the row flips to the truthful reason.
const doctorFix: VerbHandler = (value, ctx) => {
  const [sessionId = "", checkName = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-fix: unknown check "${checkName}"`);
  }
  const facts = gatherFacts(ctx.doctor, sessionHints(ctx, sid));
  const verdict = check.probe(facts);
  if (verdict.ok || verdict.fix === undefined) {
    throw new BadVerbArgs(
      `doctor-fix: ${check.label} — ${verdict.ok ? "nothing to fix" : verdict.reason}`,
    );
  }
  const after = applyFix(verdict.fix, facts);
  ctx.dlog(
    "info",
    `doctor-fix: ${check.name} → ${verdict.fix.kind} ${verdict.fix.name}=${verdict.fix.value} (session=${sid})`,
  );
  writeReport(ctx, sid, after);
};

// ─── Memento ceiling (brandon-context-ceiling-xta.asv) ───────────────────────

// [LAW:parse-dont-validate] A click's move is honoured only as one of the
// `ceiling` actions the session's config declares: the declaration found is
// the parsed move, so what reaches memento is what the config author wrote,
// never text a URL made up. The session's recorded render origin supplies the
// directories memento anchors its project layer on — the ones the bar's
// reading was taken with.
const ceiling: VerbHandler = (value, ctx) => {
  const [sessionId = "", ...args] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const action = Object.values(ctx.configFor(origin).actions)
    .filter((a): a is CeilingAction => "ceiling" in a)
    .find((a) => {
      const declared = ceilingMoveArgs(a);
      return (
        declared.length === args.length &&
        declared.every((d, i) => d === args[i])
      );
    });
  if (action === undefined) {
    throw new BadVerbArgs(
      `ceiling: "${args.join(" ")}" is not a move this config declares`,
    );
  }
  const move: CeilingMove =
    action.ceiling === "set"
      ? { kind: "set", to: action.to }
      : { kind: "clear" };
  ctx.memento.move(
    { sessionId: sid, projectDir: origin.projectDir, cwd: origin.cwd },
    move,
  );
  ctx.dlog("info", `ceiling: ${args.join(" ")} (session=${sid})`);
};

// ─── Slash commands (brandon-context-ceiling-xta.7xt) ───────────────────────

// [LAW:parse-dont-validate] A click's line is honoured only as one a `slash`
// action in the session's config declares — the declaration found supplies
// the SlashLine typed, so the URL chooses among the config's lines and can
// add none. The pane is the one the session's last render reported.
const slash: VerbHandler = (value, ctx) => {
  const [sessionId = "", line = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const declared = Object.values(
    ctx.configFor(sessionOrigin(ctx, sid)).actions,
  ).filter((a): a is SlashAction => "slash" in a);
  const action = declared.find((a) => a.slash === line);
  if (action === undefined) {
    throw new BadVerbArgs(
      `${JSON.stringify(line)} is not a command this config declares (it declares: ${[...new Set(declared.map((a) => a.slash))].join(", ") || "none"})`,
    );
  }
  const result = typeSlash(
    ctx.claudeInput,
    sessionHints(ctx, sid).tmux,
    action.slash,
  );
  if (result.kind === "refused") {
    ctx.dlog(
      "warn",
      `slash: ${line} refused — ${result.reason} (session=${sid})`,
    );
    // The pane's own state refused the click — the user's to change, like a
    // store refusal, so BAD_REQUEST; a tmux failure throws from the edge.
    throw new BadVerbArgs(`${line} was not typed: ${result.reason}`);
  }
  ctx.dlog("info", `slash: typed ${line} into ${result.pane} (session=${sid})`);
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
  [VERB_SAVE, save],
  [VERB_SAVE_PRESET, savePreset],
  [VERB_DELETE_PRESET, deletePreset],
  [VERB_APPLY_LAYOUT_OP, applyLayoutOp],
  [VERB_UNDO, undo],
  [VERB_REDO, redo],
  [VERB_BACK, back],
  [VERB_REWIND, rewind],
  [VERB_SHOW_CONFIG_ERROR, showConfigError],
  [VERB_SHOW_CONFIG_WARNING, showConfigWarning],
  [VERB_TOOLBAR_TOGGLE, toolbarToggle],
  [VERB_APPLY_UPDATE, applyUpdate],
  [VERB_DOCTOR_RUN, doctorRun],
  [VERB_DOCTOR_FIX, doctorFix],
  [VERB_CEILING, ceiling],
  [VERB_SLASH, slash],
]);

// [LAW:one-source-of-truth] The verbs whose FIRST wire segment is the session
// id — the set `dispatch` reads to know which session a failing click should
// surface its error in. Membership here is the fact; a verb that carries the
// session id first joins by one row, not one more `||`.
const SESSION_FIRST_VERBS: ReadonlySet<string> = new Set([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_DELETE_PRESET,
  VERB_APPLY_LAYOUT_OP,
  VERB_UNDO,
  VERB_REDO,
  VERB_BACK,
  VERB_REWIND,
  VERB_TOOLBAR_TOGGLE,
  VERB_APPLY_UPDATE,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  VERB_CEILING,
  VERB_SLASH,
]);

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects; the
// dispatcher folds the list, running EVERY effect through the leaf table, after
// batchAdjacentWrites has joined each run of adjacent set-state (or
// reset-config) effects into the one batch that lands whole. The
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
  for (const { verb, value } of batchAdjacentWrites(parseEffects(rawValue))) {
    // Extract session ID from the first session-bearing effect for error
    // display — every SESSION_FIRST_VERBS member carries it as its first
    // segment, so a failing step surfaces in the bar like any other.
    if (!sessionId && SESSION_FIRST_VERBS.has(verb)) {
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

// [LAW:single-enforcer] One click is one undoable step, so the step boundary
// is the click boundary: every entry of the table the daemon looks up against
// runs inside a journal it opens and commits. `dispatch` folds its effects
// through the RAW leaf table, so a click of N effects is one journal and one
// step, never N. The commit runs even when a handler threw — whatever landed
// before the throw is real, so it is recorded. [LAW:no-silent-failure] A
// commit that fails too never hides the handler's own error: the click
// reports both.
function journaled(
  handler: VerbHandler,
): (value: string, ctx: VerbContext) => void {
  return (value, ctx) => {
    const journal = ctx.history.begin();
    const navigation = ctx.navigation.begin(journal.sessionState);
    const failures: unknown[] = [];
    try {
      handler(value, {
        ...ctx,
        sessionState: journal.sessionState,
        journal,
        navigating: navigation.sessionState,
      });
    } catch (e) {
      failures.push(e);
    }
    navigation.commit();
    try {
      journal.commit();
    } catch (e) {
      failures.push(e);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new Error(
        failures.map((e) => String((e as Error).message ?? e)).join("; "),
      );
    }
  };
}

// [LAW:one-source-of-truth] The full dispatch table the daemon looks up against:
// every leaf verb plus the one `dispatch` wrapper. Old scrollback links that
// name a leaf verb directly still resolve here; new renders all emit `dispatch`.
export const VERBS: ReadonlyMap<
  string,
  (value: string, ctx: VerbContext) => void
> = new Map(
  [...LEAF_VERBS, [VERB_DISPATCH, dispatch] as const].map(
    ([verb, handler]) => [verb, journaled(handler)] as const,
  ),
);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];
