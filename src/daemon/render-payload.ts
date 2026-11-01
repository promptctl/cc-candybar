// [LAW:single-enforcer] The single place where the daemon assembles every
// data field the DSL templates can read. The output of this function — the
// view's payload (`payloadOf`) — is what a session view's inputs derive from
// (`bindView`, src/dsl/parts.ts), and every `kind: "input"` variable in the
// default DSL config resolves its `path` against exactly this shape.
//
// [LAW:dataflow-not-control-flow] Variability lives in the values flowing
// through here, not in hand-coded branches. The set of providers actually
// invoked is selected by inspecting the DslConfig's declared input paths —
// the *config* (data) chooses what runs. Templates use `when` predicates
// and inline guards on the resulting values to decide what renders.
//
// [LAW:one-source-of-truth] `RenderPayload` is the contract between the
// daemon's data-provider fleet and the DSL config's input declarations. The
// default config in `src/config/default-dsl-config.ts` declares input paths
// that mirror this shape; user configs MUST agree (a path that doesn't
// resolve falls back to the variable's declared default).

import type { HistoryDepth } from "./settings-history";
import path from "node:path";
import { inspect } from "node:util";
import type { ClaudeHookData } from "../utils/claude.js";
import type { ClientHints } from "./protocol.js";
import type { DslConfig } from "../config/dsl-types.js";
import {
  DEFAULT_TERMINAL_WIDTH,
  type BuildLineOptions,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";
import type { SettingName } from "../config/setting-projections.js";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import type { LaneFeeds } from "../config/lanes.js";
import { presetGlobals, presetRoot } from "../config/presets.js";
import { EXPRESSION_SLOTS, isExpression } from "../themes/policy.js";
import { walkNodes } from "../config/dsl-types.js";
import { declaredVariables } from "../config/loader/refs.js";
import {
  PLUGIN_SCOPES,
  type PluginScope,
} from "../config/loader/plugin-scope.js";
import { payloadPathOf, valueReadsOf } from "../config/loader/value-reads.js";
import {
  prOfHead,
  trackingOf,
  type GitInfo,
  type GitInfoOptions,
  type PrState,
  type Tracking,
} from "../segments/git.js";
import {
  ABSENT,
  failed,
  isPending,
  PENDING,
  type Outcome,
  type Pending,
  type Reading,
} from "../utils/outcome.js";
import type { CacheExpiryProvider } from "../segments/cache.js";
import {
  answered,
  settledLane,
  type Current,
  type Lane,
  type Waiting,
} from "../utils/reading.js";
import type { DaemonLogger } from "../utils/logger.js";
import { isBundledPreset } from "./bundled-presets.js";
import type {
  DaySums,
  SessionUsageStore,
  SpeedObservation,
  TodayInfo,
} from "./cache/session-usage-store.js";
import type { ContextInfo, ContextProvider } from "../segments/context.js";
import type { MetricsInfo, MetricsProvider } from "../segments/metrics.js";
import type { UsageInfo } from "../segments/session.js";
import type {
  ActivityInfo,
  ActivityProvider,
  ToolTally,
} from "../segments/activity.js";
import type { TmuxService } from "../segments/tmux.js";
import type { HostService } from "../segments/host.js";
import type { AutoCompactProvider } from "../segments/autocompact-provider.js";
import {
  autoCompactControls,
  type AutoCompactControls,
  type AutoCompactWindow,
} from "../segments/autocompact.js";
import { claudeConfigDir, claudeSettingsPath } from "../claude-settings.js";
import { resumeCommand } from "../claude-resume.js";
import type { GitDataProvider } from "./cache/git.js";
import type { Holds } from "../utils/holds.js";
import {
  VALUED_FIELDS,
  type ValuedField,
  type ValuedGlobals,
} from "../config/globals-fields.js";
import { dateOf, type Instant } from "../utils/instant.js";
import type { RefreshFaults, RefreshLane } from "./refresh-faults.js";
import type { SessionId } from "./session-id.js";
import type { ManagedStorage, StorageKey } from "./cache/managed-storage.js";
import type { JsonValue } from "../var-system/types.js";

// The resolved globals as the options drawDsl's joiner and cells read (its
// selection is the resolution itself — RenderSelection is a Pick of it).
// [LAW:one-source-of-truth] The daemon, `cc-candybar check` and the demo all
// project THROUGH this, so a field added to EffectiveGlobals reaches every
// renderer at once and no caller can leave one out — a hand copy of this
// projection had already dropped `separator` (brandon-menu-ia-zyf).
export function renderOptionsOf(
  effective: EffectiveGlobals,
  width: number,
): BuildLineOptions {
  return {
    endcaps: effective.endcaps,
    separator: effective.separator,
    colorCompatibility: effective.colorCompatibility,
    wrap: effective.autoWrap,
    padding: effective.padding,
    width,
  };
}

// [LAW:types-are-the-program] Every valued global as the payload carries it:
// `<field>.effective`, the value the render resolved, typed by its row
// (src/config/globals-fields.ts) — so a setting declared there is published
// with no edit here. `theme`, `style` and `effect` are not valued fields:
// the payload never carries them, since a rule may decide them; a read of
// their `.effective` is answered by the view's slot (src/dsl/parts.ts).
export type ValuedInputs = {
  readonly [K in ValuedField]: { readonly effective: ValuedGlobals[K] };
};

// The `.effective` inputs a render reads back — the resolved globals, as the
// payload fields a settings label or a carousel reads.
// [LAW:one-source-of-truth] The daemon's payload, `cc-candybar check`'s fixture
// and the demo's payload all spread THIS, so a caller cannot render a label
// blank by forgetting a field the daemon's payload carries.
export type EffectiveInputs = ValuedInputs & Pick<RenderPayload, "preset">;

export function effectiveInputs(effective: EffectiveGlobals): EffectiveInputs {
  return {
    ...(Object.fromEntries(
      VALUED_FIELDS.map((field) => [field, { effective: effective[field] }]),
    ) as ValuedInputs),
    preset: {
      effective: effective.preset,
      customized: effective.presetCustomized,
      bundled: isBundledPreset(effective.preset),
    },
  };
}

// ─── Augmented payload shape ─────────────────────────────────────────────────

// [LAW:types-are-the-program] The RenderPayload extends ClaudeHookData with
// daemon-computed fields. The new keys are all OPTIONAL on the type because
// individual provider failures (no transcript, no git repo, no tmux) leave
// their slots null/missing — and the DSL templates handle absence via
// `when`/inline guards, never by branching in this code.
// [LAW:types-are-the-program] `P` is how a field a source answers says "not
// answered yet": a frame draws every value as it stands, so its payload may
// carry `Pending` (`DrawnPayload`); a request waits for every answer, so its
// payload carries none (`RenderPayload`, `P = never`).
export interface RenderPayloadOf<P> extends ClaudeHookData, ValuedInputs {
  // env-style values surfaced as paths so the DSL can read them via `input`
  // alongside the rest of the payload. (`kind: "env"` is also available for
  // arbitrary env-var lookups in user configs.)
  readonly home?: string;

  // ─── Daemon-computed augmentations ───────────────────────────────────────
  // The provider's null/absent return becomes a missing field; the DSL's
  // input-var fallback chain fills in the default.

  readonly git?: GitPayloadOf<P> | P;
  // [LAW:one-source-of-truth] The tmux pane this session's CLIENT reported
  // (ClientHints.tmux) — the same hint a `slash` click types into, so a
  // control gated on `tmux.pane` shows exactly where its click has a pane to
  // reach. Missing when the client reported "not in tmux" or is too old to
  // say; the detached daemon's own environment is never consulted
  // (brandon-tmux-tk7). `session` is that pane's session name.
  readonly tmux?: { readonly pane: string; readonly session?: string | P };
  // [LAW:types-are-the-program] REQUIRED: every payload carries the object,
  // and the fields INSIDE it carry the real optionality — the name and the
  // user each a source the closure reads (src/segments/host.ts), `ssh` the
  // session's hint. See HostPayloadOf.
  readonly host: HostPayloadOf<P>;
  // `theme.effective`, `style.effective` and `effect.effective` are
  // deliberately NOT fields here. They are the selections whose config rung may
  // hold an EXPRESSION (brandon-looks-pe6, brandon-themes-dzl,
  // brandon-effects-2gka.d2i), so each fold finishes inside drawDsl — which
  // therefore injects `theme`, `style` and `effect: { effective }` into the
  // payload it pushes, exactly as it injects
  // `term: { cols }`. ONE producer per field, so the name a label displays and
  // the palette the bar actually wears cannot disagree
  // [LAW:one-source-of-truth]. `EffectiveGlobals` above carries the SELECTIONS
  // that render resolves.
  // [LAW:one-type-per-behavior] The daemon-resolved effective PRESET name —
  // effectivePresetName(sessionState.preset, globals.preset, presets) — theme
  // and style's twin one level up: the SAME name that selected the layout this
  // render walked and the globals it rendered with, surfaced so a preset
  // trigger's label can never claim an arrangement the bar is not in.
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.5 — `customized` rides
  // alongside `effective` rather than as a sibling top-level field, mirroring
  // the shape a `when`-gated status segment reads (`.preset.customized`)
  // beside the trigger's own `.preset.effective` label. Required for the
  // same reason as `effective`: resolved unconditionally per render from
  // the render cache's authoredRoots, never absent.
  // `bundled` says whether the bundled default declares that preset — false
  // exactly for a preset the user authored, the only kind the settings menu's
  // `🚮` deletes (brandon-save-undo-bwi.o6u).
  readonly preset: {
    readonly effective: string;
    readonly customized: boolean;
    readonly bundled: boolean;
  };
  // The valued globals (ValuedInputs, which this interface extends) are
  // theme/style's twins over the remaining persistable globals
  // (candybar-config-engine-71o.3) — each REQUIRED and unconditionally
  // present for the same reason: the daemon already resolves the value for
  // BuildLineOptions every render, and this is that exact value, so a
  // trigger's "current selection" highlight and the render it describes
  // trace to one resolution. Each is narrowed to its row's own type rather
  // than widened to `string`, so a downstream `switch` gets exhaustiveness.
  // What each lane of this session's frames is doing — its subscribers, the
  // frames that went out to it in the last second, whether the pane is on a
  // screen — read by the lane's toggle (src/config/settings-menu.ts).
  readonly feeds: LaneFeeds;
  // [LAW:one-source-of-truth] How many steps this session's settings history
  // can undo and redo (src/daemon/settings-history.ts), read from the history
  // itself every render, so the menu's `↶`/`↷` exist exactly while there is
  // something to step. Required: the daemon always holds a history, empty is
  // `{ undo: 0, redo: 0 }`.
  readonly history: HistoryDepth;
  // How many steps this session's back history holds
  // (src/daemon/navigation-history.ts), so the bar's `◁` shows exactly while
  // there is somewhere to go back to.
  readonly navigation: { readonly back: number };
  // [LAW:one-source-of-truth] How many settings this session has picked that
  // the config file does not already resolve to — the drafts a `save` writes
  // (src/daemon/setting-drafts.ts), derived every render so the menu's
  // `💾 save N` exists exactly while there is something to save.
  readonly unsaved: number;
  // Per setting, whether its reset would change anything: it has a draft, or
  // the config file holds a value at a layer a reset clears (settingCounts
  // over fileHeldSettings, src/daemon/setting-drafts.ts). Total over SETTINGS,
  // so each control's `↺`, each tab's `•`, and the menu's `⟲` show exactly
  // while they would do something.
  readonly resettable: Readonly<Record<SettingName, boolean>>;
  // Whether saving the look this session draws as the active theme's default
  // would change it (themeDefaultSave, src/daemon/setting-drafts.ts), and, when
  // it would, the theme the save writes — so the menu's `⤓ default for
  // <theme>` shows exactly while a save would change something and names the
  // theme its click writes. Never under a rule-chosen theme: there is no name.
  readonly themeDefault:
    | { readonly differs: false }
    | { readonly differs: true; readonly theme: string };
  // The config file this session's saves and resets edit (the render cache
  // entry's home); absent while that file does not exist, so the menu's
  // `↗ config` shows exactly while there is a file to open.
  readonly configPath?: string;
  // The shell command that resumes this session (src/claude-resume.ts) —
  // what the menu's `⎘ resume` copies.
  readonly resumeCommand: string;
  // The width the bar is drawn to (`renderWidth`): the client's measure less
  // Claude Code's reserve.
  readonly term: { readonly cols: number };

  // Usage-family. Each provider returns null when it has no data (no
  // transcript yet, no rate-limit window active, etc.); we drop the field
  // rather than emit zeros, so an unconfigured user sees their declared
  // `default`. Individual fields inside each sub-object are ALSO optional —
  // "we have a metrics object but messageCount couldn't be computed" is
  // representable distinct from "metrics object zeroed because we had to
  // satisfy a non-optional type." Absence flows through an input's
  // fallback chain (which writes both the default value AND a last_error)
  // exactly like a missing top-level field.
  readonly session?: SessionPayload | P;
  readonly today?: TodayPayload | P;
  readonly burn?: BurnPayload | P;
  readonly speed?: SpeedPayload | P;
  readonly block?: BlockPayload;
  readonly weekly?: WeeklyPayload;
  readonly cache?: CachePayload | P;
  readonly context?: ContextPayload | P;
  readonly metrics?: MetricsPayload | P;
  // The one non-quantity family (brandon-activity-ue7): what Claude is DOING.
  readonly activity?: ActivityPayload | P;
  // Claude Code's auto-compact window, as its `/autocompact` last wrote it.
  readonly autocompact?: AutoCompactPayload | P;
  // [LAW:types-are-the-program] Each plugin source the view declared, by
  // scope, plugin then source — `.plugins.<plugin>.<source>` for an installed
  // plugin, `.repo.<plugin>.<source>` for a repository's, the source
  // variable's own name — as the managed storage owner read the session's
  // file: ok, absent or failed, or not answered yet. Required: a payload
  // builder that leaves the sources out does not compile (`projectSources`).
  readonly plugins: SourcesPayload<P>;
  readonly repo: SourcesPayload<P>;
}

// The readings of a view's sources, nested by plugin and source.
export type SourcesPayload<P> = Readonly<
  Record<string, Readonly<Record<string, Outcome<JsonValue> | P>>>
>;

// What a request is answered from: every source answered.
export type RenderPayload = RenderPayloadOf<never>;
// What a frame draws: every value as it stands.
export type DrawnPayload = RenderPayloadOf<Pending>;
// [LAW:types-are-the-program] What a view keeps of it: everything but the
// facts of the draw's own instant (DRAW_PROJECTIONS, which each draw hands
// its binding), so no stored value moves with the clock.
export type ViewPayload = Omit<DrawnPayload, "feeds" | "today">;
// The control's facts (src/segments/autocompact.ts) — or the refusal that the
// settings file could not be read, carried as text, so the control says why
// it cannot show the window.
export type AutoCompactPayload =
  | AutoCompactControls
  | { readonly error: string };

// Flattened projection of GitInfo: every field shape the parity bindings
// reference. [LAW:one-type-per-behavior] Same absence policy as
// MetricsPayload: every field can independently be absent (not requested,
// genuinely none, or its fetch failed), and absence is PRESERVED — the DSL
// input fallback chain emits the declared `default` and records a
// `last_error` per field. The old coerce-to-''/0 shim erased the distinction
// between "no stashes" and "stash count unknown because git failed".
export type GitPayloadOf<P> = GitFacts & (PrPayload | PrPendingOf<P>);
export type GitPayload = GitPayloadOf<never>;

interface GitFacts {
  readonly repoName?: string;
  // The repo's browsable web page (an https/http URL, credentials stripped),
  // derived from the same remotes read `repoName` is. Missing = the repo has no
  // remote a browser can open, so a template gates its link on `ne … ""`.
  readonly repoUrl?: string;
  readonly branch?: string;
  readonly sha?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly staged?: number;
  readonly unstaged?: number;
  readonly untracked?: number;
  readonly conflicts?: number;
  readonly upstream?: string;
  // Present whenever `upstream` was read, so a template can tell a branch
  // level with its upstream (`tracked`, ahead and behind 0) from one whose
  // ahead/behind are missing because it has no upstream or it is `gone`.
  readonly tracking?: Tracking;
  readonly stash?: number;
  readonly status?: string;
  readonly operation?: string;
  // The last commit's committer date, epoch seconds — an instant, like
  // `block.resetsAt`, so a frame drawn after the read that stored it reads its
  // age against its own instant (the bundled `git.timeSinceCommit`).
  readonly committedAt?: number;
}

// Forge PR/MR. [LAW:no-silent-failure] Unlike every other git field (where
// `failed` collapses to a missing key), the PR's failure is surfaced as
// `prError` so the segment can render a VISIBLY DISTINCT marker — a forge
// outage must not look like "no PR". [LAW:types-are-the-program] The four
// arms of `BranchPr`, flat because templates read `.git.prState` and the rest,
// and exclusive because every field outside an arm is `never` there: the
// branch's PR (prNumber/prState/prUrl), lookup failed (prError), an earlier
// PR of the branch's name (prEarlier — its state, no click target, since it is
// not this work's), and no PR (all absent → segment when-gated off).
interface PrFieldTypes {
  prNumber: number;
  prState: PrState;
  prUrl: string;
  prError: string;
  prEarlier: PrState;
}
type PrArm<K extends keyof PrFieldTypes> = {
  readonly [F in K]: PrFieldTypes[F];
} & { readonly [F in Exclude<keyof PrFieldTypes, K>]?: never };
export type PrPayload =
  | PrArm<"prNumber" | "prState" | "prUrl">
  | PrArm<"prError">
  | PrArm<"prEarlier">
  | PrArm<never>;
// The branch's PR not answered yet (a key just moved): every field a template
// reads of it is `P`, so the rest of git draws as it stands.
type PrPendingOf<P> = { readonly [F in keyof PrFieldTypes]: P };

// [LAW:one-source-of-truth] Every PR field a template can lay out; reading any
// of them turns on the forge lookup, so a new arm's field is a compile error
// here until it does too.
const PR_FIELDS: { readonly [F in keyof PrFieldTypes]: true } = {
  prNumber: true,
  prState: true,
  prUrl: true,
  prError: true,
  prEarlier: true,
};

// The render event's `pr=`: the branch's PR state, `failed` when the forge
// could not say, `earlier-<state>` when its PR was an older use of the
// branch's name, `pending` when a PR the render reads is not answered yet,
// `-` when the payload carries none (no PR, or no segment reads one).
export function prFactOf(
  git: GitPayloadOf<Pending> | Pending | undefined,
  readsPr: boolean,
): string {
  if (!readsPr) return "-";
  if (isPending(git)) return "pending";
  const { prState, prError, prEarlier } = git ?? {};
  if (isPending(prState)) return "pending";
  if (prState !== undefined) return prState;
  if (prError !== undefined) return "failed";
  if (prEarlier !== undefined) return `earlier-${String(prEarlier)}`;
  return "-";
}

// Which machine this session is on, and whether the user got here over the
// network. The two halves have DIFFERENT provenance and that is the whole
// design ([LAW:one-source-of-truth]):
//
//   • `name`/`user` are MACHINE facts. Client and daemon are the same machine
//     by construction — the socket path is UID-derived and the pid mutex is
//     per-user — so the daemon reading them directly cannot drift from what
//     the client would have reported. Sending them over the wire would buy
//     nothing and add a second source.
//   • `ssh` is a SESSION fact and is the exact opposite: one daemon serves a
//     local session and an SSH session simultaneously, so the daemon's own env
//     answers for whichever shell spawned it. It can ONLY arrive as a client
//     hint. This is the same reasoning that makes `globals.colorCompatibility:
//     "auto"` deliberately unrepresentable.
//
// [LAW:no-silent-failure] Every field is optional because each can genuinely
// be unknown, and absence is preserved rather than defaulted here: `user` when
// the uid has no passwd entry, `ssh` when the client predates the hint. Both
// travel as missing keys to the DSL input-fallback chain, which emits the
// declared default AND records a `last_error` that `cc-candybar vars`
// surfaces — so "we don't know" stays distinguishable from "we know it's
// local", which a `?? false` here would have destroyed.
export interface HostPayloadOf<P> {
  // The SHORT hostname — `os.hostname()` up to the first dot, the same
  // projection zsh's `%m` makes. A statusbar cell identifies a machine to a
  // human; the FQDN is a network address, a different fact, and a separate
  // field the day something needs it.
  readonly name?: string | P;
  // The EFFECTIVE username from the passwd database, not `$USER`. The env var
  // is a map that drifts (su/sudo leave it stale); the passwd entry for the
  // running uid is the territory. Matches zsh's `%n`.
  readonly user?: string | P;
  readonly ssh?: boolean;
}

export interface SessionPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

export interface TodayPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

// [LAW:one-type-per-behavior] The burn rate is the session's spend velocity —
// dollars per wall-clock hour — a derivative of the same cost the `session`
// segment totals, so it is its own concept, not a field bolted onto the
// totals. Optional because a too-young session yields no honest rate
// ([LAW:no-silent-failure] — absence over a single-turn artifact).
export interface BurnPayload {
  readonly costPerHour?: number;
}

// [LAW:one-type-per-behavior] Token throughput for the active turn — tokens per
// second on each of three lanes (prompt-side input, generated output, their
// total). Each lane is INDEPENDENTLY optional: during streaming `output` moves
// while `input` (fixed at turn start) is idle, so an absent `input` rate beside a
// live `output` rate is the honest shape, not a zero. Absence (no baseline yet,
// idle between turns, or a too-stale prior sample) travels as a missing field to
// the -1 default, which the `formatSpeed` helper reads as "—". [LAW:no-silent-failure]
export interface SpeedPayload {
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  // [LAW:one-type-per-behavior] The recent burn-rate trend: a delimited series
  // of total-lane tok/s over the store's sample ring, for the `sparkline` helper.
  // It rides the speed lane because it folds from the SAME observation the three
  // instantaneous rates do, but it is INDEPENDENTLY optional — a session that
  // burst then went idle has no current rate yet still has a history to draw. It
  // travels as a string because a series cannot cross the scalar var-system seam;
  // the helper decodes it. Absent (no measurable in-window pair) → missing → "".
  readonly history?: string;
}

// A rate-limit window's facts as Claude Code reported them: how much of it is
// used, and the instant it resets. What they say relative to now — the reset
// countdown, the ETA to the cap — is the draw's to compute against its own
// instant (`minutesUntilReset`, `etaMinutes`), never a stored value a frame
// drawn later would read stale.
export interface BlockPayload {
  readonly nativeUtilization: number;
  readonly resetsAt: number;
}

export interface WeeklyPayload {
  readonly percentage: number;
  readonly resetsAt: number;
}

// Prompt-cache warmth. One field — the epoch-seconds expiry instant —
// mirroring block/weekly `resetsAt` so the DSL composes the countdown via
// `minutesUntilReset`. Absent when no cache-bearing transcript entry exists.
export interface CachePayload {
  readonly expiresAt: number;
}

export interface ContextPayload {
  readonly totalTokens: number;
  readonly contextLeft: number;
}

// [LAW:types-are-the-program] Each metrics field can independently be absent
// (transcript missing, cost block absent, response-time math undefined). The
// optional fields make "no data for this dimension" distinguishable from
// "real zero" — the DSL input fallback chain emits the declared `default`
// for absent fields and records a `last_error` (`cc-candybar vars` surfaces it).
// A coerce-to-zero shim here would erase that distinction.
export interface MetricsPayload {
  readonly lastResponseTime?: number;
  readonly responseTime?: number;
  readonly sessionDuration?: number;
  readonly messageCount?: number;
  readonly nonPrompts?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

// [LAW:types-are-the-program] The activity family, absent whenever there is
// nothing real to say — `todo` when no list exists, `tool` when nothing has run
// this turn, `command` when the turn opened with plain text. The same
// drop-the-field-rather-than-emit-zeros policy as every family above, so an
// author sees their declared `default`.
export interface ActivityPayload {
  readonly command?: string;
  readonly todo?: ActivityTodoPayload;
  readonly tool?: ActivityToolPayload;
}

// `total`/`completed` are the whole list; `position`/`active` describe the ONE
// item in progress and are absent together when none is (a list that is all
// pending, or all complete). `completed` is what tells those two apart, which is
// why it rides alongside rather than being inferred from `position`.
export interface ActivityTodoPayload {
  readonly total: number;
  readonly completed: number;
  readonly position?: number;
  readonly active?: string;
}

// [LAW:series-crosses-var-seam-as-string, in this repo's terms] A VarValue is a
// scalar, so a tally crosses as `"Bash:3,Read:1"` — the SAME
// `"<name>:<count>"` spelling `cascade` and `gauge` stops already use, which
// sprig's `splitList` reads back into a real list inside a template. Both fields
// carry one encoding, so one helper renders either.
export interface ActivityToolPayload {
  readonly running?: string;
  readonly done?: string;
}

// ─── Provider dependencies ────────────────────────────────────────────────────

export interface RenderPayloadDeps {
  readonly gitProvider: GitDataProvider;
  // [LAW:one-source-of-truth] One store backs BOTH the `session` and `today`
  // projections — they are folds over the same per-session records, not two
  // independent providers that could disagree.
  readonly usageStore: SessionUsageStore;
  readonly contextProvider: ContextProvider;
  readonly metricsProvider: MetricsProvider;
  readonly activityProvider: ActivityProvider;
  readonly tmuxService: TmuxService;
  // [LAW:single-enforcer] The one owner of every plugin's session files: a
  // view's declaration holds each source it reads there, and a render state's
  // build holds the folders its config declares.
  readonly managedStorage: ManagedStorage;
  // Claude Code's auto-compact window, read from the user settings file at
  // the path a render names.
  readonly autoCompact: AutoCompactProvider;
  // Each session's prompt-cache expiry, read off its transcript's tail.
  readonly cacheExpiry: CacheExpiryProvider;
  // The machine's identity: its host name and the daemon's user.
  readonly hostService: HostService;
  // The log for a session lane whose refresh threw: a bug no owner saw.
  readonly log: DaemonLogger;
  // Each session lane whose refresh threw, until one runs clean.
  readonly faults: RefreshFaults;
  // The lanes the view's latest declaration handed it (`declareLanes`), read
  // at each read: a read takes nothing, so the view holds exactly what its
  // latest declaration took.
  readonly lanes: () => DeclaredLanes;
}

// ─── Spend and throughput projections (pure) ──────────────────────────────────
//
// [LAW:effects-at-boundaries] The math is pure — cost, duration and token
// samples in; rates out. These stay testable in isolation.

// Under a minute of session wall-clock, $/hr is dominated by a single turn
// rather than a sustained burn.
const MIN_BURN_SECONDS = 60;

// tok/s is a delta between two successive render observations. The wall-time
// between them must clear a tiny floor (the clock has to have advanced — below
// it the rate is divide-by-near-zero noise) and stay under a ceiling: a gap
// wider than this means the prior sample predates an idle stretch, so the rate
// would be diluted by dead time. Both bounds → no reading (re-baseline silently
// on the next render) rather than a misleading number. [LAW:no-silent-failure]
const MIN_SPEED_SAMPLE_MS = 50;
const MAX_SPEED_SAMPLE_MS = 10 * 1000;

/**
 * Session spend rate in dollars per hour: cost over wall-clock duration.
 * Returns undefined under a wall-clock floor where the rate is a single-turn
 * artifact, not a sustained burn. A real $0 over enough time is a true 0/hr,
 * not absence. [LAW:no-silent-failure]
 */
export function projectCostPerHour(
  cost: number,
  durationSeconds: number,
): number | undefined {
  if (durationSeconds < MIN_BURN_SECONDS) return undefined;
  return (cost * 3600) / durationSeconds;
}

/**
 * Instantaneous tokens-per-second between two successive render observations of
 * one cumulative token count. Returns undefined when the sample window is too
 * small or too large to be honest (see the floor/ceiling constants) or when the
 * count did not advance (idle / between turns — a true 0 over a real window is
 * reported as 0, but a flat count carries no throughput to report). A real
 * positive rate is always >= 0, so callers use -1 as the absence default — 0
 * tok/s never doubles as the "no reading" marker. [LAW:no-silent-failure]
 */
export function projectTokensPerSecond(
  prevTokens: number,
  prevMs: number,
  curTokens: number,
  nowMs: number,
): number | undefined {
  const deltaMs = nowMs - prevMs;
  if (deltaMs < MIN_SPEED_SAMPLE_MS || deltaMs > MAX_SPEED_SAMPLE_MS)
    return undefined;
  const deltaTokens = curTokens - prevTokens;
  if (deltaTokens <= 0) return undefined;
  return (deltaTokens * 1000) / deltaMs;
}

// [LAW:effects-at-boundaries] Pure fold of one speed observation into the
// payload's three rate lanes. No baseline (first render of a session) or every
// lane un-projectable → undefined (the whole `speed` key is dropped); otherwise
// each lane that projects contributes its rate, each that doesn't is a missing
// field → the -1 default → "—".
function projectSpeed(obs: SpeedObservation): SpeedPayload | undefined {
  const { prev, cur } = obs;
  if (prev === undefined) return undefined;
  const input = projectTokensPerSecond(
    prev.input,
    prev.atMs,
    cur.input,
    cur.atMs,
  );
  const output = projectTokensPerSecond(
    prev.output,
    prev.atMs,
    cur.output,
    cur.atMs,
  );
  const total = projectTokensPerSecond(
    prev.total,
    prev.atMs,
    cur.total,
    cur.atMs,
  );
  if (input === undefined && output === undefined && total === undefined)
    return undefined;
  return {
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(total !== undefined && { total }),
  };
}

// [LAW:effects-at-boundaries] Pure fold of the observation's sample ring into the
// burn-rate history string. Each adjacent pair becomes one total-lane tok/s; an
// un-projectable pair (no new tokens, or a gap outside the sample window) is a
// real ZERO-throughput interval, not absence — the series is a string of numbers,
// and 0 is the honest value for "burned nothing here" ([LAW:no-silent-failure] —
// the gap is reported, not dropped to misalign the graph). Fewer than two samples
// ⇒ no pair ⇒ undefined (the whole field drops to the "" default).
function projectSpeedHistory(obs: SpeedObservation): string | undefined {
  const { samples } = obs;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    // [LAW:no-silent-failure] Only an in-window interval is a measurable reading.
    // An out-of-window pair — samples too close to time a rate reliably, or a
    // stale gap spanning idle time — is UNMEASURABLE, not zero burn, so it is
    // SKIPPED rather than fabricated as a 0 bar that would read as real activity.
    // projectTokensPerSecond stays the single formula+window authority (same
    // module constants); this classifier disambiguates its undefined: out-of-
    // window ⇒ skip, in-window ⇒ undefined means a non-positive token delta, a
    // genuine zero-burn reading that stays 0.
    const deltaMs = cur.atMs - prev.atMs;
    if (deltaMs < MIN_SPEED_SAMPLE_MS || deltaMs > MAX_SPEED_SAMPLE_MS)
      continue;
    const rate = projectTokensPerSecond(
      prev.total,
      prev.atMs,
      cur.total,
      cur.atMs,
    );
    rates.push(rate ?? 0);
  }
  if (rates.length === 0) return undefined;
  return rates.join(",");
}

// ─── Builder ─────────────────────────────────────────────────────────────────

// ─── Config-driven provider gating ───────────────────────────────────────────
//
// [LAW:dataflow-not-control-flow] Whether a provider fires is selected by
// the active layout. Walk from the preset's resolved root (`presetRoot`, the
// same tree drawDsl compiles for it) → its nodes → their segments → their
// template strings → the declarations they read (value-reads.ts), and on
// through what each of those reads. The transitive closure tells us which
// input paths are actually reachable from a rendered segment; providers
// feeding paths outside that closure do not run.
//
// [LAW:single-enforcer] One reachability walk owns "is this provider
// needed." A declared-but-unreachable input variable (the default config
// declares every built-in variable for reference completeness) contributes
// no work to the hot path, and neither does a segment only an inactive preset
// places.
export function buildNeededPrefixes(
  config: DslConfig,
  preset: string,
): ReadonlySet<string> {
  // Seeds: each rendered segment's template/when/bg/fg ONLY — segment-local
  // vars in `seg.vars` are reached transitively through the templates that
  // read them. Seeding from `seg.vars` directly would mark unused per-segment
  // template vars as needed and pull in their providers without justification.
  //
  // A globals rule (a theme or style chosen by data) reads variables too, and
  // it runs every render — seed it so a provider feeding only the rule is not
  // gated out and the rule never evaluates against unfilled defaults. The rule
  // in force is the active preset's config-default rung (`presetGlobals`, the
  // merge `resolveEffectiveGlobals` reads); editGlobals holds names only.
  const declared = presetGlobals(config, preset);
  const rules = EXPRESSION_SLOTS.flatMap((slot) => {
    const authored = declared[slot];
    return isExpression(authored) ? [authored] : [];
  });
  const seeds = [...rules];
  for (const node of walkNodes(presetRoot(config, preset).node)) {
    // A node's `when` reads variables too — seed it so a provider feeding only
    // a predicate (e.g. a state var gating a row/container) isn't gated out.
    if (node.when) seeds.push(node.when);
    if (node.kind !== "segment") continue;
    seeds.push(...segmentTemplates(config, node.name));
  }
  return inputClosure(config, seeds);
}

// One segment's own templates — what it seeds the closure with.
function segmentTemplates(config: DslConfig, name: string): string[] {
  const seg = config.segments[name];
  if (!seg) return [];
  return [seg.template, seg.when, seg.bg, seg.fg].flatMap((src) =>
    src ? [src] : [],
  );
}

// [LAW:single-enforcer] The payload paths ONE segment's placements read — its
// own templates and each placement's `when`, the seeds buildNeededPrefixes
// takes from them — through the same closure the render's gate walks: what
// the doctor asks to say which segment needs which data
// (src/doctor/data-needs.ts).
export function segmentInputPaths(
  config: DslConfig,
  name: string,
  whens: readonly string[],
): ReadonlySet<string> {
  return inputClosure(config, [...segmentTemplates(config, name), ...whens]);
}

// The payload paths a set of templates reaches — each input's path, each
// plugin source's name (payloadPathOf) — through every edge of
// the one fold of what a value reads (value-reads.ts): a template's reads and
// the texts of the actions it binds, a variable's template, cache key and
// depends_on. The draw follows each of these, so a path the closure missed
// would draw unfilled.
function inputClosure(
  config: DslConfig,
  seeds: readonly string[],
): ReadonlySet<string> {
  const reads = valueReadsOf(config);
  const decls = new Map(declaredVariables(config));
  const frontier = seeds.flatMap((template) =>
    reads.ofTemplate(template).flatMap(({ reaches }) => reaches),
  );
  const visited = new Set<string>();
  const inputPaths = new Set<string>();
  while (frontier.length > 0) {
    const name = frontier.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const decl = decls.get(name)!;
    const read = payloadPathOf(name, decl);
    if (read !== undefined) inputPaths.add(read);
    for (const { reaches } of reads.ofVariable(decl)) frontier.push(...reaches);
  }
  return inputPaths;
}

export function neededPrefixesByPreset(
  config: DslConfig,
): (preset: string) => ReadonlySet<string> {
  const byPreset = new Map<string, ReadonlySet<string>>();
  return (preset) => {
    const cached = byPreset.get(preset);
    if (cached !== undefined) return cached;
    const needed = buildNeededPrefixes(config, preset);
    byPreset.set(preset, needed);
    return needed;
  };
}

export function anyPathStartsWith(
  paths: ReadonlySet<string>,
  prefix: string,
): boolean {
  for (const p of paths) {
    if (p === prefix || p.startsWith(prefix + ".")) return true;
  }
  return false;
}

// [LAW:dataflow-not-control-flow] Each `show*` flag is derived from a
// specific declared input path; the closure tells us exactly which fields
// the user's templates will read. Without this, GitService.getGitInfo
// silently returns "" / 0 for fields whose `show*` flag isn't set (because
// computing them requires extra git invocations), and a user who declares
// `git.sha` or `git.staged` would see their template evaluate against
// empty strings or zeros.
export function gitOptionsFromClosure(
  needed: ReadonlySet<string>,
): GitInfoOptions {
  const has = (path: string): boolean => needed.has(path);
  // `git.staged` / `git.unstaged` / `git.untracked` / `git.conflicts` all
  // come from one `git status --porcelain` call — any one of them turning
  // the flag on enables all four.
  const wantsWorkingTree =
    has("git.staged") ||
    has("git.unstaged") ||
    has("git.untracked") ||
    has("git.conflicts");
  return {
    ...(has("git.sha") && { showSha: true }),
    ...(wantsWorkingTree && { showWorkingTree: true }),
    ...(has("git.stash") && { showStashCount: true }),
    ...((has("git.upstream") || has("git.tracking")) && {
      showUpstream: true,
    }),
    ...(has("git.repoName") && { showRepoName: true }),
    ...(has("git.repoUrl") && { showRepoUrl: true }),
    ...(has("git.operation") && { showOperation: true }),
    ...(has("git.committedAt") && { showCommittedAt: true }),
    // Any PR field laid out turns on the (network) forge lookup.
    ...(Object.keys(PR_FIELDS).some((f) => has(`git.${f}`)) && {
      showPullRequest: true,
    }),
  };
}

/**
 * Compose every render-time data source into the augmented payload that the
 * DSL applies to its input variables.
 *
 * Each provider runs only if its payload prefix sits in the closure
 * computed by `buildNeededPrefixes(config, preset)` — the set of `kind: "input"`
 * paths transitively reachable from a segment in the active preset's root. Merely
 * declaring an input variable does NOT trigger provider work; the variable
 * must actually be referenced by a layout-rendered segment (directly, or
 * via a chain of `template`-kind vars). The default config declares many
 * unused inputs for reference completeness — switching one on is a layout
 * edit, not a re-declaration.
 *
 * All needed providers run concurrently via `Promise.all`; each one's
 * failure becomes a missing field (handled by the DSL input fallback
 * chain). No provider error propagates to the caller — a single broken
 * source must not blank the bar.
 *
 * [LAW:no-silent-failure][LAW:single-enforcer] Every lane carries a typed
 * outcome (ok | absent | failed) and THIS function is the one log site:
 * `failed` is logged through `deps.log` and projected as a missing field,
 * `absent` is a missing field with nothing to log — the default lives in
 * the DSL declaration's `default` field, owned by the config, not buried
 * here.
 */
export type SettingCounts = Pick<
  RenderPayload,
  "unsaved" | "resettable" | "themeDefault"
>;

// Facts about the config the session renders with: the save cell's counts
// (that config against the session's picks) and the home file's path,
// `null` while it does not exist.
export type ConfigFileFacts = SettingCounts & {
  readonly configPath: string | null;
};

// What every payload function reads of the render it serves: the request's
// facts and the closure its config reads.
export interface PayloadInputs {
  readonly hookData: ClaudeHookData;
  readonly deps: RenderPayloadDeps;
  readonly cwd: string | undefined;
  // [LAW:single-enforcer] The cache pre-computes the closure once at
  // registration; passing it in (rather than recomputing per render) keeps
  // the hot path free of the closure's cost.
  readonly neededInputPaths: ReadonlySet<string>;
  // [LAW:locality-or-seam] The parsed client hints, NOT the raw request — this
  // module is downstream of the wire checkpoint and never re-sanitizes.
  readonly hints: ClientHints;
}

// What a view's payload reads of its session besides the sources: every
// globals field a menu/stepper can persist, resolved ONCE per change of the
// session's picks (src/daemon/session-source.ts) and read by BOTH the draw AND
// these payload fields — so a trigger label can never disagree with what was
// drawn — the save cell's counts (src/daemon/setting-drafts.ts) with the
// config file they count against, and the depths of the session's histories.
export interface DrawInputs {
  readonly effective: EffectiveGlobals;
  readonly configFacts: ConfigFileFacts;
  readonly history: HistoryDepth;
  readonly back: number;
}

// [LAW:dataflow-not-control-flow] Which lanes the closure reads: every lane is
// ONE shape — wanted, read; not wanted, ABSENT — decided here once for the
// refresh and the draw alike.
// Memoised per closure: the cache builds each set once, and a frame asks of it
// at every draw.
const wantedOf = new WeakMap<ReadonlySet<string>, Wanted>();
type Wanted = ReturnType<typeof wantsOf>;

function wanted(neededInputPaths: ReadonlySet<string>): Wanted {
  let want = wantedOf.get(neededInputPaths);
  if (want === undefined) {
    want = wantsOf(neededInputPaths);
    wantedOf.set(neededInputPaths, want);
  }
  return want;
}

function wantsOf(neededInputPaths: ReadonlySet<string>) {
  const wants = (prefix: string): boolean =>
    anyPathStartsWith(neededInputPaths, prefix);
  return {
    git: wants("git"),
    // The burn segment reads `burn.costPerHour`, a derivative of session cost
    // and metrics duration — so wanting `burn` pulls in exactly the two lanes
    // it is folded from.
    session: wants("session.cost") || wants("session.tokens") || wants("burn"),
    today: wants("today"),
    // autocompact's controls are capped to the model's context window, so the
    // lane runs for either family, as metrics runs for burn.
    context: wants("context") || wants("autocompact"),
    metrics: wants("metrics") || wants("burn"),
    burn: wants("burn"),
    activity: wants("activity"),
    // Only the session NAME costs a spawn; `tmux.pane` is the hint itself, so
    // a config that reads only the pane (every slash gate) runs nothing here.
    tmux: wants("tmux.session"),
    // `host.ssh` is the hint itself; the name and the user are each a read.
    hostName: wants("host.name"),
    hostUser: wants("host.user"),
    cache: wants("cache"),
    speed: wants("speed"),
    autocompact: wants("autocompact"),
    block: wants("block"),
  };
}

// [LAW:one-source-of-truth] The width a session's bar is drawn to: what its
// client measured, else the default, less Claude Code's reserve — the one
// value the payload's `term.cols` and the draw's options both carry.
export function renderWidth(hints: ClientHints): number {
  return applyClaudeCodeReserve(hints.termCols ?? DEFAULT_TERMINAL_WIDTH);
}

// The settings file of THIS session's Claude Code, from the client's
// `claudeConfigDir` hint — never the daemon's own env, which answers for
// whichever session spawned it. [LAW:single-enforcer]
function settingsPathOf(hints: ClientHints): string {
  return claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir));
}

