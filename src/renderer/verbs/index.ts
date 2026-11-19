// [LAW:single-enforcer] One registry that maps click verb names to their
// handlers. Adding a new verb is one entry — no branching in the click turn
// (src/renderer/click.ts), which does table lookup only; verb semantics live
// in the per-verb handler functions.
//
// [LAW:dataflow-not-control-flow] The verb is data, the lookup is data;
// the dispatcher runs the same operation every call (find handler, invoke
// it). Variability lives entirely in the verb-name argument and in the
// per-verb handler body — never in whether dispatch happens.
//
// [LAW:one-source-of-truth] The verb table is the single canonical list of
// click verbs. Tests assert against this table directly so the live registry
// and the test enumeration cannot drift.
//
// Multi-arg verbs (set-state) carry their args as a single slash-delimited
// `value` string on the wire — keeping ClickRequest shape-stable at
// protocol v3 ({verb, value}). The per-verb handler parses its own value
// into the typed args it needs. URL format mirrors:
//   cc-candybar://<verb>/<value>   where <value> may itself contain `/`.

import type { Locations } from "../../config/loader/chain-places";
import type { ConfigSnapshot } from "../../config/config-snapshot";
import {
  LAYER_ROLES,
  layerRoleOf,
  type LayerRole,
} from "../../config/layer-role";
import type { SessionStateRW } from "../../renderer-interface/session-state";
import { holdClickError } from "../../daemon/foundations/click-error";
import type { Instant } from "../../utils/instant";
import { stateKeySeed, configKeySeed } from "./key-seeds";
import {
  disclosureNest,
  NO_NEST,
  openRoots,
  type DisclosureNest,
} from "../../config/disclosure-nest";
import { DISCLOSURE_CLOSED } from "../../config/disclosure";
import type { Drawing } from "../../config/lanes";
import { closingView } from "../closing-view";
import type { Gates } from "../../daemon/foundations/gates";
import type {
  Gate,
  RangeParams,
} from "../../daemon/foundations/validator-registry";
import {
  applyLayoutOp as applyLayoutOpToFile,
  deletePreset as deletePresetFromFile,
  deleteValues,
  proveLoads,
  readValue,
  writePreset,
  writeDrafts,
  writeThemeDefault,
  writeValues,
  writeLayerOf,
  type EditStore,
  type WriteLayer,
} from "../config-file-store";
import {
  describeStep,
  type Journal,
  type SettingsHistory,
} from "../settings-history";
import type { NavigationHistory } from "../navigation-history";
import {
  placementId,
  settingSpelling,
  walkNodes,
  type DslConfig,
  type Globals,
  type SegmentNode,
} from "../../config/dsl-types";
import { THEME_DEFAULT_FIELDS } from "../../config/globals-fields";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  PLACEMENT_DRAFT_NS,
} from "../../config/loader/edit-mode";
import {
  durableLanding,
  placementDrafts,
  placementPickProblems,
  presetSnapshot,
  type PlacementDraft,
  resetLayers,
  settingDrafts,
  themeDefaultSave,
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
  VERB_REDO,
  VERB_BACK,
  VERB_REWIND,
  VERB_RESET_CONFIG,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_SAVE_THEME_DEFAULT,
  VERB_DELETE_PRESET,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_COPY_DIAGNOSTIC,
  type EvaluatedRun,
  clickSessionOf,
} from "../../click/wire";
import type { LinkSigner } from "../../click/link-signer";
import type { ConfigWrites, Landed } from "../config-writes";
import type {
  ActRequest,
  Effect,
  EffectId,
  EffectOutcome,
} from "../../renderer-interface/interface";
import { repoAnswerFields } from "../../config/repo-question";
import { REPO_ANSWERS } from "../../config/loader/repo-gate";
import type {
  DeclaredSources,
  SessionContext,
} from "../../renderer-interface/request-context";
import { runDeclaration, type SlashAction } from "../../config/action";
import {
  GLYPH_MARKS,
  checkByName,
  describeFix,
  type DoctorFacts,
  type GlyphMark,
} from "../../doctor/checks";
import type { RenderOrigin } from "../../config-hint";
import { withMark } from "../../doctor/mark-book";
import type { ClickArrival } from "../../doctor/sightings";
import type { ConfigLoad, DoctorDocuments } from "../../doctor/ports";
import { tmuxPaneOf } from "../../claude-input/typing";
import { readSources, readThrough, settingChange } from "../../doctor/gather";
import type { DoctorRuns } from "../doctor";
import {
  BadVerbArgs,
  decodeWire,
  failureOf,
} from "../../daemon/foundations/verb-error";
import {
  noteFacts,
  type RequestFacts,
} from "../../daemon/foundations/request-event";
import {
  DOCTOR_RUN_NAME_NOTE,
  DOCTOR_RUN_NOTE,
  type RunAsked,
} from "../../renderer-interface/noted-doctor";
import type { ActsOnTheirWay } from "../acts";
import {
  parseSessionId,
  type SessionId,
} from "../../daemon/foundations/session-id";
import type { IdleSpan } from "../menu-idle";
import { throwAll } from "../../utils/run-each";

// What the daemon hands everything that writes a session's state: a click's
// verb, and the idle close of its menus (`closeIdleMenus`).
export interface DaemonContext {
  // What this daemon's clicks may write: the gates its root built.
  readonly gates: Gates;
  readonly sessionState: SessionStateRW;
  // [LAW:one-source-of-truth] The snapshot the host handed in for an origin:
  // what a click reads and writes its layers from. One not held throws,
  // naming the origin.
  readonly snapshotFor: (origin: RenderOrigin) => ConfigSnapshot;
  // [LAW:effects-at-boundaries] The turn's wall instant, which the host read.
  readonly now: () => Instant;
  readonly log: (level: "info" | "warn" | "error", msg: string) => void;
  // [LAW:single-enforcer] Where every act a click asks of the host goes: its
  // turn's effects, which the host performs once its changes have landed
  // (src/renderer/acts.ts).
  readonly acts: Pick<ActsOnTheirWay, "ask">;
  // Where the user's config and installed plugins live: a click's write
  // resolves its home under them.
  readonly locations: Locations;
  // [LAW:single-enforcer] Each session's doctor run (src/renderer/doctor.ts),
  // and the config load a run judges: the session's cache entry's, reloaded.
  readonly doctorRuns: DoctorRuns;
  readonly doctorLoad: (origin: RenderOrigin) => ConfigLoad;
  // The doctor's stores, which this daemon files (src/doctor/ports.ts).
  readonly doctorStores: DoctorDocuments;
  // [LAW:one-source-of-truth] The one undo history over every settings change
  // (src/renderer/settings-history.ts). The verb table opens a journal on it
  // around each click, so a handler records by writing, never by remembering.
  readonly history: SettingsHistory;
  // [LAW:one-source-of-truth] The one back history over what a session has
  // open (src/renderer/navigation-history.ts), journaled around each click
  // beside the settings history.
  readonly navigation: NavigationHistory;
  // [LAW:no-ambient-temporal-coupling] A click of the session landed, in its
  // turn: the session's idle period restarts (src/renderer/menu-idle.ts).
  readonly clickLanded: (sessionId: SessionId) => void;
  // [LAW:effects-at-boundaries] The config a session renders with, looked up
  // by the inputs its last render resolved from (the render cache owns it), so
  // `save` compares the session against the same config the bar was drawn from.
  readonly configFor: (origin: RenderOrigin) => DslConfig;
  // [LAW:single-enforcer] Where every click's config writes go: changes its
  // turn returns, and its consequence held until they land
  // (src/renderer/config-writes.ts).
  readonly configWrites: ConfigWrites;
  // The storage folder of each source that config declares, from the same
  // render state: what a `run` supersedes.
  readonly sourcesFor: (origin: RenderOrigin) => DeclaredSources;
  // [LAW:single-enforcer] The signer every `run` link was drawn with: a link
  // is honoured only if it verifies here.
  readonly links: LinkSigner;
  // What the diagnostic the frame renderer `by` last delivered for the
  // session listed under `key` copies; undefined when it lists none under it.
  readonly diagnosticCopy: (
    sessionId: SessionId,
    by: Drawing["by"],
    key: string,
  ) => string | undefined;
}

