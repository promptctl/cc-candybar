// [LAW:single-enforcer] The single place where the daemon assembles every
// data field the DSL templates can read. The output of this function — the
// view's payload (`projectPayload`) — is what a session view's inputs derive from
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
import {
  DEFAULT_TERMINAL_WIDTH,
  type BuildLineOptions,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";
import type { SettingName } from "../config/setting-projections.js";
import { pathUnder } from "../config/payload-reads.js";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import type { LaneFeeds } from "../config/lanes.js";
import {
  PLUGIN_SCOPES,
  type PluginScope,
} from "../config/loader/plugin-scope.js";
import {
  prOfHead,
  trackingOf,
  type GitInfo,
  type GitInfoOptions,
  type PrState,
  type PullRequest,
  type Tracking,
} from "../segments/git.js";
import {
  ABSENT,
  failed,
  isPending,
  isUndeclared,
  isUnanswered,
  ok,
  pendingOf,
  type Outcome,
  type Pending,
  type Reading,
  type Undeclared,
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
} from "./cache/session-usage-store.js";
import { projectToday, type TodayFacts } from "./cache/today-facts.js";
import type { ContextProvider } from "../segments/context.js";
import type { MetricsProvider } from "../segments/metrics.js";
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
import type { Fact } from "../facts/fact.js";
import {
  builtinOf,
  declaredBuiltins,
  type BuiltinName,
  type BuiltinValues,
  type DeclaredBuiltins,
  type FactsDiagnostic,
  type GitFacts as DocumentGitFacts,
  type RunFact,
  type SessionFacts,
  type SourceDigest,
  type SourceValue,
} from "../facts/session-facts.js";
import type { SessionId } from "./session-id.js";
import type { ManagedStorage, StorageKey } from "./cache/managed-storage.js";
import type { JsonValue } from "../var-system/types.js";
import { elapsedMs, type Timekeeper } from "../time";
import { shortDigest } from "../source-digest.js";

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
  // The user's home directory, surfaced as a path so the DSL reads it via
  // `input` alongside the rest of the payload.
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
  // user each a source (src/segments/host.ts), `ssh` the
  // session's hint. See HostPayloadOf.
  readonly host: HostPayloadOf<P>;
  // `theme.effective`, `style.effective` and `effect.effective` are
  // deliberately NOT fields here. They are the selections whose config rung may
  // hold an EXPRESSION (brandon-looks-pe6, brandon-themes-dzl,
  // brandon-effects-2gka.d2i), so each fold finishes in the view, whose slots
  // answer `theme`, `style` and `effect: { effective }` from the selections
  // it was bound with. ONE producer per field, so the name a label displays and
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
// [LAW:types-are-the-program] A field a frame draws without an answer: not
// answered yet, or filled by a built-in the renderer did not declare.
export type Unanswered = Pending | Undeclared;
// What a frame draws: every value as it stands.
export type DrawnPayload = RenderPayloadOf<Unanswered>;
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

// [LAW:one-source-of-truth] Every PR field a template can lay out, so the
// doctor's question "does this segment read the PR" (src/doctor/data-needs.ts)
// names a new arm's field, or fails to compile until it does.
export const PR_FIELDS: { readonly [F in keyof PrFieldTypes]: true } = {
  prNumber: true,
  prState: true,
  prUrl: true,
  prError: true,
  prEarlier: true,
};

// The render event's `pr=`: the branch's PR state, `failed` when the forge
// could not say, `earlier-<state>` when its PR was an older use of the
// branch's name, `pending` when a PR the render reads is not answered yet,
// `-` when the payload carries none, `undeclared` when the renderer does not
// read it.
export function prFactOf(
  git: GitPayloadOf<Unanswered> | Unanswered | undefined,
): string {
  if (isPending(git)) return "pending";
  if (isUndeclared(git)) return "undeclared";
  const { prState, prError, prEarlier } = git ?? {};
  if (isPending(prState)) return "pending";
  if (isUndeclared(prState)) return "undeclared";
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
  // [LAW:one-source-of-truth] The user's home directory: the one derivation
  // (`Host.home`) the payload's `home`, the default Claude Code directory and
  // the usage store's transcripts share.
  readonly home: string;
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
  // [LAW:effects-at-boundaries] The daemon's clock, which times each lane's
  // refresh and stamps its facts.
  readonly clock: Pick<Timekeeper, "monotonic" | "now">;
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
// facts.
export interface PayloadInputs {
  readonly hookData: ClaudeHookData;
  readonly deps: RenderPayloadDeps;
  readonly cwd: string | undefined;
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

// [LAW:one-source-of-truth] The width a session's bar is drawn to: what its
// client measured, else the default, less Claude Code's reserve — the one
// value the payload's `term.cols` and the draw's options both carry.
export function renderWidth(hints: ClientHints): number {
  return applyClaudeCodeReserve(hints.termCols ?? DEFAULT_TERMINAL_WIDTH);
}

// The settings file of THIS session's Claude Code, from the client's
// `claudeConfigDir` hint — never the daemon's own env, which answers for
// whichever session spawned it. [LAW:single-enforcer]
function settingsPathOf(hints: ClientHints, home: string): string {
  return claudeSettingsPath(claudeConfigDir(hints.claudeConfigDir, home));
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

// ─── Built-in lanes ──────────────────────────────────────────────────────────

// The request's one refresh of its session's usage record, which the session,
// today and speed lanes share.
type SessionRequest = ReturnType<SessionUsageStore["request"]>;

// What a request's arrival hands a lane's refresh: the instant its speed
// sample is taken at, and the session's usage request, made by the first lane
// that asks for it, so a declaration that reads none of the three makes none.
export interface LaneRequest {
  readonly at: Instant;
  readonly usage: () => SessionRequest;
}

// A request's own refresh of one lane, named by the lane its timing and its
// standing fault are kept under.
export interface LaneRefresh {
  readonly lane: RefreshLane;
  readonly run: (request: LaneRequest) => Promise<unknown>;
}

// [LAW:types-are-the-program] One declared built-in, as every stage after its
// declaration reads it: its reading as its owner holds it now; the refresh a
// request's arrival starts, or none for a lane only its owner's period and
// watch refresh; the first answer a request waits on while the lane has none,
// or none for a lane a request never waits on; and the refresh's standing
// fault. So refreshing, reading, waiting and stamping each iterate the lanes
// they are handed and never ask which built-ins were declared.
export interface BuiltinLane<T> {
  readonly current: () => Reading<T>;
  readonly refresh: LaneRefresh | null;
  readonly landing: () => Promise<void> | null;
  readonly fault: () => FactsDiagnostic | null;
}

export type BuiltinLanes = {
  readonly [K in BuiltinName]?: BuiltinLane<BuiltinValues[K]>;
};

// [LAW:types-are-the-program] The one place the declared lanes are walked as
// entries: an object keyed by a declared name holds that name's lane, and
// iteration keeps the declaration's order.
function laneEntries(
  lanes: BuiltinLanes,
): ReadonlyArray<readonly [BuiltinName, BuiltinLane<unknown>]> {
  return Object.entries(lanes) as Array<[BuiltinName, BuiltinLane<unknown>]>;
}

// A lane whose value has never answered carries its landing: what a request
// waits on.
function landingOf(current: Current<unknown>): Promise<void> | null {
  return current.kind === "pending" && current.why === "unread"
    ? current.landed
    : null;
}

// [LAW:one-type-per-behavior] A keyed lane: the entry its declaration took,
// read as it stands, refreshed by its owner alone, and waited on for its first
// answer (git, tmux, the host's name and user).
function keyedLane<T>(lane: Lane<T>): BuiltinLane<T> {
  return {
    current: () => lane.current(),
    refresh: null,
    landing: () => landingOf(lane.current()),
    fault: () => null,
  };
}

// A built-in answering one outcome for good: a session outside tmux, or a
// lane whose declaration threw. [LAW:one-type-per-behavior] A keyed lane over
// a settled one: read as it stands, refreshed by nobody, and an answered
// outcome is never waited on.
const settledBuiltin = <T>(outcome: Outcome<T>): BuiltinLane<T> =>
  keyedLane(settledLane(outcome));

// A keyed lane's value carried through `project`, its landing kept.
function mapLane<T, U>(lane: Lane<T>, project: (value: T) => U): Lane<U> {
  return {
    current: () => {
      const current = lane.current();
      return current.kind === "ok" ? ok(project(current.value)) : current;
    },
  };
}

// What a lane's constructor reads of the declaration it serves: the owners,
// the holds it takes in, the request its keys come from, and the one
// repository read git and the PR both ask.
interface LaneContext {
  readonly owners: LaneOwners;
  readonly holds: Holds;
  readonly facts: ViewFacts;
  readonly repo: () => Lane<GitInfo>;
}

// [LAW:single-enforcer] A lane a request refreshes: its owner's stored value
// for the session, read through the lane's standing fault. A refresh's
// contract is to answer, so a throw is a bug in its owner: a read that throws
// is logged here, the one site a read's throw is logged (a frame's included,
// whose failures go nowhere else), and answered as that lane's failure, so it
// costs its own cells, never the bar; a refresh that threw is that failure
// (RefreshFaults) until one runs clean, while a refresh that answered failed
// was logged by its owner, which met it.
function sessionLane<T>(
  { owners, facts }: LaneContext,
  lane: RefreshLane,
  read: () => Reading<T>,
  run: LaneRefresh["run"],
): BuiltinLane<T> {
  const sessionId = facts.hookData.session_id;
  const standing = () => owners.faults.of(sessionId, lane);
  return {
    current: () => {
      const fault = standing();
      if (fault !== undefined) return fault;
      try {
        return read();
      } catch (e) {
        owners.log("error", `${lane} read threw: ${inspect(e)}`);
        return failed(`${lane}: ${String(e)}`, "read");
      }
    },
    refresh: { lane, run },
    landing: () => null,
    fault: () => {
      const fault = standing();
      return fault === undefined ? null : { lane, reason: fault.reason };
    },
  };
}

// [LAW:types-are-the-program] The PR as a fact of its own (its cost is its
// own), asked of the repository's read: no repository has no PR, a repository
// that failed to read cannot be asked, and a repository read without its PR
// has not been asked.
function prOf(git: Reading<GitInfo>): Reading<PullRequest> {
  switch (git.kind) {
    case "pending":
    case "failed":
      return git;
    case "absent":
      return ABSENT;
    case "ok":
      return git.value.pullRequest ?? pendingOf("unread");
  }
}

function gitFactsOf({
  pullRequest: _pullRequest,
  ...git
}: GitInfo): DocumentGitFacts {
  return git;
}

// [LAW:single-enforcer] The one constructor of each built-in's lane, which is
// where a keyed lane takes its hold and a session lane closes over its owner.
// `declareLanes` calls it for each declared built-in, once per declaration, so
// a built-in nobody declares takes no hold and starts no refresh.
const BUILTIN_LANES: {
  readonly [K in BuiltinName]: (
    ctx: LaneContext,
  ) => BuiltinLane<BuiltinValues[K]>;
} = {
  session: (ctx) =>
    sessionLane(
      ctx,
      "session",
      () =>
        ctx.owners.usageStore.usageOf(
          ctx.facts.hookData.session_id,
          ctx.facts.hookData,
        ),
      (request) => request.usage().usage(ctx.facts.hookData),
    ),
  // Today holds its directory set's day sums and refreshes the session's own
  // records: the sums land through their scan's store and are never waited
  // on (waitsOf), the session's days through the request's refresh.
  today: (ctx) => {
    const sums = ctx.owners.usageStore.declareToday(
      ctx.holds,
      ctx.facts.hints.claudeConfigDir,
    );
    return sessionLane(
      ctx,
      "today",
      () =>
        todayReading(
          sums,
          ctx.owners.usageStore,
          ctx.facts.hookData.session_id,
        ),
      (request) => request.usage().today(),
    );
  },
  // [LAW:one-source-of-truth] tok/s folds from the SAME store the session
  // lane reads, one sample per request: a frame takes none, so how often the
  // bar is drawn moves no rate.
  speed: (ctx) =>
    sessionLane(
      ctx,
      "speed",
      () => ctx.owners.usageStore.speedOf(ctx.facts.hookData.session_id),
      (request) => request.usage().speed(dateOf(request.at).getTime()),
    ),
  context: (ctx) =>
    sessionLane(
      ctx,
      "context",
      () => ctx.owners.contextProvider.contextOf(ctx.facts.hookData),
      () => ctx.owners.contextProvider.getContextInfo(ctx.facts.hookData),
    ),
  metrics: (ctx) =>
    sessionLane(
      ctx,
      "metrics",
      () =>
        ctx.owners.metricsProvider.metricsOf(
          ctx.facts.hookData.session_id,
          ctx.facts.hookData,
        ),
      () =>
        ctx.owners.metricsProvider.getMetricsInfo(
          ctx.facts.hookData.session_id,
          ctx.facts.hookData,
        ),
    ),
  activity: (ctx) =>
    sessionLane(
      ctx,
      "activity",
      () =>
        ctx.owners.activityProvider.activityOf(ctx.facts.hookData.session_id),
      () =>
        ctx.owners.activityProvider.getActivityInfo(
          ctx.facts.hookData.session_id,
          ctx.facts.hookData,
        ),
    ),
  // Prompt-cache expiry: a bounded tail-read through the gated transcript-fs
  // seam, made only when the transcript's stamp moved.
  cache: (ctx) =>
    sessionLane(
      ctx,
      "cache",
      () => ctx.owners.cacheExpiry.expiryOf(ctx.facts.hookData.session_id),
      () =>
        ctx.owners.cacheExpiry.refresh(
          ctx.facts.hookData.session_id,
          ctx.facts.hookData.transcript_path,
        ),
    ),
  autocompact: (ctx) => {
    const settings = () => settingsPathOf(ctx.facts.hints, ctx.owners.home);
    return sessionLane(
      ctx,
      "autocompact",
      () => ctx.owners.autoCompact.stored(settings()),
      async () => ctx.owners.autoCompact.window(settings()),
    );
  },
  git: (ctx) => keyedLane(mapLane(ctx.repo(), gitFactsOf)),
  // The PR lands through the repository's own source and is never waited on:
  // a forge's network call would make every first bar as slow as it.
  pr: (ctx) => {
    const repo = ctx.repo();
    return {
      current: () => prOf(repo.current()),
      refresh: null,
      landing: () => null,
      fault: () => null,
    };
  },
  // [LAW:dataflow-not-control-flow] A session outside tmux has no pane to
  // read: its lane answers `ABSENT` and takes no hold.
  tmux: (ctx) => {
    const pane = ctx.facts.hints.tmux ?? null;
    return pane === null
      ? settledBuiltin(ABSENT)
      : keyedLane(
          mapLane(ctx.owners.tmuxService.declare(ctx.holds, pane), (name) => ({
            session: name,
          })),
        );
  },
  hostName: (ctx) => keyedLane(ctx.owners.hostService.declareName(ctx.holds)),
  hostUser: (ctx) => keyedLane(ctx.owners.hostService.declareUser(ctx.holds)),
};

// [LAW:single-enforcer] A statusline request's own triggers
// (brandon-unfiled-3248.8ro6, step 3): it refreshes each declared lane a
// request refreshes — the transcript's folds, the cache expiry, the speed
// sample, the auto-compact window, today's first scan — each stamp-gated by
// its owner, so an unchanged transcript reads nothing. A frame never calls
// this: it draws the values these refreshes stored.
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
  const { hookData, deps } = inputs;
  const sessionId = hookData.session_id;
  let usage: SessionRequest | undefined;
  const request: LaneRequest = {
    at,
    usage: () =>
      (usage ??= deps.usageStore.request(sessionId, hookData.transcript_path)),
  };
  const refresh = async ({ lane, run }: LaneRefresh): Promise<void> => {
    const startedAt = deps.clock.monotonic();
    refreshed.set(lane, null);
    let threw: string | null = null;
    try {
      await run(request);
    } catch (e) {
      deps.log("error", `${lane} lane threw: ${inspect(e)}`);
      threw = `${lane}: ${String(e)}`;
    }
    refreshed.set(lane, elapsedMs(deps.clock, startedAt));
    deps.faults.refreshed(sessionId, lane, threw);
  };
  await Promise.all(
    laneEntries(deps.lanes().builtins).flatMap(([, lane]) =>
      lane.refresh === null ? [] : [refresh(lane.refresh)],
    ),
  );
}

// [LAW:one-source-of-truth] Everything a session's readers read of its owners
// in one turn: each declared built-in's reading, every source the config
// declares, and the declared lanes' standing faults. The payload and the facts
// document are both folds of this one record.
export type BuiltinReadings = {
  readonly [K in BuiltinName]?: Reading<BuiltinValues[K]>;
};
export interface Readings {
  readonly builtins: BuiltinReadings;
  readonly sources: ReadonlyMap<string, Current<JsonValue>>;
  // Each declared `shell` and `file` source's run, by its identity's digest.
  readonly runs: ReadonlyMap<SourceDigest, RunReading>;
  readonly faults: readonly FactsDiagnostic[];
}

// What a run holds now: its reading, and its watch's fault.
export interface RunReading {
  readonly reading: Reading<JsonValue>;
  readonly fault: string | null;
}

// What a view's declaration reads of the request its renders draw by: the
// keys every keyed lane is read at, and the session as the checkpoint parsed
// it.
export type ViewFacts = Pick<PayloadInputs, "hookData" | "cwd" | "hints"> & {
  readonly sessionId: SessionId;
};

// The owners a declaration builds its lanes over: every provider, and the
// log and faults a lane reads through.
export type LaneOwners = Omit<RenderPayloadDeps, "lanes">;

// [LAW:types-are-the-program] What a view's declaration hands its draws: one
// lane per declared built-in and per plugin source, each closed over the entry
// the declaration took, so the key is computed once, by the declaration, and a
// read takes nothing.
export interface DeclaredLanes {
  readonly builtins: BuiltinLanes;
  // [LAW:dataflow-not-control-flow] One lane per plugin source the config
  // declares, by the source variable's name: no fixed list — the set is what
  // the loaded plugins declare.
  readonly sources: ReadonlyMap<string, Lane<JsonValue>>;
}

// The plugin sources a config declares, by variable name, at the storage key
// its render state's build took for each one's folder.
export type DeclaredSources = ReadonlyMap<string, StorageKey>;

// What a view declares of a session beyond the request it draws by: the
// built-ins its config reads and the plugin sources it declares, at the
// storage keys the state's build took for them. Both are its config's, so
// the same for every request the view draws.
export interface LaneDeclaration {
  readonly builtins: DeclaredBuiltins;
  readonly sources: DeclaredSources;
}

// A declaration's lanes, and what threw while it took them.
export interface Declaration {
  readonly lanes: DeclaredLanes;
  readonly faults: readonly string[];
}

// Every declared lane answering one outcome: a view's when its declaration
// threw whole.
export function settledLanes(
  outcome: Outcome<never>,
  { builtins, sources }: LaneDeclaration,
): DeclaredLanes {
  return {
    builtins: Object.fromEntries(
      [...builtins].map((name) => [name, settledBuiltin(outcome)]),
    ),
    sources: new Map(
      [...sources.keys()].map((name) => [name, settledLane(outcome)]),
    ),
  };
}

// [LAW:dataflow-not-control-flow] The one option set every session reads git
// at, so a repository's state is one value however many configs draw it; the
// PR's lookup rides it when the PR is declared. The tag is not among them: no
// field of the document carries it.
const GIT_READS: GitInfoOptions = {
  showSha: true,
  showWorkingTree: true,
  showStashCount: true,
  showUpstream: true,
  showRepoName: true,
  showRepoUrl: true,
  showOperation: true,
  showCommittedAt: true,
};

// [LAW:one-source-of-truth] The repo a request names, at the one option set,
// with the PR when the declaration reads it.
function gitAt(
  { cwd, hookData }: ViewFacts,
  declared: DeclaredBuiltins,
): readonly [
  workingDir: string,
  options: GitInfoOptions,
  projectDir: string | undefined,
] {
  return [
    cwd ?? hookData.workspace?.current_dir,
    { ...GIT_READS, showPullRequest: declared.has("pr") },
    hookData.workspace?.project_dir,
  ];
}

// [LAW:single-enforcer] A view's declaration (brandon-unfiled-3248.8ro6, steps
// 3 and 4), the one taker of holds and the one reader of what was declared:
// each declared built-in's lane, built by its constructor (BUILTIN_LANES) at
// the keys its request names, and each declared source's, taken in `holds` —
// an entry not read yet is created and its first read started — and handed
// back as the lanes its draws read. It runs when the view opens and when the
// request moves (src/daemon/cache/render.ts). What it takes depends on the
// config and the request, never on the layout a session has picked, so a
// preset pick moves no hold.
export function declareLanes(
  owners: LaneOwners,
  holds: Holds,
  facts: ViewFacts,
  { builtins, sources }: LaneDeclaration,
): Declaration {
  // [LAW:no-silent-failure] A lane whose declaration throws is a bug in its
  // owner, reported to the caller, while every other lane declares.
  const faults: string[] = [];
  const declare = <L>(
    lane: string,
    take: () => L,
    settled: (outcome: Outcome<never>) => L,
  ): L => {
    try {
      return take();
    } catch (e) {
      faults.push(`${lane}: ${inspect(e)}`);
      return settled(failed(`${lane}: ${String(e)}`, "read"));
    }
  };
  // The one repository read git and the PR both ask, declared by whichever
  // asks first: a declaration that throws is one fault, and both lanes answer
  // it.
  let repo: Lane<GitInfo> | undefined;
  const ctx: LaneContext = {
    owners,
    holds,
    facts,
    repo: () =>
      (repo ??= declare(
        "git",
        () => owners.gitProvider.declare(holds, ...gitAt(facts, builtins)),
        settledLane,
      )),
  };
  const lanes: DeclaredLanes = {
    // [LAW:types-are-the-program] Each declared name's lane from its own
    // constructor: the one cast is that a name's constructor returns that
    // name's lane.
    builtins: Object.fromEntries(
      [...builtins].map((name) => [
        name,
        declare(
          name,
          () => BUILTIN_LANES[name](ctx) as BuiltinLane<unknown>,
          settledBuiltin,
        ),
      ]),
    ) as BuiltinLanes,
    // [LAW:one-source-of-truth] Each source's hold at (its folder's storage
    // key, the session the checkpoint parsed).
    sources: new Map(
      [...sources].map(([name, key]) => [
        name,
        declare(
          name,
          () => owners.managedStorage.declare(holds, key, facts.sessionId),
          settledLane,
        ),
      ]),
    ),
  };
  return { lanes, faults };
}

// [LAW:effects-at-boundaries] No I/O, and no write: every read takes what its
// owner stored, so the view's payload computed over it is recomputed in the
// turn an owner stores a new value. The runs are the follow's own
// declaration's, read beside these (src/daemon/facts-source.ts).
export function readingsOf({
  deps,
}: Pick<PayloadInputs, "deps">): Omit<Readings, "runs"> {
  const { builtins, sources } = deps.lanes();
  const lanes = laneEntries(builtins);
  return {
    builtins: Object.fromEntries(
      lanes.map(([name, lane]) => [name, lane.current()]),
    ) as BuiltinReadings,
    sources: new Map(
      [...sources].map(([name, lane]) => [name, lane.current()]),
    ),
    // [LAW:one-source-of-truth] The faults of what is declared: a lane a
    // reload stops declaring takes its standing fault out of the document.
    faults: lanes.flatMap(([, lane]) => lane.fault() ?? []),
  };
}

// [LAW:single-enforcer] Today's facts as the session reads them: the directory
// set's day sums with the session's own days beside them, failing if the
// session's last ingest did. The draw's projection (`todayOf`) and the facts
// document read through this one definition, behind the today lane's fault.
export function todayReading(
  lane: Lane<DaySums>,
  usage: Pick<SessionUsageStore, "daysOutside">,
  sessionId: string,
): Current<TodayFacts> {
  const set = lane.current();
  if (set.kind !== "ok") return set;
  const own = usage.daysOutside(sessionId, set.value.roots);
  if (own.kind === "failed") return own;
  return ok({ sums: set.value.sums, own: own.kind === "ok" ? own.value : {} });
}

// The landings a request waits on before it draws: every declared lane whose
// key has never answered, except those whose first answer is slow and
// external (today's day sums, a scan of every transcript under the Claude Code
// directory; the branch's PR, a forge's network call), which draw pending and
// land through the observables their owners store them in, and those a
// request refreshes, which its refresh awaits. A lane the daemon itself
// superseded (a click's move) is not waited on either: it draws its loading
// cell, and its landing reaches the next frame.
function waitsOf(lanes: DeclaredLanes): Array<Promise<void>> {
  // [LAW:dataflow-not-control-flow] Each lane says what it waits on; no test
  // of which lane it is.
  return [
    ...laneEntries(lanes.builtins).map(([, lane]) => lane.landing()),
    ...[...lanes.sources.values()].map((lane) => landingOf(lane.current())),
  ].flatMap((landed) => (landed === null ? [] : [landed]));
}

// [LAW:single-enforcer] The one place a fact's instant is dropped on the way to
// a template: the payload carries what the owners hold, never when it first
// differed, which only the document keeps.
export const unstamped = <T>(fact: Fact<T>): Reading<T> => {
  switch (fact.kind) {
    case "pending":
      return fact;
    case "absent":
      return ABSENT;
    case "ok":
      return ok(fact.value);
    case "failed":
      return failed(fact.reason, fact.failedAt);
  }
};

// `over` is the total fold of one fact's reading into its payload field: ok →
// its projection, absent or failed → undefined, pending → the payload's
// pending spelling. [LAW:no-silent-failure] A failed lane was logged by the
// refresh that failed, its owner's (src/utils/refresh-ledger.ts), so a
// payload derived from it logs nothing again.
function over<T, U>(
  reading: Reading<T>,
  project: (value: T) => U | undefined,
): U | Pending | undefined {
  switch (reading.kind) {
    case "pending":
      return pendingOf(reading.why);
    case "failed":
    case "absent":
      return undefined;
    case "ok":
      return project(reading.value);
  }
}

const valueOf = <T>(reading: Reading<T>): T | undefined =>
  reading.kind === "ok" ? reading.value : undefined;

// [LAW:dataflow-not-control-flow] A value derived from several facts is not
// answered while any of them is not: it waits for the first that is pending,
// and says why that one is.
function firstPending(
  ...readings: ReadonlyArray<Reading<unknown>>
): Pending | undefined {
  const reading = readings.find((r) => r.kind === "pending");
  return reading?.kind === "pending" ? pendingOf(reading.why) : undefined;
}

// ─── The payload's rows ──────────────────────────────────────────────────────

// The readings a row is composed from, by the facts it names.
type RowFacts<R extends BuiltinName> = {
  readonly [K in R]: Reading<BuiltinValues[K]>;
};
// The facts some fields of a row read and the rest do not: the reading, or
// `Undeclared` when the declaration does not name it.
type PartFacts<O extends BuiltinName> = {
  readonly [K in O]: Reading<BuiltinValues[K]> | Undeclared;
};

// [LAW:types-are-the-program] One payload path a fact fills, and the facts it
// is composed from. Its composer receives exactly the facts it names, so
// reading another is a compile error: the row is both what the composition
// reads and what the walk declares for a read at its path. `parts` are facts
// only some fields below the path read, each with those fields.
interface RowReads<R extends BuiltinName, O extends BuiltinName> {
  readonly facts: readonly R[];
  readonly parts: { readonly [K in O]: readonly string[] };
}
// A row is composed in one of two phases, and the phase is its type: a turn
// row once per document, a draw row at the draw's instant, because what it
// picks out of its fact moves with the clock and no owner (today's day turns
// over at midnight). So the view's payload, which reads no instant, is made
// of turn rows alone, and a draw row cannot be asked without one.
interface TurnRow<
  R extends BuiltinName,
  O extends BuiltinName,
  V,
> extends RowReads<R, O> {
  readonly phase: "turn";
  readonly compose: (facts: RowFacts<R> & PartFacts<O>) => V;
}
interface DrawRow<R extends BuiltinName, V> extends RowReads<R, never> {
  readonly phase: "draw";
  readonly project: (facts: RowFacts<R>, at: Instant) => V;
}

const turn = <R extends BuiltinName, V, O extends BuiltinName = never>(
  facts: readonly R[],
  compose: (facts: RowFacts<R> & PartFacts<O>) => V,
  parts = {} as { readonly [K in O]: readonly string[] },
): TurnRow<R, O, V> => ({ phase: "turn", facts, parts, compose });

const draw = <R extends BuiltinName, V>(
  facts: readonly R[],
  project: (facts: RowFacts<R>, at: Instant) => V,
): DrawRow<R, V> => ({ phase: "draw", facts, parts: {}, project });

// [LAW:one-source-of-truth] Every payload path a built-in fact fills. A path
// not here is the hook's, the hints' or the renderer's own, and reads no fact.
// `tmux` and `host` are rows at their fact's leaf, because their objects carry
// a hint beside it (`tmux.pane`, `host.ssh`), which is always present.
const PAYLOAD_ROWS = {
  session: turn(["session"], ({ session }) =>
    over(session, (usage) =>
      pickNonNull({ cost: usage.session.cost, tokens: usage.session.tokens }),
    ),
  ),
  // [LAW:dataflow-not-control-flow] Absent cost/duration (provider empty)
  // yields no rate, never a fabricated one, and a rate over a value not
  // answered yet is not answered either.
  burn: turn(
    ["session", "metrics"],
    ({ session, metrics }): BurnPayload | Pending | undefined =>
      firstPending(session, metrics) ??
      burnOf(valueOf(session)?.session.cost, valueOf(metrics)?.sessionDuration),
  ),
  // [LAW:dataflow-not-control-flow] The instantaneous rates and the burn-rate
  // history fold independently from one observation — either can be present
  // without the other — and the whole key drops only when both are absent.
  speed: turn(["speed"], ({ speed }) => over(speed, speedPayloadOf)),
  cache: turn(["cache"], ({ cache }) =>
    over(cache, (expiresAt) => ({ expiresAt })),
  ),
  context: turn(["context"], ({ context }) =>
    over(context, (info) => ({
      totalTokens: info.totalTokens,
      contextLeft: info.contextLeftPercentage,
    })),
  ),
  metrics: turn(["metrics"], ({ metrics }) =>
    over(metrics, (info) =>
      pickNonNull({
        lastResponseTime: info.lastResponseTime,
        responseTime: info.responseTime,
        sessionDuration: info.sessionDuration,
        messageCount: info.messageCount,
        nonPrompts: info.nonPrompts,
        linesAdded: info.linesAdded,
        linesRemoved: info.linesRemoved,
      }),
    ),
  ),
  activity: turn(["activity"], ({ activity }) =>
    over(activity, projectActivity),
  ),
  // The controls are capped to the model's context window, so they are not
  // answered while the window is not.
  autocompact: turn(
    ["autocompact", "context"],
    ({ autocompact, context }) =>
      firstPending(context) ??
      projectAutoCompact(autocompact, valueOf(context)?.maxTokens),
  ),
  // Git logs its own failures, once per refresh that failed
  // (src/daemon/cache/git.ts): its value is stored, so logging one here would
  // repeat a failure on every render. The PR is a part of the row: its fields
  // read it, the rest of git does not.
  git: turn(
    ["git"],
    ({ git, pr }): GitPayloadOf<Unanswered> | Pending | undefined =>
      git.kind === "pending"
        ? pendingOf(git.why)
        : git.kind === "ok"
          ? projectGitInfo(git.value, pr)
          : undefined,
    { pr: Object.keys(PR_FIELDS) },
  ),
  "tmux.session": turn(["tmux"], ({ tmux }) =>
    tmux.kind === "pending" ? pendingOf(tmux.why) : valueOf(tmux)?.session,
  ),
  "host.name": turn(["hostName"], ({ hostName }) =>
    hostName.kind === "pending" ? pendingOf(hostName.why) : valueOf(hostName),
  ),
  "host.user": turn(["hostUser"], ({ hostUser }) =>
    hostUser.kind === "pending" ? pendingOf(hostUser.why) : valueOf(hostUser),
  ),
  // [LAW:one-source-of-truth] `today` at a draw's instant: the day of the
  // document's `today` fact the draw is at, a projection of the draw and never
  // of the view's payload (DRAW_PROJECTIONS, src/config/payload-inputs.ts).
  today: draw(["today"], ({ today }, at) => todayOf(today, at)),
} as const;

type Rows = typeof PAYLOAD_ROWS;
// The paths of each phase, read off the table, and a row's value: what its
// composer returns.
type TurnPath = {
  [P in keyof Rows]: Rows[P] extends { readonly phase: "turn" } ? P : never;
}[keyof Rows];
type DrawPath = Exclude<keyof Rows, TurnPath>;
type RowValue<P extends keyof Rows> = Rows[P] extends {
  readonly compose: (facts: never) => infer V;
}
  ? V
  : Rows[P] extends { readonly project: (facts: never, at: Instant) => infer V }
    ? V
    : never;

// The rows with their facts' types erased, as the walk and a document's reader
// see them: a composer over `never` accepts every row's, so no row is cast to
// be held here.
interface ErasedReads {
  readonly facts: readonly BuiltinName[];
  readonly parts: Readonly<Partial<Record<BuiltinName, readonly string[]>>>;
}
interface ErasedTurn extends ErasedReads {
  readonly compose: (facts: never) => unknown;
}
interface ErasedDraw extends ErasedReads {
  readonly project: (facts: never, at: Instant) => unknown;
}
const TURN_ROWS: Readonly<Record<TurnPath, ErasedTurn>> = PAYLOAD_ROWS;
const DRAW_ROWS: Readonly<Record<DrawPath, ErasedDraw>> = PAYLOAD_ROWS;
// Every row by its path, as the walk reads them.
const ROWS: ReadonlyArray<readonly [string, ErasedReads]> =
  Object.entries<ErasedReads>({ ...TURN_ROWS, ...DRAW_ROWS });

// The facts a row reads out of a document: each it names, or the first one
// the declaration does not; its parts, each its reading or `Undeclared`.
function rowFacts(
  document: SessionFacts,
  row: ErasedReads,
): Record<string, Reading<unknown> | Undeclared> | Undeclared {
  const facts: Record<string, Reading<unknown> | Undeclared> = {};
  for (const name of row.facts) {
    const fact = builtinOf(document, name);
    if (fact.kind === "undeclared") return fact;
    facts[name] = unstamped(fact);
  }
  for (const name of Object.keys(row.parts) as BuiltinName[]) {
    const fact = builtinOf(document, name);
    facts[name] = fact.kind === "undeclared" ? fact : unstamped(fact);
  }
  return facts;
}

// [LAW:single-enforcer] A row's value: what its composer makes of the facts it
// names, or `Undeclared` when the declaration does not name one of them — the
// gap a template's read of it surfaces (src/var-system/sources.ts).
// [LAW:types-are-the-program] `rowFacts` read exactly the facts the row names,
// which is what its composer is typed over, and the composer is the one `path`
// names: the casts in each phase are those two claims.
function composeRow<P extends TurnPath>(
  document: SessionFacts,
  path: P,
): RowValue<P> | Undeclared {
  const facts = rowFacts(document, TURN_ROWS[path]);
  return isUndeclared(facts)
    ? facts
    : (TURN_ROWS[path].compose(facts as never) as RowValue<P>);
}

function projectRow<P extends DrawPath>(
  document: SessionFacts,
  path: P,
  at: Instant,
): RowValue<P> | Undeclared {
  const facts = rowFacts(document, DRAW_ROWS[path]);
  return isUndeclared(facts)
    ? facts
    : (DRAW_ROWS[path].project(facts as never, at) as RowValue<P>);
}

// What a draw answers at its own instant from the document: the draw rows.
export interface DrawFields {
  readonly today: RowValue<"today"> | Undeclared;
}

// [LAW:one-source-of-truth] The draw rows at `at`: what the daemon's draw,
// `check` and the demo each hand their binding beside the payload.
export function projectDrawFields(
  document: SessionFacts,
  at: Instant,
): DrawFields {
  return { today: projectRow(document, "today", at) };
}

// [LAW:one-source-of-truth] The built-ins a set of payload paths reads, through
// the rows: a path at or under a row reads the row's facts, and so does a path
// above one (an input that reads all of `host` reads both of its facts); a
// part is read by a path at or under one of its fields, or at or above the
// row. The walk over a config (src/config/payload-reads.ts) supplies the
// paths, and the declaration is this set.
export function builtinsReadAt(paths: Iterable<string>): DeclaredBuiltins {
  const read = new Set<BuiltinName>();
  for (const path of paths) {
    for (const [root, row] of ROWS) {
      if (!pathUnder(root, path) && !pathUnder(path, root)) continue;
      for (const name of row.facts) read.add(name);
      for (const [name, fields] of Object.entries(row.parts) as Array<
        [BuiltinName, readonly string[]]
      >) {
        if (
          pathUnder(path, root) ||
          fields.some((field) => pathUnder(`${root}.${field}`, path))
        ) {
          read.add(name);
        }
      }
    }
  }
  return declaredBuiltins(read);
}

// What a payload is composed from besides the document: the hook's
// instantaneous fields, the client's hints and the user's home.
export type ComposeInputs = Pick<PayloadInputs, "hookData" | "hints"> & {
  readonly home: string;
};

// [LAW:one-source-of-truth] The one assembly of a view's payload: the facts
// document as its owners held it when it was stamped, a value not answered yet
// as pending — which the draw takes as its own outcome (the placement's
// loading cell) — and a value no declared fact fills as `Undeclared`. Performs
// no I/O, refreshes nothing and reads no instant, so the session's view keeps
// it as one computed over its turn (src/daemon/session-source.ts), and `check`
// composes its fixture document through it.
export function composePayload(
  facts: SessionFacts,
  inputs: ComposeInputs,
  draw: DrawInputs,
): ViewPayload {
  const { hookData, hints } = inputs;
  const { effective, configFacts } = draw;
  const { configPath, ...settingCounts } = configFacts;
  const row = <P extends TurnPath>(path: P) => composeRow(facts, path);
  const tmuxPane = hints.tmux ?? null;
  const tmuxValue = row("tmux.session");
  const hostName = row("host.name");
  const hostUser = row("host.user");
  const git = row("git");
  const sessionPayload = row("session");
  const burn = row("burn");
  const speedPayload = row("speed");
  const cachePayload = row("cache");
  const contextPayload = row("context");
  const metricsPayload = row("metrics");
  const activityPayload = row("activity");
  const autoCompactValue = row("autocompact");
  // [LAW:dataflow-not-control-flow] block.* and weekly.* read straight from
  // hookData's rate-limit windows; what they say relative to now is the
  // draw's (BlockPayload).
  const fiveHour = hookData.rate_limits?.five_hour;
  const sevenDay = hookData.rate_limits?.seven_day;
  // home is always available — the host's value, no I/O cost.
  // Letting the gate skip it would add a branch with no win.
  // [LAW:single-enforcer] All path-shaped payload fields are normalized
  // to forward-slash separators at this boundary. The DSL's directory
  // template (and any user template that does prefix/relative-path math)
  // assumes POSIX separators; without normalization, Windows hookData
  // (current_dir = "C:\Users\Alice") would never match a forward-slash
  // home prefix. Normalize *here*, not in the template — keeps DSL
  // templates platform-agnostic by construction.
  const home = posixify(inputs.home);
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
    // are those exact values: each costs nothing (already in hand) and a config
    // reading e.g. `.padding.effective` must always find it.
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
    ...(fiveHour !== undefined && {
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
    ...projectSources(Object.keys(facts.sources), (name) => {
      const reading = unstamped(facts.sources[name]!);
      return reading.kind === "pending" ? pendingOf(reading.why) : reading;
    }),
  };
  return payload;
}

// [LAW:nothing-unseen] The render event's `builtins=`: the built-ins the view's
// document holds, which are the ones its renderer declared, in the document's
// order; `-` for none. A lane left out on purpose is told from one that never
// ran by this field alone.
export function builtinsFact(builtins: Iterable<string>): string {
  return [...builtins].join(",") || "-";
}

// [LAW:nothing-unseen] The render event's `sources=` and `sourcesPending=`:
// how many plugin sources the view declared, and those not answered yet as
// the draw reads them, each with why (`<name>:unread` or `<name>:superseded`;
// `-` for none), so a source that never lands is told from one nothing
// declared, and a run's superseded source from a wait that left one out.
export function sourcesFactOf(
  sources: Readonly<Record<string, Fact<SourceValue>>>,
): {
  readonly sources: string;
  readonly sourcesPending: string;
} {
  const named = Object.entries(sources);
  return {
    sources: String(named.length),
    sourcesPending:
      named
        .flatMap(([name, fact]) =>
          fact.kind === "pending" ? [`${name}:${fact.why}`] : [],
        )
        .join(",") || "-",
  };
}

// [LAW:nothing-unseen] The render event's `runs=` and `runsPending=`: how
// many `shell` and `file` runs the view declared, and those not answered yet
// as the draw reads them, by short digest with why (`-` for none), so a run
// that never lands is told from one nothing declared. A run's source events
// name the same short digest.
export function runsFactOf(runs: Readonly<Record<string, RunFact>>): {
  readonly runs: string;
  readonly runsPending: string;
} {
  const declared = Object.entries(runs);
  return {
    runs: String(declared.length),
    runsPending:
      declared
        .flatMap(([digest, { reading }]) =>
          reading.kind === "pending"
            ? [`${shortDigest(digest)}:${reading.why}`]
            : [],
        )
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

// The today row's projector (PAYLOAD_ROWS): the day of the `today` fact the
// draw is at. A failed scan or ingest is logged by its owner, the usage store.
export function todayOf(
  fact: Reading<TodayFacts>,
  at: Instant,
): TodayPayload | Pending | undefined {
  if (fact.kind === "pending") return pendingOf(fact.why);
  if (fact.kind !== "ok") return undefined;
  const today = projectToday(fact.value, at);
  return today.kind === "ok"
    ? { cost: today.value.cost, tokens: today.value.tokens }
    : undefined;
}

// A statusline request's wait (rule 1 of the model): it refreshes what its
// arrival triggers, then waits for the first value of the keyed lanes its
// view declared that have not answered yet (`waitsOf`). The answer is then drawn from the
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
  outcome: Reading<AutoCompactWindow>,
  contextWindow: number | undefined,
): AutoCompactPayload | Pending | undefined {
  switch (outcome.kind) {
    case "pending":
      return pendingOf(outcome.why);
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
function projectGitInfo(
  info: DocumentGitFacts,
  pullRequest: Reading<PullRequest> | Undeclared,
): GitPayloadOf<Unanswered> {
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
  // waits at its width while the rest of git draws as it stands. A PR the
  // declaration does not name is every PR field undeclared, the same way.
  const pr = isUnanswered(pullRequest)
    ? pullRequest
    : prOfHead(pullRequest, info.head);
  let prFields: PrPayload | PrPendingOf<Unanswered> = {};
  switch (pr.kind) {
    case "pending":
    case "undeclared": {
      const p = pr.kind === "pending" ? pendingOf(pr.why) : pr;
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
