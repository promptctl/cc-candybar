// [LAW:single-enforcer] One registry that maps click verb names to their
// handlers. Adding a new verb is one entry — no branching in handleClick,
// no scattered if/else in reply.ts. The dispatcher does table lookup
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

import type { LaunchOpts, Launcher } from "../../proc/launch";
import type { SessionStateReader, SessionStateRW } from "../session-state";
import { holdClickError } from "../click-error";
import type { Instant } from "../../utils/instant";
import { stateGate, stateKeySeed } from "./state-validators";
import {
  disclosureNest,
  NO_NEST,
  openRoots,
  type DisclosureNest,
} from "../../config/disclosure-nest";
import { DISCLOSURE_CLOSED } from "../../config/disclosure";
import type { Drawing, LaneSwitches } from "../../config/lanes";
import { closingView } from "../closing-view";
import { configGate, configKeySeed } from "./config-validators";
import type { Gate, RangeParams } from "./validator-registry";
import {
  applyLayoutOp as applyLayoutOpToFile,
  deletePreset as deletePresetFromFile,
  deleteValues,
  readValue,
  writePreset,
  writeDrafts,
  writeThemeDefault,
  writeValues,
  type EditStore,
} from "../config-file-store";
import {
  describeStep,
  type Journal,
  type SettingsHistory,
  type Step,
} from "../settings-history";
import type { NavigationHistory } from "../navigation-history";
import { durableConfig, type ConfigHome } from "../../config/loader/discovery";
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
import { ident } from "../../config/ident";
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
  decodeFirstSegment,
  decodeSegments,
  batchAdjacentWrites,
  parseEffects,
  type ParsedEffect,
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
  VERB_SAVE_THEME_DEFAULT,
  VERB_DELETE_PRESET,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_PROBE,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_COPY_DIAGNOSTIC,
  type EvaluatedRun,
} from "../../click/wire";
import type { LinkSigner } from "../../click/link-signer";
import { recordAnswer, repoAnswerFields, repoConfigs } from "../repo-configs";
import type { RepoAnswer } from "../../config/loader/repo-gate";
import type { Runs, RunRequest } from "../runs";
import type { DeclaredSources } from "../render-payload";
import { sessionEnv } from "../session-env";
import { runDeclaration, type SlashAction } from "../../config/action";
import type { SlashLine } from "../../claude-input/slash-line";
import type { RenderSightings } from "../render-sightings";
import type { ServingDaemon } from "../limits";
import { parseClientHints, type ClientHints } from "../protocol";
import {
  GLYPH_MARKS,
  checkByName,
  describeFix,
  runDoctor,
  type DoctorFacts,
  type GlyphMark,
} from "../../doctor/checks";
import { sightingOf } from "../../doctor/terminal";
import {
  daemonFields,
  dataFields,
  transcriptFields,
  frameFields,
  truecolorEnvFields,
  doctorReportPairs,
  linkFields,
  configFields,
  nerdFontFields,
  terminalFeatureFields,
  installFields,
} from "../../doctor/report";
import type {
  ConfigTarget,
  RenderOrigin,
  RequestedOrigin,
} from "../../config-hint";
import { withMark } from "../../doctor/mark-book";
import { withClicked } from "../../doctor/clicked-terminals";
import { DoctorBusy } from "../../doctor/busy";
import { barsOf, type ClickArrival } from "../../doctor/sightings";
import {
  applyFix,
  clickArrived,
  installFacts,
  gatherFacts,
  oneAskPerClick,
  sessionWidth,
  readStores,
  type DoctorEdge,
  type DoctorStores,
} from "../../doctor/edge";
import {
  parseProbeNonce,
  type ProbeArrivals,
} from "../../doctor/handler-probe";
import { typeSlash, type ClaudeInputEdge } from "../../claude-input/edge";