// The lanes a request's arrival refreshed: how long each took, or null while
// it is still out.
export type Refreshed = Map<RefreshLane, number | null>;

// [LAW:nothing-unseen] The render event's `refreshed=`: each lane the
// request's arrival refreshed, with how long it took, `…` for one still out
// when the answer was drawn; `-` for none.
export function refreshedFact(refreshed: Refreshed): string {
  return (
    [...refreshed]
      .map(([lane, ms]) => `${lane}:${ms === null ? "…" : `${ms}ms`}`)
      .join(",") || "-"
  );
}

// [LAW:single-enforcer] A statusline request's own triggers
// (brandon-unfiled-3248.8ro6, step 3): it refreshes every session source the
// closure reads — the transcript's folds, the cache expiry, the speed sample,
// the auto-compact window, today's first scan — each stamp-gated by its
// owner, so an unchanged transcript reads nothing. A frame never calls this: it draws the
// values these refreshes stored.
//
// [LAW:no-silent-failure] A refresh's contract is to answer, never to throw or
// reject, so a throw — the owner's or the lane's own code around it — is a
// bug, logged here where it is caught and stored as that lane's failure
// (RefreshFaults) until a refresh of it runs clean, so the view's payload,
// derived from what is stored, reads it failed rather than not answered.
//
// `at` is the request's arrival, the instant its speed sample is taken at.
// `refreshed` is the request's record of them: each lane it starts, and how
// long the lane took once it lands.
export async function refreshPayload(
  inputs: PayloadInputs,
  at: Instant,
  refreshed: Refreshed,
): Promise<void> {
  const { hookData, deps, hints } = inputs;
  const want = wanted(inputs.neededInputPaths);
  const sessionId = hookData.session_id;
  // The request's one refresh of its session's record, which the session,
  // today and speed lanes share.
  const session = deps.usageStore.request(sessionId, hookData.transcript_path);
  const lane = async (
    name: RefreshLane,
    needed: boolean,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    if (!needed) return;
    const startedAt = performance.now();
    refreshed.set(name, null);
    let threw: string | null = null;
    try {
      await run();
    } catch (e) {
      deps.log("error", `${name} lane threw: ${inspect(e)}`);
      threw = `${name}: ${String(e)}`;
    }
    refreshed.set(name, Math.round(performance.now() - startedAt));
    deps.faults.refreshed(sessionId, name, threw);
  };
  await Promise.all([
    lane("session", want.session, () => session.usage(hookData)),
    lane("today", want.today, () => session.today(deps.lanes().today)),
    lane("context", want.context, () =>
      deps.contextProvider.getContextInfo(hookData),
    ),
    lane("metrics", want.metrics, () =>
      deps.metricsProvider.getMetricsInfo(sessionId, hookData),
    ),
    lane("activity", want.activity, () =>
      deps.activityProvider.getActivityInfo(sessionId, hookData),
    ),
    // Prompt-cache expiry: a bounded tail-read through the gated transcript-fs
    // seam, made only when the transcript's stamp moved.
    lane("cache", want.cache, () =>
      deps.cacheExpiry.refresh(sessionId, hookData.transcript_path),
    ),
    // [LAW:one-source-of-truth] tok/s folds from the SAME store the session
    // lane reads, one sample per request: a frame takes none, so how often the
    // bar is drawn moves no rate.
    lane("speed", want.speed, () => session.speed(dateOf(at).getTime())),
    lane("autocompact", want.autocompact, async () =>
      deps.autoCompact.window(settingsPathOf(hints)),
    ),
  ]);
}

