// [LAW:one-way-deps] The adapter: every reach between the renderer and the
// host, spelled in shared types. The host's parts satisfy `AdapterToHost`
// structurally where it calls the renderer's start, so no renderer file names
// a host type. The host reaches the renderer only by an `AdapterPush`, plain
// data a process can carry, answered by its `AdapterReply`. Each entry is a
// reach a later step removes: in process it is a call nobody counts, so the
// list is what shows the work left.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { DiagnosticMessage, SourcedText } from "../render/diagnostics";
import type { ClientHints, Response } from "../daemon/foundations/protocol.js";
import type { RenderOrigin } from "../config-hint.js";
import type { Answered } from "../daemon/foundations/sighting-roles.js";
import type { StorageKey, RequestId } from "./interface.js";
import type { Frame } from "../render/frame";
import type { Instant } from "../utils/instant.js";
import type { Release } from "../utils/holds.js";
import type { Lane, LaneFeeds, LaneSwitches } from "../config/lanes.js";
import type { Crosses } from "./crosses.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { ClientHint } from "../client-hint.js";
import type { Launcher } from "../proc/launcher.js";
import type { LinkSigner } from "../click/link-signer.js";
import type {
  CheckedRenderRequest,
  Refreshed,
  ViewFacts,
} from "./request-context.js";
import type {
  Delivery,
  ProbeArrival,
  RenderCacheStats,
  StatsSnapshot,
  StoresRead,
} from "../daemon/foundations/stats-snapshot.js";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types.js";
import type { ServingDaemon } from "../daemon/foundations/memory-limit.js";
import type {
  RateLimitsSeen,
  RenderSighting,
  TranscriptSaid,
} from "../daemon/foundations/sightings.js";
import type {
  HeldWatch,
  Invalidation,
  WatchMove,
  WatchSpec,
  WatchTargets,
  WatcherHandle,
} from "../daemon/foundations/watch-targets.js";
import type { SightedBar, SightingScope } from "../doctor/sightings.js";
import type {
  Asked,
  DoctorFacts,
  Fix,
  InstallFacts,
  Width,
} from "../doctor/checks.js";
import type { DoctorEdge, DoctorStores, InstallEdge } from "../doctor/ports.js";
import type { ClaudeInputEdge } from "../claude-input/typing.js";

// The per-session facts the notice reads: whose clicks these are, what this
// session dismissed (the identity it wrote, or nothing), and whether the
// session's config allows the notice at all (Globals.updateNotice).
export interface NoticeContext {
  readonly sessionId: SessionId;
  readonly dismissed: string | null;
  readonly enabled: boolean;
}

// What one update tells a session: the offer, an info message whose line is
// the sentence and the three affordances, and the failure of the last act on
// it, a plain warning of its own. They are two messages because they are two
// levels: the offer is nothing going wrong, a failed click is
// [LAW:no-silent-failure].
// [LAW:types-are-the-program] At most one of each, and no failure without its
// offer: a failure with nothing to retry is unrepresentable.
export type UpdateNotice =
  | { readonly offer: readonly []; readonly failure: readonly [] }
  | {
      readonly offer: readonly [DiagnosticMessage];
      readonly failure: readonly [] | readonly [SourcedText];
    };

export interface LaneSession {
  readonly sessionId: SessionId;
  readonly hints: ClientHints;
  // The inputs its last render resolved its config from.
  readonly origin: RenderOrigin;
  // Its conversation, as Claude Code names it in the statusline JSON: a
  // session resumes from it, and has none until its first message.
  readonly transcript: string;
  // Whether Claude Code has answered in it, by the one mark it leaves
  // (`answeredOf`): a session it has answered in has a conversation, whether
  // or not a transcript of it is on disk.
  readonly answered: Answered;
}

// A source a run makes stale: its full name, for the event, and its file's key
// in the storage owner.
export interface RunRefresh {
  readonly name: string;
  readonly storage: StorageKey;
}

