import { randomBytes } from "node:crypto";
import {
  heldAside,
  routedWrites,
  staleEdit,
  type EditFinish,
  type EditTransactions,
} from "../edit-transaction.js";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../config/loader/edit-mode.js";
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
import { layerAtPath, type ConfigSnapshot } from "../../config/config-snapshot";
import {
  LAYER_ROLES,
  layerRoleOf,
  type LayerRole,
} from "../../config/layer-role";
import type { SessionStateRW } from "../../renderer-interface/session-state";
import { holdClickError } from "../../daemon/foundations/click-error";
import type { Instant } from "../../utils/instant";
import { stateKeyShown, configKeyShown, configKeySeed } from "./key-seeds";
import {
  landing as landOnOption,
  parseOffset,
  parseStep,
  type OptionStep,
} from "../../render/option-ring";
import {
  pageCount,
  pageHolding,
  pageShown,
  parsePageMap,
  type PageMap,
} from "../../render/page-map";
import { resolveOptionDomain } from "../../config/option-domain";
import { configOptionDomains } from "../../config/edit-chrome";
import {
  disclosureNest,
  NO_NEST,
  openRoots,
  type DisclosureNest,
} from "../../config/disclosure-nest";
import { DISCLOSURE_CLOSED } from "../../config/disclosure";
import {
  CLICK_MODE_KEY,
  DEFAULT_CLICK_MODE,
  HOVER_KEY,
  clickModeOf,
  modeIsOpen,
  NO_HOVER,
} from "../../config/click-mode";
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
  readDeclared,
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
  type ConfigFiles,
  type Journal,
  type SettingsHistory,
} from "../settings-history";
import type {
  EndedVisits,
  MenuContext,
  NavigationHistory,
  NavigationTurn,
} from "../navigation-history";
import {
  settingSpelling,
  type DslConfig,
  type Globals,
} from "../../config/dsl-types";
import { THEME_DEFAULT_FIELDS } from "../../config/globals-fields";
import { isEditModeKey, isPlacementDraftKey } from "../../config/session-key";
import {
  durableLanding,
  placementDrafts,
  placementPickProblems,
  presetSnapshot,
  type PlacementDraft,
  resetLayers,
  settingDrafts,
  unsavedCount,
  themeDefaultSave,
} from "../setting-drafts";
import { SETTINGS } from "../../config/setting-projections";
import { settingTable } from "../../config/setting-table";
import { decodeLayoutOp } from "../../config/layout-ops";
import {
  VERB_APPLY_LAYOUT_OP,
  VERB_COPY,
  VERB_REDO,
  VERB_BACK,
  VERB_REWIND,
  VERB_RESET_CONFIG,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_SAVE_THEME_DEFAULT,
  VERB_DELETE_PRESET,
  VERB_RING_CONFIG,
  VERB_RING_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_TURN_PAGE,
  VERB_UNDO,
  VERB_SLASH,
  VERB_COPY_DIAGNOSTIC,
  type AdmittedClick,
  type StateWriteEffect,
  type ClickStep,
  type GlobalStep,
} from "../../click/wire";
import {
  requireLayerText,
  type ConfigWrites,
  type Landed,
} from "../config-writes";
import type { LayerContent } from "../../config/config-snapshot.js";
import type {
  ActRequest,
  Effect,
  EffectId,
  EffectOutcome,
} from "../../renderer-interface/interface";
import type {
  DeclaredSources,
  SessionContext,
} from "../../renderer-interface/request-context";
import {
  headOf,
  runDeclaration,
  type ActionDecl,
  type SlashAction,
} from "../../config/action";
import type { ClickArrival } from "../../renderer-interface/click-arrival";
import type { RenderOrigin } from "../../config-hint";
import { tmuxPaneOf } from "../../claude-input/typing";
import { BadVerbArgs, failureOf } from "../../daemon/foundations/verb-error";
import type { RequestFacts } from "../../daemon/foundations/request-event";
import type { ActsOnTheirWay } from "../acts";
import { type SessionId } from "../../daemon/foundations/session-id";
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
  // [LAW:one-source-of-truth] The one undo history over every settings change
  // (src/renderer/settings-history.ts). The verb table opens a journal on it
  // around each click, so a handler records by writing, never by remembering.
  readonly history: SettingsHistory;
  readonly edits: EditTransactions;
  readonly editViewChanged: (sid: SessionId) => void;
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
  readonly configFor: (origin: RenderOrigin, editing?: SessionId) => DslConfig;
  // [LAW:single-enforcer] Where every click's config writes go: changes its
  // turn returns, and its consequence held until they land
  // (src/renderer/config-writes.ts).
  readonly configWrites: ConfigWrites;
  // The storage folder of each source that config declares, from the same
  // render state: what a `run` supersedes.
  readonly sourcesFor: (origin: RenderOrigin) => DeclaredSources;
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
  // THIS click's turn record.
  readonly record: RequestFacts;
}

// A context with the journals the verb table opens around a write.
export type Journaled<C extends DaemonContext> = C & {
  readonly session: SessionId;
  readonly context: SessionContext | null;
  readonly journal: Journal;
  readonly readConfigFile: (file: string) => LayerContent;
  readonly finishEdit: (finish: EditFinish) => void;
  readonly menu: NavigationTurn;
};

// What a handler runs with: the daemon's context, with `sessionState` the
// click's journaling view of it and `journal` where its file writes report.
// `menu` applies the click's navigational transitions in that same turn.
export type ClickContext = Journaled<VerbContext>;

// The host has decoded the arguments and admitted the session. Each handler
// checks what its own action requires and returns external acts as effects.
export type VerbHandler = (args: readonly string[], ctx: ClickContext) => void;

export { BadVerbArgs };