// Each lane's value as its owner holds it now. The keyed lanes' (git, tmux)
// are `Current`: a value not answered yet carries its landing.
// `today` is no lane of the payload: the day it sums is the draw's
// (`todayOf`).
interface Lanes {
  readonly git: Current<GitInfo>;
  readonly usage: Reading<UsageInfo>;
  readonly context: Reading<ContextInfo>;
  readonly metrics: Reading<MetricsInfo>;
  readonly activity: Reading<ActivityInfo>;
  readonly tmuxSession: Current<string>;
  readonly hostName: Current<string>;
  readonly hostUser: Current<string>;
  readonly cache: Reading<number>;
  readonly speed: Reading<SpeedObservation>;
  readonly autoCompact: Reading<AutoCompactWindow>;
  readonly sources: ReadonlyMap<string, Current<JsonValue>>;
}

// What a view's declaration reads of the request its renders draw by: the
// keys every keyed lane is read at, and the session as the checkpoint parsed
// it.
export type ViewFacts = Pick<PayloadInputs, "hookData" | "cwd" | "hints"> & {
  readonly sessionId: SessionId;
};

// The owners of the keyed lanes, which a declaration takes its holds in.
export type KeyedOwners = Pick<
  RenderPayloadDeps,
  | "gitProvider"
  | "tmuxService"
  | "hostService"
  | "usageStore"
  | "managedStorage"