// [LAW:types-are-the-program] One run, as the verb hands it over: everything
// was settled at the click — the program and its arguments as the draw
// evaluated them, the environment, the directory, the sources it refreshes —
// so the owner decides nothing about what runs.
export interface RunRequest {
  readonly sessionId: SessionId;
  readonly action: string;
  readonly argv: readonly [string, ...string[]];
  // Set over the owner's launcher's inherited environment.
  readonly envOverlay: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly refreshes: readonly RunRefresh[];
}

// What one frame of the feed drew: the bar, the responses its subscribers
// receive, and — for a render that threw — the render event describing it,
// logged when that failure is first pushed. It is drawn for the feed
// (`drawing.by` "feed"), so it shows the feed's ceiling where a render
// request's answer shows that it is polled.
// [LAW:decomposition] A frame says only what was drawn. Whether anyone can see
// it is the feed's question, asked when it schedules the next.
// A frame's two answers: `resp`, which a lane drawing the bar elsewhere is sent,
// and `statusline`, what Claude Code's statusline shows — the bar, or the
// handoff line in its place while a lane draws it elsewhere
// (src/renderer/lane-handoff.ts).
export interface FeedFrame {
  // [LAW:types-are-the-program] Every frame has a bar: one that failed draws
  // its diagnostic Frame, so a lane holds no failure branch. Its `nextChange`
  // is when the feed draws next, within its spacing.
  readonly bar: Frame;
  readonly resp: Response;
  readonly statusline: Response;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // How many strip items dividing cells too wide for a line added.
  readonly cellBreaks: number;
  // The lanes the session's settings switched on as it drew, which the feed's
  // lane gate reads as the frame goes out: null for a frame that failed,
  // which read no settings and so ends no lane.
  readonly lanes: LaneSwitches | null;
  readonly failure: LogLine | null;
}

export type Level = "info" | "warn" | "error";

export interface LogLine {
  readonly level: Level;
  readonly line: string;
}

// A cache's tally, as the render event's debug facts show it.
export interface CacheTally {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
}

// The doctor's world probes: the machine, the settings files and the stores,
// each over the edge it is handed.
export interface DoctorProbes {
  readonly gatherFacts: (
    edge: DoctorEdge,
    hints: Pick<
      ClientHints,
      "tmux" | "claudeConfigDir" | "terminalEnv" | "ssh"
    >,
    origin: RenderOrigin,
    sessionPick: (key: string) => string | null,
    serving: Asked<ServingDaemon>,
    rateLimits: Asked<readonly RateLimitsSeen[]>,
    transcripts: Asked<readonly TranscriptSaid[]>,
    sighted: SightingScope,
    bars: Asked<readonly SightedBar[]>,
    width: Asked<Width>,
    stores: StoresRead,
  ) => Promise<Omit<DoctorFacts, "urlHandler" | "install">>;
  readonly applyFix: (
    stores: DoctorStores,
    fix: Fix,
    facts: DoctorFacts,
  ) => Asked<DoctorFacts>;
  readonly installFacts: (
    edge: InstallEdge,
    daemonBundle: string,
    clients: ReadonlyArray<ClientHint | null>,
  ) => InstallFacts;
  readonly readStores: (stores: DoctorStores) => StoresRead;
  readonly oneAskPerClick: (edge: DoctorEdge) => DoctorEdge;
}

