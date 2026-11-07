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
// `value`, the tail of the link after its verb, where <value> may itself
// contain `/`. The per-verb handler parses its own value into the typed args
// it needs.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  failureText,
  readJobEnd,
  type Failed,
  type LaunchOpts,
  type Launcher,
} from "../../proc/launch";
import type { Locations } from "../paths";
import type { SessionStateReader, SessionStateRW } from "../session-state";
import { holdClickError } from "../click-error";
import type { Instant } from "../../utils/instant";
import { sleep } from "../../time";
import { stateKeySeed } from "./key-seeds";
import {
  disclosureNest,
  NO_NEST,
  openRoots,
  type DisclosureNest,
} from "../../config/disclosure-nest";
import { DISCLOSURE_CLOSED } from "../../config/disclosure";
import type { Drawing, LaneSwitches } from "../../config/lanes";
import type { CheckedRenderRequest } from "../render-checkpoint";
import { closingView } from "../closing-view";
import { configKeySeed } from "./key-seeds";
import type { Gates } from "../foundations/gates";
import type { Gate, RangeParams } from "../foundations/validator-registry";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
} from "../foundations/session-keys";
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
  batchAdjacentWrites,
  parseEffects,
  type ParsedEffect,
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
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_PROBE,
  VERB_SLASH,
  VERB_RUN,
  VERB_REPO_CONFIG,
  VERB_COPY_DIAGNOSTIC,
  isClickVerb,
  type ClickVerb,
  type EvaluatedRun,
} from "../../click/wire";
import type { RendererLinks } from "../../click/renderer-links";
import { recordAnswer, repoAnswerFields } from "../repo-configs";
import { readRepoAnswers } from "../../config/loader/repo-book";
import type { Filesystem } from "../../disk/filesystem";
import type { InstalledLayerMemo } from "../../config/dsl-loader";
import type { RepoAnswer } from "../../config/loader/repo-gate";
import type { Runs, RunRequest } from "../runs";
import type { LaneSetups } from "../lane-setup";
import type { DeclaredSources } from "../render-payload";
import { sessionEnv } from "../session-env";
import { runDeclaration, type SlashAction } from "../../config/action";
import type { RenderSightings } from "../render-sightings";
import type { ServingDaemon } from "../limits";
import { parseClientHints } from "../protocol";
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
import type { ConfigTarget, RenderOrigin } from "../../config-hint";
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
import { tmuxPaneOf, type ClaudeInputEdge } from "../../claude-input/edge";
import type {
  DoctorEffect,
  DoctorGathered,
  DoctorStamp,
  DoctorStep,
  Effect,
  LaunchSpec,
} from "../effect";