>;

// [LAW:types-are-the-program] What a view's declaration hands its draws: one
// lane per keyed lane, each closed over the entry the declaration took, so
// the key is computed once, by the declaration, and a read takes nothing.
export interface DeclaredLanes {
  readonly git: Lane<GitInfo>;
  readonly tmux: Lane<string>;
  readonly hostName: Lane<string>;
  readonly hostUser: Lane<string>;
  readonly today: Lane<DaySums>;
  // [LAW:dataflow-not-control-flow] One lane per plugin source the preset
  // reads, by the source variable's name: no fixed list — the set is what the
  // loaded plugins declare and the closure reaches.
  readonly sources: ReadonlyMap<string, Lane<JsonValue>>;
}

// The plugin sources a config declares, by variable name, at the storage key
// its render state's build took for each one's folder.
export type DeclaredSources = ReadonlyMap<string, StorageKey>;

// [LAW:one-source-of-truth] The sources a view reads: those the config
// declares that its preset's closure reaches, at their own names
// (payloadPathOf).
export function sourcesRead(
  closure: ReadonlySet<string>,
  sources: DeclaredSources,
): readonly string[] {
  return [...sources.keys()].filter((name) => closure.has(name));
}

// A declaration's lanes, and what threw while it took them.
export interface Declaration {
  readonly lanes: DeclaredLanes;
  readonly faults: readonly string[];
}