// What the renderer reaches in the host, handed in at its start. Each member
// keeps its in-process shape: the methods the renderer calls on a host part.
export interface AdapterToHost {
  // [LAW:effects-at-boundaries] exception: the feeds' subscribers, which lanes
  // follow a session and the request each feed draws from.
  readonly frameFeeds: {
    following(sessionId: SessionId): ReadonlySet<Lane>;
    latest(sessionId: SessionId): CheckedRenderRequest | null;
    feedsOf(sessionId: SessionId, at: Instant): LaneFeeds;
    wake(sessionId: SessionId, cause: WakeCause): void;
  };
  // [LAW:effects-at-boundaries] exception: the update watch's notice and the
  // failure of its last act.
  readonly updateWatch: {
    notice(ctx: NoticeContext): UpdateNotice;
    error(): string | null;
  };
  // [LAW:effects-at-boundaries] exception: whether file events are heard.
  readonly fileEvents: { delivery(): Delivery };
  // [LAW:effects-at-boundaries] exception: each session's idle clock and the
  // timer that closes its menus.
  readonly menuIdle: {
    clicked(sessionId: SessionId, at: Instant): void;
    clickArrived(sessionId: SessionId): void;
    clickSettled(sessionId: SessionId): void;
    since(sessionId: SessionId, at: Instant): Instant | undefined;
    observe(
      sessionId: SessionId,
      at: Instant,
      shown: boolean,
      timeoutS: number,
    ): void;
    confirmClose(sessionId: SessionId, firedAt: Instant): boolean;
  };
  // [LAW:effects-at-boundaries] exception: the launcher a click's programs
  // run through, and the warnings it holds.
  readonly launcher: Launcher;
  // [LAW:effects-at-boundaries] exception: what turning an animation lane on
  // or off takes.
  readonly laneSetups: {
    noted(session: LaneSession, switches: LaneSwitches): void;
    clicked(
      sessionId: SessionId,
      session: LaneSession | null,
      before: LaneSwitches,
      after: LaneSwitches,
    ): void;
  };
  // [LAW:effects-at-boundaries] exception: the tmux status lines this daemon
  // lays out.
  readonly tmuxStatusLines: {
    observe(
      sessionId: SessionId,
      tmux: TmuxHint | null | undefined,
      on: boolean,
    ): void;
  };
  // [LAW:effects-at-boundaries] exception: whether a click's client has left.
  readonly clicks: { gone(click: RequestId): boolean };
  // [LAW:effects-at-boundaries] exception: the providers' refresh a request's
  // arrival triggers, which `refreshed` records lane by lane.
  readonly refresh: (
    facts: ViewFacts,
    at: Instant,
    refreshed: Refreshed,
  ) => Promise<void>;
  // [LAW:effects-at-boundaries] exception: the repository and usage caches'
  // tallies.
  readonly cacheTallies: () => {
    readonly git: CacheTally;
    readonly usage: CacheTally;
  };
  // [LAW:effects-at-boundaries] exception: the owner of every plugin's
  // session files, which a config's sources are keyed and watched in.
  readonly managedStorage: {
    keyFor(folder: string): StorageKey;
    watch(key: StorageKey): Release;
  };
  // [LAW:effects-at-boundaries] exception: the daemon's one watcher registry.
  readonly watchers: {
    acquire(
      key: string,
      targets: WatchTargets,
      onInvalidate: (invalidation: Invalidation) => void,
    ): WatcherHandle;
    follow(
      held: HeldWatch | null,
      spec: WatchSpec,
      onInvalidate: (invalidation: Invalidation) => void,
    ): { readonly watch: HeldWatch; readonly move: WatchMove };
  };
  // [LAW:effects-at-boundaries] exception: the signer over the state
  // directory's key.
  readonly linkSigner: LinkSigner;
  // [LAW:effects-at-boundaries] exception: the one owner of `run` programs in
  // flight.
  readonly runs: {
    start(run: RunRequest): void;
    refused(sessionId: string, action: string, reason: string): void;
  };
  // [LAW:effects-at-boundaries] exception: this daemon as the doctor's daemon
  // row judges it.
  readonly serving: () => ServingDaemon;
  // [LAW:effects-at-boundaries] exception: which client drew each session's
  // bar, as this process saw it render.
  readonly renderSightings: {
    ofSession(sessionId: SessionId, now: Instant): readonly RenderSighting[];
  };
  // [LAW:effects-at-boundaries] exception: where a `doctor-probe` link
  // records that it arrived.
  readonly probes: { arrive(arrival: ProbeArrival): void };
  // [LAW:effects-at-boundaries] exception: the doctor's world probes, its
  // reads of the machine over the config load the renderer hands it (the load
  // its bar is drawn from), and its stores, which the host files.
  readonly doctor: DoctorProbes & {
    readonly edge: (loadConfig: DoctorEdge["loadConfig"]) => DoctorEdge;
    readonly stores: DoctorStores;
  };
  // [LAW:effects-at-boundaries] exception: the tmux pane read and the typing
  // of a slash line.
  readonly claudeInput: ClaudeInputEdge;
  // [LAW:effects-at-boundaries] exception: the update notice's act.
  readonly applyUpdate: () => Promise<void>;
}

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), or which panes are on a screen changed (`visibility`).
export const WAKE_CAUSES = ["data", "state", "reload", "visibility"] as const;