export interface VerbContext extends DaemonContext {
  // How THIS click arrived — a link the URL handler delivered (its staged
  // runtime's version, or null from one too old to report it), or a tmux
  // status-line range — the one per-click fact here; the daemon's dispatcher
  // sets it on each click.
  readonly arrival: ClickArrival;
  // THIS click's session as the host's book holds it.
  readonly context: SessionContext | null;
  // THIS click's turn's effects, which its config changes join.
  readonly effects: Effect[];
  // THIS click's turn's record, which a doctor report is noted on.
  readonly record: RequestFacts;
}

// A context with the journals the verb table opens around a write.
export type Journaled<C extends DaemonContext> = C & {
  // The session the click names, whose bar its acts' failures show on; null
  // for a link that names none. `context` is what the journal acts on it with.
  readonly session: SessionId | null;
  readonly context: SessionContext | null;
  readonly journal: Journal;
  readonly navigating: SessionStateRW;
};

// What a handler runs with: the daemon's context, with `sessionState` the
// click's journaling view of it and `journal` where its file writes report.
// `navigating` is the view the navigating verbs write through: the same store,
// with what they change on screen recorded for `back` as well.
export type ClickContext = Journaled<VerbContext>;

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// raw wire-level `value` string and the daemon's verb context; it returns
// nothing (clicks have no payload), and acts within its turn: what it asks
// of the host is an effect its turn returns.
// User-facing failures throw an Error, which the turn's classification
// (src/daemon/foundations/verb-error.ts) answers as RENDER_FAILED.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error, which it answers as BAD_REQUEST.
export type VerbHandler = (value: string, ctx: ClickContext) => void;

export { BadVerbArgs };

// ─── Argument decoders ───────────────────────────────────────────────────────