// Every lane answering one outcome, `sources` one per name: a view's when its
// declaration threw whole, or a caller's that declares nothing.
export function settledLanes(
  outcome: Outcome<never>,
  sources: readonly string[],
): DeclaredLanes {
  const lane = settledLane(outcome);
  return {
    git: lane,
    tmux: lane,
    hostName: lane,
    hostUser: lane,
    today: lane,
    sources: new Map(sources.map((name) => [name, lane])),
  };
}

// [LAW:one-source-of-truth] The repo a request names, at the option sets and
// PR its closure reads.
function gitAt(
  { cwd, hookData }: ViewFacts,
  closure: ReadonlySet<string>,
): readonly [
  workingDir: string,
  options: GitInfoOptions,
  projectDir: string | undefined,
] {
  return [
    cwd ?? hookData.workspace?.current_dir,
    gitOptionsFromClosure(closure),
    hookData.workspace?.project_dir,
  ];
}

// [LAW:single-enforcer] A view's declaration (brandon-unfiled-3248.8ro6, steps
// 3 and 4), the one taker of holds: every keyed entry its closure reads, at
// the keys its request names, taken in `holds` — an entry not read yet is
// created and its first read started — and handed back as the lanes its
// draws read. It runs when the view opens and when the request or the
// session's preset moves (src/daemon/cache/render.ts), so a preset that newly
// places a source starts its read before any draw asks for it, and one that
// stops placing a source releases it at once (`Holds.declare`).
//
// [LAW:dataflow-not-control-flow] Every lane is a lane: one the closure does
// not read answers `ABSENT`, and one whose declaration threw answers that
// failure and takes no hold.
export function declareLanes(
  owners: KeyedOwners,
  holds: Holds,
  facts: ViewFacts,
  closure: ReadonlySet<string>,
  sources: DeclaredSources,
): Declaration {
  const want = wanted(closure);
  const pane = facts.hints.tmux ?? null;
  // [LAW:no-silent-failure] A lane whose declaration throws is a bug in its
  // owner, reported to the caller, while every other lane declares.
  const faults: string[] = [];
  const declare = <T>(
    lane: string,
    needed: boolean,
    take: () => Lane<T>,
  ): Lane<T> => {
    if (!needed) return settledLane(ABSENT);
    try {
      return take();
    } catch (e) {
      faults.push(`${lane}: ${inspect(e)}`);
      return settledLane(failed(`${lane}: ${String(e)}`));
    }
  };
  const lanes: DeclaredLanes = {
    git: declare("git", want.git, () =>
      owners.gitProvider.declare(holds, ...gitAt(facts, closure)),
    ),
    tmux: declare("tmux", want.tmux && pane !== null, () =>
      owners.tmuxService.declare(holds, pane!),
    ),
    hostName: declare("host.name", want.hostName, () =>
      owners.hostService.declareName(holds),
    ),
    hostUser: declare("host.user", want.hostUser, () =>
      owners.hostService.declareUser(holds),
    ),
    today: declare("today", want.today, () =>
      owners.usageStore.declareToday(holds, facts.hints.claudeConfigDir),
    ),
    // [LAW:one-source-of-truth] Each source's hold at (its folder's storage
    // key, the session the checkpoint parsed).
    sources: new Map(
      sourcesRead(closure, sources).map((name) => [
        name,
        declare(name, true, () =>
          owners.managedStorage.declare(
            holds,
            sources.get(name)!,
            facts.sessionId,
          ),
        ),
      ]),
    ),
  };
  return { lanes, faults };
}