export type WakeCause = (typeof WAKE_CAUSES)[number];

// What reloads every entry at once: the answers on disk moved, or file events
// resumed after a span in which an edit may have gone unheard.
export type EveryEntryLoad =
  | { readonly kind: "answers-watch"; readonly heard: Invalidation }
  | { readonly kind: "events-resumed"; readonly since: number };

// [LAW:effects-at-boundaries] exception: what the host reaches in the
// renderer, each a push it hands in as an `adapter` input
// (src/renderer-interface/interface.ts), answered by a reply of its own kind.
// The list is the work left: each later step deletes an arm.
export type AdapterPush =
  // The feed's draw of one frame of a subscribed session, with the lanes that
  // follow it and draw it now, and what each lane was sent of late.
  | {
      readonly kind: "frame";
      readonly session: SessionId;
      readonly fps: number;
      readonly following: readonly Lane[];
      readonly feeds: LaneFeeds;
    }
  // The lanes the session's view switches on, which a subscribe is gated by.
  | { readonly kind: "lanes"; readonly session: SessionId }
  // The feed's pin on the session's view, from its open to its close.
  | { readonly kind: "pin"; readonly session: SessionId }
  | { readonly kind: "unpin"; readonly session: SessionId }
  // The stats reply's reads of the renderer's state.
  | { readonly kind: "stats" }
  // The debug reply's projection of the most recently drawn view.
  | { readonly kind: "debug"; readonly what: DebugWhat }
  // A host part's write of a click error into the session's state, at the
  // input's instant: a run's end, a lane setup's failure.
  | {
      readonly kind: "hold-click-error";
      readonly session: SessionId;
      readonly text: string;
    }
  // Every entry's reload, when file events resume after `since`.
  | { readonly kind: "reload-every"; readonly since: number }
  // The reload of the config `origin` resolves to, after a write.
  | { readonly kind: "reload-config"; readonly origin: RenderOrigin }
  // The daemon's teardown, in its three renderer steps: the journal in flight
  // commits, the views close, and the session state flushes, last.
  | { readonly kind: "close-journal" }
  | { readonly kind: "close-views" }
  | { readonly kind: "close-session-state" };

// The kinds of push whose reply carries data.
type ReadingPush = "frame" | "lanes" | "stats" | "debug";

// What each push answers, of its own kind: what it read, or nothing.
export type AdapterReply =
  // Null while the session has no view.
  | { readonly kind: "frame"; readonly frame: FeedFrame | null }
  // Null while the session has no view.
  | { readonly kind: "lanes"; readonly lanes: LaneSwitches | null }
  | { readonly kind: "stats"; readonly stats: RendererStats }
  | { readonly kind: "debug"; readonly snapshot: DebugSnapshot }
  | { readonly kind: Exclude<AdapterPush["kind"], ReadingPush> };

// The reply a push of kind `K` answers.
export type ReplyTo<K extends AdapterPush["kind"]> = K extends ReadingPush
  ? Extract<AdapterReply, { readonly kind: K }>
  : { readonly kind: K };

// [LAW:types-are-the-program] Every push and reply is plain data: the build
// fails on one a process could not carry, naming where it fails.
export const PUSHES_CROSS: Crosses<AdapterPush> = true;
export const REPLIES_CROSS: Crosses<AdapterReply> = true;

// What the stats reply reads of the renderer's state.
export interface RendererStats {
  readonly renderCache: RenderCacheStats;
  readonly effectCache: StatsSnapshot["effectCache"];
  readonly sessionState: StatsSnapshot["sessionState"];
  readonly journalTurns: StatsSnapshot["journalTurns"];
}