// [LAW:single-enforcer] A click's session id crosses the one session-id
// checkpoint (parseSessionId); a refusal is the click's bad arguments.
function requireSessionId(value: string): SessionId {
  const parsed = parseSessionId(value);
  if (!parsed.ok) throw new BadVerbArgs(`session id ${parsed.problem}`);
  return parsed.id;
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

// [LAW:single-enforcer] What a handler asks of the host: an act in its
// click's turn, performed once the click's changes have landed.
function ask(ctx: ClickContext, act: ActRequest): void {
  ctx.acts.ask(ctx.effects, act);
}

// A copy's failure shows on the bar of the session its click names; a plain
// copy link names none, so its failure is the daemon's to show.
const copy: VerbHandler = (value, ctx) =>
  ask(ctx, { kind: "copy", session: ctx.session, text: oneArg(value) });

// [LAW:parse-dont-validate] The renderer a copy click names: the surface it
// was drawn on, whose last frame it copies from.
const DRAWERS: ReadonlySet<string> = new Set<Drawing["by"]>([
  "request",
  "feed",
]);
function requireDrawer(by: string): Drawing["by"] {
  if (!DRAWERS.has(by))
    throw new BadVerbArgs(`unknown renderer ${JSON.stringify(by)}`);
  return by as Drawing["by"];
}

// [LAW:no-silent-failure] A key the frame the click came from does not list
// (the message fixed since, or the session never drawn here) is refused,
// never a clipboard silently left as it was.
const copyDiagnostic: VerbHandler = (value, ctx) => {
  const [sessionId = "", by = "", key = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const text = ctx.diagnosticCopy(sid, requireDrawer(by), key);
  if (text === undefined)
    throw new BadVerbArgs(
      `that message is no longer listed in session ${sid}'s diagnostics — open the indicator beside the settings door again and copy from there`,
    );
  ask(ctx, { kind: "copy", session: sid, text });
};

const openVscode: VerbHandler = (value, ctx) =>
  ask(ctx, { kind: "open", session: ctx.session, target: oneArg(value) });

// [LAW:single-enforcer] One verb writes SessionState — for every key the
// session's gate holds, for every pair in a batch. That gate
// (./state-validators.ts, derived from the config the session renders) is
// the single place that decides what is a legal value for a given key; the
// body here is residue:
// split args into pairs, validate each, write atomically, log.
//
// [LAW:dataflow-not-control-flow] The key is data flowing across the
// boundary, not a discriminator that selects between verb handlers.
// The pair count is data too — N=1 (single write) is the degenerate
// form of the N≥2 batch; the parser walks pairs uniformly. A new
// state-writable key is an action in a config, not a new verb; a multi-write
// click (e.g. menu action that writes the chosen value AND collapses
// the menu) is one URL with multiple pairs, not multiple URLs.
//
// [LAW:types-are-the-program] The validator returns a discriminated
// `ValidateResult`. The body cannot fabricate a value (the `ok: true`
// branch's `value` is the only thing it may write) and cannot proceed
// on `ok: false` (it throws BadVerbArgs with the reason verbatim,
// naming the failing pair so the operator can localize the typo), which the
// turn's classification answers as BAD_REQUEST.
//
// [LAW:no-silent-failure] Batch atomicity: every pair is validated
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
  const gate = ctx.gates.state.gateFor(sessionConfig(ctx, sid));
  if (rest.length === 0)
    throw new BadVerbArgs(
      `set-state: <key>/<value> is required (have keys: ${gate.listKeys().join(", ")})`,
    );
  // [LAW:dataflow-not-control-flow] The pair count emerges from the data. The
  // loop walks the same path for N=1 and N=K — no branch on "is this a batch."
  if (rest.length % 2 !== 0) {
    throw new BadVerbArgs(
      `set-state: expected even-count <key>/<value> pairs, got ${rest.length} ` +
        `segment(s) after session id (have keys: ${gate.listKeys().join(", ")})`,
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
    const result = gate.validate(key, incoming);
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
  ctx.log("info", `set-state: ${summary} (session=${sid})`);
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
// the signed delta against the bounds the session's own config declares, then
// route the result through its gate so the one range gate owns the [min,max]
// clamp and the canonical decimal form that persists.
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
  const config = sessionConfig(ctx, sid);
  const gate = ctx.gates.state.gateFor(config);
  // [LAW:no-silent-failure] A key the session's config declares no range for
  // is not a stepper — reject loudly rather than fabricate bounds or silently
  // no-op.
  const params = gate.rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-state: key "${key}" is not a bounded (range) state key ` +
        `(have keys: ${gate.listKeys().join(", ")})`,
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
          stateKeySeed(config, (k) => ctx.sessionState.get(sid, k), key),
        );
  const next = stepWithin(clamped, by, params.min, params.max);
  const result = gate.validate(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-state: ${result.reason}`);
  refuseDisorderedPicks(ctx, sid, "step-state", [{ key, value: result.value }]);
  ctx.navigating.set(sid, key, result.value);
  ctx.log(
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
  sid: SessionId,
  verb: string,
  writes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): void {
  const picks = writes.filter((w) => w.key.startsWith(PLACEMENT_DRAFT_NS));
  if (picks.length === 0) return;
  const problems = placementPickProblems(
    sessionConfig(ctx, sid),
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
// resolved from the session's picks). A key whose config shows nothing steps from `min`; one that shows a
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

// [LAW:one-source-of-truth] What a context says its session renders from:
// null for a context of another session, or none, as for a session the host's
// book holds nothing of.
function originOf(
  context: SessionContext | null,
  sid: SessionId,
): RenderOrigin | null {
  return contextFor(context, sid)?.durable.origin ?? null;
}

// [LAW:single-enforcer] The click's context as the session `sid` reads it:
// none for a session it does not name.
function contextFor(
  context: SessionContext | null,
  sid: SessionId,
): SessionContext | null {
  return context?.session === sid ? context : null;
}

// [LAW:no-silent-failure] A session the click's context names nothing of has
// no origin and therefore no config — a loud BadVerbArgs, not the daemon's
// own XDG guess.
function sessionOrigin(
  ctx: Pick<VerbContext, "context">,
  sid: SessionId,
): RenderOrigin {
  const origin = originOf(ctx.context, sid);
  if (origin === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no config to act on`,
    );
  }
  return origin;
}

// [LAW:single-enforcer] How a click's config changes landed, in the turn of
// their last `effect-done`. [LAW:no-ambient-temporal-coupling] Landed, the
// host has already handed in, in the click's own slot, the `config` of every
// origin the landing moved, so the click's consequence applies over the
// config the landing left, and no frame draws the reloaded file without what
// the click did beside it, nor that without the file.
// [LAW:no-silent-failure] Not landed, the click's consequence is dropped: its
// drafts, picks and history stay as they were, and the reason shows on its
// session's ⚠. No click answers this turn, so whatever fails in it shows on
// the session's ⚠ itself.
export function changeDone(
  ctx: DaemonContext,
  id: EffectId,
  outcome: EffectOutcome,
  effects: Effect[],
): boolean {
  const landed = ctx.configWrites.settled(id, outcome);
  if (landed === undefined) return false;
  if (landed !== "owed") changeLanded(ctx, landed, effects);
  return true;
}

function changeLanded(
  ctx: DaemonContext,
  { session, consequence, outcome }: Landed,
  effects: Effect[],
): void {
  const failed: string[] = [];
  const step = (work: () => void): void => {
    try {
      work();
    } catch (e) {
      failed.push(failureOf(e).message);
    }
  };
  if (outcome.kind === "ok") step(() => consequence(effects));
  else if (outcome.kind === "closing") return;
  else failed.push(outcome.reason);
  if (failed.length === 0) return;
  const reason = failed.join("\n");
  ctx.log("warn", `config change: ${reason} (session=${session})`);
  holdClickError(ctx.sessionState, session, reason, ctx.now());
}

// [LAW:no-silent-failure] A history step's text loads as the layer of the
// session stepping it that the step wrote, or the step is refused: a step
// only ever wrote that session's layers, and a file it no longer renders from
// has no chain to prove the text in.
function proveLoadsAsLayer(
  ctx: DaemonContext,
  origin: RenderOrigin | null,
  file: string,
  text: string | null,
  read: (file: string) => string | null,
): void {
  const layer =
    origin === null
      ? undefined
      : ctx.snapshotFor(origin).chain.find((l) => l.path === file);
  if (origin === null || layer === undefined)
    throw new BadVerbArgs(
      `${file} is not a config file this session renders from — its step is not taken`,
    );
  proveLoads(heldLayer(ctx, origin, layer.role), text, read);
}

// [LAW:one-source-of-truth] The config a session renders — what its clicks
// read, and what gates them: a session's gate is its own config's, never a
// merge of every config the daemon holds.
function sessionConfig(ctx: VerbContext, sid: SessionId): DslConfig {
  return ctx.configFor(sessionOrigin(ctx, sid));
}

// What the session's config nests; a session the context names nothing of
// has no config, so nothing nested.
function nestOf(
  ctx: DaemonContext,
  context: SessionContext | null,
  sid: SessionId,
): DisclosureNest {
  const origin = originOf(context, sid);
  return origin === null ? NO_NEST : disclosureNest(ctx.configFor(origin));
}

// [LAW:single-enforcer] The layer a config write names in the session's
// chain, as the snapshot the host handed in for its origin holds it: a click's
// chain is the bar's. A layer the chain has no place for is refused, never
// written somewhere else.
function heldLayer(
  ctx: Pick<ClickContext, "snapshotFor" | "locations">,
  origin: RenderOrigin,
  role: LayerRole,
): WriteLayer {
  return writeLayerOf(
    ctx.snapshotFor(origin),
    role,
    origin.target.path ?? null,
    ctx.locations.home,
  );
}

// [LAW:parse-dont-validate] A config write's wire: the session, the layer of
// its chain it writes, then the verb's own arguments.
function configWire(
  verb: string,
  raw: string,
): { sid: SessionId; role: LayerRole; args: string[] } {
  const [sessionId = "", layer = "", ...args] = decodeWire(() =>
    decodeSegments(raw),
  );
  const sid = requireSessionId(sessionId);
  const role = layerRoleOf(layer);
  if (role === null)
    throw new BadVerbArgs(
      `${verb}: "${layer}" is not a config layer (one of ${LAYER_ROLES.join(", ")})`,
    );
  return { sid, role, args };
}

function editStore(ctx: ClickContext, sid: SessionId): EditStore {
  return {
    read: (file) => ctx.configWrites.read(file),
    record: (file, before, after) => ctx.journal.file(sid, file, before, after),
  };
}

// [LAW:single-enforcer] `persist`'s twin of setState: the SAME validate-then-
// write shape, writing into the session's config file instead of
// SessionState. The write is DURABLE, and the session's config reloads in
// the turn it lands (changeLanded), so the next render draws it
// ([LAW:no-ambient-temporal-coupling] — not a bet on the fs watcher's latency).
// [LAW:no-silent-failure] Unknown key or out-of-domain value is a loud
// BAD_REQUEST — the config-file twin of `set-state`'s gate (configGate),
// derived from the SAME action table.
const setConfig: VerbHandler = (rawValue, ctx) => {
  const {
    sid,
    role,
    args: [key = "", incoming = ""],
  } = configWire("set-config", rawValue);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const gate = ctx.gates.config.gateFor(config);
  if (!key) {
    throw new BadVerbArgs(
      `set-config: <key>/<value> is required (have keys: ${gate.listKeys().join(", ")})`,
    );
  }
  const result = gate.validate(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-config: ${result.reason}`);
  const into = heldLayer(ctx, origin, role);
  const landing = durableLanding(
    config,
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  writeValues(editStore(ctx, sid), into, [[landing.key, result.value]]);
  ctx.log(
    "info",
    `set-config: ${landing.key}=${result.value} → ${into.path} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] `persist`'s twin of stepState: a RELATIVE nudge
// against the value the file declares at the layer the click lands in (or,
// when it declares none, what the bar renders there — configKeySeed), wrapped
// and re-validated through the SAME range gate, then written durably.
const stepConfig: VerbHandler = (rawValue, ctx) => {
  const {
    sid,
    role,
    args: [key = "", byRaw = ""],
  } = configWire("step-config", rawValue);
  if (!key) {
    throw new BadVerbArgs(
      "step-config: <key> is required (shape: <sessionId>/<layer>/<key>/<by>)",
    );
  }
  if (!STEP_INT_RE.test(byRaw)) {
    throw new BadVerbArgs(
      `step-config: delta must be an integer, got "${byRaw}"`,
    );
  }
  const by = parseInt(byRaw, 10);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const gate = ctx.gates.config.gateFor(config);
  const params = gate.rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${gate.listKeys().join(", ")})`,
    );
  }
  const into = heldLayer(ctx, origin, role);
  const landing = durableLanding(
    config,
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  const store = editStore(ctx, sid);
  const stored = readValue(store.read(into.path), landing.key);
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
  const result = gate.validate(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-config: ${result.reason}`);
  writeValues(editStore(ctx, sid), into, [[landing.key, result.value]]);
  ctx.log(
    "info",
    `step-config: ${landing.key} ${current}→${result.value} (by ${by}) → ${into.path} (session=${sid})`,
  );
};

// Save (brandon-save-undo-bwi.hpi): every unsaved setting lands in the config
// file as ONE write. The drafts are derived at click time by the SAME function
// the render counts them with, over the config this session renders with, so
// the click writes exactly what the `💾 save N` cell counted.
// [LAW:no-ambient-temporal-coupling] The write and the picks it releases are
// one click, which lands whole (changeLanded): the picks are released in the
// turn the session's config reloads the file that now holds them, so no frame
// draws the old file without them, and a write refused here or by the host
// keeps every draft. Released, the session follows the file again — a later
// hand edit, another session's save, a reset — instead of pinning over it.
// [LAW:single-enforcer] Each value re-crosses the gate that admitted it as a
// session pick (the session's stateGate): a value the gate no longer admits is
// refused loudly here, never written to the file.
const save: VerbHandler = (value, ctx) => {
  const { sid, role } = configWire("save", value);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const pick = (key: string) => ctx.sessionState.get(sid, key);
  const drafts = settingDrafts(config, pick);
  const placements = placementDrafts(config, pick);
  // Nothing unsaved is the save's own postcondition already holding — a second
  // click on a bar drawn before the first save released its picks — so it is
  // a recorded no-op, never a failure the bar reports.
  if (drafts.length + placements.length === 0) {
    ctx.log("info", `save: nothing unsaved (session=${sid})`);
    return;
  }
  const gate = ctx.gates.state.gateFor(config);
  const pairs = drafts.map((d): readonly [string, string] => {
    const result = gate.validate(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save: ${result.reason}`);
    return [d.target, result.value];
  });
  gatePlacements("save", gate, placements);
  const into = heldLayer(ctx, origin, role);
  writeDrafts(editStore(ctx, sid), into, pairs, placements);
  for (const key of [
    ...drafts.map((d) => d.sessionKey),
    ...placements.map((p) => p.key),
  ]) {
    ctx.sessionState.clear(sid, key);
  }
  ctx.log(
    "info",
    `save: ${[
      ...pairs.map(([k, v]) => `${k}=${v}`),
      ...placements.map(placementLog),
    ].join(" ")} → ${into.path} (session=${sid})`,
  );
};

// [LAW:single-enforcer] A placement's value re-crosses the gate its control's
// click passed, as a display setting's does.
const placementLog = (p: PlacementDraft): string =>
  `${p.preset}/${p.id}.settings.${p.setting}=${settingSpelling(p.value)}`;

function gatePlacements(
  verb: string,
  gate: Gate,
  placements: readonly PlacementDraft[],
): void {
  for (const p of placements) {
    const result = gate.validate(p.key, settingSpelling(p.value));
    if (!result.ok) throw new BadVerbArgs(`${verb}: ${result.reason}`);
  }
}

// Save as preset (brandon-save-undo-bwi.o6u): the bar the session renders
// becomes `presets.<name>` in its config file (presetSnapshot), and the
// session switches to it. Once the file holds every setting the session had
// picked, those picks are released — the preset now renders them — so the
// session is left with one pick: the preset itself.
// [LAW:no-ambient-temporal-coupling] The pick and the preset it names land
// together, as a save's do (changeLanded): no frame draws a pick of a preset
// the loaded file lacks.
// [LAW:single-enforcer] Each pinned value re-crosses the session gate that
// admitted it, as a save's do.
const savePreset: VerbHandler = (value, ctx) => {
  const { sid, role } = configWire("save-preset", value);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const snapshot = presetSnapshot(config, (key) =>
    ctx.sessionState.get(sid, key),
  );
  const gate = ctx.gates.state.gateFor(config);
  const picks = snapshot.picks.map((d): readonly [keyof Globals, string] => {
    const result = gate.validate(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save-preset: ${result.reason}`);
    return [d.configKey, result.value];
  });
  gatePlacements("save-preset", gate, snapshot.placements);
  const into = heldLayer(ctx, origin, role);
  const name = writePreset(
    editStore(ctx, sid),
    into,
    snapshot.from,
    snapshot.globals,
    picks,
    snapshot.placements,
  );
  for (const key of [
    ...SETTING_PROJECTIONS.map((p) => p.sessionKey),
    ...snapshot.placements.map((p) => p.key),
  ]) {
    ctx.sessionState.clear(sid, key);
  }
  ctx.sessionState.set(sid, SETTINGS.preset.sessionKey, name);
  ctx.log(
    "info",
    `save-preset: ${[`${name} from=${snapshot.from}`, ...picks.map(([k, v]) => `${k}=${v}`), ...snapshot.placements.map(placementLog)].join(" ")} → ${into.path} (session=${sid})`,
  );
};

// Save the look the session draws as the active theme's default
// (candybar-theme-colours-6fq5.ix8): `themeDefaults.<theme>` in the session's
// written layer takes the session's shade, variation and style, and each of the
// session's picks of those three that the written file draws is released,
// so the session follows the file again, as a save's do. A field the config's
// globals declare is not the rung's to save (themeDefaultSave), so a pick of it
// is still a draft, and stays, so the bar does not move under the click.
// [LAW:no-ambient-temporal-coupling] The write and the release land together,
// as a save's do, read over the config the write's own load proved.
// [LAW:no-silent-failure] A theme chosen by a rule has no name until a render
// evaluates it, and a theme's default is keyed by name: refused, naming the
// rule, never a guess at what it would have rendered.
const saveThemeDefault: VerbHandler = (value, ctx) => {
  const { sid, role } = configWire("save-theme-default", value);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const save = themeDefaultSave(config, (key) =>
    ctx.sessionState.get(sid, key),
  );
  if (save.kind === "rule") {
    throw new BadVerbArgs(
      "save-theme-default: the theme is chosen by a rule (globals.palette), so there is no name to save as a theme's default — pick one in the menu first",
    );
  }
  const into = heldLayer(ctx, origin, role);
  const written = writeThemeDefault(
    editStore(ctx, sid),
    into,
    save.theme,
    save.look,
  );
  const pick = (key: string) => ctx.sessionState.get(sid, key);
  const drafted = new Set(
    settingDrafts(written, pick).map((d) => d.sessionKey),
  );
  const released = THEME_DEFAULT_FIELDS.map(
    (f) => SETTINGS[f].sessionKey,
  ).filter((key) => !drafted.has(key));
  for (const key of released) ctx.sessionState.clear(sid, key);
  ctx.log(
    "info",
    `save-theme-default: ${save.theme} ${THEME_DEFAULT_FIELDS.map((f) => `${f}=${save.look[f]}`).join(" ")} → ${into.path} (session=${sid})`,
  );
};

// Delete a preset the session's config file authors. A session that was in
// it returns to the file's default arrangement; any other session in it
// falls to the floor, as it would for a name deleted by hand.
const deletePreset: VerbHandler = (value, ctx) => {
  const {
    sid,
    role,
    args: [name = ""],
  } = configWire("delete-preset", value);
  if (!name) {
    throw new BadVerbArgs(
      "delete-preset: <name> is required (shape: <sessionId>/<layer>/<name>)",
    );
  }
  const origin = sessionOrigin(ctx, sid);
  const into = heldLayer(ctx, origin, role);
  deletePresetFromFile(editStore(ctx, sid), into, name);
  const key = SETTINGS.preset.sessionKey;
  if (ctx.sessionState.get(sid, key) === name) ctx.sessionState.clear(sid, key);
  ctx.log("info", `delete-preset: ${name} ← ${into.path} (session=${sid})`);
};

// [LAW:one-source-of-truth] `reset`: return each key to its bundled default
// at every layer that can hold it (resetLayers) — their paths in the session's
// config file, as ONE write, and the session's own picks. A `do` over several
// resets arrives here as one effect (batchAdjacentWrites), so reset all is one
// change, one reload, and one undo step. Gated by key MEMBERSHIP
// (the session's configGate's keys) rather than a value domain — there is no value to
// validate, only a legitimate target to clear — and every key is checked
// before anything is written, so a batch lands whole or not at all.
// [LAW:no-ambient-temporal-coupling] The write and the picks it clears land
// together, as a save's do, so no frame draws a pick's absence over a file
// that still holds the value.
const resetConfig: VerbHandler = (value, ctx) => {
  const { sid, role, args: keys } = configWire("reset-config", value);
  const origin = sessionOrigin(ctx, sid);
  const known = ctx.gates.config.gateFor(ctx.configFor(origin)).listKeys();
  const unknown =
    keys.length === 0 ? [""] : keys.filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${unknown.join('", "')}" (have: ${known.join(", ")})`,
    );
  }
  const into = heldLayer(ctx, origin, role);
  const layers = keys.map(resetLayers);
  const fileKeys = layers.flatMap((l) => l.fileKeys);
  const sessionKeys = layers.flatMap((l) => l.sessionKeys);
  deleteValues(editStore(ctx, sid), into, fileKeys);
  for (const k of sessionKeys) ctx.sessionState.clear(sid, k);
  ctx.log(
    "info",
    `reset-config: ${[...fileKeys, ...sessionKeys.map((k) => `session:${k}`)].join(" ")} ← ${into.path} (session=${sid})`,
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
      placed(after, preset).map((n) => configureMember(preset, placementId(n))),
    ),
  );
  return presetNames(before.presets).flatMap((preset) =>
    placed(before, preset)
      .map((node) => ({
        member: configureMember(preset, placementId(node)),
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
// allow-list machinery setConfig uses (configGate, derived from the session's
// config's declared removeSegment/insertSegment actions) — an op token no
// action declares is a loud BAD_REQUEST. [LAW:parse-dont-validate] The
// gate proves the VALUE is one an action allows; decodeLayoutOp stamps its
// shape, and the store proves the KEY is a preset-root target — a globals
// or segment-palette key smuggled through this verb is refused there.
const applyLayoutOp: VerbHandler = (rawValue, ctx) => {
  const {
    sid,
    role,
    args: [key = "", opToken = ""],
  } = configWire("apply-layout-op", rawValue);
  const origin = sessionOrigin(ctx, sid);
  const before = ctx.configFor(origin);
  const gate = ctx.gates.config.gateFor(before);
  if (!key) {
    throw new BadVerbArgs(
      `apply-layout-op: <key>/<op> is required (have: ${gate.listKeys().join(", ")})`,
    );
  }
  const result = gate.validate(key, opToken);
  if (!result.ok) throw new BadVerbArgs(`apply-layout-op: ${result.reason}`);
  const op = decodeLayoutOp(result.value);
  if (op === null) {
    throw new BadVerbArgs(
      `apply-layout-op: "${result.value}" is not a layout op token`,
    );
  }
  const into = heldLayer(ctx, origin, role);
  const { placed, config } = applyLayoutOpToFile(
    editStore(ctx, sid),
    into,
    key,
    op,
  );
  // A removed placement's session state ends with it (endedSessionKeys).
  // Measured on the config the write's own load proved, and released in the
  // same click, so its undo brings the placement and its drafts back.
  // The session state the edit discards — the fact its log line carries.
  const released = endedSessionKeys(
    endedPlacements(before, config),
    ctx.sessionState.get(sid, EDIT_CONFIGURE_KEY),
  ).filter((key) => ctx.sessionState.get(sid, key) !== null);
  for (const key of released) ctx.sessionState.clear(sid, key);
  // The placement an insertion wrote — its id minted here, at click time — is
  // the one fact of the edit the op token does not already carry.
  ctx.log(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${into.path} placed=${JSON.stringify(placed)} released=${JSON.stringify(released)} (session=${sid})`,
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
  const step = ctx.journal.undo(sid);
  ctx.log("info", `undo: restored ${describeStep(step)} (session=${sid})`);
};

// [LAW:single-enforcer] Back restores through the click's settings view, never
// a navigation journal, so going back is not itself a step it could return to.
const back: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  const { step, discarded } = ctx.navigation.back(
    sid,
    ctx.sessionState,
    ctx.gates.state.gateFor(sessionConfig(ctx, sid)),
  );
  const restored = step.map((c) => `${c.key}=${c.before ?? "∅"}`).join(" ");
  ctx.log("info", `back: ${restored} discarded=${discarded} (session=${sid})`);
};

// [LAW:single-enforcer] Cancel for edit mode. The history owns what changed
// since edit mode opened and how to put it back (SettingsHistory.rewind); this
// handler is plumbing between the wire and it, and says what it put back.
// [LAW:no-silent-failure] A session with no savepoint is a loud BAD_REQUEST
// with nothing written; a target changed since is one too, raised after every
// other target was put back, naming the target it kept.
const rewind: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  const restored = ctx.journal.rewind(sid);
  ctx.log(
    "info",
    `rewind: put back ${describeStep(restored) || "nothing"} as edit mode found it (session=${sid})`,
  );
};

// undo's mirror — steps the same history forward one click.
const redo: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const step = ctx.journal.redo(sid);
  ctx.log("info", `redo: re-applied ${describeStep(step)} (session=${sid})`);
};

// [LAW:effects-at-boundaries] The update notice's `[rebuild]` / `[upgrade]`
// click (brandon-build-notice-5d6). The wire carries only the session id (for
// click.error surfacing); the daemon's update watch decides what to run from
// its own provenance, so no command or version ever arrives from a URL.
const applyUpdate: VerbHandler = (value, ctx) =>
  ask(ctx, { kind: "apply-update", session: requireSessionId(oneArg(value)) });

// ─── Doctor (brandon-doctor-b6a) ────────────────────────────────────────────

// A run of the session's doctor, asked by this click (src/renderer/doctor.ts).
// [LAW:one-source-of-truth] It judges the load the session's bar is drawn
// from: the config discovery last handed in, so the verdict is on the bar the
// user sees, and a watch that cannot hear the files is the bar's own notice.
// The host reads the machine for it (src/daemon/cache/doctor.ts) once the
// turn's subscriptions name it, after the turn's changes have landed.
function startRun(ctx: ClickContext, sid: SessionId): void {
  const origin = sessionOrigin(ctx, sid);
  const run = ctx.doctorRuns.start(ctx.sessionState, sid, {
    at: ctx.now(),
    load: ctx.doctorLoad(origin),
    target: origin.target,
    pick: (key) => ctx.sessionState.get(sid, key),
    arrival: ctx.arrival,
  });
  noteRun(ctx, "started", run);
}

// A click while the session's run is on its way starts no other: the launcher
// refuses a probe within a second of the last of its kind, so a second run
// behind the first would be refused, and the first is the one the click asks.
function askRun(ctx: ClickContext, sid: SessionId): void {
  const waiting = ctx.doctorRuns.waiting(sid);
  if (waiting === null) startRun(ctx, sid);
  else noteRun(ctx, "joined", waiting);
}

// [LAW:nothing-unseen] The click's record names the run it asked, and how.
function noteRun(ctx: ClickContext, asked: RunAsked, run: number): void {
  noteFacts(ctx.record, {
    [DOCTOR_RUN_NOTE]: asked,
    [DOCTOR_RUN_NAME_NOTE]: String(run),
  });
}

// [LAW:single-enforcer] What a fix or a mark judges: the facts of the report
// the session's run wrote, never a reading made for another config or long
// enough ago that the terminal may have moved. With no such reading, the
// click starts a run unless one is on its way, and asks to be clicked again.
function reportedFacts(
  ctx: ClickContext,
  sid: SessionId,
  verb: string,
): DoctorFacts {
  const facts = ctx.doctorRuns.facts(sid, ctx.arrival, ctx.now());
  if (facts !== null) return facts;
  askRun(ctx, sid);
  throw new BadVerbArgs(
    `${verb}: the doctor's report is being read — click again once it is in`,
  );
}

const doctorRun: VerbHandler = (value, ctx) =>
  askRun(ctx, requireSessionId(oneArg(value)));

// The fix THIS check's verdict carries over the reported facts. A settings fix
// is a change guarded by what the run read of the one setting it writes
// (docs/design/host-and-renderer.md §7, A-3): the host lands it only while that
// setting is as read, so it applies only to the settings it diagnosed, and a
// setting moved since is refused with the reason on the bar. The run starts
// again either way, so the row is read again after the change landed or was
// refused.
const doctorFix: VerbHandler = (value, ctx) => {
  const [sessionId = "", checkName = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-fix: unknown check "${checkName}"`);
  }
  const facts = reportedFacts(ctx, sid, "doctor-fix");
  const verdict = check.probe(facts);
  if (verdict.ok || verdict.fix === undefined) {
    throw new BadVerbArgs(
      `doctor-fix: ${check.label} — ${verdict.ok ? "nothing to fix" : verdict.reason}`,
    );
  }
  const { fix } = verdict;
  // The fix, once it is asked for, ahead of the report it leads to.
  const asked = (): void =>
    ctx.log(
      "info",
      `doctor-fix: ${check.name} → ${describeFix(fix)} (session=${sid})`,
    );
  switch (fix.kind) {
    case "claude-settings":
      ctx.configWrites.changeSettings(
        fix.file.path,
        settingChange(fix, readSources(facts.claudeSettings)),
      );
      asked();
      startRun(ctx, sid);
      return;
    case "post-mortems-read": {
      const read = ctx.doctorStores.postMortemsRead.update(
        readThrough(fix.through),
      );
      if (read.kind === "failed") {
        throw new BadVerbArgs(`doctor-fix: ${check.label} — ${read.reason}`);
      }
      asked();
      ctx.doctorRuns.report(
        ctx.sessionState,
        sid,
        { ...facts, daemon: { ...facts.daemon, read } },
        ctx.record,
      );
      return;
    }
  }
};

// Record what the user saw of the glyphs THIS check's verdict shows, under the
// sighting they are, then write the report again with the mark folded in.
const doctorMark: VerbHandler = (value, ctx) => {
  const [sessionId = "", checkName = "", mark = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-mark: unknown check "${checkName}"`);
  }
  if (!(GLYPH_MARKS as readonly string[]).includes(mark)) {
    throw new BadVerbArgs(
      `doctor-mark: the mark is ${JSON.stringify(mark)}, not ${GLYPH_MARKS.join(" or ")}`,
    );
  }
  const facts = reportedFacts(ctx, sid, "doctor-mark");
  const verdict = check.probe(facts);
  if (verdict.ok || verdict.sighting === undefined) {
    throw new BadVerbArgs(
      `doctor-mark: ${check.label} — ${verdict.ok ? "nothing to mark" : "shows nothing to look at"}`,
    );
  }
  const made = [check.name, verdict.sighting.id, mark as GlyphMark] as const;
  // [LAW:single-enforcer] The store refuses to file over a book that does
  // not read; that refusal is the click's.
  const marks = ctx.doctorStores.marks.update((book) =>
    withMark(book, ...made),
  );
  if (marks.kind === "failed") {
    throw new BadVerbArgs(`doctor-mark: ${marks.reason}`);
  }
  ctx.log(
    "info",
    `doctor-mark: ${check.name} ${mark} on ${verdict.sighting.id} (session=${sid})`,
  );
  ctx.doctorRuns.report(ctx.sessionState, sid, { ...facts, marks }, ctx.record);
};

// ─── Slash commands (brandon-context-ceiling-xta.7xt) ───────────────────────

// [LAW:parse-dont-validate] A click's line is honoured only as one a `slash`
// action in the session's config declares — the declaration found supplies
// the SlashLine typed, so the URL chooses among the config's lines and can
// add none. The pane is the one the session's live request reported.
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
  // [LAW:no-silent-failure] The pane the session's live request names: one
  // read back from the book may be another session's by now, so a session
  // whose request the daemon does not hold is typed into nowhere until its
  // next request.
  const live = contextFor(ctx.context, sid)?.live ?? null;
  if (live === null)
    throw new BadVerbArgs(
      `${line} was not typed: the daemon holds no request of session ${sid}, so its pane is not known until its next request`,
    );
  const pane = tmuxPaneOf(live.hints.tmux);
  if (pane.kind === "refused")
    throw new BadVerbArgs(`${line} was not typed: ${pane.reason}`);
  ask(ctx, {
    kind: "type-slash",
    session: sid,
    pane: pane.hint,
    line: action.slash,
  });
};

// ─── Run (a `run` action) ───────────────────────────────────────────────────

// [LAW:parse-dont-validate] A run link is honoured only when it names a `run`
// action the session's config declares and its mac verifies — it was drawn by
// this daemon's key, for this session, from that declaration as it stands
// now, with exactly the program, arguments and environment it carries. The
// directory the program runs in and the sources it refreshes come from that
// declaration, never from the link. Any web page can open a `cc-candybar://`
// link, so either check failing refuses the click before anything runs.
function runOf(
  [sessionId = "", action = "", evaluated = "", mac = ""]: readonly string[],
  ctx: VerbContext,
): Extract<ActRequest, { kind: "run" }> {
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const actions = ctx.configFor(origin).actions;
  const decl = Object.hasOwn(actions, action) ? actions[action] : undefined;
  if (decl === undefined || !("run" in decl)) {
    throw new BadVerbArgs(
      `"${action}" is not a run action this session's config declares`,
    );
  }
  const declaration = runDeclaration(decl);
  if (
    !ctx.links.verify({ sessionId: sid, action, declaration, evaluated }, mac)
  ) {
    throw new BadVerbArgs(
      "the link's signature does not match what it carries: it was not drawn by this daemon, or its action has been edited since it was drawn",
    );
  }
  // Signed, so it is what a draw wrote: the JSON of an EvaluatedRun.
  let drawn: EvaluatedRun;
  try {
    drawn = JSON.parse(evaluated) as EvaluatedRun;
  } catch {
    throw new BadVerbArgs(`run ${action}: what the link carries is not JSON`);
  }
  const [program, ...args] = drawn.run;
  if (program === undefined || program === "") {
    throw new BadVerbArgs(`run ${action}: the program evaluated to nothing`);
  }
  const sources = ctx.sourcesFor(origin);
  return {
    kind: "run",
    session: sid,
    action,
    program,
    args,
    // [LAW:single-enforcer] The action's own variables only: the host lays
    // them over the session's environment, which no renderer holds.
    env: drawn.env,
    // The bundled config's runs go in the user's home.
    cwd: decl.cwd ?? ctx.locations.home,
    // The loader proved every name a declared source of this config, whose
    // state holds its folder.
    refreshes: decl.refreshes.map((name) => ({
      name,
      folder: sources.get(name)!,
    })),
  };
}

const run: VerbHandler = (value, ctx) =>
  ask(
    ctx,
    runOf(
      decodeWire(() => decodeSegments(value)),
      ctx,
    ),
  );

// ─── Repository configs (brandon-unfiled-3248.kezw) ─────────────────────────

// [LAW:parse-dont-validate] An answer is recorded only when its mac verifies:
// the question drew it, for this session, for this directory and this answer.
// The link's own signature proves only that the bar drew the link, and a
// config can draw any link, so the answer keeps a mac of its own. The book
// lives beside the link key. The host lands the answer with the click's
// changes or not at all, and its config discovery then hands in a new config
// for every origin with a repository to ask about, the clicking session's
// before the click answers.
const repoConfig: VerbHandler = (value, ctx) => {
  const [sessionId = "", dir = "", answer = "", mac = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const answered = REPO_ANSWERS.find((known) => known === answer);
  if (
    answered === undefined ||
    !ctx.links.verify(repoAnswerFields(sid, dir, answered), mac)
  ) {
    throw new BadVerbArgs(
      "the answer's signature does not match what it carries: it was not drawn by this daemon",
    );
  }
  ctx.configWrites.answer(dir, answered);
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
// dispatch unrepresentable, matching src/renderer/session-state.ts.
const LEAF_VERBS = new Map<string, VerbHandler>([
  [VERB_COPY, copy],
  [VERB_OPEN_VSCODE, openVscode],
  [VERB_SET_STATE, setState],
  [VERB_STEP_STATE, stepState],
  [VERB_SET_CONFIG, setConfig],
  [VERB_STEP_CONFIG, stepConfig],
  [VERB_RESET_CONFIG, resetConfig],
  [VERB_SAVE, save],
  [VERB_SAVE_PRESET, savePreset],
  [VERB_SAVE_THEME_DEFAULT, saveThemeDefault],
  [VERB_DELETE_PRESET, deletePreset],
  [VERB_APPLY_LAYOUT_OP, applyLayoutOp],
  [VERB_UNDO, undo],
  [VERB_REDO, redo],
  [VERB_BACK, back],
  [VERB_REWIND, rewind],
  [VERB_APPLY_UPDATE, applyUpdate],
  [VERB_DOCTOR_RUN, doctorRun],
  [VERB_DOCTOR_FIX, doctorFix],
  [VERB_DOCTOR_MARK, doctorMark],
  [VERB_SLASH, slash],
  [VERB_RUN, run],
  [VERB_REPO_CONFIG, repoConfig],
  [VERB_COPY_DIAGNOSTIC, copyDiagnostic],
]);

// One effect of a click: its verb and its value.
type Step = ReturnType<typeof parseEffects>[number];

// [LAW:dataflow-not-control-flow] A click is a list of effects: a `dispatch`
// link's own list, and any other link one effect, its verb's, so a click of
// one and of a hundred walk the one fold. Each run of adjacent set-state (or
// reset-config) effects is joined into the one batch that lands whole.
function stepsOf(verb: string, value: string): readonly Step[] {
  return batchAdjacentWrites(
    verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }],
  );
}

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects
// (`stepsOf`); the fold runs EVERY effect through the leaf table.
// [LAW:no-silent-failure] Every effect runs even if an earlier one failed;
// failures accumulate in `errors`. An unknown or non-leaf (e.g. nested
// `dispatch`) verb is a miss in LEAF_VERBS — reported, never executed.
//
// [LAW:types-are-the-program] The aggregate PRESERVES the dispatcher's
// input-vs-operational error classification: a leaf throws BadVerbArgs for bad
// input (→ BAD_REQUEST) and a plain Error for an operational failure
// (→ RENDER_FAILED). If ANY effect failed
// operationally, the whole click failed operationally (plain Error); only when
// every failure is an input error does the aggregate stay BadVerbArgs. An
// unknown verb is bad input — it does not flip the classification.
//
// [LAW:one-source-of-truth] Per-effect errors are written to session state
// so the bar shows WHICH effect(s) failed, for the hold src/daemon/foundations/click-error.ts
// sets. Only possible when the click names a session.
function foldEffects(
  steps: readonly Step[],
  sid: SessionId | null,
  ctx: ClickContext,
): void {
  const errors: string[] = [];
  let operational = false;
  for (const { verb, value } of steps) {
    const leaf = LEAF_VERBS.get(verb);
    if (!leaf) {
      errors.push(`unknown effect verb "${verb}"`);
      continue;
    }
    try {
      leaf(value, ctx);
    } catch (e) {
      // [LAW:single-enforcer] Classified once, by failureOf. A click the
      // daemon's close cut off is over: no later effect runs, it keeps its
      // own class, and what failed before it has no bar left to reach, so the
      // log has it.
      const failure = failureOf(e);
      if (failure.kind !== "bad-request" && failure.kind !== "threw") {
        if (errors.length > 0) ctx.log("warn", `click: ${errors.join("; ")}`);
        throw e;
      }
      if (failure.kind === "threw") operational = true;
      errors.push(`${verb}: ${failure.message}`);
    }
  }
  if (errors.length > 0) {
    if (sid !== null)
      holdClickError(ctx.sessionState, sid, errors.join("\n"), ctx.now());
    const message = errors.join("; ");
    throw operational ? new Error(message) : new BadVerbArgs(message);
  }
}

// [LAW:single-enforcer] One click is one undoable step, so the step boundary
// is the click boundary: every entry of the table the daemon looks up against
// runs inside a journal it opens and commits. `dispatch` folds its effects
// through the RAW leaf table, so a click of N effects is one journal and one
// step, never N. The commit runs even when a handler threw — whatever it did
// before the throw is real, so it is recorded. [LAW:no-silent-failure] A
// commit that fails too never hides the handler's own error: the click
// reports both.
//
// [LAW:no-ambient-temporal-coupling] The commit and what follows it are the
// click's consequence (src/renderer/config-writes.ts): applied at once by a
// click that changed no config file, and otherwise in the turn its changes
// land (changeLanded), or never, when they are refused.
//
// [LAW:no-ambient-temporal-coupling] It runs whole within one turn, begin
// through seal: the host's mailbox hands the renderer one input at a time,
// and a handler awaits nothing, so no other journal opens beside it.
function journaled<C extends DaemonContext>(
  verb: string,
  sid: SessionId | null,
  context: SessionContext | null,
  ctx: C,
  effects: Effect[],
  handler: (ctx: Journaled<C>) => void,
): void {
  const origin = sid === null ? null : originOf(context, sid);
  ctx.configWrites.begin(verb, () => {
    if (origin === null)
      throw new BadVerbArgs(
        `${verb}: the click names no session that has rendered — no config to write`,
      );
    return { origin, chain: ctx.snapshotFor(origin).chain };
  });
  const journal = ctx.history.begin({
    read: (file) => ctx.configWrites.read(file),
    land: (file, before, after) => ctx.configWrites.land(file, before, after),
    roleOf: (file) => ctx.configWrites.roleOf(file),
    pathOf: (role) => ctx.configWrites.pathOf(role),
    prove: (file, text, read) =>
      proveLoadsAsLayer(ctx, origin, file, text, read),
  });
  const navigation = ctx.navigation.begin(journal.sessionState);
  const failures: unknown[] = [];
  // Both views close what a write closes, the navigating one above its
  // recording, so ◁ back restores a closed menu with what was open in it.
  const closing = (store: SessionStateRW): SessionStateRW =>
    closingView(
      store,
      (sid) => nestOf(ctx, context, sid),
      (line) => ctx.log("info", line),
    );
  try {
    handler({
      ...ctx,
      session: sid,
      context,
      sessionState: closing(journal.sessionState),
      journal,
      navigating: closing(navigation.sessionState),
    });
  } catch (e) {
    failures.push(e);
  }
  // Each commit runs whatever the other did: both record what landed.
  const consequence = (): void => {
    const failed: unknown[] = [];
    for (const step of [navigation, journal]) {
      try {
        step.commit();
      } catch (e) {
        failed.push(e);
      }
    }
    throwAll(failed);
  };
  try {
    ctx.configWrites.seal(effects, sid, consequence);
  } catch (e) {
    failures.push(e);
  }
  throwAll(failures);
}

// [LAW:single-enforcer] A click: a journal around the fold of its effects,
// in its turn.
function click(verb: string): (value: string, ctx: VerbContext) => void {
  return (value, ctx) => {
    const session = clickSessionOf(verb, value);
    const sid = session?.ok ? session.id : null;
    const steps = stepsOf(verb, value);
    journaled(verb, sid, ctx.context, ctx, ctx.effects, (c) => {
      try {
        foldEffects(steps, sid, c);
      } finally {
        if (sid !== null) ctx.clickLanded(sid);
      }
    });
  };
}

// [LAW:one-source-of-truth] The full table the daemon looks up against: every
// leaf verb, and `dispatch`, whose value lists them. Old scrollback links that
// name a leaf verb directly still resolve here; new renders all emit
// `dispatch`.
export const VERBS: ReadonlyMap<
  string,
  (value: string, ctx: VerbContext) => void
> = new Map(
  [...LEAF_VERBS.keys(), VERB_DISPATCH].map(
    (verb) => [verb, click(verb)] as const,
  ),
);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];

// [LAW:single-enforcer] The idle close (brandon-menus-sjhy.my3) takes
// a click's own path: the journals the verb table opens — so an exit from edit
// mode releases its savepoint, and ◁ back can reopen what it closed — and the
// closing view, which folds everything open inside what closes. It writes
// `closed` to each menu open at the top, the write its ✕ makes. No URL names
// it: it is not in VERBS. It runs in a `due` turn, so a click lands wholly
// before it or after it, and a `due` waits behind every input that arrives
// while it waits, so a click that has arrived lands before it: it restarts
// the idle period, and the close is not due.
export function closeIdleMenus(
  sid: SessionId,
  context: SessionContext | null,
  idle: IdleSpan,
  ctx: DaemonContext,
  effects: Effect[],
): void {
  journaled("menu-idle", sid, context, ctx, effects, (c) => {
    const roots = openRoots(nestOf(c, context, sid), (key) =>
      c.navigating.get(sid, key),
    );
    c.navigating.setBatch(
      sid,
      roots.map(({ key }) => ({ key, value: DISCLOSURE_CLOSED })),
    );
    c.log(
      "info",
      `menu-idle: closed=${roots.map(({ key }) => key).join(",") || "-"} ` +
        `idle=${idle.idleS.toFixed(1)}s timeout=${idle.timeoutS}s (session=${sid})`,
    );
  });
}