// [LAW:effects-at-boundaries] No I/O, and no write: every read takes what its
// owner stored, so the view's payload computed over it is recomputed in the
// turn an owner stores a new value.
function readLanes(inputs: PayloadInputs): Lanes {
  const { hookData, deps } = inputs;
  const want = wanted(inputs.neededInputPaths);
  const sessionId = hookData.session_id;
  const lanes = deps.lanes();
  // [LAW:no-silent-failure] A read that throws is a bug in its owner: logged
  // here, by the read that met it — a frame's included, whose failures go
  // nowhere else — and that lane's failure, so it costs its own cells, never
  // the bar. A lane whose refresh threw is that failure (RefreshFaults).
  const read = <T>(
    lane: RefreshLane,
    needed: boolean,
    value: () => T,
  ): T | Outcome<never> => {
    if (!needed) return ABSENT;
    const fault = deps.faults.of(sessionId, lane);
    if (fault !== undefined) return fault;
    try {
      return value();
    } catch (e) {
      deps.log("error", `${lane} read threw: ${inspect(e)}`);
      return failed(`${lane}: ${String(e)}`);
    }
  };
  return {
    git: lanes.git.current(),
    usage: read("session", want.session, () =>
      deps.usageStore.usageOf(sessionId, hookData),
    ),
    context: read("context", want.context, () =>
      deps.contextProvider.contextOf(hookData),
    ),
    metrics: read("metrics", want.metrics, () =>
      deps.metricsProvider.metricsOf(sessionId, hookData),
    ),
    activity: read("activity", want.activity, () =>
      deps.activityProvider.activityOf(sessionId),
    ),
    tmuxSession: lanes.tmux.current(),
    hostName: lanes.hostName.current(),
    hostUser: lanes.hostUser.current(),
    cache: read("cache", want.cache, () =>
      deps.cacheExpiry.expiryOf(sessionId),
    ),
    speed: read("speed", want.speed, () => deps.usageStore.speedOf(sessionId)),
    autoCompact: read("autocompact", want.autocompact, () =>
      deps.autoCompact.stored(settingsPathOf(inputs.hints)),
    ),
    sources: new Map(
      [...lanes.sources].map(([name, lane]) => [name, lane.current()]),
    ),
  };
}

// The landings a request waits on before it draws: every declared lane whose
// key has never answered, the branch's PR included. A lane the daemon itself
// superseded (a click's move) is not waited on: it draws its loading cell, and
// its landing reaches the next frame.
function waitsOf(lanes: DeclaredLanes): Array<Promise<void>> {
  const git = lanes.git.current();
  const pr = git.kind === "ok" ? git.value.pullRequest : undefined;
  // [LAW:dataflow-not-control-flow] One test over every lane: why it is
  // pending decides, never which lane it is.
  return [
    git,
    lanes.tmux.current(),
    lanes.hostName.current(),
    lanes.hostUser.current(),
    lanes.today.current(),
    ...[...lanes.sources.values()].map((lane) => lane.current()),
    ...(pr === undefined ? [] : [pr]),
  ].flatMap((lane) =>
    lane.kind === "pending" && lane.why === "unread" ? [lane.landed] : [],
  );
}