// [LAW:single-enforcer] What a handler asks of the host: an act in its
// click's turn, performed once the click's changes have landed.
function ask(
  ctx: Pick<VerbContext, "acts" | "effects">,
  act: ActRequest,
): void {
  ctx.acts.ask(ctx.effects, act);
}

function globalAct(
  step: Exclude<GlobalStep, { kind: "invalid" }>,
  ctx: VerbContext,
  session: SessionId | null,
): void {
  ask(
    ctx,
    step.verb === VERB_COPY
      ? { kind: "copy", session, text: step.value }
      : { kind: "open", session, target: step.value },
  );
}

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
const copyDiagnostic: VerbHandler = (args, ctx) => {
  const [by = "", key = ""] = args;
  const sid = ctx.session;
  const text = ctx.diagnosticCopy(sid, requireDrawer(by), key);
  if (text === undefined)
    throw new BadVerbArgs(
      `that message is no longer listed in session ${sid}'s diagnostics — open the indicator beside the settings door again and copy from there`,
    );
  ask(ctx, { kind: "copy", session: sid, text });
};

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
const setState: VerbHandler = (rest, ctx) => {
  const sid = ctx.session;
  const config = sessionConfig(ctx);
  const gate = ctx.gates.state.gateFor(config);
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
  refuseDisorderedPicks(ctx, "set-state", validated);
  // [LAW:single-enforcer] One write call, one log line format. setBatch
  // is the seam that owns reactive atomicity — every pair lands before
  // observers fire, so an autorun never sees half-applied batch state.
  // Partial application is unrepresentable: validation already passed,
  // and the seam guarantees the writes ship as one transaction.
  ctx.menu.choose(sid, validated, () => menuContext(ctx, sid, config));
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
const stepState: VerbHandler = (args, ctx) => {
  const [key = "", byRaw = ""] = args;
  const sid = ctx.session;
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
  const config = sessionConfig(ctx);
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
  // [LAW:one-source-of-truth] A step moves from what the bar shows: a
  // setting's fold, so a stale pick steps from the value the bar wears.
  const clamped = stepFrom(
    "step-state",
    key,
    params,
    stateKeyShown(config, (k) => ctx.sessionState.get(sid, k), key),
  );
  const next = stepWithin(clamped, by, params.min, params.max);
  const result = gate.validate(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-state: ${result.reason}`);
  refuseDisorderedPicks(ctx, "step-state", [{ key, value: result.value }]);
  ctx.menu.choose(sid, [{ key, value: result.value }], () =>
    menuContext(ctx, sid, config),
  );
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
  ctx: ClickContext,
  verb: string,
  writes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): void {
  const picks = writes.filter((w) => isPlacementDraftKey(w.key));
  if (picks.length === 0) return;
  const problems = placementPickProblems(
    sessionConfig(ctx),
    (k) => ctx.sessionState.get(ctx.session, k),
    picks,
  );
  if (problems.length > 0) {
    throw new BadVerbArgs(`${verb}: refused — ${problems.join("; ")}`);
  }
}

function clampTo(params: RangeParams, n: number): number {
  return Math.max(params.min, Math.min(params.max, n));
}

// [LAW:no-defensive-null-guards] "unset" is a real state: a key steps from
// the value it shows (`shown`, resolved from the session's picks). A key that
// shows nothing steps from `min`; one that shows a non-integer is a stepper
// over a value that is no number, refused loudly rather than stepped from a
// guess.
function stepFrom(
  verb: string,
  key: string,
  params: RangeParams,
  shown: string | null,
): number {
  if (shown === null) return params.min;
  if (!STEP_INT_RE.test(shown)) {
    throw new BadVerbArgs(
      `${verb}: "${key}" shows ${JSON.stringify(shown)}, not an integer to step`,
    );
  }
  return clampTo(params, parseInt(shown, 10));
}

// ─── The durable store: which file, and the history over it ─────────────────

// [LAW:no-silent-failure] A session the click's context names nothing of has
// no origin and therefore no config — a loud BadVerbArgs, not the daemon's
// own XDG guess.
function sessionOrigin(
  ctx: Pick<ClickContext, "session" | "context">,
): RenderOrigin {
  if (ctx.context === null) {
    throw new BadVerbArgs(
      `session ${ctx.session} has not rendered yet — no config to act on`,
    );
  }
  return ctx.context.durable.origin;
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
  read: (file: string) => LayerContent,
): void {
  const layer =
    origin === null
      ? undefined
      : layerAtPath(ctx.snapshotFor(origin).chain, file);
  if (origin === null || layer === undefined)
    throw new BadVerbArgs(
      `${file} is not a config file this session renders from — its step is not taken`,
    );
  proveLoads(heldLayer(ctx, origin, layer.role), text, read);
}

// [LAW:one-source-of-truth] The config a session renders — what its clicks
// read, and what gates them: a session's gate is its own config's, never a
// merge of every config the daemon holds.
function sessionConfig(
  ctx: Pick<ClickContext, "configFor" | "session" | "context">,
): DslConfig {
  return ctx.configFor(sessionOrigin(ctx));
}

function menuContext(
  ctx: Pick<DaemonContext, "gates" | "edits">,
  sid: SessionId,
  config: DslConfig,
): MenuContext {
  return {
    gate: ctx.gates.state.gateFor(config),
  };
}

// What the session's config nests; a session the context names nothing of
// has no config, so nothing nested.
function nestOf(
  ctx: DaemonContext,
  origin: RenderOrigin | null,
): DisclosureNest {
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
    origin.target.source === "argument-only" ? origin.target.path : null,
    ctx.locations.home,
  );
}

// The first decoded config write argument names its layer. The remaining
// arguments describe the write's value or operation.
function configArgs(
  verb: string,
  [layer = "", ...args]: readonly string[],
): { role: LayerRole; args: string[] } {
  const role = layerRoleOf(layer);
  if (role === null)
    throw new BadVerbArgs(
      `${verb}: "${layer}" is not a config layer (one of ${LAYER_ROLES.join(", ")})`,
    );
  return { role, args };
}

function editStore(ctx: ClickContext, sid: SessionId): EditStore {
  return {
    read: ctx.readConfigFile,
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
const setConfig: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const {
    role,
    args: [key = "", incoming = ""],
  } = configArgs("set-config", args);
  const origin = sessionOrigin(ctx);
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
const stepConfig: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const {
    role,
    args: [key = "", byRaw = ""],
  } = configArgs("step-config", args);
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
  const origin = sessionOrigin(ctx);
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
  const declared = readDeclared(
    requireLayerText(into.path, store.read(into.path)),
    landing.key,
  );
  // [LAW:no-silent-failure] A layer that declares the key holds an integer, to
  // step from (clamped into the stepper's own range), or something else, which
  // is refused naming what the layer holds: a step from the value the bar draws
  // would overwrite what its author wrote.
  if (declared.kind === "other" || declared.kind === "text") {
    throw new BadVerbArgs(
      `step-config: ${landing.key} holds ${declared.source} in ${into.path}, not an integer to step`,
    );
  }
  const current =
    declared.kind === "integer"
      ? clampTo(params, declared.value)
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

// [LAW:one-source-of-truth] The option ring an action's link names, read the
// way the draw reads it: the options are the head's own domain, resolved over
// this session's config as the compile resolved them, and the value the ring
// starts from is the one the bar wears (the fold behind its `.effective`),
// except for a persist twin, which steps its own layer's value (ringConfig). A
// `do` is its head's ring.
interface OptionRing {
  readonly twin: "set" | "persist";
  readonly key: string;
  readonly options: readonly string[];
  // What the key shows now, or null when it names nothing yet (a theme chosen
  // by a rule has no name until a render evaluates it).
  readonly shown: string | null;
}

function headFor(config: DslConfig, name: string): ActionDecl | undefined {
  const action = config.actions[name];
  return action === undefined ? undefined : headOf(config.actions, action);
}

// The options an action lists: a ring's own, a cycle's members, or the list a
// structural insert picks from.
function optionsOf(
  config: DslConfig,
  head: ActionDecl,
): readonly string[] | undefined {
  if ("cycle" in head) return head.cycle;
  const domain =
    "from" in head
      ? head.from
      : "insertSegmentFrom" in head
        ? head.insertSegmentFrom
        : undefined;
  return domain === undefined
    ? undefined
    : resolveOptionDomain(domain, configOptionDomains(config)).members;
}

// The ring a `set` or `persist` head over a list of options, or a cycle's
// members, holds, or nothing for any other action (a structural insert has a
// list but holds no value).
function ringHeld(
  ctx: ClickContext,
  config: DslConfig,
  head: ActionDecl,
): OptionRing | undefined {
  // A structural insert lists options too, but holds no value.
  const options =
    "from" in head || "cycle" in head ? optionsOf(config, head) : undefined;
  if (options === undefined) return undefined;
  const pick = (k: string) => ctx.sessionState.get(ctx.session, k);
  if ("set" in head)
    return {
      twin: "set",
      key: head.set,
      options,
      shown: stateKeyShown(config, pick, head.set),
    };
  if ("persist" in head)
    return {
      twin: "persist",
      key: head.persist,
      options,
      shown: configKeyShown(config, pick, head.persist),
    };
  return undefined;
}

function ringOf(
  verb: string,
  ctx: ClickContext,
  name: string,
  twin: OptionRing["twin"],
): OptionRing {
  const config = sessionConfig(ctx);
  const head = headFor(config, name);
  const ring = head === undefined ? undefined : ringHeld(ctx, config, head);
  if (ring === undefined || ring.twin !== twin) {
    throw new BadVerbArgs(
      `${verb}: "${name}" is not a ${twin} action over a list of options`,
    );
  }
  if (ring.options.length === 0)
    throw new BadVerbArgs(`${verb}: "${name}" has no options to step through`);
  return ring;
}

// [LAW:parse-dont-validate] The step a link carried, or a refusal naming it.
function stepOf(verb: string, raw: string): OptionStep {
  const parsed = parseStep(raw);
  if (!parsed.ok) throw new BadVerbArgs(`${verb}: ${parsed.problem}`);
  return parsed.step;
}

function pageMapOfLink(
  verb: string,
  raw: string,
  options: readonly string[],
): PageMap {
  const parsed = parsePageMap(raw, options.length);
  if (!parsed.ok) throw new BadVerbArgs(`${verb}: ${parsed.problem}`);
  return parsed.map;
}

// The page cursor a ring step also turns, as the link carried it, or nothing:
// `pageKey, pageLayout`.
interface PageTurn {
  readonly key: string;
  readonly map: PageMap;
}

function turnOf(
  verb: string,
  raw: readonly string[],
  options: readonly string[],
): PageTurn | undefined {
  if (raw.length === 0) return undefined;
  const [key, layout, ...extra] = raw;
  if (!key || layout === undefined || extra.length > 0)
    throw new BadVerbArgs(
      `${verb}: a page turn is <pageKey>/<pageLayout>, got ${raw.length} segment(s)`,
    );
  return { key, map: pageMapOfLink(verb, layout, options) };
}

// [LAW:no-ambient-temporal-coupling] The page the landed option stands on is
// derived here, from the landing, and written with it: a persist write lands
// after the click, so a second effect that read the key would turn the row to
// the page of the value from before the click.
const turnWrites = (
  turn: PageTurn | undefined,
  options: readonly string[],
  landed: string,
): string[] =>
  turn === undefined
    ? []
    : [turn.key, String(pageHolding(turn.map, options.indexOf(landed)))];

interface RingLanding {
  readonly ring: OptionRing;
  readonly next: string;
  readonly turn: string[];
}

// [LAW:one-source-of-truth] A step through an option ring, resolved against the
// value the key holds NOW, which `held` reads, so N clicks without a redraw
// land N steps. A key that holds no name starts where the draw centred
// (`centre`, the value its read-back variable had): the one thing only a
// render can evaluate.
function landRing(
  verb: string,
  ctx: ClickContext,
  name: string,
  twin: OptionRing["twin"],
  [stepRaw, centre, ...turnRaw]: readonly string[],
  held: (ring: OptionRing) => string | null,
): RingLanding {
  // [LAW:no-silent-failure] `centre` is empty when no rule chooses the key; a
  // link that lacks the slot is malformed, never a ring from the first option.
  if (stepRaw === undefined || centre === undefined)
    throw new BadVerbArgs(
      `${verb}: a ring step is <step>/<centre>[/<pageKey>/<pageLayout>]`,
    );
  const ring = ringOf(verb, ctx, name, twin);
  const turn = turnOf(verb, turnRaw, ring.options);
  const from = held(ring) ?? centre;
  const step = stepOf(verb, stepRaw);
  const next = landOnOption(ring.options, from, step, ctx.now());
  ctx.log(
    "info",
    `${verb}: ${ring.key} ${JSON.stringify(from)}→${JSON.stringify(next)} (step ${stepRaw}, session=${ctx.session})`,
  );
  return { ring, next, turn: turnWrites(turn, ring.options, next) };
}

// A step lands in SessionState through the write every set action makes: the
// same gate, the same batch (setState), the page turn riding in it.
function ringStatePairs(args: readonly string[], ctx: ClickContext): string[] {
  const [name = "", ...rest] = args;
  const { ring, next, turn } = landRing(
    "ring-state",
    ctx,
    name,
    "set",
    rest,
    (r) => r.shown,
  );
  return [ring.key, next, ...turn];
}

// [LAW:single-enforcer] A click's adjacent state writes are one write: each
// ring step is resolved to its pairs against the state the click found, and
// setState validates every pair before it writes any, so a `do` that steps a
// cycle and resets its page cursor lands both or neither.
function landStateWrites(
  writes: readonly StateWriteEffect[],
  ctx: ClickContext,
): void {
  setState(
    writes.flatMap(({ verb, args }) =>
      verb === VERB_RING_STATE ? ringStatePairs(args, ctx) : args,
    ),
    ctx,
  );
}

// The name a layer's text declares at a value key, or nothing when it declares
// none or something that is no name.
function declaredName(text: string | null, key: string): string | undefined {
  const declared = readDeclared(text, key);
  return declared.kind === "text" ? declared.value : undefined;
}

// `persist`'s twin of a ring-state step: the option lands in the layer's file
// through setConfig, and the page turn, which is session state, with it.
// [LAW:one-source-of-truth] The ring steps from what the bar wears while the
// session holds a pick of the key; else the value of the layer it writes, as
// step-config does: the name that layer's file declares, which carries an
// earlier click's write the bar has not reloaded, else what the bar wears (the
// layer declares no name, or a rule).
const ringConfig: VerbHandler = (args, ctx) => {
  const {
    role,
    args: [name = "", ...rest],
  } = configArgs("ring-config", args);
  const origin = sessionOrigin(ctx);
  const config = ctx.configFor(origin);
  const into = heldLayer(ctx, origin, role);
  const { ring, next, turn } = landRing(
    "ring-config",
    ctx,
    name,
    "persist",
    rest,
    (r) => {
      if (
        resetLayers(r.key).sessionKeys.some(
          (k) => ctx.sessionState.get(ctx.session, k) !== null,
        )
      )
        return r.shown;
      const key = durableLanding(
        config,
        (k) => ctx.sessionState.get(ctx.session, k),
        r.key,
      ).key;
      const declared = declaredName(
        requireLayerText(
          into.path,
          editStore(ctx, ctx.session).read(into.path),
        ),
        key,
      );
      return declared !== undefined && r.options.includes(declared)
        ? declared
        : r.shown;
    },
  );
  setConfig([role, ring.key, next], ctx);
  // [LAW:one-source-of-truth] The step started from the pick, and the file now
  // holds what it chose, so the pick stops shadowing the file: the bar follows
  // the file, and the next click, finding no pick, steps from what this one
  // wrote. The release lands with the click, whose consequence applies once the
  // write has reloaded. A write that is no ring step (a persist `to`) leaves a
  // pick standing: it repeats the same write however many times it is clicked.
  for (const picked of resetLayers(ring.key).sessionKeys)
    ctx.sessionState.clear(ctx.session, picked);
  // [LAW:dataflow-not-control-flow] exception: the page turn is optional on
  // the wire, and the session gate refuses an empty batch.
  if (turn.length > 0) setState(turn, ctx);
};

// [LAW:one-source-of-truth] A page arrow: the page the cursor shows now, turned
// by the arrow's direction and stopped at the first and last page the drawn
// layout holds, as the draw's boundary arrows stop. The cursor folds as the
// draw folds it (pageShown): a cursor below zero is the page holding the
// option in force, which this reads from the session, else from where the draw
// centred (`centre`), not from the link's layout.
const turnPage: VerbHandler = (args, ctx) => {
  const [name = "", pageKey, byRaw, layout, centre] = args;
  if (
    !pageKey ||
    byRaw === undefined ||
    layout === undefined ||
    centre === undefined
  )
    throw new BadVerbArgs(
      "turn-page: <action>/<pageKey>/<by>/<pageLayout>/<centre> is required",
    );
  const by = parseOffset(byRaw);
  if (!by.ok) throw new BadVerbArgs(`turn-page: by is ${by.problem}`);
  const config = sessionConfig(ctx);
  const head = headFor(config, name);
  const options = head === undefined ? undefined : optionsOf(config, head);
  if (head === undefined || options === undefined || options.length === 0)
    throw new BadVerbArgs(
      `turn-page: "${name}" lists no options to page through`,
    );
  const map = pageMapOfLink("turn-page", layout, options);
  const pick = (k: string) => ctx.sessionState.get(ctx.session, k);
  // A structural insert holds no value in force, as its draw has none.
  const inForce = ringHeld(ctx, config, head)?.shown ?? centre;
  const pages = pageCount(map);
  const at = pageShown(
    stateKeyShown(config, pick, pageKey) ?? "",
    pageHolding(map, options.indexOf(inForce)),
    pages,
  );
  const next = Math.max(0, Math.min(at + by.by, pages - 1));
  setState([pageKey, String(next)], ctx);
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
const save: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const { role } = configArgs("save", args);
  const origin = sessionOrigin(ctx);
  const config = ctx.configFor(origin);
  const pick = (key: string) => ctx.sessionState.get(sid, key);
  const drafts = settingDrafts(config, pick);
  const placements = placementDrafts(config, pick);
  // Nothing unsaved writes nothing — a second click on a bar drawn before the
  // first save released its picks — so it is never a failure the bar reports,
  // and the bar draws what the file holds. It still settles the session: a
  // pick that is no draft (a stale one) is released, as any save releases it.
  if (drafts.length + placements.length === 0) {
    ctx.log("info", `save: nothing unsaved (session=${sid})`);
    releaseSaved(ctx, config);
    ctx.finishEdit("save");
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
  releaseSaved(ctx, writeDrafts(editStore(ctx, sid), into, pairs, placements));
  ctx.finishEdit("save");
  ctx.log(
    "info",
    `save: ${[
      ...pairs.map(([k, v]) => `${k}=${v}`),
      ...placements.map(placementLog),
    ].join(" ")} → ${into.path} (session=${sid})`,
  );
};

// [LAW:single-enforcer] THE release every save makes: a save is the user
// deciding what the bar draws, so once `written` holds it, every pick of a
// setting that is no draft against `written` lets go — the session follows
// the file again. A pick its setting cannot hold is never written and never a
// draft, so a save releases it too, and the bar keeps what was saved when
// its domain returns. `movedOn` are the drafts the write put somewhere else
// (save as preset lays a preset's drafts into its copy), which stay drafts
// against the file they came from and are released all the same. Only a pick
// the session holds is released: letting go of nothing writes nothing, which
// matters for an edit mode key with no edit open.
//
// [LAW:no-ambient-temporal-coupling] The drafts are judged against the picks
// the save settles on, which is an input (`read`): a save that switches
// presets passes the session's picks with the new preset over them, so the
// release never depends on whether that write has landed.
function releaseSaved(
  ctx: ClickContext,
  written: DslConfig,
  settled: {
    readonly read?: (key: string) => string | null;
    readonly movedOn?: readonly string[];
  } = {},
): void {
  const sid = ctx.session;
  const pick =
    settled.read ?? ((key: string) => ctx.sessionState.get(sid, key));
  const drafted = new Set([
    ...settingDrafts(written, pick).map((d) => d.sessionKey),
    ...placementDrafts(written, pick).map((p) => p.key),
  ]);
  for (const key of settled.movedOn ?? []) drafted.delete(key);
  // [LAW:nothing-unseen] A release that lets go of a stale pick is a decision
  // the save made for the user: the log names it.
  const released = [...settingTable(written).rows].flatMap(([key, row]) => {
    const raw = pick(key);
    return drafted.has(key) || raw === null
      ? []
      : [{ key, stale: row.parse(raw) === null }];
  });
  for (const { key } of released) ctx.sessionState.clear(sid, key);
  if (released.length > 0)
    ctx.log(
      "info",
      `released: ${released.map((r) => `${r.key}${r.stale ? " (stale)" : ""}`).join(" ")} (session=${sid})`,
    );
}

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
const savePreset: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const { role } = configArgs("save-preset", args);
  const origin = sessionOrigin(ctx);
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
  const { name, config: written } = writePreset(
    editStore(ctx, sid),
    into,
    snapshot.from,
    snapshot.globals,
    picks,
    snapshot.placements,
  );
  ctx.sessionState.set(sid, SETTINGS.preset.sessionKey, name);
  releaseSaved(ctx, written, {
    read: (key) =>
      key === SETTINGS.preset.sessionKey
        ? name
        : ctx.sessionState.get(sid, key),
    movedOn: snapshot.placements.map((p) => p.key),
  });
  ctx.log(
    "info",
    `save-preset: ${[`${name} from=${snapshot.from}`, ...picks.map(([k, v]) => `${k}=${v}`), ...snapshot.placements.map(placementLog)].join(" ")} → ${into.path} (session=${sid})`,
  );
};

// Save the look the session draws as the active theme's default
// (candybar-theme-colours-6fq5.ix8): `themeDefaults.<theme>` in the session's
// written layer takes the session's shade, variation and style, and the
// session's picks the written file draws are released (releaseSaved), as a
// save's are. A field the config's
// globals declare is not the rung's to save (themeDefaultSave), so a pick of it
// is still a draft, and stays, so the bar does not move under the click.
// [LAW:no-ambient-temporal-coupling] The write and the release land together,
// as a save's do, read over the config the write's own load proved.
// [LAW:no-silent-failure] A theme chosen by a rule has no name until a render
// evaluates it, and a theme's default is keyed by name: refused, naming the
// rule, never a guess at what it would have rendered.
const saveThemeDefault: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const { role } = configArgs("save-theme-default", args);
  const origin = sessionOrigin(ctx);
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
  releaseSaved(
    ctx,
    writeThemeDefault(editStore(ctx, sid), into, save.theme, save.look),
  );
  ctx.log(
    "info",
    `save-theme-default: ${save.theme} ${THEME_DEFAULT_FIELDS.map((f) => `${f}=${save.look[f]}`).join(" ")} → ${into.path} (session=${sid})`,
  );
};

// Delete a preset the session's config file authors. A session that was in
// it returns to the file's default arrangement; any other session in it
// falls to the floor, as it would for a name deleted by hand.
const deletePreset: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const {
    role,
    args: [name = ""],
  } = configArgs("delete-preset", args);
  if (!name) {
    throw new BadVerbArgs(
      "delete-preset: <name> is required (shape: <sessionId>/<layer>/<name>)",
    );
  }
  const origin = sessionOrigin(ctx);
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
const resetConfig: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const { role, args: keys } = configArgs("reset-config", args);
  const origin = sessionOrigin(ctx);
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
const applyLayoutOp: VerbHandler = (args, ctx) => {
  const sid = ctx.session;
  const {
    role,
    args: [key = "", opToken = ""],
  } = configArgs("apply-layout-op", args);
  const origin = sessionOrigin(ctx);
  const gate = ctx.gates.config.gateFor(ctx.configFor(origin));
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
  // [LAW:effects-at-boundaries] The click draws the new placement's suffix.
  const placed = applyLayoutOpToFile(editStore(ctx, sid), into, key, op, () =>
    randomBytes(3).toString("hex"),
  );
  // The placement an insertion wrote — its id minted here, at click time — is
  // the one fact of the edit the op token does not already carry.
  ctx.log(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${into.path} placed=${JSON.stringify(placed)} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] Step the session's settings history
// (settings-history.ts) back one click — whatever that click changed, in the
// session or in a config file. No key, no value: the history owns which step
// moves and what it restores; this handler is plumbing between the wire and
// it. [LAW:no-silent-failure] An empty stack and a stale target are loud
// BAD_REQUESTs, surfaced as a transient candybar.clickError.
const undo: VerbHandler = (_args, ctx) => {
  const sid = ctx.session;
  const step = ctx.journal.undo(sid);
  ctx.log("info", `undo: restored ${describeStep(step)} (session=${sid})`);
};

const back: VerbHandler = (_args, ctx) => {
  const sid = ctx.session;
  const { writes, discarded } = ctx.menu.back(
    sid,
    menuContext(ctx, sid, sessionConfig(ctx)),
  );
  const restored = writes
    .map(({ key, value }) => `${key}=${value ?? "∅"}`)
    .join(" ");
  ctx.log("info", `back: ${restored} discarded=${discarded} (session=${sid})`);
};

// [LAW:effects-at-boundaries] Cancel drops the transaction in the
// click's consequence. It emits no reverse writes.
const rewind: VerbHandler = (_args, ctx) => {
  const sid = ctx.session;
  if (ctx.edits.draft(sid) === null)
    throw new BadVerbArgs(
      "rewind: edit mode has no transaction — nothing to cancel",
    );
  ctx.finishEdit("cancel");
  ctx.log("info", `rewind: discarded draft (session=${sid})`);
};

// undo's mirror — steps the same history forward one click.
const redo: VerbHandler = (_args, ctx) => {
  const sid = ctx.session;
  const step = ctx.journal.redo(sid);
  ctx.log("info", `redo: re-applied ${describeStep(step)} (session=${sid})`);
};

// ─── Slash commands (brandon-context-ceiling-xta.7xt) ───────────────────────

// [LAW:parse-dont-validate] A click's line is honoured only as one a `slash`
// action in the session's config declares — the declaration found supplies
// the SlashLine typed, so the URL chooses among the config's lines and can
// add none. The pane is the one the session's live request reported.
const slash: VerbHandler = (args, ctx) => {
  const [line = ""] = args;
  const sid = ctx.session;
  const declared = Object.values(
    ctx.configFor(sessionOrigin(ctx)).actions,
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
  const live = ctx.context?.live ?? null;
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

// [LAW:effects-at-boundaries] Supply the session's current declaration and
// source context. The host verifies the evidence and owns the launch.
function runOf(
  { action, capture }: Extract<ClickStep, { kind: "run" }>,
  ctx: ClickContext,
): Extract<ActRequest, { kind: "run" }> {
  const sid = ctx.session;
  const origin = sessionOrigin(ctx);
  const actions = ctx.configFor(origin).actions;
  const decl = Object.hasOwn(actions, action) ? actions[action] : undefined;
  if (decl === undefined || !("run" in decl)) {
    throw new BadVerbArgs(
      `"${action}" is not a run action this session's config declares`,
    );
  }
  const sources = ctx.sourcesFor(origin);
  return {
    kind: "run",
    session: sid,
    action,
    declaration: runDeclaration(decl),
    capture,
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

// The decoded session verbs index this complete table.
const SESSION_HANDLERS: Record<
  Extract<ClickStep, { kind: "session" }>["verb"],
  VerbHandler
> = {
  [VERB_STEP_STATE]: stepState,
  [VERB_RING_CONFIG]: ringConfig,
  [VERB_TURN_PAGE]: turnPage,
  [VERB_SET_CONFIG]: setConfig,
  [VERB_STEP_CONFIG]: stepConfig,
  [VERB_RESET_CONFIG]: resetConfig,
  [VERB_SAVE]: save,
  [VERB_SAVE_PRESET]: savePreset,
  [VERB_SAVE_THEME_DEFAULT]: saveThemeDefault,
  [VERB_DELETE_PRESET]: deletePreset,
  [VERB_APPLY_LAYOUT_OP]: applyLayoutOp,
  [VERB_UNDO]: undo,
  [VERB_REDO]: redo,
  [VERB_BACK]: back,
  [VERB_REWIND]: rewind,
  [VERB_SLASH]: slash,
  [VERB_COPY_DIAGNOSTIC]: copyDiagnostic,
};

// A failure as the bar reports it: under its step's verb. A run of state writes
// has no one verb: its refusal is the message of the handler that refused it,
// a ring step's own, or the one batch's (set-state, which every pair lands by).
const reported = (
  step: Exclude<ClickStep, { kind: "invalid" }>,
  message: string,
): string =>
  step.kind === "state-writes" ? message : `${step.verb}: ${message}`;

// [LAW:no-silent-failure] Every admitted step runs in order even if an earlier
// one failed. The host has turned malformed steps into error entries.
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
function foldEffects<Step extends Exclude<ClickStep, { kind: "invalid" }>>(
  steps: ReadonlyArray<Step | Extract<ClickStep, { kind: "invalid" }>>,
  log: VerbContext["log"],
  perform: (step: Step) => void,
  recordErrors: (message: string) => void,
): void {
  const errors: string[] = [];
  let operational = false;
  for (const step of steps) {
    if (step.kind === "invalid") {
      errors.push(step.reason);
      continue;
    }
    try {
      perform(step);
    } catch (e) {
      // [LAW:single-enforcer] Classified once, by failureOf. A click the
      // daemon's close cut off is over: no later effect runs, it keeps its
      // own class, and what failed before it has no bar left to reach, so the
      // log has it.
      const failure = failureOf(e);
      if (failure.kind !== "bad-request" && failure.kind !== "threw") {
        if (errors.length > 0) log("warn", `click: ${errors.join("; ")}`);
        throw e;
      }
      if (failure.kind === "threw") operational = true;
      errors.push(reported(step, failure.message));
    }
  }
  if (errors.length > 0) {
    recordErrors(errors.join("\n"));
    const message = errors.join("; ");
    throw operational ? new Error(message) : new BadVerbArgs(message);
  }
}

// [LAW:single-enforcer] All effects of a session click share one journal.
// Its commit runs even if a handler threw. If both fail, the click reports
// both failures.
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
  sid: SessionId,
  context: SessionContext | null,
  ctx: C,
  effects: Effect[],
  handler: (ctx: Journaled<C>) => void,
): void {
  const held = context?.session === sid ? context : null;
  const origin = held?.durable.origin ?? null;
  ctx.configWrites.begin(verb, () => {
    if (origin === null)
      throw new BadVerbArgs(
        `${verb}: the click names no session that has rendered — no config to write`,
      );
    return { origin, chain: ctx.snapshotFor(origin).chain };
  });
  const files: ConfigFiles = {
    read: (file) => ctx.configWrites.read(file),
    land: (file, before, after) => ctx.configWrites.land(file, before, after),
    roleOf: (file) => ctx.configWrites.roleOf(file),
    pathOf: (role) => ctx.configWrites.pathOf(role),
    prove: (file, text, read) =>
      proveLoadsAsLayer(ctx, origin, file, text, read),
  };
  const draft =
    origin === null || ctx.edits.revision(origin, sid) === null
      ? null
      : ctx.edits.draft(sid);
  const scoped =
    draft === null
      ? ctx
      : {
          ...ctx,
          snapshotFor: (of: RenderOrigin) =>
            ctx.edits.revision(of, sid)?.snapshot ?? ctx.snapshotFor(of),
          configFor: (of: RenderOrigin) => ctx.configFor(of, sid),
        };
  const edit = draft?.begin((file, text, read) =>
    proveLoadsAsLayer(scoped, origin, file, text, read),
  );
  const journal = edit?.journal ?? ctx.history.begin(files);
  // [LAW:single-enforcer] The click's session writes pass the one router,
  // over its journal: a click in an open edit writes the edit's journal, and
  // any other holds edit mode's keys aside, for the edit it may open. Whether
  // the click is in an edit was decided once, above, by its origin; the router
  // is not asked again.
  const aside = heldAside();
  const writes =
    edit !== undefined
      ? journal.sessionState
      : routedWrites(journal.sessionState, () => null, aside);
  const requested: { finish?: EditFinish } = {};
  const failures: unknown[] = [];
  const sessionState = closingView(
    writes,
    (target) => (target === sid ? nestOf(scoped, origin) : NO_NEST),
    (line) => ctx.log("info", line),
  );
  // [LAW:single-enforcer] Choosing a menu uses the same disclosure rules as
  // any state write. Back receives the bare journal so it can install an
  // already computed view without applying new closure rules to it. An open
  // edit holds its own Back steps, which end with it; outside one, Back sees
  // the journal, which no edit-mode key reaches.
  const navigation = (edit?.navigation ?? ctx.navigation).begin(
    journal.sessionState,
    sessionState.setBatch,
  );
  try {
    handler({
      ...scoped,
      session: sid,
      context: held,
      sessionState,
      journal,
      readConfigFile: (edit?.files ?? files).read,
      finishEdit: (finish) => {
        // A save outside an edit (the settings menu's own) has none to finish:
        // it writes through the click's journal alone. A stale edit-mode key
        // is what the consequence reports.
        if (edit === undefined) return;
        requested.finish = finish;
        sessionState.set(sid, EDIT_MODE_KEY, DISCLOSURE_CLOSED);
      },
      menu: navigation,
    });
  } catch (e) {
    failures.push(e);
  }
  let saved: Journal | null = null;
  if (requested.finish === "save" && edit !== undefined && origin !== null) {
    try {
      if (failures.length === 0) {
        const destination = ctx.history.begin(files);
        edit.save(destination, files, ctx.snapshotFor(origin));
        saved = destination;
      }
    } catch (e) {
      failures.push(e);
    }
  }
  // [LAW:no-ambient-temporal-coupling] Save releases the draft only in the
  // host's successful acknowledgement turn. Conflict and failure keep the
  // original draft and its undo and redo history.
  const consequence = (): void => {
    if (requested.finish === "save" && saved === null) return;
    const failed: unknown[] = [];
    let visits: EndedVisits = new Map();
    try {
      visits = navigation.commit();
    } catch (e) {
      failed.push(e);
    }
    // The one way an edit ends: its Back steps land outside it, and its view
    // is redrawn without it.
    const end = (): void => {
      ctx.navigation.landOutsideEdit(visits);
      ctx.edits.close(sid);
      ctx.editViewChanged(sid);
    };
    try {
      if (edit === undefined) {
        const clicked = new Map([
          ...(journal.commit().get(sid) ?? []),
          ...aside.held(sid),
        ]);
        const entering =
          clicked.get(EDIT_MODE_KEY) === EDIT_MODE_ARRANGE && origin !== null;
        const edited = new Map(
          [...clicked].filter(([key]) => isEditModeKey(key)),
        );
        // [LAW:no-silent-failure] A click outside an edit that opens none
        // (one drawn before its edit closed) has no edit for those writes to
        // mean anything in.
        if (entering) {
          ctx.edits.open(sid, origin, ctx.snapshotFor(origin), edited);
          ctx.editViewChanged(sid);
        } else if (edited.size > 0) failed.push(staleEdit(edited.keys()));
      } else if (saved !== null) {
        saved.commit();
        end();
      } else {
        const { moved, clicked } = edit.commit();
        const mode = clicked.get(EDIT_MODE_KEY);
        if (mode !== undefined && mode !== EDIT_MODE_ARRANGE) {
          edit.leave(clicked);
          end();
        } else if (moved) {
          ctx.edits.changed(sid);
          ctx.editViewChanged(sid);
        }
      }
    } catch (e) {
      failed.push(e);
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

// [LAW:single-enforcer] Every session click runs in one journal. A global
// click can only ask for an act and has no state or config to journal.
export function runClick(click: AdmittedClick, ctx: VerbContext): void {
  if (click.scope === "global") {
    foldEffects(
      click.steps,
      ctx.log,
      (step) => globalAct(step, ctx, click.session ?? null),
      () => {},
    );
    return;
  }
  const sid = click.session;
  journaled(click.verb, sid, ctx.context, ctx, ctx.effects, (c) => {
    try {
      foldEffects(
        click.steps,
        c.log,
        (step) => {
          switch (step.kind) {
            case "global":
              globalAct(step, c, sid);
              break;
            case "session":
              SESSION_HANDLERS[step.verb](step.args, c);
              break;
            case "state-writes":
              landStateWrites(step.writes, c);
              break;
            case "repo-answer":
              c.configWrites.answer(step.dir, step.answer);
              break;
            case "run":
              ask(c, runOf(step, c));
              break;
          }
        },
        (message) => holdClickError(c.sessionState, sid, message, c.now()),
      );
    } finally {
      ctx.clickLanded(sid);
    }
  });
}

// [LAW:single-enforcer] A menu's idle close goes through the same
// disclosure transition as its ✕. It runs in a due turn after any click
// already in the mailbox has restarted the idle period.
export function closeIdleMenus(
  sid: SessionId,
  context: SessionContext | null,
  idle: IdleSpan,
  ctx: DaemonContext,
  effects: Effect[],
): void {
  journaled("menu-idle", sid, context, ctx, effects, (c) => {
    const nest = nestOf(c, c.context?.durable.origin ?? null);
    // An edit's work is what the save cell counts (the files it changed and
    // the drafts a save would write) and redo besides, which the cell does not
    // show but a timer must not discard.
    const depth = c.edits.draft(sid)?.depth();
    const hasWork =
      depth !== undefined &&
      depth.sinceEdit +
        depth.redo +
        unsavedCount(sessionConfig(c), (key) => c.sessionState.get(sid, key)) >
        0;
    const roots = openRoots(nest, (key) => c.sessionState.get(sid, key))
      // [LAW:no-ambient-temporal-coupling] A timer cannot abandon an
      // edit with work to keep or redo. Other disclosures still time out.
      .filter(
        (root) =>
          !hasWork ||
          !nest.inside(root).some(({ key }) => key === EDIT_MODE_KEY),
      );
    // [LAW:no-ambient-temporal-coupling] A click mode left on ends with the
    // menus, and the region it made hovered with it.
    const modeOpen = modeIsOpen(
      clickModeOf(c.sessionState.get(sid, CLICK_MODE_KEY)),
    );
    // [LAW:nothing-unseen] What the choice closes is what the log names.
    const closed = [
      ...roots.map(({ key }) => ({ key, value: DISCLOSURE_CLOSED })),
      ...(modeOpen
        ? [
            { key: CLICK_MODE_KEY, value: DEFAULT_CLICK_MODE },
            { key: HOVER_KEY, value: NO_HOVER },
          ]
        : []),
    ];
    c.menu.choose(sid, closed, () => menuContext(c, sid, sessionConfig(c)));
    c.log(
      "info",
      `menu-idle: closed=${closed.map(({ key }) => key).join(",") || "-"} ` +
        `idle=${idle.idleS.toFixed(1)}s timeout=${idle.timeoutS}s (session=${sid})`,
    );
  });
}