// What the daemon hands everything that writes a session's state: a click's
// verb, and the idle timer that closes its menus (`closeIdleMenus`).
export interface DaemonContext {
  // What this daemon's clicks may write: the gates its root built.
  readonly gates: Gates;
  readonly sessionState: SessionStateRW;
  // [LAW:effects-at-boundaries] The daemon's clock.
  readonly now: () => Instant;
  readonly log: (level: "info" | "warn" | "error", msg: string) => void;
  // Who a click's programs belong to.
  readonly launcher: Launcher;
  // The state directory whose answers book a click reads and records in.
  readonly stateDir: string;
  // The disk a click resolves its home over and records an answer on, and the
  // installed layers the render cache's loads over it share, which a click's
  // proof load shares too.
  readonly filesystem: Filesystem;
  readonly installedLayers: InstalledLayerMemo;
  // The directory a stored home path is relative to (paths.ts storedRoot):
  // what the session's recorded origin is read back against.
  readonly storedRoot: StoredRoot;
  // Where the user's config and installed plugins live: a click's write
  // resolves its home under them.
  readonly locations: Locations;
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
  // Where a `probe` link records that it arrived.
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
  readonly journalTurns: Pick<
    JournalTurns,
    "take" | "gathering" | "performing"
  >;
  // [LAW:effects-at-boundaries] Where a turn's described effects go once it
  // has committed: the performer's list (src/daemon/apply.ts). The arm that
  // runs the turn hands this in; a handler never reaches it, `Journaled.effect`
  // being its one way to describe.
  readonly described: (effects: readonly Effect[]) => void;
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
  // [LAW:single-enforcer] Whose links this daemon drew: a `run` link is
  // honoured only if it verifies under their key.
  readonly links: RendererLinks;
  // [LAW:no-ambient-temporal-coupling] The one owner of runs in flight: a
  // `run` click supersedes its sources in its turn and describes the launch,
  // which the performer hands back (`run`), and is answered at once.
  readonly runs: Pick<Runs, "superseded" | "run" | "refused">;
  // [LAW:effects-at-boundaries] A session's animation-lane switches over the
  // config it renders with (`of`, looked up like `configFor`), and what
  // follows a click of that session (`clicked`) or a request's arrival
  // (`arrived`): the click path measures them before each click and after
  // its commit (`journaled`), the request's arm in its turn
  // (src/daemon/apply.ts), and the daemon hands each to the one owner of lane
  // setup (src/daemon/lane-setup.ts) and of the tmux status line.
  readonly lanes: {
    readonly of: (origin: RenderOrigin, sessionId: string) => LaneSwitches;
    // The lane setups the click settles, as effects of its turn.
    readonly clicked: (
      sessionId: string,
      before: LaneSwitches,
      after: LaneSwitches,
    ) => readonly Effect[];
    // The lane setups the request's arrival settles, as effects of its turn.
    readonly arrived: (req: CheckedRenderRequest) => readonly Effect[];
    // The performer's run of one setup (src/daemon/lane-setup.ts).
    readonly setup: LaneSetups["setup"];
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
  // Whether THIS click's client has left: told TIMEOUT, or hung up, while the
  // click sat behind the loop.
  readonly gone: () => boolean;
}

// The edges a handler never reaches: what it would do through them it
// describes as an effect instead (`Journaled.effect`), so it awaits nothing.
// Nor does it reach the performer's list: the turn hands its effects over
// once it has committed.
type TurnBound =
  | "launcher"
  | "doctor"
  | "claudeInput"
  | "applyUpdate"
  | "described";

// What a helper reads, from either side of the turn.
type Unbound = Omit<DaemonContext, TurnBound>;

// A context with the journals the verb table opens around a write.
export type Journaled<C extends DaemonContext> = Omit<C, TurnBound> & {
  readonly journal: Journal;
  readonly navigating: SessionStateRW;
  // [LAW:effects-at-boundaries] What the click asks of the world (a program,
  // a line typed into its pane, the update's act, the doctor's probes) is
  // described here, as data, and performed once the turn has committed
  // (src/daemon/apply.ts): a handler awaits nothing, and a turn is as short
  // as its writes. An effect goes where the step's writes went: a turn that
  // committed performs every effect its steps described, a refused step's
  // refusal beside them.
  readonly effect: (effect: Effect) => void;
};

// What a handler runs with: the daemon's context, with `sessionState` the
// click's journaling view of it and `journal` where its file writes report.
// `navigating` is the view the navigating verbs write through: the same store,
// with what they change on screen recorded for `back` as well.
export type ClickContext = Journaled<VerbContext>;

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// session its click is in, already parsed, the decoded arguments after it, and
// the daemon's verb context, so a verb that names no session cannot join the
// leaf table; it returns
// nothing (clicks have no payload), and synchronously: it runs in its turn,
// and what it would wait on it describes as an effect. `undefined`, not
// `void`, so an async handler, whose promise `void` would accept, fails to
// build.
// User-facing failures throw an Error;
// the dispatcher in reply.ts converts that to a RENDER_FAILED response.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error which the dispatcher surfaces as BAD_REQUEST.
export type VerbHandler = (
  sid: SessionId,
  args: readonly string[],
  ctx: ClickContext,
) => undefined;

import type { JournalTurns } from "../journal-turns";
import {
  BadVerbArgs,
  ClickAbandoned,
  DaemonClosing,
  parseWire,
  type WireParse,
} from "../verb-error";
import {
  StoredPathRefused,
  resolveStoredPath,
  type StoredRoot,
} from "../foundations/stored-path";
import {
  parseSessionId,
  type ParsedSessionId,
  type SessionId,
} from "../session-id";
export { BadVerbArgs };

// ─── Verb handlers ───────────────────────────────────────────────────────────

// How long a program a click launches has before its effect fails, or, for an
// opener's handoff, before it counts as handed off: a handful of seconds at most.
export const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// [LAW:single-enforcer] What an opener's handoff that ended badly does to the
// click that waits on it (`clickHandoff`); a launch described as an effect
// answers an outcome instead (src/daemon/apply.ts).
// [LAW:dataflow-not-control-flow] Rate-limit rejection is one outcome among
// many — the click is acknowledged and the rejection is logged. A closing
// daemon is its own outcome; every other failure surfaces as RENDER_FAILED,
// saying what the launch itself said: the spawn's error, or the program's stderr.
function clickFailed(r: Failed, what: string, log: DaemonContext["log"]): void {
  if (r.reason === "rate-limited") {
    log("warn", failureText(r));
    return;
  }
  if (r.reason === "aborted") throw new DaemonClosing(what);
  throw new Error(`${what} failed (${failureText(r)})`);
}

// How often a handoff looks for its opener's verdict while the click waits.
const HANDOFF_POLL_MS = 50;

// [LAW:one-type-per-behavior] A click that hands a URL to the platform's
// opener. Unlike `clickLaunch`, what the opener starts must outlive the click:
// xdg-open with no browser running stays the browser's parent, so a launch the
// bound ends would end the browser with it. The opener runs as a job, whose
// group nothing aimed at the daemon reaches — a closing daemon included — and
// the click waits on its verdict for `boundMs`. [LAW:no-silent-failure] An
// opener that exits non-zero inside the bound fails the click with what it
// wrote to stderr, and a job whose group is gone with no verdict was lost; one
// still running at the bound has handed off, and is left running.
export async function clickHandoff(
  launcher: Launcher,
  opts: Omit<LaunchOpts, "timeoutMs">,
  what: string,
  log: DaemonContext["log"],
  boundMs: number,
  tmp: string,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmp, "cc-candybar-handoff-"));
  // The job's files go when the click is answered: a program still running
  // keeps the descriptors it already holds, and its sh's verdict, written to a
  // directory that is gone, has no reader left to miss it.
  try {
    const files = {
      // Unread, and a handed-off browser would write to it for its whole life.
      stdout: "/dev/null",
      stderr: path.join(dir, "stderr"),
      status: path.join(dir, "status"),
    };
    const job = launcher.launchJobSync(opts, files);
    if (!job.ok) {
      clickFailed(
        { ...job, stdout: "", stderr: "", exitCode: null, signal: null },
        what,
        log,
      );
      return;
    }
    job.release();
    // [LAW:no-ambient-temporal-coupling] A monotonic clock, so a wall-clock
    // step neither stretches nor cuts the bound.
    const deadline = launcher.clock.monotonic() + boundMs;
    for (;;) {
      // Liveness before the verdict: the sh writes its verdict before it exits,
      // so a group seen gone and then no verdict means none is coming.
      const alive = launcher.jobGroupAlive(job.pid);
      const end = readJobEnd(files.status);
      if (end !== null) {
        if (end.kind === "exit" && end.code === 0) return;
        clickFailed(
          end.kind === "exit"
            ? {
                ok: false,
                reason: "non-zero",
                stdout: "",
                stderr: readFileSync(files.stderr, "utf8"),
                exitCode: end.code,
                signal: null,
              }
            : {
                ok: false,
                reason: "timeout",
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
              },
          what,
          log,
        );
        return;
      }
      if (!alive)
        throw new Error(
          `${what} failed (lost): the opener ended with no verdict`,
        );
      if (launcher.clock.monotonic() >= deadline) {
        // [LAW:nothing-unseen] What the click leaves running is said once.
        log(
          "info",
          `${opts.category} handed off at ${boundMs}ms, pid ${job.pid}`,
        );
        return;
      }
      await sleep(launcher.clock, HANDOFF_POLL_MS);
    }
  } finally {
    // A sh writing its verdict as the click is answered can add a file between
    // the listing and the rmdir; the retry takes it with the rest.
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// One clipboard primitive, no decode: copy-text (its text segment) and the
// diagnostic verbs (a plain message) both funnel here.
function pbcopy(text: string, ctx: ClickContext): void {
  launch(
    ctx,
    { bin: "/usr/bin/pbcopy", stdinInput: text, category: "click.pbcopy" },
    "pbcopy",
  );
}

// A program the click waits out, described for the performer.
function launch(ctx: ClickContext, spec: LaunchSpec, what: string): void {
  ctx.effect({ kind: "launch", spec, what });
}

const copy: VerbHandler = (_sid, [text = ""], ctx) => {
  pbcopy(text, ctx);
};

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
const copyDiagnostic: VerbHandler = (sid, args, ctx) => {
  const [by = "", key = ""] = args;
  const text = ctx.diagnosticCopy(sid, requireDrawer(by), key);
  if (text === undefined)
    throw new BadVerbArgs(
      `that message is no longer listed in session ${sid}'s diagnostics — open ⚠ again and copy from there`,
    );
  pbcopy(text, ctx);
};

const openVscode: VerbHandler = (_sid, [target = ""], ctx) => {
  launch(
    ctx,
    {
      bin: "/usr/bin/open",
      args: ["-a", "Visual Studio Code", target],
      category: "click.open",
    },
    'open -a "Visual Studio Code"',
  );
};

// [LAW:one-source-of-truth] SessionState is the canonical store for
// toolbar-expanded state (eir merge). Toggle via set/clear; the file-backed
// storage owned by the daemon process persists the change automatically.
const toolbarToggle: VerbHandler = (sessionId, _args, ctx) => {
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
//   <sessionId>/<k1>/<v1>[/<k2>/<v2>/...]. The click reader splits on `/` and
//   decodes each segment — a CODEC property: a `/` inside a segment rides as
//   `%2F` and is never read as a separator, so the wire itself is slash-safe.
//   This is NOT an end-to-end "slash-bearing state keys are supported" claim:
//   the loader and the state-validator factories reject slash-bearing keys and
//   option values upstream, so a slash never reaches here in practice. The N=1
//   form is the degenerate single-pair case — the parser walks pairs uniformly.
const setState: VerbHandler = (sid, rest, ctx) => {
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
const stepState: VerbHandler = (sid, args, ctx) => {
  const [key = "", byRaw = ""] = args;
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
// guessed path. A file is a StoredPath resolved against the home's root
// (stored-path.ts), which reads an older build's bare string too.
export function parseRenderOrigin(raw: string, root: StoredRoot): RenderOrigin {
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
    configFile === undefined
  ) {
    throw new BadVerbArgs(`render origin has the wrong shape: ${raw}`);
  }
  let file: string | null;
  try {
    file = configFile === null ? null : resolveStoredPath(root, configFile);
  } catch (e) {
    if (!(e instanceof StoredPathRefused)) throw e;
    throw new BadVerbArgs(`render origin: ${e.message}`);
  }
  return { projectDir, cwd, target: recordedTarget(source, file) };
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
function recordedOrigin(
  ctx: Omit<DaemonContext, TurnBound>,
  sid: string,
): RenderOrigin | null {
  const raw = ctx.sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
  return raw === null ? null : parseRenderOrigin(raw, ctx.storedRoot);
}

// [LAW:no-ambient-temporal-coupling] A history step that rewrote the file this
// session renders from reloads it before the click answers, as save does; one
// that wrote no such file rebuilds nothing (a reload restarts every source).
// Another session's file reaches its render through the fs watcher.
function reloadIfWritten(ctx: Unbound, sid: string, step: Step): void {
  // A session with no recorded render has no cache entry to draw stale.
  const origin = recordedOrigin(ctx, sid);
  if (origin === null) return;
  const { path } = originHome(ctx, origin);
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
// config it renders with now. Null for a session that has never rendered,
// which has no config to switch them.
interface LaneMeter {
  readonly sessionId: string;
  readonly before: LaneSwitches;
  readonly read: () => LaneSwitches;
}

function laneMeter(ctx: DaemonContext, sid: string): LaneMeter | null {
  const origin = recordedOrigin(ctx, sid);
  if (origin === null) return null;
  const read = (): LaneSwitches => ctx.lanes.of(origin, sid);
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
function originHome(
  ctx: Pick<
    ClickContext,
    "stateDir" | "locations" | "filesystem" | "installedLayers"
  >,
  origin: RenderOrigin,
): ConfigHome {
  return durableConfig(
    ctx.filesystem,
    ctx.installedLayers,
    ctx.locations,
    readRepoAnswers(ctx.filesystem, ctx.stateDir),
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
const setConfig: VerbHandler = (sid, args, ctx) => {
  const [key = "", incoming = ""] = args;
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
  const home = originHome(ctx, origin);
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
const stepConfig: VerbHandler = (sid, args, ctx) => {
  const [key = "", byRaw = ""] = args;
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
  const gate = ctx.gates.config.gateFor(config);
  const params = gate.rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${gate.listKeys().join(", ")})`,
    );
  }
  const home = originHome(ctx, origin);
  const landing = durableLanding(
    config,
    (k) => ctx.sessionState.get(sid, k),
    key,
  );
  const stored = readValue(home, landing.key);
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
const save: VerbHandler = (sid, _args, ctx) => {
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
  const home = originHome(ctx, origin);
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
const savePreset: VerbHandler = (sid, _args, ctx) => {
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
  const home = originHome(ctx, origin);
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
const saveThemeDefault: VerbHandler = (sid, _args, ctx) => {
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
  const home = originHome(ctx, origin);
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
const deletePreset: VerbHandler = (sid, args, ctx) => {
  const [name = ""] = args;
  if (!name) {
    throw new BadVerbArgs(
      "delete-preset: <name> is required (shape: <sessionId>/<name>)",
    );
  }
  const origin = sessionOrigin(ctx, sid);
  const home = originHome(ctx, origin);
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
const resetConfig: VerbHandler = (sid, args, ctx) => {
  const keys = args;
  const origin = sessionOrigin(ctx, sid);
  const known = ctx.gates.config.gateFor(ctx.configFor(origin)).listKeys();
  const unknown =
    keys.length === 0 ? [""] : keys.filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${unknown.join('", "')}" (have: ${known.join(", ")})`,
    );
  }
  const home = originHome(ctx, origin);
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
const applyLayoutOp: VerbHandler = (sid, args, ctx) => {
  const [key = "", opToken = ""] = args;
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
  const home = originHome(ctx, origin);
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
const undo: VerbHandler = (sid, _args, ctx) => {
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
const back: VerbHandler = (sid, _args, ctx) => {
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
const rewind: VerbHandler = (sid, _args, ctx) => {
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
const redo: VerbHandler = (sid, _args, ctx) => {
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
const applyUpdate: VerbHandler = (_sid, _args, ctx) => {
  ctx.effect({ kind: "apply-update" });
};

// ─── Doctor (brandon-doctor-b6a) ────────────────────────────────────────────

// [LAW:no-silent-failure] A session that has never rendered has no hints —
// a loud BadVerbArgs, never a click that acts on a guessed "not in tmux".
function sessionHints(
  ctx: { readonly sessionState: SessionStateReader },
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

// [LAW:effects-at-boundaries] A doctor click's probes are an effect: the click
// checks its arguments in its turn and describes the step, the performer
// gathers after the turn has committed (src/daemon/apply.ts), so the gather
// reads every write of the click before it, and the step lands with the
// outcome, in a turn of its own (`landDoctor`). No turn waits on a probe.
function describeDoctor(
  ctx: ClickContext,
  sid: string,
  step: DoctorStep,
): void {
  ctx.effect({ kind: "doctor", session: sid, step, arrival: ctx.arrival });
}

// [LAW:one-source-of-truth] What a gather read that a turn can change, so
// the landing can ask whether it still stands: the config it loaded, and
// every key of the session's state it read, through a view that records them
// (the render origin a request records, the picks that choose the glyphs it
// probes). Nothing lists which keys matter; a key the doctor starts reading
// is in the stamp by being read. The hints are the one record read through a
// projection (`doctorHints`), so they are stamped as it reads them.
function recordingReads(
  store: SessionStateRW,
  reads: Map<string, DoctorStamp["reads"][number]>,
): SessionStateRW {
  const refused = (what: string): never => {
    throw new Error(`doctor: the gather ${what}; a gather writes nothing`);
  };
  return {
    get: (sid, key) => {
      const value = store.get(sid, key);
      reads.set(JSON.stringify([sid, key]), {
        what: key,
        value,
        again: (state) => state.get(sid, key),
      });
      return value;
    },
    // [LAW:no-silent-failure] A gather reads keys by name, so each is stamped
    // as it is read: the whole record read as one would stamp every write the
    // session takes during the probes, a resize's hints among them.
    values: () => refused("read every key; a gather reads keys by name"),
    revision: (sid) => store.revision(sid),
    set: (_sid, key) => refused(`set ${key}`),
    setBatch: () => refused("wrote a batch"),
    clear: (_sid, key) => refused(`cleared ${key}`),
  };
}

// The first input a gather read that no longer reads as it did, or null.
function movedSince(
  ctx: Unbound & Pick<DaemonContext, "doctor">,
  sid: string,
  stamp: DoctorStamp,
): string | null {
  for (const { what, value, again } of stamp.reads) {
    if (again(ctx.sessionState) !== value) return what;
  }
  const stands = ctx.doctor.loadConfig(sessionOrigin(ctx, sid));
  // A reload that failed keeps the config it had, so its error is the news.
  return stands.config === stamp.load.config &&
    stands.error === stamp.load.error &&
    stands.warning === stamp.load.warning
    ? null
    : "config";
}

// What the doctor reads of the hints the session's last request recorded.
function doctorHints(
  state: SessionStateReader,
  sid: string,
): Parameters<typeof gatherFacts>[1] {
  const { tmux, claudeConfigDir, terminalEnv, ssh } = sessionHints(
    { sessionState: state },
    sid,
  );
  return { tmux, claudeConfigDir, terminalEnv, ssh };
}

// `doctor` answers each question once for the click (`oneAskPerClick`), so a
// gather repeated for moved inputs asks again only what they changed. A probe
// the rate limit refused refuses the step (DoctorBusy), so no report is
// written over facts the doctor did not see.
async function gatherOnce(
  ctx: Omit<DaemonContext, "described">,
  sid: string,
  arrival: ClickArrival,
  doctor: DoctorEdge,
): Promise<DoctorGathered> {
  const reads = new Map<string, DoctorStamp["reads"][number]>();
  const seen = {
    ...ctx,
    sessionState: recordingReads(ctx.sessionState, reads),
  };
  // [LAW:one-source-of-truth] The hints as the doctor reads them: a request
  // rewrites the record it said on a resize, which moves nothing a report
  // judges, so the stamp holds what the doctor read of it and no more.
  const hintsRead = (state: SessionStateReader): string =>
    JSON.stringify(doctorHints(state, sid));
  const hints = doctorHints(ctx.sessionState, sid);
  reads.set("hints", {
    what: SESSION_CLIENT_HINTS_KEY,
    value: JSON.stringify(hints),
    again: hintsRead,
  });
  const load = doctor.loadConfig(sessionOrigin(seen, sid));
  // The session's own renders, read once: whatever its Claude Code sends, it
  // sends to this session.
  const scope = { kind: "clicked", sessionId: sid, via: arrival.via } as const;
  const said = ctx.clients.ofSession(sid, ctx.now());
  let facts: DoctorGathered["facts"];
  try {
    facts = await gatherFacts(
      { ...doctor, loadConfig: () => load },
      hints,
      sessionOrigin(seen, sid),
      (key) => seen.sessionState.get(sid, key),
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
  return {
    facts,
    // The client that drew the bar this click came from, and the daemon the
    // click reached — this process.
    install: installFacts(
      doctor.install,
      ctx.bundle,
      said.map((s) => s.client),
    ),
    stamp: { load, reads: [...reads.values()] },
  };
}

// [LAW:no-ambient-temporal-coupling] The doctor effect's performer: one gather
// for the inputs as they stand, and one more if they moved during its probes,
// as a snapshot of one set of inputs. Whether they still stand when it lands
// is the landing's to ask, in its turn.
export async function gatherDoctor(
  ctx: Omit<DaemonContext, "described">,
  effect: DoctorEffect,
): Promise<DoctorGathered> {
  const doctor = oneAskPerClick(ctx.doctor);
  const sid = effect.session;
  return ctx.journalTurns.gathering(async () => {
    const first = await gatherOnce(ctx, sid, effect.arrival, doctor);
    return movedSince(ctx, sid, first.stamp) === null
      ? first
      : gatherOnce(ctx, sid, effect.arrival, doctor);
  });
}

// The gather as it lands, with the click itself as the link that came back
// through the URL handler. [LAW:no-ambient-temporal-coupling] The stores are
// read here, not in the gather: this landing's turn is what files into them,
// so what the gather read another landing may have moved.
function landedFacts(
  ctx: Unbound,
  sid: string,
  arrival: ClickArrival,
  { facts, install }: DoctorGathered,
): DoctorFacts {
  const stores = readStores(ctx.doctorStores);
  const read = {
    ...facts,
    marks: stores.marks,
    clicked: stores.clicked,
    daemon: { ...facts.daemon, read: stores.postMortemsRead },
  };
  return {
    ...read,
    urlHandler: clickArrived(arrival),
    install,
    clicked: clickedFrom(ctx, arrival, read),
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
  arrival: ClickArrival,
  { terminal, clicked }: DoctorGathered["facts"],
): DoctorFacts["clicked"] {
  const sighting =
    terminal.kind === "seen" ? sightingOf(terminal.identified) : null;
  if (sighting === null || arrival.via !== "link") return clicked;
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

// What each step does with the facts as they land, in the landing's turn: a
// refusal throws, as a click's step does, and the landing answers it failed.
const DOCTOR_STEPS: {
  readonly [K in DoctorStep["kind"]]: (
    ctx: Unbound,
    sid: string,
    step: Extract<DoctorStep, { readonly kind: K }>,
    facts: DoctorFacts,
  ) => void;
} = {
  run: (ctx, sid, _step, facts) => writeReport(ctx, sid, facts),
  // Re-probe THIS check at click time and perform the fix its fresh verdict
  // carries — never a fix cached from the render that drew the `[fix]`,
  // because the world may have moved (the var got set, the tmux server went
  // away). Then re-run over the post-fix facts, so the row flips to the
  // truthful reason.
  fix: (ctx, sid, { check }, facts) => {
    const verdict = check.probe(facts);
    if (verdict.ok || verdict.fix === undefined) {
      throw new BadVerbArgs(
        `doctor-fix: ${check.label} — ${verdict.ok ? "nothing to fix" : verdict.reason}`,
      );
    }
    const after = applyFix(ctx.doctorStores, verdict.fix, facts);
    if (after.kind === "failed") {
      throw new BadVerbArgs(`doctor-fix: ${check.label} — ${after.reason}`);
    }
    ctx.log(
      "info",
      `doctor-fix: ${check.name} → ${describeFix(verdict.fix)} (session=${sid})`,
    );
    writeReport(ctx, sid, after.value);
  },
  // Record what the user saw of the glyphs THIS check's fresh verdict shows,
  // under the sighting they are — never a sighting cached from the render
  // that drew the ✓ and ✗, since the session's terminal or joiner may have
  // moved — then re-run over those same facts with the mark folded in.
  mark: (ctx, sid, { check, mark }, facts) => {
    const verdict = check.probe(facts);
    if (verdict.ok || verdict.sighting === undefined) {
      throw new BadVerbArgs(
        `doctor-mark: ${check.label} — ${verdict.ok ? "nothing to mark" : "shows nothing to look at"}`,
      );
    }
    // [LAW:single-enforcer] The store refuses to file over a book that does
    // not read; that refusal is the step's.
    const marks = ctx.doctorStores.marks.update((book) =>
      withMark(book, check.name, verdict.sighting!.id, mark),
    );
    if (marks.kind === "failed") {
      throw new BadVerbArgs(`doctor-mark: ${marks.reason}`);
    }
    ctx.log(
      "info",
      `doctor-mark: ${check.name} ${mark} on ${verdict.sighting.id} (session=${sid})`,
    );
    writeReport(ctx, sid, { ...facts, marks });
  },
};

// [LAW:single-enforcer] A doctor step lands in the outcome's turn, so the
// question whether its inputs still stand and the write of its answer are
// one synchronous step that no writer can come between: an input moved since
// the gather refuses the step, so a report never judges one set of inputs on
// probes taken for another.
export function landDoctor(
  ctx: Unbound & Pick<DaemonContext, "doctor">,
  effect: DoctorEffect,
  gathered: DoctorGathered,
): void {
  const sid = effect.session;
  const moved = movedSince(ctx, sid, gathered.stamp);
  if (moved !== null) {
    throw new BadVerbArgs(
      `doctor: the session's ${moved} changed during the doctor's probes — click again`,
    );
  }
  landStep(
    ctx,
    sid,
    effect.step,
    landedFacts(ctx, sid, effect.arrival, gathered),
  );
}

function landStep<K extends DoctorStep["kind"]>(
  ctx: Unbound,
  sid: string,
  step: Extract<DoctorStep, { readonly kind: K }>,
  facts: DoctorFacts,
): void {
  const land: (typeof DOCTOR_STEPS)[K] = DOCTOR_STEPS[step.kind];
  land(ctx, sid, step, facts);
}

const doctorRun: VerbHandler = (sid, _args, ctx) => {
  describeDoctor(ctx, sid, { kind: "run" });
};

// A probe link `cc-candybar doctor` opened, delivered by the URL handler: its
// arrival is the whole effect, read back by the CLI from the daemon's stats.
// [LAW:single-enforcer] It writes no journal, so it takes no turn: nothing
// queued can make it wait, and no client's leaving can refuse a link that came.
const probe = (
  read: WireParse<string>,
  ctx: Pick<VerbContext, "arrival" | "probes" | "log">,
): undefined => {
  if (!read.ok) throw new BadVerbArgs(`probe: ${read.problem}`);
  const nonce = read.value;
  // [LAW:no-silent-failure] A probe link is opened by the CLI, never drawn in
  // a frame, so one cannot come from the tmux status line.
  if (ctx.arrival.via !== "link")
    throw new BadVerbArgs("probe: a probe arrives only as a link");
  const { delivery } = ctx.arrival;
  ctx.probes.arrive({ nonce, delivery });
  ctx.log("info", `probe: arrived nonce=${nonce} delivery=${delivery.kind}`);
};

const doctorFix: VerbHandler = (sid, args, ctx) => {
  const [checkName = ""] = args;
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-fix: unknown check "${checkName}"`);
  }
  describeDoctor(ctx, sid, { kind: "fix", check });
};

// [LAW:single-enforcer] One gathering per click, as doctorFix: a second asks
// only what moved inputs changed (`oneAskPerClick`), since a refused spawn
// would read as a different terminal than the one marked.
const doctorMark: VerbHandler = (sid, args, ctx) => {
  const [checkName = "", mark = ""] = args;
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-mark: unknown check "${checkName}"`);
  }
  if (!(GLYPH_MARKS as readonly string[]).includes(mark)) {
    throw new BadVerbArgs(
      `doctor-mark: the mark is ${JSON.stringify(mark)}, not ${GLYPH_MARKS.join(" or ")}`,
    );
  }
  describeDoctor(ctx, sid, { kind: "mark", check, mark: mark as GlyphMark });
};

// ─── Slash commands (brandon-context-ceiling-xta.7xt) ───────────────────────

// [LAW:parse-dont-validate] A click's line is honoured only as one a `slash`
// action in the session's config declares — the declaration found supplies
// the SlashLine typed, so the URL chooses among the config's lines and can
// add none. The pane is the one the session's last render reported.
const slash: VerbHandler = (sid, args, ctx) => {
  const [line = ""] = args;
  const declared = Object.values(
    ctx.configFor(sessionOrigin(ctx, sid)).actions,
  ).filter((a): a is SlashAction => "slash" in a);
  const action = declared.find((a) => a.slash === line);
  if (action === undefined) {
    throw new BadVerbArgs(
      `${JSON.stringify(line)} is not a command this config declares (it declares: ${[...new Set(declared.map((a) => a.slash))].join(", ") || "none"})`,
    );
  }
  // [LAW:parse-dont-validate] A session with no pane to type in refuses the
  // click here, where it is known without a read: the user's to change, like
  // a store refusal, so BAD_REQUEST. The pane's own state (a dialog up, a
  // line typed moments ago) is read by the performer, beside the typing it
  // guards, and refuses the effect instead.
  const pane = tmuxPaneOf(sessionHints(ctx, sid).tmux);
  if (pane.kind === "refused") {
    throw new BadVerbArgs(`${line} was not typed: ${pane.reason}`);
  }
  ctx.effect({ kind: "type-slash", pane: pane.hint, line: action.slash });
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
  sid: SessionId,
  [action = "", evaluated = "", mac = ""]: readonly string[],
  ctx: Unbound,
): RunRequest {
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
    !ctx.links.signer.verify(
      { sessionId: sid, action, declaration, evaluated },
      mac,
    )
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
    envOverlay: {
      ...sessionEnv({
        sessionId: sid,
        projectDir: origin.projectDir,
        claudeConfigDir: sessionHints(ctx, sid).claudeConfigDir,
      }),
      ...drawn.env,
    },
    // The bundled config's runs go in the user's home.
    cwd: decl.cwd ?? ctx.locations.homeDir,
    // The loader proved every name a declared source of this config, whose
    // state holds its key.
    refreshes: decl.refreshes.map((name) => ({
      name,
      storage: sources.get(name)!,
    })),
  };
}

const run: VerbHandler = (sid, args, ctx) => {
  const request = runOf(sid, args, ctx);
  ctx.effect({ kind: "run", id: ctx.runs.superseded(request), run: request });
};

// ─── Repository configs (brandon-unfiled-3248.kezw) ─────────────────────────

// [LAW:parse-dont-validate] An answer is recorded only when its mac verifies:
// the bar drew it, for this session, for this directory and this answer. The
// book lives beside the link key, and the render cache watches it, so every
// bar reloads; the clicking session's reloads before the click answers, as
// save's does.
const repoConfig: VerbHandler = (sid, args, ctx) => {
  const [dir = "", answer = "", mac = ""] = args;
  // Signed, so it is an answer the bar offered.
  const answered = answer as RepoAnswer;
  if (!ctx.links.signer.verify(repoAnswerFields(sid, dir, answered), mac)) {
    throw new BadVerbArgs(
      "the answer's signature does not match what it carries: it was not drawn by this daemon",
    );
  }
  const filed = recordAnswer(ctx.filesystem, ctx.stateDir, dir, answered);
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
//
// [LAW:types-are-the-program] Every leaf verb's first wire segment is the
// session it was clicked in, and its handler takes that session parsed, so a
// verb that names none cannot join this table: it is a link kind beside it, as
// the probe is.
//
// [LAW:no-silent-failure] Each row states the fewest and most arguments its
// verb reads after the session, so a link carrying more is refused, never acted
// on with the rest dropped unread, and one carrying fewer never reaches a
// handler to read an empty value in a missing one's place. A verb whose
// arguments are a list (pairs, keys) reads any number, and judges the list.
interface Leaf {
  readonly handler: VerbHandler;
  readonly takes: readonly [min: number, max: number];
}

const LEAF_VERBS = new Map<string, Leaf>(
  (
    [
      [VERB_COPY, copy, [1, 1]],
      [VERB_OPEN_VSCODE, openVscode, [1, 1]],
      [VERB_SET_STATE, setState, [0, Infinity]],
      [VERB_STEP_STATE, stepState, [2, 2]],
      [VERB_SET_CONFIG, setConfig, [2, 2]],
      [VERB_STEP_CONFIG, stepConfig, [2, 2]],
      [VERB_RESET_CONFIG, resetConfig, [0, Infinity]],
      [VERB_SAVE, save, [0, 0]],
      [VERB_SAVE_PRESET, savePreset, [0, 0]],
      [VERB_SAVE_THEME_DEFAULT, saveThemeDefault, [0, 0]],
      [VERB_DELETE_PRESET, deletePreset, [1, 1]],
      [VERB_APPLY_LAYOUT_OP, applyLayoutOp, [2, 2]],
      [VERB_UNDO, undo, [0, 0]],
      [VERB_REDO, redo, [0, 0]],
      [VERB_BACK, back, [0, 0]],
      [VERB_REWIND, rewind, [0, 0]],
      [VERB_TOOLBAR_TOGGLE, toolbarToggle, [0, 0]],
      [VERB_APPLY_UPDATE, applyUpdate, [0, 0]],
      [VERB_DOCTOR_RUN, doctorRun, [0, 0]],
      [VERB_DOCTOR_FIX, doctorFix, [1, 1]],
      [VERB_DOCTOR_MARK, doctorMark, [2, 2]],
      [VERB_SLASH, slash, [1, 1]],
      [VERB_RUN, run, [3, 3]],
      [VERB_REPO_CONFIG, repoConfig, [3, 3]],
      [VERB_COPY_DIAGNOSTIC, copyDiagnostic, [2, 2]],
    ] as const
  ).map(([verb, handler, takes]) => [verb, { handler, takes }]),
);

// The verbs a dispatch may carry as its effects.
export const LEAF_VERB_NAMES: ReadonlySet<string> = new Set(LEAF_VERBS.keys());

// [LAW:single-enforcer] A leaf effect as its click reads it, once: its
// handler, the session its first segment names as it crosses the one
// session-id checkpoint, and the segments after it, each decoded alone. Reading
// never throws: a step's malformed session or argument is that step's error to
// hold on the bar, after the click has found its session.
interface LeafEffect {
  readonly verb: string;
  readonly leaf: Leaf;
  readonly session: ParsedSessionId;
  readonly args: WireParse<readonly string[]>;
}

// An effect a dispatch carries: a leaf, or a verb the leaf table lacks, which
// names no session.
type ReadEffect =
  | LeafEffect
  | { readonly verb: string; readonly leaf: undefined };

// Split before decoding, so a segment's own escaped "/" stays data and an
// empty last argument (a copy of "") is still an argument.
function readLeaf(verb: string, leaf: Leaf, value: string): LeafEffect {
  const [head = "", ...tail] = value.split("/");
  return {
    verb,
    leaf,
    session: readSession(head),
    args: parseWire(() => tail.map(decodeURIComponent)),
  };
}

// [LAW:parse-dont-validate] A malformed escape is the session's failed parse,
// as any other bad id is, so its read refuses that one step.
function readSession(head: string): ParsedSessionId {
  const decoded = parseWire(() => decodeURIComponent(head));
  return decoded.ok
    ? parseSessionId(decoded.value)
    : { ok: false, problem: `has ${decoded.problem}` };
}

function readEffect({ verb, value }: ParsedEffect): ReadEffect {
  const leaf = LEAF_VERBS.get(verb);
  return leaf === undefined ? { verb, leaf } : readLeaf(verb, leaf, value);
}

// [LAW:one-source-of-truth] The session a click is in: the one its first leaf
// effect names, or none. Dispatch surfaces a failed step in that session's
// bar, and the daemon counts the click as that session's activity
// (src/daemon/menu-idle.ts). Every reader of a click's session reads this one
// checked value; one that fails is no session's, and its effects are refused.
function sessionOf(effects: readonly ReadEffect[]): ParsedSessionId | null {
  return effects.find((e) => e.leaf !== undefined)?.session ?? null;
}

// Why a step did not run: as its verb's refusal owner counts it (`reason`),
// and as its click's error holds it on the bar and every reader of the link
// shows it (`problem`).
interface Refusal {
  readonly kind: "refused";
  readonly reason: string;
  readonly problem: string;
}

// A step its read lets run: its leaf, its click's session and the arguments
// its leaf takes, so its run checks nothing.
interface RunnableStep {
  readonly ok: true;
  readonly verb: string;
  readonly leaf: Leaf;
  readonly sid: SessionId;
  readonly args: readonly string[];
}

// [LAW:parse-dont-validate] A dispatch's step as its read judges it, once: one
// that runs, or one refused with why and the arguments that decoded, which
// its refusal owner names it by.
export type ClickStep =
  | RunnableStep
  | {
      readonly ok: false;
      readonly verb: string;
      readonly args: readonly string[];
      readonly refusal: Refusal;
    };

// [LAW:one-source-of-truth] The one spelling of a step that did not run, and
// of a verb the daemon has not.
function stepProblem(verb: string, reason: string): string {
  return `${verb}: ${reason}`;
}
export function unknownVerb(verb: string): string {
  return `unknown effect verb "${verb}"`;
}

function stepRefusal(verb: string, reason: string): Refusal {
  return { kind: "refused", reason, problem: stepProblem(verb, reason) };
}
// A verb the daemon has not has no refusal owner, so its reason is its problem.
function unknownVerbRefusal(verb: string): Refusal {
  const problem = unknownVerb(verb);
  return { kind: "refused", reason: problem, problem };
}

function refused(
  { verb }: ReadEffect,
  args: readonly string[],
  reason: string,
): ClickStep {
  return { ok: false, verb, args, refusal: stepRefusal(verb, reason) };
}

// [LAW:single-enforcer] A step is refused as bad input here, the one place,
// when its session fails the checkpoint or is not its click's, so a dispatch
// cannot act on one session and report to another's bar.
function readStep(
  effect: ReadEffect,
  click: ParsedSessionId | null,
): ClickStep {
  if (effect.leaf === undefined) {
    return {
      ok: false,
      verb: effect.verb,
      args: [],
      refusal: unknownVerbRefusal(effect.verb),
    };
  }
  const { verb, leaf, session, args } = effect;
  const decoded = args.ok ? args.value : [];
  if (!session.ok) {
    return refused(effect, decoded, `session id ${session.problem}`);
  }
  if (!click?.ok) {
    return refused(
      effect,
      decoded,
      "its click's own session is refused, so no step of it runs",
    );
  }
  if (click.id !== session.id) {
    return refused(
      effect,
      decoded,
      `names session ${session.id}, not the session its click is in`,
    );
  }
  if (!args.ok) return refused(effect, decoded, args.problem);
  const [min, max] = leaf.takes;
  if (args.value.length < min || args.value.length > max) {
    return refused(
      effect,
      decoded,
      `reads ${min === max ? min : `${min} to ${max}`} after its session, and the link carries ${args.value.length}`,
    );
  }
  return { ok: true, verb, leaf, sid: session.id, args: args.value };
}

// [LAW:types-are-the-program] A probe link carries ONE argument, its nonce: the
// WHOLE value, decoded once, never split on "/". The link's parse leaves the
// value encoded, so the decode lives with the reader that knows its shape
// [LAW:single-enforcer].
function readProbe(value: string): WireParse<string> {
  const decoded = parseWire(() => decodeURIComponent(value));
  if (!decoded.ok) return decoded;
  const nonce = parseProbeNonce(decoded.value);
  return nonce === null
    ? { ok: false, problem: "the value is not a probe nonce" }
    : { ok: true, value: nonce };
}

// [LAW:one-source-of-truth] A click as the daemon's edge reads it, once
// (src/daemon/reply.ts): what its event carries and what it runs from. A
// dispatch's session is taken from its effects in the read, so the session the
// reply facts record, the one its journal and landing use, and the one its
// steps were judged against are one value. Branded, so only `readClick` makes
// one.
type ClickRead =
  | {
      readonly kind: typeof VERB_DISPATCH;
      readonly steps: readonly ClickStep[];
      readonly session: ParsedSessionId | null;
    }
  | { readonly kind: typeof VERB_PROBE; readonly nonce: WireParse<string> };
export type Click = ClickRead & { readonly __click: true };
type ClickOf<V extends ClickVerb> = Extract<Click, { readonly kind: V }>;

// [LAW:one-source-of-truth] One reader for each verb a click runs from, keyed
// by the wire's list of them, so a click verb with no reader does not compile.
// A leaf verb arrives only as a dispatch's effect, so a link naming one is a
// miss here.
const CLICK_READERS: {
  readonly [V in ClickVerb]: (
    value: string,
  ) => Extract<ClickRead, { readonly kind: V }>;
} = {
  [VERB_DISPATCH]: (value) => {
    const effects = batchAdjacentWrites(parseEffects(value)).map(readEffect);
    const session = sessionOf(effects);
    return {
      kind: VERB_DISPATCH,
      steps: effects.map((effect) => readStep(effect, session)),
      session,
    };
  },
  [VERB_PROBE]: (value) => ({ kind: VERB_PROBE, nonce: readProbe(value) }),
};

// A link's click, or null for a verb no click runs from. Reading never
// throws: a malformed step or nonce is held as data, for the run to refuse.
// The verb is untrusted wire input, so it is matched against the list before
// it keys the table: a `__proto__` is a miss, never a hit on
// Object.prototype. The brand is set here, once.
export function readClick(verb: string, value: string): Click | null {
  return isClickVerb(verb) ? (CLICK_READERS[verb](value) as Click) : null;
}

// The session a click is in, as its event names it: a dispatch's that passed
// the checkpoint, or none.
export function clickSession(click: Click): SessionId | null {
  return click.kind === VERB_DISPATCH && click.session?.ok
    ? click.session.id
    : null;
}

// What one step's run came to: it ran, it was refused as bad input (by its
// read, or by its handler's own BadVerbArgs), or it failed operationally.
type StepOutcome =
  | { readonly kind: "ran" }
  | Refusal
  | { readonly kind: "failed"; readonly problem: string };

// A step's run in the turn. [LAW:single-enforcer] The one place a handler's
// throw becomes an outcome. [LAW:effects-at-boundaries] A step's effects are
// its own until it returns: one that throws after describing describes
// nothing, so no effect performs for a step the bar reports as refused. Held
// here, in the one runner every leaf passes through, rather than as a rule
// each leaf keeps.
function perform(step: RunnableStep, ctx: ClickContext): StepOutcome {
  const described: Effect[] = [];
  try {
    step.leaf.handler(step.sid, step.args, {
      ...ctx,
      effect: (effect) => void described.push(effect),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return e instanceof BadVerbArgs
      ? stepRefusal(step.verb, reason)
      : { kind: "failed", problem: stepProblem(step.verb, reason) };
  }
  for (const effect of described) ctx.effect(effect);
  return { kind: "ran" };
}

// The leaf verbs whose refused links an owner counts, beside the bar's hold
// every refused step gets. Any web page can open a run link, so the run
// stats count each one refused before anything ran; the action is named as
// the config names it, decoded.
const REFUSAL_OWNERS: ReadonlyMap<
  string,
  (
    ctx: ClickContext,
    refusal: { sid: string; args: readonly string[]; reason: string },
  ) => void
> = new Map([
  [
    VERB_RUN,
    (ctx, { sid, args: [action], reason }) =>
      ctx.runs.refused(sid, action || "-", reason),
  ],
]);

// [LAW:dataflow-not-control-flow] One click is an ordered list of effects; the
// dispatcher folds the list of steps its read judged, after
// batchAdjacentWrites has joined each run of adjacent set-state (or
// reset-config) effects into the one batch that lands whole. The
// effect count is data — N=1 and N=100 walk the identical loop, no plain-vs-
// compound branch. [LAW:no-silent-failure] Every step runs even if an
// earlier one failed; failures accumulate in `errors`. An unknown or
// non-leaf (e.g. nested `dispatch`) verb is a miss in LEAF_VERBS — refused at
// its read, reported, never executed.
//
// [LAW:types-are-the-program] The aggregate PRESERVES the dispatcher's
// input-vs-operational error classification: a step refused at its read, or
// whose leaf throws BadVerbArgs, is bad input (→ BAD_REQUEST), and a leaf's
// plain Error is an operational failure (a store
// that refused the write → RENDER_FAILED). If ANY step failed operationally,
// the whole click failed operationally (plain Error); only when every failure
// is an input error does the aggregate stay BadVerbArgs. An unknown verb is
// bad input — it does not flip the classification. A program a step launches
// is no step of the fold: it is an effect, performed after the turn, and its
// failure reaches the bar through its own event (src/daemon/apply.ts).
//
// [LAW:one-source-of-truth] Per-step errors are written to session state
// so the bar shows WHICH step(s) failed, for the hold src/daemon/click-error.ts
// sets.
//
// [LAW:single-enforcer] The one reader of step outcomes, and so the one caller
// of the refusal owners. [LAW:nothing-unseen] Every refused step reaches its
// verb's refusal owner, whatever refused it: its read or its own handler,
// counted for the session that clicked, never one a step's link spelled.
function foldEffects(
  steps: readonly ClickStep[],
  session: ParsedSessionId | null,
  ctx: ClickContext,
): undefined {
  const errors: string[] = [];
  let operational = false;
  for (const step of steps) {
    const outcome = step.ok ? perform(step, ctx) : step.refusal;
    if (outcome.kind === "ran") continue;
    if (outcome.kind === "refused") {
      REFUSAL_OWNERS.get(step.verb)?.(ctx, {
        sid: session?.ok ? session.id : "-",
        args: step.args,
        reason: outcome.reason,
      });
    } else {
      operational = true;
    }
    errors.push(outcome.problem);
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
// [LAW:single-enforcer] It runs in one journal turn (src/daemon/journal-turns.ts),
// begin through view-follow, and synchronously, so no draw and no other
// writer can come between a click's first write and its commit.
//
// [LAW:effects-at-boundaries] It hands the effects the handler described to
// the performer (`ctx.described`) once the turn has committed, and throws the
// failure of any step (the handler, the commit, what follows it) after that:
// the effects go where the writes went. A dispatch commits the steps that
// landed and holds the refused one on the bar (`foldEffects`), so what a
// landed step described is performed, as its write was kept.
function journaled<C extends DaemonContext>(
  sid: string | null,
  ctx: C,
  // [LAW:types-are-the-program] `undefined`, not `void`: an async handler,
  // whose writes after its first await would land past the commit and
  // outside the turn, fails to build.
  handler: (ctx: Journaled<C>) => undefined,
): void {
  const lanes = sid === null ? null : laneMeter(ctx, sid);
  const journal = ctx.history.begin();
  const navigation = ctx.navigation.begin(journal.sessionState);
  const failures: unknown[] = [];
  // Both views close what a write closes, the navigating one above its
  // recording, so ◁ back restores a closed menu with what was open in it.
  const closing = (store: SessionStateRW): SessionStateRW =>
    closingView(
      store,
      (sid) => nestOf(ctx, sid),
      (line) => ctx.log("info", line),
    );
  const effects: Effect[] = [];
  try {
    handler({
      ...ctx,
      sessionState: closing(journal.sessionState),
      journal,
      navigating: closing(navigation.sessionState),
      effect: (effect: Effect) => void effects.push(effect),
    } as unknown as Journaled<C>);
  } catch (e) {
    failures.push(e);
  }
  // Each commit runs whatever the other did: both record what landed.
  for (const step of [navigation, journal]) {
    try {
      step.commit();
    } catch (e) {
      failures.push(e);
    }
  }
  if (lanes !== null) {
    try {
      // [LAW:no-ambient-temporal-coupling] Only a click that wrote can have
      // moved its lanes: for one that wrote nothing, what moved since its
      // measure is a watcher reload, and no move of its own.
      const after = lanes.read();
      effects.push(
        ...ctx.lanes.clicked(
          lanes.sessionId,
          journal.written() ? lanes.before : after,
          after,
        ),
      );
    } catch (e) {
      failures.push(e);
    }
  }
  ctx.described(effects);
  throwAll(failures);
}

// [LAW:single-enforcer] A dispatch: one journal turn around the fold of its
// effects (src/daemon/journal-turns.ts), the session's landing stamped
// whatever the fold did. One whose client has left never lands, so a client
// told TIMEOUT can click again without reverting a toggle: it takes no turn,
// stamps no landing and describes nothing.
function dispatch(
  click: ClickOf<typeof VERB_DISPATCH>,
  ctx: VerbContext,
): void {
  if (ctx.gone()) throw new ClickAbandoned(VERB_DISPATCH);
  const sid = clickSession(click);
  ctx.journalTurns.take(VERB_DISPATCH, () =>
    journaled(sid, ctx, (c) => {
      try {
        foldEffects(click.steps, click.session, c);
      } finally {
        if (sid !== null) ctx.clickLanded(sid);
      }
    }),
  );
}

// A click as the daemon runs it, from the edge's read. It returns once its
// turn has committed and handed its effects over; it throws the refusal of a
// step that failed.
export function runClick(click: Click, ctx: VerbContext): void {
  switch (click.kind) {
    case VERB_DISPATCH:
      return dispatch(click, ctx);
    case VERB_PROBE:
      return probe(click.nonce, ctx);
    default:
      // A link verb with no run arm does not compile.
      return click satisfies never;
  }
}

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
// it: it is no click verb.
export function closeIdleMenus(
  sid: string,
  idle: IdleClose,
  ctx: DaemonContext,
): void {
  ctx.journalTurns.take("menu-idle", () =>
    journaled(sid, ctx, (c) => {
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