// What the daemon hands everything that writes a session's state: a click's
// verb, and the idle timer that closes its menus (`closeIdleMenus`).
export interface DaemonContext {
  readonly sessionState: SessionStateRW;
  // [LAW:effects-at-boundaries] The daemon's clock.
  readonly now: () => Instant;
  readonly log: (level: "info" | "warn" | "error", msg: string) => void;
  // Who a click's programs belong to.
  readonly launcher: Launcher;
  // [LAW:effects-at-boundaries] The update notice's act (src/daemon/
  // update-notice.ts), handed in by the daemon: the verb names the effect,
  // the watch that knows what is newer performs it.
  readonly applyUpdate: () => Promise<void>;
  // [LAW:effects-at-boundaries] The doctor's edge (src/doctor/edge.ts): the
  // tmux query and the settings.json read/write, handed in so the handlers
  // below stay a fold over pure verdicts and a test drives them with fakes.
  readonly doctor: DoctorEdge;
  // The doctor's stores, which this daemon files (src/doctor/edge.ts).
  readonly doctorStores: DoctorStores;
  // Where a `doctor-probe` link records that it arrived.
  readonly probes: ProbeArrivals;
  // Which client drew each session's bar, as this process saw it render, and
  // the bundle this daemon runs.
  readonly clients: RenderSightings;
  readonly bundle: string;
  // This daemon as the doctor's daemon row judges it (src/daemon/limits.ts).
  readonly serving: () => ServingDaemon;
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
  // [LAW:no-ambient-temporal-coupling] Whose turn it is to hold those journals
  // (src/daemon/journal-turns.ts).
  readonly journalTurns: Pick<JournalTurns, "take" | "click" | "gathering">;
  // [LAW:no-ambient-temporal-coupling] A click of the session landed, in its
  // turn: the session's idle clock restarts (src/daemon/menu-idle.ts).
  readonly clickLanded: (sessionId: string) => void;
  // [LAW:effects-at-boundaries] The config a session renders with, looked up
  // by the inputs its last render resolved from (the render cache owns it), so
  // `save` compares the session against the same config the bar was drawn from.
  readonly configFor: (origin: RenderOrigin) => DslConfig;
  // Reload that config from disk now, so the next render reads what a click
  // just wrote rather than waiting on the file watcher.
  readonly reloadConfig: (origin: RenderOrigin) => void;
  // The storage key of each source that config declares, from the same
  // render state: what a `run` supersedes.
  readonly sourcesFor: (origin: RenderOrigin) => DeclaredSources;
  // [LAW:single-enforcer] The signer every `run` link was drawn with: a link
  // is honoured only if it verifies here.
  readonly links: LinkSigner;
  // [LAW:no-ambient-temporal-coupling] The one owner of runs in flight: a
  // `run` click hands its program over and is answered at once.
  readonly runs: Pick<Runs, "start" | "refused">;
  // [LAW:effects-at-boundaries] A session's animation-lane switches over the
  // config it renders with (`of`, looked up like `configFor`), and what
  // follows a click of that session (`clicked`): the click path measures
  // them before each click and after its commit (`journaled`), and the
  // daemon hands both to the one owner of lane setup
  // (src/daemon/lane-setup.ts) and of the tmux status line.
  readonly lanes: {
    readonly of: (origin: RenderOrigin, sessionId: string) => LaneSwitches;
    readonly clicked: (
      sessionId: string,
      before: LaneSwitches,
      after: LaneSwitches,
    ) => void;
  };
  // [LAW:single-enforcer] Brings the session's view, if it has one, to the
  // config `origin` resolves to: what a click that moved its load-config pick
  // does after its commit (`journaled`), so a feed drawing the session shows
  // the pick on its next frame with no request after it.
  readonly views: {
    readonly follow: (sessionId: string, origin: RenderOrigin) => void;
  };
  // What the diagnostic the frame renderer `by` last delivered for the
  // session listed under `key` copies; undefined when it lists none under it.
  readonly diagnosticCopy: (
    sessionId: string,
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
  // [LAW:nothing-unseen] How long THIS click waited for its place in its
  // session, gathered, and waited for its turn, for its event.
  readonly placeWaited: (ms: number) => void;
  readonly gatherTook: (ms: number) => void;
  readonly turnWaited: (ms: number) => void;
  // Whether the client that sent THIS click has left.
  readonly clientGone: () => boolean;
}

// What only the turn may wait on: a handler reaches a launch through `launch`,
// `typing`, `gather` or `applyUpdate`, each bound to the turn, so it cannot await one the
// daemon's close would not stop it after.
type TurnBound = "launcher" | "doctor" | "claudeInput" | "applyUpdate";

// What a helper reads, from either side of the turn.
type Unbound = Omit<VerbContext, TurnBound>;

// A context with the journals the verb table opens around a write.
export type Journaled<C extends DaemonContext> = Omit<C, TurnBound> & {
  readonly journal: Journal;
  readonly navigating: SessionStateRW;
  // [LAW:single-enforcer] Every await of a handler is one of these four: the
  // click's turn answers whether it may go on (JournalTurn.landed).
  readonly launch: (
    opts: Omit<LaunchOpts, "timeoutMs">,
    what: string,
  ) => Promise<void>;
  readonly typing: (
    hint: ClientHints["tmux"],
    line: SlashLine,
  ) => ReturnType<typeof typeSlash>;
  readonly applyUpdate: () => Promise<void>;
  // Read-only work in the turn, over what the click has written so far.
  readonly gather: <T>(work: (ctx: C) => Promise<T>) => Promise<T>;
};

// What a handler runs with: the daemon's context, with `sessionState` the
// click's journaling view of it and `journal` where its file writes report.
// `navigating` is the view the navigating verbs write through: the same store,
// with what they change on screen recorded for `back` as well.
export type ClickContext = Journaled<VerbContext>;

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// raw wire-level `value` string and the daemon's verb context; it returns
// nothing (clicks have no payload) once what it awaits has landed.
// User-facing failures throw an Error;
// the dispatcher in reply.ts converts that to a RENDER_FAILED response.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error which the dispatcher surfaces as BAD_REQUEST.
export type VerbHandler = (value: string, ctx: ClickContext) => Promise<void>;

// What a click's effect does in the turn, once anything it gathered is in hand.
type ClickStep = (ctx: ClickContext) => Promise<void>;

// [LAW:types-are-the-program] An effect of the click table. `prepare` is its
// read-only part, handed the unjournaled context, and what it answers is the
// rest. A gathering effect's launches only inform, so they need no turn when
// the effect opens its click (`headGather`). `slash` is no
// gathering effect though its first await is a pane read: that read is the
// guard for its typing, and a guard split from its act guards nothing.
interface Verb {
  readonly gathers: boolean;
  readonly prepare: (value: string, ctx: VerbContext) => Promise<ClickStep>;
}

const inTurn = (handler: VerbHandler): Verb => ({
  gathers: false,
  prepare: async (value) => (ctx) => handler(value, ctx),
});

import type { JournalTurn, JournalTurns } from "../journal-turns";
import { BadVerbArgs, DaemonClosing, decodeWire } from "../verb-error";
import {
  parseSessionId,
  type ParsedSessionId,
  type SessionId,
} from "../session-id";
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

// ─── Verb handlers ───────────────────────────────────────────────────────────

// How long a program a click launches has before the click fails: a handful of
// seconds at most for a clipboard or an opener, each of which hands off and exits.
const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// [LAW:single-enforcer] The one launch a click makes of a program — the
// clipboard, an editor, a status-line link's opener — so its failure handling
// lives in one place. [LAW:dataflow-not-control-flow] Rate-limit rejection is
// one outcome among many — the click is acknowledged and the rejection is
// logged. Other failures are genuine errors that surface as RENDER_FAILED.
export async function clickLaunch(
  launcher: Launcher,
  opts: Omit<LaunchOpts, "timeoutMs">,
  what: string,
  log: DaemonContext["log"],
): Promise<void> {
  // [LAW:no-ambient-temporal-coupling] A click holds the daemon-wide turn while
  // it waits, so the bound is no option: it is what gives the turn back.
  const result = await launcher.launch({
    ...opts,
    timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
  });
  if (result.ok) return;
  if (result.reason === "rate-limited") {
    log("warn", `${opts.category} rate-limited: ${result.error ?? ""}`);
    return;
  }
  if (result.reason === "aborted") throw new DaemonClosing(what);
  // What the launch itself said of its failure: the spawn's error, or what
  // the program wrote to stderr before it exited.
  const said = result.error ?? result.stderr.trim();
  throw new Error(
    `${what} failed (${result.reason}, exit ${result.exitCode ?? "null"})${said === "" ? "" : `: ${said}`}`,
  );
}

// One clipboard primitive, no decode — both the `copy` verb (decodes a wire
// segment) and the diagnostic verbs (already hold a plain message) funnel here.
function pbcopy(text: string, ctx: ClickContext): Promise<void> {
  return ctx.launch(
    {
      bin: "/usr/bin/pbcopy",
      stdinInput: text,
      category: "click.pbcopy",
    },
    "pbcopy",
  );
}

const copy: VerbHandler = (value, ctx) => pbcopy(oneArg(value), ctx);

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
const copyDiagnostic: VerbHandler = async (value, ctx) => {
  const [sessionId = "", by = "", key = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const text = ctx.diagnosticCopy(sid, requireDrawer(by), key);
  if (text === undefined)
    throw new BadVerbArgs(
      `that message is no longer listed in session ${sid}'s diagnostics — open ⚠ again and copy from there`,
    );
  await pbcopy(text, ctx);
};

const openVscode: VerbHandler = (value, ctx) =>
  ctx.launch(
    {
      bin: "/usr/bin/open",
      args: ["-a", "Visual Studio Code", oneArg(value)],
      category: "click.open",
    },
    'open -a "Visual Studio Code"',
  );

// [LAW:one-source-of-truth] SessionState is the canonical store for
// toolbar-expanded state (eir merge). Toggle via set/clear; the file-backed
// storage owned by the daemon process persists the change automatically.
const toolbarToggle: VerbHandler = async (value, ctx) => {
  const sessionId = requireSessionId(oneArg(value));
  const expanded = ctx.navigating.get(sessionId, "toolbar-expanded");
  if (expanded) ctx.navigating.clear(sessionId, "toolbar-expanded");
  else ctx.navigating.set(sessionId, "toolbar-expanded", "1");
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
// naming the failing pair so the operator can localize the typo). The
// dispatcher in reply.ts maps BadVerbArgs to BAD_REQUEST.
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
const setState: VerbHandler = async (rawValue, ctx) => {
  // [LAW:single-enforcer] Decode the whole encoded tail at this boundary; the
  // session id is the head, the rest are the (key,value) pairs. A malformed
  // escape in any segment is bad input, not a handler failure (decodeWire).
  const [sessionId = "", ...rest] = decodeWire(() => decodeSegments(rawValue));
  const sid = requireSessionId(sessionId);
  const gate = stateGate(sessionConfig(ctx, sid));
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
const stepState: VerbHandler = async (rawValue, ctx) => {
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
  const gate = stateGate(config);
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
  ctx: Unbound,
  sid: string,
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

// [LAW:one-source-of-truth] The config FILE is the one durable store
// (candybar-config-dqe). A click carries only a session id, so a render
// request records — under this daemon-internal key, the
// SESSION_CONFIG_OVERRIDE_KEY precedent — the INPUTS it named for config
// resolution, and a durable verb runs the same resolution over them, under
// the session's load-config pick, at click time (durableConfig). The
// file it lands in is the one the NEXT reload reads, not a snapshot of the
// one the last render read: RenderCache re-resolves the same chain whenever
// a candidate appears (a higher-precedence file supersedes a lower one), so
// a recorded resolved path would be a second clock — a write to a file the
// bar has already stopped reading. No re-derivation from the daemon's own
// cwd either, which describes whichever shell spawned it.
export const SESSION_RENDER_ORIGIN_KEY = "render-origin";

// [LAW:one-source-of-truth] The one place a load-config pick outranks the
// path the request named: what the render draws from (draw-bar.ts) and what a
// durable click resolves (sessionOrigin) both come through here, so a click
// made right after a pick lands in the file the bar now draws from, without
// waiting for the session's next request to record it.
// [LAW:effects-at-boundaries] The load-config verb writes per-session config
// overrides into SessionState; this is the one read point.
export function sessionRenderOrigin(
  requested: RenderOrigin,
  state: SessionStateReader,
  sid: string,
): RenderOrigin {
  const pick = state.get(sid, SESSION_CONFIG_OVERRIDE_KEY);
  return pick === null
    ? requested
    : { ...requested, target: { source: "pick", path: pick } };
}

// The record is flat and additive, and `configFile` keeps its meaning, because
// session state sits at one unversioned path that builds of either age read:
// an older build finds the field it requires and ignores `source`.
export function encodeRenderOrigin({
  projectDir,
  cwd,
  target,
}: RequestedOrigin): string {
  return JSON.stringify({
    projectDir,
    cwd,
    configFile: target.path ?? null,
    source: target.source,
  });
}

// [LAW:parse-dont-validate] What a record's two fields say together. The path
// is what a session reads and keeps its meaning across builds, so no path is a
// search whichever build wrote it. The source only labels the path: one this
// build cannot read, because an older build kept none or a newer build has a
// source of its own, leaves the path standing with its source unknown. A
// refusal here would fail every durable click over a label.
function recordedTarget(
  source: unknown,
  configFile: string | null,
): ConfigTarget {
  if (configFile === null) return { source: "search" };
  return source === "argument" || source === "environment"
    ? { source, path: configFile }
    : { source: "unknown", path: configFile };
}

// [LAW:parse-dont-validate] The one boundary that lifts the stored string
// back into a RenderOrigin; a wrong shape is a loud BadVerbArgs, never a
// guessed path.
export function parseRenderOrigin(raw: string): RenderOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadVerbArgs(`render origin is not JSON: ${raw}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BadVerbArgs(`render origin is not an object: ${raw}`);
  }
  const { projectDir, cwd, configFile, source } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof projectDir !== "string" ||
    typeof cwd !== "string" ||
    (configFile !== null && typeof configFile !== "string")
  ) {
    throw new BadVerbArgs(`render origin has the wrong shape: ${raw}`);
  }
  return { projectDir, cwd, target: recordedTarget(source, configFile) };
}

// [LAW:no-silent-failure] A session that has never rendered has no origin
// and therefore no config — a loud BadVerbArgs, not the daemon's own XDG
// guess.
function sessionOrigin(ctx: Unbound, sid: string): RenderOrigin {
  const origin = recordedOrigin(ctx, sid);
  if (origin === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no config to act on`,
    );
  }
  return origin;
}

// The origin the session's last request recorded, as it named it; null for a
// session that has never rendered.
function requestedOrigin(
  ctx: Omit<DaemonContext, TurnBound>,
  sid: string,
): RenderOrigin | null {
  const raw = ctx.sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
  return raw === null ? null : parseRenderOrigin(raw);
}

// The origin the session's last request recorded, under its load-config
// pick; null for a session that has never rendered.
function recordedOrigin(
  ctx: Omit<DaemonContext, TurnBound>,
  sid: string,
): RenderOrigin | null {
  const requested = requestedOrigin(ctx, sid);
  return requested === null
    ? null
    : sessionRenderOrigin(requested, ctx.sessionState, sid);
}

// [LAW:no-ambient-temporal-coupling] A history step that rewrote the file this
// session renders from reloads it before the click answers, as save does; one
// that wrote no such file rebuilds nothing (a reload restarts every source).
// Another session's file reaches its render through the fs watcher.
function reloadIfWritten(ctx: Unbound, sid: string, step: Step): void {
  // A session with no recorded render has no cache entry to draw stale.
  const origin = recordedOrigin(ctx, sid);
  if (origin === null) return;
  const { path } = originHome(origin);
  if (step.some((c) => c.kind === "file" && c.file === path)) {
    ctx.reloadConfig(origin);
  }
}

// [LAW:one-source-of-truth] The config a session renders — what its clicks
// read, and what gates them: a session's gate is its own config's, never a
// merge of every config the daemon holds.
function sessionConfig(ctx: Unbound, sid: string): DslConfig {
  return ctx.configFor(sessionOrigin(ctx, sid));
}

// A session's lane switches as a click found them, and their read over the
// config it renders with now — under its load-config pick as it stands at
// each read, which a click can move. Null for a session that has never
// rendered, which has no config to switch them.
interface LaneMeter {
  readonly sessionId: string;
  readonly before: LaneSwitches;
  readonly read: () => LaneSwitches;
}

function laneMeter(ctx: DaemonContext, sid: string): LaneMeter | null {
  const requested = requestedOrigin(ctx, sid);
  if (requested === null) return null;
  const read = (): LaneSwitches =>
    ctx.lanes.of(sessionRenderOrigin(requested, ctx.sessionState, sid), sid);
  return { sessionId: sid, before: read(), read };
}

// What the session's config nests; a session that has never rendered has no
// config, so nothing nested.
function nestOf(
  ctx: Omit<DaemonContext, TurnBound>,
  sid: string,
): DisclosureNest {
  const origin = recordedOrigin(ctx, sid);
  return origin === null ? NO_NEST : disclosureNest(ctx.configFor(origin));
}

// [LAW:single-enforcer] The home as the render resolves it, under the same
// answers: a click's chain leaves out what the bar's leaves out.
function originHome(origin: RenderOrigin): ConfigHome {
  return durableConfig(
    repoConfigs().read(),
    origin.projectDir,
    origin.cwd,
    origin.target.path,
  );
}

function editStore(ctx: ClickContext, sid: string): EditStore {
  return {
    record: (file, before, after) => ctx.journal.file(sid, file, before, after),
    logger: ctx.log,
  };
}

// [LAW:single-enforcer] `persist`'s twin of setState: the SAME validate-then-
// write shape, writing into the session's config file instead of
// SessionState. The write is DURABLE, and the session's config reloads before
// the click answers, as save's does, so the next render draws it
// ([LAW:no-ambient-temporal-coupling] — not a bet on the fs watcher's latency).
// [LAW:no-silent-failure] Unknown key or out-of-domain value is a loud
// BAD_REQUEST — the config-file twin of `set-state`'s gate (configGate),
// derived from the SAME action table.
const setConfig: VerbHandler = async (rawValue, ctx) => {
  const [sessionId = "", key = "", incoming = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const gate = configGate(config);
  if (!key) {
    throw new BadVerbArgs(
      `set-config: <key>/<value> is required (have keys: ${gate.listKeys().join(", ")})`,
    );
  }
  const result = gate.validate(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-config: ${result.reason}`);
  const home = originHome(origin);
  const landing = durableLanding(
    config,
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  writeValues(editStore(ctx, sid), home, [[landing.key, result.value]]);
  ctx.reloadConfig(origin);
  ctx.log(
    "info",
    `set-config: ${landing.key}=${result.value} → ${home.path} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] `persist`'s twin of stepState: a RELATIVE nudge
// against the value the file declares at the layer the click lands in (or,
// when it declares none, what the bar renders there — configKeySeed), wrapped
// and re-validated through the SAME range gate, then written durably.
const stepConfig: VerbHandler = async (rawValue, ctx) => {
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
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const gate = configGate(config);
  const params = gate.rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${gate.listKeys().join(", ")})`,
    );
  }
  const home = originHome(origin);
  const landing = durableLanding(
    config,
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  const stored = readValue(home.path, landing.key);
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
  writeValues(editStore(ctx, sid), home, [[landing.key, result.value]]);
  ctx.reloadConfig(origin);
  ctx.log(
    "info",
    `step-config: ${landing.key} ${current}→${result.value} (by ${by}) → ${home.path} (session=${sid})`,
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
// session pick (the session's stateGate): a value the gate no longer admits is
// refused loudly here, never written to the file.
const save: VerbHandler = async (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
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
  const gate = stateGate(config);
  const pairs = drafts.map((d): readonly [string, string] => {
    const result = gate.validate(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save: ${result.reason}`);
    return [d.target, result.value];
  });
  gatePlacements("save", gate, placements);
  const home = originHome(origin);
  writeDrafts(editStore(ctx, sid), home, pairs, placements);
  ctx.reloadConfig(origin);
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
    ].join(" ")} → ${home.path} (session=${sid})`,
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
// [LAW:no-ambient-temporal-coupling] Save's order: write, reload, then the
// session — the preset the pick names exists before the pick does.
// [LAW:single-enforcer] Each pinned value re-crosses the session gate that
// admitted it, as a save's do.
const savePreset: VerbHandler = async (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const config = ctx.configFor(origin);
  const snapshot = presetSnapshot(config, (key) =>
    ctx.sessionState.get(sid, key),
  );
  const gate = stateGate(config);
  const picks = snapshot.picks.map((d): readonly [keyof Globals, string] => {
    const result = gate.validate(d.sessionKey, d.value);
    if (!result.ok) throw new BadVerbArgs(`save-preset: ${result.reason}`);
    return [d.configKey, result.value];
  });
  gatePlacements("save-preset", gate, snapshot.placements);
  const home = originHome(origin);
  const name = writePreset(
    editStore(ctx, sid),
    home,
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
  ctx.log(
    "info",
    `save-preset: ${[`${name} from=${snapshot.from}`, ...picks.map(([k, v]) => `${k}=${v}`), ...snapshot.placements.map(placementLog)].join(" ")} → ${home.path} (session=${sid})`,
  );
};

// Save the look the session draws as the active theme's default
// (candybar-theme-colours-6fq5.ix8): `themeDefaults.<theme>` in the session's
// home file takes the session's shade, variation and style, and each of the
// session's picks of those three that the reloaded file now draws is released,
// so the session follows the file again, as a save's do. A field the config's
// globals declare is not the rung's to save (themeDefaultSave), so a pick of it
// is still a draft, and stays, so the bar does not move under the click.
// [LAW:no-ambient-temporal-coupling] Save's order: write, reload, release.
// [LAW:no-silent-failure] A theme chosen by a rule has no name until a render
// evaluates it, and a theme's default is keyed by name: refused, naming the
// rule, never a guess at what it would have rendered.
const saveThemeDefault: VerbHandler = async (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
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
  const home = originHome(origin);
  writeThemeDefault(editStore(ctx, sid), home, save.theme, save.look);
  ctx.reloadConfig(origin);
  const pick = (key: string) => ctx.sessionState.get(sid, key);
  const drafted = new Set(
    settingDrafts(ctx.configFor(origin), pick).map((d) => d.sessionKey),
  );
  const released = THEME_DEFAULT_FIELDS.map(
    (f) => SETTINGS[f].sessionKey,
  ).filter((key) => !drafted.has(key));
  for (const key of released) ctx.sessionState.clear(sid, key);
  ctx.log(
    "info",
    `save-theme-default: ${save.theme} ${THEME_DEFAULT_FIELDS.map((f) => `${f}=${save.look[f]}`).join(" ")} → ${home.path} (session=${sid})`,
  );
};

// Delete a preset the session's config file authors. A session that was in
// it returns to the file's default arrangement; any other session in it
// falls to the floor, as it would for a name deleted by hand.
const deletePreset: VerbHandler = async (value, ctx) => {
  const [sessionId = "", name = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  if (!name) {
    throw new BadVerbArgs(
      "delete-preset: <name> is required (shape: <sessionId>/<name>)",
    );
  }
  const origin = sessionOrigin(ctx, sid);
  const home = originHome(origin);
  deletePresetFromFile(editStore(ctx, sid), home, name);
  ctx.reloadConfig(origin);
  const key = SETTINGS.preset.sessionKey;
  if (ctx.sessionState.get(sid, key) === name) ctx.sessionState.clear(sid, key);
  ctx.log("info", `delete-preset: ${name} ← ${home.path} (session=${sid})`);
};

// [LAW:one-source-of-truth] `reset`: return each key to its bundled default
// at every layer that can hold it (resetLayers) — their paths in the session's
// config file, as ONE write, and the session's own picks. A `do` over several
// resets arrives here as one effect (batchAdjacentWrites), so reset all is one
// write, one reload, and one undo step. Gated by key MEMBERSHIP
// (the session's configGate's keys) rather than a value domain — there is no value to
// validate, only a legitimate target to clear — and every key is checked
// before anything is written, so a batch lands whole or not at all.
// [LAW:no-ambient-temporal-coupling] Save's order, for the same reason: the
// file is written and reloaded before the picks are released, so no render in
// between draws a pick's absence over a file that still holds the value.
const resetConfig: VerbHandler = async (value, ctx) => {
  const [sessionId = "", ...keys] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const known = configGate(ctx.configFor(origin)).listKeys();
  const unknown =
    keys.length === 0 ? [""] : keys.filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${unknown.join('", "')}" (have: ${known.join(", ")})`,
    );
  }
  const home = originHome(origin);
  const layers = keys.map(resetLayers);
  const fileKeys = layers.flatMap((l) => l.fileKeys);
  const sessionKeys = layers.flatMap((l) => l.sessionKeys);
  deleteValues(editStore(ctx, sid), home, fileKeys);
  ctx.reloadConfig(origin);
  for (const k of sessionKeys) ctx.sessionState.clear(sid, k);
  ctx.log(
    "info",
    `reset-config: ${[...fileKeys, ...sessionKeys.map((k) => `session:${k}`)].join(" ")} ← ${home.path} (session=${sid})`,
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
// allow-list machinery setConfig uses (configGate, derived from the session's
// config's declared removeSegment/insertSegment actions) — an op token no
// action declares is a loud BAD_REQUEST. [LAW:parse-dont-validate] The
// gate proves the VALUE is one an action allows; decodeLayoutOp stamps its
// shape, and the store proves the KEY is a preset-root target — a globals
// or segment-palette key smuggled through this verb is refused there.
const applyLayoutOp: VerbHandler = async (rawValue, ctx) => {
  const [sessionId = "", key = "", opToken = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  const origin = sessionOrigin(ctx, sid);
  const before = ctx.configFor(origin);
  const gate = configGate(before);
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
  const home = originHome(origin);
  const placed = applyLayoutOpToFile(editStore(ctx, sid), home, key, op);
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
  ctx.log(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${home.path} placed=${JSON.stringify(placed)} released=${JSON.stringify(released)} (session=${sid})`,
  );
};

// [LAW:one-source-of-truth] Step the session's settings history
// (settings-history.ts) back one click — whatever that click changed, in the
// session or in a config file. No key, no value: the history owns which step
// moves and what it restores; this handler is plumbing between the wire and
// it. [LAW:no-silent-failure] An empty stack and a stale target are loud
// BAD_REQUESTs, surfaced as a transient click.error.
const undo: VerbHandler = async (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  // The click's own earlier changes are a step of their own first, so one
  // click behaves exactly as the same clicks made one at a time.
  ctx.journal.commit();
  const step = ctx.history.undo(sid);
  ctx.journal.wrote();
  reloadIfWritten(ctx, sid, step);
  ctx.log("info", `undo: restored ${describeStep(step)} (session=${sid})`);
};

// [LAW:single-enforcer] Back restores through the click's settings view, never
// a navigation journal, so going back is not itself a step it could return to.
const back: VerbHandler = async (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  const { step, discarded } = ctx.navigation.back(
    sid,
    ctx.sessionState,
    stateGate(sessionConfig(ctx, sid)),
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
const rewind: VerbHandler = async (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  // The click's own earlier changes are a step of their own first, as undo's.
  ctx.journal.commit();
  // Said first: a stale target throws after the rest were put back.
  ctx.journal.wrote();
  const restored = ctx.history.rewind(sid);
  reloadIfWritten(ctx, sid, restored);
  ctx.log(
    "info",
    `rewind: put back ${describeStep(restored) || "nothing"} as edit mode found it (session=${sid})`,
  );
};

// undo's mirror — steps the same history forward one click.
const redo: VerbHandler = async (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  ctx.journal.commit();
  const step = ctx.history.redo(sid);
  ctx.journal.wrote();
  reloadIfWritten(ctx, sid, step);
  ctx.log("info", `redo: re-applied ${describeStep(step)} (session=${sid})`);
};

// [LAW:effects-at-boundaries] The update notice's `[rebuild]` / `[upgrade]`
// click (brandon-build-notice-5d6). The wire carries only the session id (for
// click.error surfacing); the daemon's update watch decides what to run from
// its own provenance, so no command or version ever arrives from a URL.
const applyUpdate: VerbHandler = async (value, ctx) => {
  requireSessionId(oneArg(value));
  await ctx.applyUpdate();
};

// ─── Doctor (brandon-doctor-b6a) ────────────────────────────────────────────

// [LAW:one-source-of-truth] Where the daemon records each session's STAMPED
// client hints (draw-bar.ts writes `JSON.stringify(parseClientHints(req))` here
// on every render request that changes them) — the SESSION_RENDER_ORIGIN_KEY move for
// client facts. A click carries no hints, so the doctor reasons over the facts
// of the session's last render, read back through the SAME checkpoint the live
// frame crossed (parseClientHints), never over the daemon's own env.
export const SESSION_CLIENT_HINTS_KEY = "client-hints";

// [LAW:no-silent-failure] A session that has never rendered has no hints —
// a loud BadVerbArgs, never a click that acts on a guessed "not in tmux".
function sessionHints(
  ctx: Unbound,
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
function writeReport(ctx: Unbound, sid: string, facts: DoctorFacts): void {
  const reports = runDoctor(facts);
  ctx.sessionState.setBatch(sid, doctorReportPairs(reports));
  ctx.log(
    "info",
    `doctor: ${reports.map((r) => `${r.check.name}=${r.verdict.ok ? "ok" : `failed(${1 + (r.verdict.more?.length ?? 0)})`}`).join(" ")} ${configFields(facts.config)} ${nerdFontFields(facts.nerdFont, facts.marks)} ${linkFields(facts.terminal, facts.clicked)} ${terminalFeatureFields(facts.terminal, facts.width)} ${installFields(facts.install)} ${daemonFields(facts.daemon)} ${dataFields(facts.data)} ${transcriptFields(facts.transcripts)} ${frameFields(facts.frames, facts.claudeSettings)} ${truecolorEnvFields(facts.claudeSettings.origin.sources)} (session=${sid})`,
  );
}

// [LAW:no-ambient-temporal-coupling] One gather: a snapshot taken for one
// config, since config chooses what is probed (the glyphs, the data needs).
interface ClickGather {
  readonly facts: Awaited<ReturnType<typeof gatherFacts>>;
  readonly install: DoctorFacts["install"];
  // The gather that holds for the config as it stands: this one, or a new one
  // over it, so a report never judges one config on probes for another.
  readonly current: (ctx: VerbContext) => Promise<ClickGather>;
}

// `doctor` answers each question once for the click (`oneAskPerClick`), so a
// gather repeated for a new config asks again only what that config changed. A
// probe the rate limit refused refuses the click (DoctorBusy), so no report is
// written over facts the doctor did not see.
async function clickGather(
  ctx: VerbContext,
  sid: string,
  doctor: DoctorEdge,
  load: ReturnType<DoctorEdge["loadConfig"]>,
): Promise<ClickGather> {
  // The session's own renders, read once: whatever its Claude Code sends, it
  // sends to this session.
  const scope = {
    kind: "clicked",
    sessionId: sid,
    via: ctx.arrival.via,
  } as const;
  const said = ctx.clients.ofSession(sid, ctx.now());
  let facts: ClickGather["facts"];
  try {
    facts = await gatherFacts(
      { ...doctor, loadConfig: () => load },
      sessionHints(ctx, sid),
      sessionOrigin(ctx, sid),
      (key) => ctx.sessionState.get(sid, key),
      { kind: "ok", value: ctx.serving() },
      { kind: "ok", value: said.map((s) => s.rateLimits) },
      { kind: "ok", value: said.map((s) => s.transcript) },
      scope,
      { kind: "ok", value: barsOf(scope, said) },
      sessionWidth(sid, said),
      readStores(ctx.doctorStores),
    );
  } catch (e) {
    if (e instanceof DoctorBusy) throw new BadVerbArgs(e.message);
    throw e;
  }
  const gathered: ClickGather = {
    facts,
    // The client that drew the bar this click came from, and the daemon the
    // click reached — this process.
    install: installFacts(
      doctor.install,
      ctx.bundle,
      said.map((s) => s.client),
    ),
    current: async (now) => {
      const stands = doctor.loadConfig(sessionOrigin(now, sid));
      // A reload that failed keeps the config it had, so its error is the news.
      const same =
        stands.config === load.config &&
        stands.error === load.error &&
        stands.warning === load.warning;
      return same ? gathered : clickGather(now, sid, doctor, stands);
    },
  };
  return gathered;
}

// A doctor effect's gather, and the facts its turn reasons over.
const gatherClick = (ctx: VerbContext, sid: string): Promise<ClickGather> => {
  const doctor = oneAskPerClick(ctx.doctor);
  return clickGather(
    ctx,
    sid,
    doctor,
    doctor.loadConfig(sessionOrigin(ctx, sid)),
  );
};

// The gather as it stands in the turn, with the click itself as the link that
// came back through the URL handler. [LAW:no-ambient-temporal-coupling] The
// stores are read here, not in the gather: this click's turn is what files
// into them, so what it read before its turn another click may have moved.
async function clickFacts(
  ctx: ClickContext,
  sid: string,
  gathered: ClickGather,
): Promise<DoctorFacts> {
  const { facts, install } = await ctx.gather(gathered.current);
  const stores = readStores(ctx.doctorStores);
  const read = {
    ...facts,
    marks: stores.marks,
    clicked: stores.clicked,
    daemon: { ...facts.daemon, read: stores.postMortemsRead },
  };
  return {
    ...read,
    urlHandler: clickArrived(ctx.arrival),
    install,
    clicked: clickedFrom(ctx, read),
  };
}

// [LAW:one-source-of-truth] A doctor click that arrived as a link is a link
// the session's terminal drew and the user clicked, so it settles for good
// that this terminal draws links: filed (src/doctor/clicked-terminals.ts)
// where `cc-candybar doctor` — which cannot click — reads it. Nothing is
// filed from a tmux status-line click (tmux ran it, no link), where nothing
// names the terminal, or over a list that does not read (the store answers
// that failure, which the run reports as its own).
// [LAW:no-silent-failure] The filing rides along with the run it came with,
// so a write that fails is logged — and the event's `clicked=no` shows
// nothing was filed — while the run reports over the list as it was read.
function clickedFrom(
  ctx: Unbound,
  { terminal, clicked }: ClickGather["facts"],
): DoctorFacts["clicked"] {
  const sighting =
    terminal.kind === "seen" ? sightingOf(terminal.identified) : null;
  if (sighting === null || ctx.arrival.via !== "link") return clicked;
  try {
    return ctx.doctorStores.clicked.update((list) =>
      withClicked(list, sighting),
    );
  } catch (e) {
    ctx.log(
      "warn",
      `doctor: clicked terminal not filed for ${JSON.stringify(sighting)}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return clicked;
  }
}

const doctorRun: Verb = {
  gathers: true,
  prepare: async (value, ctx) => {
    const sid = requireSessionId(oneArg(value));
    const gathered = await gatherClick(ctx, sid);
    return async (c) => writeReport(c, sid, await clickFacts(c, sid, gathered));
  },
};

// A probe link `cc-candybar doctor` opened, delivered by the URL handler: its
// arrival is the whole effect, read back by the CLI from the daemon's stats.
// [LAW:single-enforcer] It writes no journal, so it takes no turn: nothing
// queued can make it wait, and no client's leaving can refuse a link that came.
const doctorProbe = async (
  value: string,
  ctx: Pick<VerbContext, "arrival" | "probes" | "log">,
): Promise<void> => {
  const nonce = parseProbeNonce(oneArg(value));
  if (nonce === null) {
    throw new BadVerbArgs("doctor-probe: the value is not a probe nonce");
  }
  // [LAW:no-silent-failure] A probe link is opened by the CLI, never drawn in
  // a frame, so one cannot come from the tmux status line.
  if (ctx.arrival.via !== "link")
    throw new BadVerbArgs("doctor-probe: a probe arrives only as a link");
  const { handler } = ctx.arrival;
  ctx.probes.arrive({ nonce, handler });
  ctx.log(
    "info",
    `doctor-probe: arrived nonce=${nonce} handler=${handler ?? "unreported"}`,
  );
};

// Re-probe THIS check at click time and perform the fix its fresh verdict
// carries — never a fix cached from the render that drew the `[fix]`, because
// the world may have moved (the var got set, the tmux server went away). Then
// re-run over the post-fix facts, so the row flips to the truthful reason.
const doctorFix: Verb = {
  gathers: true,
  prepare: async (value, ctx) => {
    const [sessionId = "", checkName = ""] = decodeWire(() =>
      decodeSegments(value),
    );
    const sid = requireSessionId(sessionId);
    const check = checkByName(checkName);
    if (check === undefined) {
      throw new BadVerbArgs(`doctor-fix: unknown check "${checkName}"`);
    }
    const gathered = await gatherClick(ctx, sid);
    return async (c) => {
      const facts = await clickFacts(c, sid, gathered);
      const verdict = check.probe(facts);
      if (verdict.ok || verdict.fix === undefined) {
        throw new BadVerbArgs(
          `doctor-fix: ${check.label} — ${verdict.ok ? "nothing to fix" : verdict.reason}`,
        );
      }
      const after = applyFix(c.doctorStores, verdict.fix, facts);
      if (after.kind === "failed") {
        throw new BadVerbArgs(`doctor-fix: ${check.label} — ${after.reason}`);
      }
      c.log(
        "info",
        `doctor-fix: ${check.name} → ${describeFix(verdict.fix)} (session=${sid})`,
      );
      writeReport(c, sid, after.value);
    };
  },
};

// Record what the user saw of the glyphs THIS check's fresh verdict shows,
// under the sighting they are — never a sighting cached from the render that
// drew the ✓ and ✗, since the session's terminal or joiner may have moved —
// then re-run over those same facts with the mark folded in.
// [LAW:single-enforcer] One gathering per click, as doctorFix: a second asks
// only what a new config changed (`oneAskPerClick`), since a refused spawn
// would read as a different terminal than the one marked.
const doctorMark: Verb = {
  gathers: true,
  prepare: async (value, ctx) => {
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
    const gathered = await gatherClick(ctx, sid);
    return async (c) => {
      const facts = await clickFacts(c, sid, gathered);
      const verdict = check.probe(facts);
      if (verdict.ok || verdict.sighting === undefined) {
        throw new BadVerbArgs(
          `doctor-mark: ${check.label} — ${verdict.ok ? "nothing to mark" : "shows nothing to look at"}`,
        );
      }
      const made = [
        check.name,
        verdict.sighting.id,
        mark as GlyphMark,
      ] as const;
      // [LAW:single-enforcer] The store refuses to file over a book that does
      // not read; that refusal is the click's.
      const marks = c.doctorStores.marks.update((book) =>
        withMark(book, ...made),
      );
      if (marks.kind === "failed") {
        throw new BadVerbArgs(`doctor-mark: ${marks.reason}`);
      }
      c.log(
        "info",
        `doctor-mark: ${check.name} ${mark} on ${verdict.sighting.id} (session=${sid})`,
      );
      writeReport(c, sid, { ...facts, marks });
    };
  },
};

// ─── Slash commands (brandon-context-ceiling-xta.7xt) ───────────────────────

// [LAW:parse-dont-validate] A click's line is honoured only as one a `slash`
// action in the session's config declares — the declaration found supplies
// the SlashLine typed, so the URL chooses among the config's lines and can
// add none. The pane is the one the session's last render reported.
const slash: VerbHandler = async (value, ctx) => {
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
  const result = await ctx.typing(sessionHints(ctx, sid).tmux, action.slash);
  if (result.kind === "refused") {
    ctx.log(
      "warn",
      `slash: ${line} refused — ${result.reason} (session=${sid})`,
    );
    // The pane's own state refused the click — the user's to change, like a
    // store refusal, so BAD_REQUEST; a tmux failure throws from the edge.
    throw new BadVerbArgs(`${line} was not typed: ${result.reason}`);
  }
  ctx.log("info", `slash: typed ${line} into ${result.pane} (session=${sid})`);
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
  ctx: Unbound,
): RunRequest {
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
    sessionId: sid,
    action,
    argv: [program, ...args],
    // [LAW:single-enforcer] The session's process environment, the action's
    // own variables over it.
    env: {
      ...sessionEnv(process.env, {
        sessionId: sid,
        projectDir: origin.projectDir,
        claudeConfigDir: sessionHints(ctx, sid).claudeConfigDir,
      }),
      ...drawn.env,
    },
    cwd: decl.cwd,
    // The loader proved every name a declared source of this config, whose
    // state holds its key.
    refreshes: decl.refreshes.map((name) => ({
      name,
      storage: sources.get(name)!,
    })),
  };
}

const run: VerbHandler = async (value, ctx) => {
  let named = { sessionId: "-", action: "-" };
  let request: RunRequest;
  try {
    const parts = decodeWire(() => decodeSegments(value));
    named = { sessionId: parts[0] || "-", action: parts[1] || "-" };
    request = runOf(parts, ctx);
  } catch (e) {
    // [LAW:nothing-unseen] Every refused link is the owner's event and count;
    // the dispatch shows it in the session's bar.
    if (e instanceof BadVerbArgs) {
      ctx.runs.refused(named.sessionId, named.action, e.message);
    }
    throw e;
  }
  ctx.runs.start(request);
};

// ─── Repository configs (brandon-unfiled-3248.kezw) ─────────────────────────

// [LAW:parse-dont-validate] An answer is recorded only when its mac verifies:
// the bar drew it, for this session, for this directory and this answer. The
// book lives beside the link key, and the render cache watches it, so every
// bar reloads; the clicking session's reloads before the click answers, as
// save's does.
const repoConfig: VerbHandler = async (value, ctx) => {
  const [sessionId = "", dir = "", answer = "", mac = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  // Signed, so it is an answer the bar offered.
  const answered = answer as RepoAnswer;
  if (!ctx.links.verify(repoAnswerFields(sid, dir, answered), mac)) {
    throw new BadVerbArgs(
      "the answer's signature does not match what it carries: it was not drawn by this daemon",
    );
  }
  const filed = recordAnswer(repoConfigs(), dir, answered);
  if (filed.kind === "failed") {
    throw new Error(`${dir} was not ${answered}: ${filed.reason}`);
  }
  ctx.journal.wrote();
  const { superseded, absent, unchecked } = filed.value;
  ctx.log(
    "info",
    `repo-config: ${dir} ${answered} superseded=${superseded.join(",") || "-"} absent=${absent.join(",") || "-"} unchecked=${unchecked.length === 0 ? "-" : JSON.stringify(unchecked)} (session=${sid})`,
  );
  ctx.reloadConfig(sessionOrigin(ctx, sid));
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
const loadConfig: VerbHandler = async (value, ctx) => {
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
    ctx.log("info", `load-config: override cleared (session=${sid})`);
  } else {
    ctx.sessionState.set(sid, SESSION_CONFIG_OVERRIDE_KEY, p);
    ctx.log("info", `load-config: ${p} (session=${sid})`);
  }
};

const LEAF_VERBS = new Map<string, Verb>([
  [VERB_COPY, inTurn(copy)],
  [VERB_LOAD_CONFIG, inTurn(loadConfig)],
  [VERB_OPEN_VSCODE, inTurn(openVscode)],
  [VERB_SET_STATE, inTurn(setState)],
  [VERB_STEP_STATE, inTurn(stepState)],
  [VERB_SET_CONFIG, inTurn(setConfig)],
  [VERB_STEP_CONFIG, inTurn(stepConfig)],
  [VERB_RESET_CONFIG, inTurn(resetConfig)],
  [VERB_SAVE, inTurn(save)],
  [VERB_SAVE_PRESET, inTurn(savePreset)],
  [VERB_SAVE_THEME_DEFAULT, inTurn(saveThemeDefault)],
  [VERB_DELETE_PRESET, inTurn(deletePreset)],
  [VERB_APPLY_LAYOUT_OP, inTurn(applyLayoutOp)],
  [VERB_UNDO, inTurn(undo)],
  [VERB_REDO, inTurn(redo)],
  [VERB_BACK, inTurn(back)],
  [VERB_REWIND, inTurn(rewind)],
  [VERB_TOOLBAR_TOGGLE, inTurn(toolbarToggle)],
  [VERB_APPLY_UPDATE, inTurn(applyUpdate)],
  [VERB_DOCTOR_RUN, doctorRun],
  [VERB_DOCTOR_FIX, doctorFix],
  [VERB_DOCTOR_MARK, doctorMark],
  [VERB_DOCTOR_PROBE, inTurn(doctorProbe)],
  [VERB_SLASH, inTurn(slash)],
  [VERB_RUN, inTurn(run)],
  [VERB_REPO_CONFIG, inTurn(repoConfig)],
  [VERB_COPY_DIAGNOSTIC, inTurn(copyDiagnostic)],
]);

// [LAW:one-source-of-truth] The verbs whose handler splits its value into
// `/`-separated segments (decodeSegments); every other verb decodes its whole
// value as one argument (oneArg, or load-config's split at the first slash).
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
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_COPY_DIAGNOSTIC,
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
  VERB_SAVE_THEME_DEFAULT,
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
  VERB_DOCTOR_MARK,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_LOAD_CONFIG,
  VERB_COPY_DIAGNOSTIC,
]);

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects; the
// dispatcher folds the list, running EVERY effect through the leaf table, after
// batchAdjacentWrites has joined each run of adjacent set-state (or
// reset-config) effects into the one batch that lands whole. The
// effect count is data — N=1 and N=100 walk the identical loop, no plain-vs-
// compound branch. [LAW:no-silent-failure] Every effect runs even if an
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
// so the bar shows WHICH effect(s) failed, for the hold src/daemon/click-error.ts
// sets. Only possible when a session ID
// is available from a set-state or toolbar-toggle effect in the same click.
// [LAW:one-source-of-truth] The session a click is in: the first segment of
// its first session-bearing effect — every SESSION_FIRST_VERBS member carries
// it there — or none. Dispatch surfaces a failed step in that session's bar,
// and the daemon counts the click as that session's activity
// (src/daemon/menu-idle.ts). [LAW:single-enforcer] It is read as it crosses
// the one session-id checkpoint, so every reader of a click's session reads
// the same checked value; one that fails is no session's, and its verb
// refuses the click.
export function clickSessionOf(
  verb: string,
  value: string,
): ParsedSessionId | null {
  return sessionOfEffects(
    verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }],
  );
}