// [LAW:effects-at-boundaries] The projections are pure folds returning data
// (payload fragment + failure descriptions); the log effect is the caller's.
// A value not answered yet is PENDING, which the draw takes as its own
// outcome.
function projectPayload(
  inputs: PayloadInputs,
  draw: DrawInputs,
  lanes: Lanes,
): ViewPayload {
  const { hookData, hints } = inputs;
  const { effective, configFacts } = draw;
  const { configPath, ...settingCounts } = configFacts;
  const want = wanted(inputs.neededInputPaths);
  // `over` is the total fold of one lane's reading into its payload field:
  // ok → its projection, absent or failed → undefined, pending → the payload's
  // pending spelling. [LAW:no-silent-failure] A failed lane was logged by the
  // refresh that failed, its owner's (src/utils/refresh-ledger.ts), so a
  // payload derived from it logs nothing again.
  const over = <T, U>(
    reading: Reading<T>,
    project: (value: T) => U | undefined,
  ): U | Pending | undefined => {
    switch (reading.kind) {
      case "pending":
        return PENDING;
      case "failed":
      case "absent":
        return undefined;
      case "ok":
        return project(reading.value);
    }
  };
  const valueOf = <T>(reading: Reading<T>): T | undefined =>
    reading.kind === "ok" ? reading.value : undefined;

  const tmuxPane = hints.tmux ?? null;
  // Git, tmux and autocompact log their own failures — once per
  // refresh that failed (src/daemon/cache/git.ts, src/utils/keyed-source.ts,
  // src/segments/autocompact-provider.ts): their values are stored, so
  // logging one here would repeat a failure on every render. Their failures
  // reach the payload as values.
  const git =
    lanes.git.kind === "pending"
      ? PENDING
      : projectGitInfo(lanes.git, () => PENDING);
  const tmuxValue =
    lanes.tmuxSession.kind === "pending" ? PENDING : valueOf(lanes.tmuxSession);
  const hostName =
    lanes.hostName.kind === "pending" ? PENDING : valueOf(lanes.hostName);
  const hostUser =
    lanes.hostUser.kind === "pending" ? PENDING : valueOf(lanes.hostUser);
  // The controls are capped to the model's context window, so they are not
  // answered while the window is not.
  const autoCompactValue =
    lanes.autoCompact.kind === "pending" ||
    (want.autocompact && lanes.context.kind === "pending")
      ? PENDING
      : projectAutoCompact(
          lanes.autoCompact,
          valueOf(lanes.context)?.maxTokens,
        );
  // [LAW:dataflow-not-control-flow] block.* and weekly.* read straight from
  // hookData's rate-limit windows; what they say relative to now is the
  // draw's (BlockPayload).
  const fiveHour = hookData.rate_limits?.five_hour;
  const sevenDay = hookData.rate_limits?.seven_day;
  // [LAW:dataflow-not-control-flow] Gated by `wants("burn")` so the rate is
  // computed only when a layout segment reads it; absent cost/duration (lane
  // skipped or provider empty) yields no rate, never a fabricated one, and a
  // rate over a value not answered yet is not answered either. Its two lanes'
  // failures are theirs to report, below.
  const burn: BurnPayload | Pending | undefined = !want.burn
    ? undefined
    : lanes.usage.kind === "pending" || lanes.metrics.kind === "pending"
      ? PENDING
      : burnOf(
          valueOf(lanes.usage)?.session.cost,
          valueOf(lanes.metrics)?.sessionDuration,
        );
  // [LAW:dataflow-not-control-flow] The instantaneous rates and the burn-rate
  // history fold independently from one observation — either can be present
  // without the other (a fresh burst has rates but a one-sample history; an
  // idle-after-burst session has a history but no current rate). Merge
  // whatever each yields; the whole `speed` key drops only when both are
  // absent.
  const speedPayload = over(lanes.speed, speedPayloadOf);
  // [LAW:types-are-the-program] Partial projections so absent provider data
  // travels as missing fields all the way to the inputs. Each provider's
  // null sub-fields become absent keys here; an input's fallback chain
  // fills in the declared DSL default and records a last_error per field.
  const sessionPayload = over(lanes.usage, (usage) =>
    pickNonNull({ cost: usage.session.cost, tokens: usage.session.tokens }),
  );
  const metricsPayload = over(lanes.metrics, (metrics) =>
    pickNonNull({
      lastResponseTime: metrics.lastResponseTime,
      responseTime: metrics.responseTime,
      sessionDuration: metrics.sessionDuration,
      messageCount: metrics.messageCount,
      nonPrompts: metrics.nonPrompts,
      linesAdded: metrics.linesAdded,
      linesRemoved: metrics.linesRemoved,
    }),
  );
  const activityPayload = over(lanes.activity, projectActivity);
  const contextPayload = over(lanes.context, (context) => ({
    totalTokens: context.totalTokens,
    contextLeft: context.contextLeftPercentage,
  }));
  const cachePayload = over(lanes.cache, (expiresAt) => ({
    expiresAt,
  }));

  // home is always available — it's a single env-var read, no I/O cost.
  // Letting the gate skip it would add a branch with no win.
  // [LAW:single-enforcer] All path-shaped payload fields are normalized
  // to forward-slash separators at this boundary. The DSL's directory
  // template (and any user template that does prefix/relative-path math)
  // assumes POSIX separators; without normalization, Windows hookData
  // (current_dir = "C:\Users\Alice") would never match a forward-slash
  // home prefix. Normalize *here*, not in the template — keeps DSL
  // templates platform-agnostic by construction.
  const home = posixify(process.env.HOME ?? process.env.USERPROFILE);
  const workspace = hookData.workspace
    ? {
        ...hookData.workspace,
        current_dir: posixify(hookData.workspace.current_dir) ?? "",
        project_dir: posixify(hookData.workspace.project_dir) ?? "",
        added_dirs: (hookData.workspace.added_dirs ?? []).map(
          (dir) => posixify(dir) ?? dir,
        ),
      }
    : hookData.workspace;

  const sessionId = hookData.session_id;

  const payload: ViewPayload = {
    ...hookData,
    ...(workspace !== undefined && { workspace }),
    ...(home !== undefined && { home }),
    ...(git !== undefined && { git }),
    ...(hookData.location !== undefined && {
      location: {
        ...hookData.location,
        main: posixify(hookData.location.main) ?? "",
        gitPending: isPending(git),
      },
    }),
    ...(tmuxPane !== null && {
      tmux: {
        pane: tmuxPane.pane,
        ...(tmuxValue !== undefined && { session: tmuxValue }),
      },
    }),
    // [LAW:one-source-of-truth] Passed straight through from the parsed
    // hint. The daemon deliberately does NOT consult its own SSH_* env as a
    // fallback: that env belongs to whichever shell spawned it, so a
    // "helpful" fallback would confidently mislabel every session that
    // daemon serves.
    host: {
      ...(hostName !== undefined && { name: hostName }),
      ...(hostUser !== undefined && { user: hostUser }),
      ...(hints.ssh !== undefined && { ssh: hints.ssh }),
    },
    // [LAW:one-source-of-truth] Always present — the daemon resolves every
    // one of these each render (for BuildLineOptions/basePalette), and these
    // are those exact values. No `wants` gate: each costs nothing (already in
    // hand) and a config reading e.g. `.padding.effective` must always find it.
    ...effectiveInputs(effective),
    history: draw.history,
    navigation: { back: draw.back },
    // [LAW:one-source-of-truth] The width the bar is drawn to, as the client
    // measured it (`renderWidth`), the one value the draw's options carry.
    term: { cols: renderWidth(hints) },
    ...settingCounts,
    ...(configPath !== null && { configPath }),
    resumeCommand: resumeCommand(workspace, sessionId, hints.claudeConfigDir),
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(burn !== undefined && { burn }),
    ...(speedPayload !== undefined && { speed: speedPayload }),
    ...(want.block &&
      fiveHour !== undefined && {
        block: {
          // [LAW:one-source-of-truth] Both fields read straight from the
          // hookData rate-limit window; the DSL composes minutesUntilReset
          // against .block.resetsAt the same way weekly does. One
          // projection rule, two segments.
          nativeUtilization: fiveHour.used_percentage,
          resetsAt: fiveHour.resets_at,
        },
      }),
    ...(sevenDay !== undefined && {
      weekly: {
        percentage: sevenDay.used_percentage,
        resetsAt: sevenDay.resets_at,
      },
    }),
    ...(cachePayload !== undefined && { cache: cachePayload }),
    ...(contextPayload !== undefined && { context: contextPayload }),
    ...(metricsPayload !== undefined && { metrics: metricsPayload }),
    ...(activityPayload !== undefined && { activity: activityPayload }),
    ...(autoCompactValue !== undefined && { autocompact: autoCompactValue }),
    // The storage owner logs each read that failed: a failure here is a value,
    // drawn by the template reading it.
    ...projectSources(lanes.sources.keys(), (name) => {
      const reading = lanes.sources.get(name)!;
      return reading.kind === "pending" ? PENDING : reading;
    }),
  };
  return payload;
}

// [LAW:nothing-unseen] The render event's `sources=` and `sourcesPending=`:
// how many plugin sources the view declared, and those not answered yet as
// the draw reads them, each with why (`<name>:unread` or `<name>:superseded`;
// `-` for none), so a source that never lands is told from one nothing
// declared, and a run's superseded source from a wait that left one out.
export function sourcesFactOf(sources: ReadonlyMap<string, Lane<JsonValue>>): {
  readonly sources: string;
  readonly sourcesPending: string;
} {
  return {
    sources: String(sources.size),
    sourcesPending:
      [...sources]
        .flatMap(([name, lane]) => {
          const reading = lane.current();
          return reading.kind === "pending" ? [`${name}:${reading.why}`] : [];
        })
        .join(",") || "-",
  };
}

// [LAW:one-source-of-truth] The one projection of a view's sources into its
// payload: each at `.<scope>.<plugin>.<source>`, its variable's own name, as
// `read` answers it — the daemon reads the storage owner's lanes, `check`
// reads every source absent (what a session reads before its program first
// writes). No second spelling of the path exists.
export function projectSources<P>(
  names: Iterable<string>,
  read: (name: string) => Outcome<JsonValue> | P,
): Record<PluginScope, SourcesPayload<P>> {
  // [LAW:dataflow-not-control-flow] Every scope is a key, empty or not, and
  // every source lands at its own payload path (`payloadPathOf`: the name it
  // is declared under), nested one object per dot — no branch on which scope
  // or plugin it is.
  const payload: Record<string, unknown> = Object.fromEntries(
    PLUGIN_SCOPES.map((scope) => [scope, {}]),
  );
  for (const name of names) {
    // [LAW:types-are-the-program] A source's name is
    // `<scope>.<plugin>.<source>`, each one identifier (the plugin loader),
    // which is what makes the nesting below the return type's shape.
    const keys = name.split(".");
    const leaf = keys.pop()!;
    const parent = keys.reduce<Record<string, unknown>>(
      (at, key) => (at[key] ??= {}) as Record<string, unknown>,
      payload,
    );
    parent[leaf] = read(name);
  }
  return payload as Record<PluginScope, SourcesPayload<P>>;
}

function burnOf(
  cost: number | null | undefined,
  duration: number | undefined,
): BurnPayload | undefined {
  const costPerHour =
    cost != null && duration != null
      ? projectCostPerHour(cost, duration)
      : undefined;
  return costPerHour === undefined ? undefined : { costPerHour };
}