function sessionOfEffects(
  effects: readonly ParsedEffect[],
): ParsedSessionId | null {
  const bearing = effects.find((e) => SESSION_FIRST_VERBS.has(e.verb));
  // Only the session's own segment is read: a step's malformed argument is
  // that step's error to hold on the bar, after the click has found its
  // session.
  const sid =
    bearing === undefined
      ? ""
      : decodeWire(() => decodeFirstSegment(bearing.value));
  return sid === "" ? null : parseSessionId(sid);
}

// [LAW:no-silent-failure] A gather that failed before the turn fails where its
// effect stands in the fold, so what follows it still runs and the error still
// reaches the bar through the journal.
const hoisted = (
  verb: Verb,
  value: string,
  ctx: VerbContext,
): Promise<ClickStep> =>
  ctx.journalTurns
    .gathering(() => verb.prepare(value, ctx))
    .catch(
      (e: unknown): ClickStep =>
        () =>
          Promise.reject(e),
    );

// An effect's turn: its gather's rest, or, gathering in the turn, the whole of
// it, which then reads what the click wrote before it.
async function perform(
  verb: Verb,
  value: string,
  ctx: ClickContext,
  gathered: ClickStep | undefined,
): Promise<void> {
  const step =
    gathered ?? (await ctx.gather((full) => verb.prepare(value, full)));
  await step(ctx);
}

// [LAW:no-ambient-temporal-coupling] Only the gather that opens a click goes
// ahead of its turn. Every other may have to read a write before it, a gather's
// own step included, so it stays in the fold.
async function headGather(
  rawValue: string,
  ctx: VerbContext,
): Promise<ClickStep | undefined> {
  const [head] = batchAdjacentWrites(parseEffects(rawValue));
  const leaf = head === undefined ? undefined : LEAF_VERBS.get(head.verb);
  return leaf?.gathers ? hoisted(leaf, head!.value, ctx) : undefined;
}

async function foldEffects(
  rawValue: string,
  ctx: ClickContext,
  gathered: ClickStep | undefined,
): Promise<void> {
  const errors: string[] = [];
  let operational = false;
  const effects = parseEffects(rawValue);
  // The click's session, for error display, so a failing step surfaces in the
  // bar like any other.
  const session = sessionOfEffects(effects);
  for (const [i, { verb, value }] of batchAdjacentWrites(effects).entries()) {
    const leaf = LEAF_VERBS.get(verb);
    if (!leaf) {
      errors.push(`unknown effect verb "${verb}"`);
      continue;
    }
    try {
      await perform(leaf, value, ctx, i === 0 ? gathered : undefined);
    } catch (e) {
      // [LAW:single-enforcer] The turn is over: no later effect runs, and the
      // journal holdClickError writes through is finished. What failed before
      // it has no bar left to reach, so the log has it.
      if (e instanceof DaemonClosing) {
        if (errors.length > 0)
          ctx.log("warn", `dispatch: ${errors.join("; ")}`);
        throw e;
      }
      if (!(e instanceof BadVerbArgs)) operational = true;
      errors.push(`${verb}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length > 0) {
    if (session?.ok) {
      holdClickError(
        ctx.sessionState,
        session.id,
        errors.join("\n"),
        ctx.now(),
      );
    }
    const message = `dispatch: ${errors.join("; ")}`;
    throw operational ? new Error(message) : new BadVerbArgs(message);
  }
}

function throwAll(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new Error(
      failures.map((e) => String((e as Error).message ?? e)).join("; "),
    );
  }
}

// [LAW:single-enforcer] One click is one undoable step, so the step boundary
// is the click boundary: every entry of the table the daemon looks up against
// runs inside a journal it opens and commits. `dispatch` folds its effects
// through the RAW leaf table, so a click of N effects is one journal and one
// step, never N. The commit runs even when a handler threw — whatever landed
// before the throw is real, so it is recorded. [LAW:no-silent-failure] A
// commit that fails too never hides the handler's own error: the click
// reports both.
//
// [LAW:single-enforcer] It is also where every click of a session passes, so
// it measures that session's lane switches (`sid` names it): before the
// handler, and after the commit — after any reload the handler made, since a
// reload is synchronous. What a lane runs follows the difference, which no
// render, frame or other session's write can make. After the commit it also
// brings the session's view to the config its origin now resolves to.
//
// [LAW:single-enforcer] It runs in the journal's turn `click` took
// (src/daemon/journal-turns.ts), begin through view-follow, so an awaited
// handler keeps its step whole. A turn the daemon's close cut off was committed
// there, and the daemon is gone from under what follows the commit.
async function journaled<C extends DaemonContext>(
  sid: string | null,
  ctx: C,
  turn: JournalTurn,
  handler: (ctx: Journaled<C>) => Promise<void>,
): Promise<void> {
  const lanes = sid === null ? null : laneMeter(ctx, sid);
  const journal = ctx.history.begin();
  const navigation = ctx.navigation.begin(journal.sessionState);
  // Each commit runs whatever the other did: both record what landed.
  const commit = turn.holds(() => {
    const failed: unknown[] = [];
    for (const step of [navigation, journal]) {
      try {
        step.commit();
      } catch (e) {
        failed.push(e);
      }
    }
    throwAll(failed);
  });
  const failures: unknown[] = [];
  // Both views close what a write closes, the navigating one above its
  // recording, so ◁ back restores a closed menu with what was open in it.
  const closing = (store: SessionStateRW): SessionStateRW =>
    closingView(
      store,
      (sid) => nestOf(ctx, sid),
      (line) => ctx.log("info", line),
    );
  // The whole context, launches included, is the gather's alone to reach.
  const journaling = {
    ...ctx,
    sessionState: closing(journal.sessionState),
    journal,
    navigating: closing(navigation.sessionState),
  };
  const launches: Pick<
    Journaled<DaemonContext>,
    "launch" | "typing" | "applyUpdate"
  > = {
    launch: (opts, what) =>
      turn.landed(clickLaunch(ctx.launcher, opts, what, ctx.log)),
    typing: (hint, line) => turn.landed(typeSlash(ctx.claudeInput, hint, line)),
    applyUpdate: () => turn.landed(ctx.applyUpdate()),
  };
  try {
    await handler({
      ...journaling,
      ...launches,
      gather: <T>(work: (c: C) => Promise<T>) => turn.landed(work(journaling)),
    } as unknown as Journaled<C>);
  } catch (e) {
    failures.push(e);
  }
  let live = true;
  try {
    live = commit();
  } catch (e) {
    failures.push(e);
  }
  if (live && lanes !== null) {
    try {
      // [LAW:no-ambient-temporal-coupling] Only a click that wrote can have
      // moved its lanes: for one that wrote nothing, what moved while it
      // parked is a watcher reload, and no move of its own.
      const after = lanes.read();
      ctx.lanes.clicked(
        lanes.sessionId,
        journal.written() ? lanes.before : after,
        after,
      );
    } catch (e) {
      failures.push(e);
    }
  }
  // [LAW:single-enforcer] Every click passes here, so here is where a
  // click that moved the session's origin — a load-config pick, or a
  // history step restoring or clearing one — moves its view: a frame opens
  // none (src/daemon/cache/render.ts `holdView`).
  // A session that has never rendered has no origin, and no view.
  if (live && sid !== null) {
    try {
      const origin = recordedOrigin(ctx, sid);
      if (origin !== null) ctx.views.follow(sid, origin);
    } catch (e) {
      failures.push(e);
    }
  }
  throwAll(failures);
}

// [LAW:single-enforcer] A click: its place in its session's order, the gather
// ahead of its turn, then a journal around the rest (src/daemon/journal-turns.ts).
function click(
  verb: string,
  gather: (value: string, ctx: VerbContext) => Promise<ClickStep | undefined>,
  handler: (
    value: string,
    ctx: ClickContext,
    gathered: ClickStep | undefined,
  ) => Promise<void>,
): (value: string, ctx: VerbContext) => Promise<void> {
  return async (value, ctx) => {
    const session = clickSessionOf(verb, value);
    const sid = session?.ok ? session.id : null;
    return ctx.journalTurns.click(
      verb,
      sid,
      {
        placed: ctx.placeWaited,
        waited: ctx.turnWaited,
        gone: ctx.clientGone,
        gathered: ctx.gatherTook,
      },
      () => gather(value, ctx),
      (gathered, turn) =>
        journaled(sid, ctx, turn, async (c) => {
          try {
            await handler(value, c, gathered);
          } finally {
            if (sid !== null) ctx.clickLanded(sid);
          }
        }),
    );
  };
}

// [LAW:one-source-of-truth] The full dispatch table the daemon looks up against:
// every leaf verb plus the one `dispatch` wrapper. Old scrollback links that
// name a leaf verb directly still resolve here; new renders all emit `dispatch`.
export const VERBS: ReadonlyMap<
  string,
  (value: string, ctx: VerbContext) => Promise<void>
> = new Map([
  ...[...LEAF_VERBS].map(
    ([verb, leaf]) =>
      [
        verb,
        click(
          verb,
          async (value, ctx) =>
            leaf.gathers ? hoisted(leaf, value, ctx) : undefined,
          (value, ctx, gathered) => perform(leaf, value, ctx, gathered),
        ),
      ] as const,
  ),
  [VERB_DISPATCH, click(VERB_DISPATCH, headGather, foldEffects)] as const,
  // After the leaves, so it replaces the click they built: a probe writes no
  // journal, so nothing may refuse it for a turn.
  [VERB_DOCTOR_PROBE, doctorProbe] as const,
]);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];

// How long a session's menus sat with no click before its timer closed them.
export interface IdleClose {
  readonly idleS: number;
  readonly timeoutS: number;
  // Whether the session is still known idle since the timer fired, read in the
  // close's turn: a click, or its record's eviction, ends that.
  readonly stillIdle: () => boolean;
  // The close decided to write: the clock's record follows it.
  readonly closed: () => void;
}

// [LAW:single-enforcer] The idle timer's close (brandon-menus-sjhy.my3) takes
// a click's own path: the journals the verb table opens — so an exit from edit
// mode releases its savepoint, and ◁ back can reopen what it closed — and the
// closing view, which folds everything open inside what closes. It writes
// `closed` to each menu open at the top, the write its ✕ makes. No URL names
// it: it is not in VERBS.
export function closeIdleMenus(
  sid: string,
  idle: IdleClose,
  ctx: DaemonContext,
): Promise<void> {
  return ctx.journalTurns.take(
    "menu-idle",
    {
      waited: (ms) =>
        ctx.log("info", `menu-idle: waited=${ms}ms (session=${sid})`),
      gone: () => false,
    },
    (turn) =>
      journaled(sid, ctx, turn, async (c) => {
        if (!idle.stillIdle()) {
          c.log("info", `menu-idle: no longer idle, kept (session=${sid})`);
          return;
        }
        idle.closed();
        const roots = openRoots(nestOf(c, sid), (key) =>
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
      }),
  );
}