function speedPayloadOf(obs: SpeedObservation): SpeedPayload | undefined {
  const rates = projectSpeed(obs);
  const history = projectSpeedHistory(obs);
  return rates !== undefined || history !== undefined
    ? { ...rates, ...(history !== undefined && { history }) }
    : undefined;
}

// [LAW:one-source-of-truth] The one assembly of a view's payload: every
// source as its owner holds it now, a value not answered yet as PENDING —
// which the draw takes as its own outcome (the placement's loading cell).
// Performs no I/O, refreshes
// nothing and reads no instant, so the session's view keeps it as one computed
// (src/daemon/session-source.ts), recomputed in the turn a fact it reads moves.
export function payloadOf(
  inputs: PayloadInputs,
  draw: DrawInputs,
): ViewPayload {
  return projectPayload(inputs, draw, readLanes(inputs));
}

// [LAW:one-source-of-truth] `today` at a draw's instant: the day of the
// declared set's sums the draw is at. A projection of the draw, never of the
// view's payload, since the day turns over at midnight with no source moving
// (DRAW_PROJECTIONS, src/config/payload-inputs.ts). A failed scan is logged
// by its owner, the usage store.
export function todayOf(
  {
    usageStore,
    faults,
    log,
  }: Pick<RenderPayloadDeps, "usageStore" | "faults" | "log">,
  lane: Lane<DaySums>,
  hookData: ClaudeHookData,
  at: Instant,
): TodayPayload | Pending | undefined {
  if (faults.of(hookData.session_id, "today") !== undefined) return undefined;
  const set = lane.current();
  if (set.kind === "pending") return PENDING;
  if (set.kind !== "ok") return undefined;
  const read = (): Reading<TodayInfo> => {
    try {
      return usageStore.todayAt(set.value, hookData, at);
    } catch (e) {
      log("error", `today read threw: ${inspect(e)}`);
      return ABSENT;
    }
  };
  const today = read();
  if (today.kind === "pending") return PENDING;
  return today.kind === "ok"
    ? { cost: today.value.cost, tokens: today.value.tokens }
    : undefined;
}

// A statusline request's wait (rule 1 of the model): it refreshes what its
// arrival triggers, then waits for the first value of every keyed lane its
// view declared that has not answered yet. The answer is then drawn from the
// view's payload, which those landings moved — the same values a frame drawn
// after it reads.
export async function settlePayload(
  inputs: PayloadInputs,
  at: Instant,
  refreshed: Refreshed,
): Promise<void> {
  await refreshPayload(inputs, at, refreshed);
  // [LAW:one-source-of-truth] The one wait for an answer: the lanes the view
  // declares now, read again once every landing they waited on has landed —
  // so a lane that turns unread again (a new key) is waited out too, and a
  // superseded one never is (waitsOf).
  await answered((): true | Waiting => {
    const waits = waitsOf(inputs.deps.lanes());
    return waits.length > 0
      ? {
          kind: "pending",
          why: "unread",
          landed: Promise.all(waits).then(() => {}),
        }
      : true;
  });
}

// [LAW:effects-at-boundaries] Pure: the settings read and the model's context
// window in, the payload shape out. The read never answers `absent` (a missing
// file is `auto`), so the family is dropped only when no segment asked for it.
export function projectAutoCompact(
  outcome: Outcome<AutoCompactWindow>,
  contextWindow: number | undefined,
): AutoCompactPayload | undefined {
  switch (outcome.kind) {
    case "absent":
      return undefined;
    case "failed":
      return { error: outcome.reason };
    case "ok":
      return autoCompactControls(outcome.value, contextWindow);
  }
}

// [LAW:effects-at-boundaries] The activity projection is pure: the provider's
// record in, the wire shape out. Returns undefined when the record says nothing
// is happening, so the family is dropped exactly like a provider that had no
// data — one absence policy, not two.
function projectActivity(info: ActivityInfo): ActivityPayload | undefined {
  const activeAt = info.todos.findIndex((t) => t.active);
  const todo: ActivityTodoPayload | undefined =
    info.todos.length === 0
      ? undefined
      : {
          total: info.todos.length,
          completed: info.todos.filter((t) => t.done).length,
          ...(activeAt >= 0 && {
            position: activeAt + 1,
            active: info.todos[activeAt]!.text,
          }),
        };
  const running = encodeTally(info.running);
  const done = encodeTally(info.done);
  const tool: ActivityToolPayload | undefined =
    running === undefined && done === undefined
      ? undefined
      : {
          ...(running !== undefined && { running }),
          ...(done !== undefined && { done }),
        };
  if (info.command === null && todo === undefined && tool === undefined) {
    return undefined;
  }
  return {
    ...(info.command !== null && { command: info.command }),
    ...(todo !== undefined && { todo }),
    ...(tool !== undefined && { tool }),
  };
}

// [LAW:one-source-of-truth] The ONE encoding of a tool tally, read back by one
// template helper. Absent (not an empty string) when there is nothing tallied,
// so the field is dropped rather than emitting a value a `when` would have to
// treat as falsy by coincidence.
function encodeTally(tally: readonly ToolTally[]): string | undefined {
  return tally.length === 0
    ? undefined
    : tally.map((t) => `${t.name}:${t.count}`).join(",");
}

// [LAW:types-are-the-program] Project an object with possibly-null fields
// down to a partial whose nulls have been dropped. If every field is null
// the result is undefined — caller treats that as "provider returned but
// had nothing usable" and omits the sub-object entirely.
function pickNonNull<T extends Readonly<Record<string, number | null>>>(
  src: T,
): { [K in keyof T]?: number } | undefined {
  const out: { [K in keyof T]?: number } = {};
  let any = false;
  for (const k of Object.keys(src) as Array<keyof T>) {
    const v = src[k];
    if (v !== null && v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

// [LAW:single-enforcer] Convert backslash-separator path strings to
// forward-slash separators so DSL templates can rely on POSIX path math
// (prefix checks, trimPrefix) on every platform. Undefined and empty
// inputs pass through unchanged. The function is platform-conditional
// only on whether `\` *could* be a separator (it never can on POSIX, so
// no harm in always converting — but the explicit guard avoids touching
// strings on non-Windows callers where backslash is meaningful
// inside path components).
function posixify(s: string | undefined): string | undefined {
  if (s === undefined || s.length === 0) return s;
  if (path.sep !== "\\") return s;
  return s.replace(/\\/g, "/");
}

// [LAW:types-are-the-program] Project the outcome-carrying GitInfo down to
// the flat shape the DSL input paths read. A pure fold: `ok` fields become
// values, `absent` and `failed` fields become MISSING keys (the DSL input
// fallback chain fills the declared default and records a last_error). It
// performs no effect ([LAW:effects-at-boundaries]): the git refresh that read a
// failure is what logged it.
function projectGitInfo<P>(
  outcome: Outcome<GitInfo>,
  pending: (lane: string) => P,
): GitPayloadOf<P> | undefined {
  if (outcome.kind !== "ok") return undefined;

  const info = outcome.value;
  const field = <T>(oc: Outcome<T> | undefined): T | undefined =>
    oc?.kind === "ok" ? oc.value : undefined;

  const aheadBehind = field(info.aheadBehind);
  const sha = field(info.sha);
  const operation = field(info.operation);
  const committedAt = field(info.committedAt);
  const stash = field(info.stashCount);
  const upstream = field(info.upstream);
  const tracking =
    info.upstream === undefined
      ? undefined
      : field(trackingOf(info.upstream, info.aheadBehind));
  const repoName = field(info.repoName);
  const repoUrl = field(info.repoUrl);

  // [LAW:no-silent-failure] The PR deliberately breaks the `field` pattern: a
  // `failed` lookup is NOT dropped to a missing key (which the template can't
  // tell apart from "no PR"). It is surfaced as `prError` so the segment
  // renders a distinct marker; the lookup that failed logged the same reason
  // for the operator. `absent` is still a missing key (no PR / no forge →
  // segment off).
  // A PR not answered yet is every PR field not answered: the cell it draws
  // waits at its width while the rest of git draws as it stands.
  const pr =
    info.pullRequest === undefined
      ? undefined
      : info.pullRequest.kind === "pending"
        ? info.pullRequest
        : prOfHead(info.pullRequest, info.head);
  let prFields: PrPayload | PrPendingOf<P> = {};
  switch (pr?.kind) {
    case "pending": {
      const p = pending("git.pr");
      prFields = {
        prNumber: p,
        prState: p,
        prUrl: p,
        prError: p,
        prEarlier: p,
      };
      break;
    }
    case "ok":
      prFields = {
        prNumber: pr.value.number,
        prState: pr.value.state,
        prUrl: pr.value.url,
      };
      break;
    case "failed":
      prFields = { prError: pr.reason };
      break;
    case "earlier":
      prFields = { prEarlier: pr.value.state };
      break;
    case "absent":
    case undefined:
      break;
  }

  return {
    branch: info.branch,
    status: info.status,
    ...(aheadBehind !== undefined && {
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
    }),
    ...(info.workingTree !== undefined && {
      staged: info.workingTree.staged,
      unstaged: info.workingTree.unstaged,
      untracked: info.workingTree.untracked,
      conflicts: info.workingTree.conflicts,
    }),
    ...(sha !== undefined && { sha }),
    ...(operation !== undefined && { operation }),
    ...(committedAt !== undefined && { committedAt }),
    ...(stash !== undefined && { stash }),
    ...(upstream !== undefined && { upstream }),
    ...(tracking !== undefined && { tracking }),
    ...(repoName !== undefined && { repoName }),
    ...(repoUrl !== undefined && { repoUrl }),
    ...prFields,
  };
}
