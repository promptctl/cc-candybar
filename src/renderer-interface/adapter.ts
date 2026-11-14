// [LAW:one-way-deps] The adapter: every reach between the renderer and the
// host, as two interfaces spelled in shared types. The host's parts satisfy
// `AdapterToHost` structurally where it calls the renderer's start, so no
// renderer file names a host type, and the start's return satisfies
// `AdapterToRenderer` the same way. Each entry is a reach a later step removes:
// in process it is a call nobody counts, so the list is what shows the work
// left.

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

export interface JournalTurn {
  // Names the commit `close` runs if the turn is cut off, and answers the one
  // way to run it: true when this call committed, false when `close` already
  // had and the turn is over.
  readonly holds: (commit: () => void) => () => boolean;
  // [LAW:single-enforcer] Where a handler resumes: what follows an await runs
  // only if the turn outlived it, so a click `close` cut off writes nothing
  // more, whichever store it would have reached. `p` settling either way
  // counts: a launch the close aborted rejects.
  readonly landed: <T>(p: Promise<T>) => Promise<T>;
}

// How a click asks for its turn: `waited` hears how many ms it took to come,
// and `gone` says whether whoever asked has left.
export interface TurnAsker {
  readonly waited: (ms: number) => void;
  readonly gone: () => boolean;
}

// The same, for a click that may gather first: `placed` hears how long it
// waited behind its session's earlier clicks, `gathered` how long it took.
export interface ClickAsker extends TurnAsker {
  readonly placed: (ms: number) => void;
  readonly gathered: (ms: number) => void;
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
  // Records what the frame's copy clicks copy, once it went out to a follower.
  readonly delivered: () => void;
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
  // [LAW:effects-at-boundaries] exception: the one queue every journal waits
  // its turn in.
  readonly journalTurns: {
    take<T>(
      verb: string,
      asker: TurnAsker,
      body: (turn: JournalTurn) => Promise<T>,
    ): Promise<T>;
    click<G, T>(
      verb: string,
      session: string | null,
      asker: ClickAsker,
      gather: () => Promise<G>,
      body: (gathering: G, turn: JournalTurn) => Promise<T>,
    ): Promise<T>;
    gathering<G>(gather: () => Promise<G>): Promise<G>;
  };
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

export interface ExplicitLoad {
  readonly kind: "write" | "doctor";
}

// What the host reaches in the renderer, returned by its start beside
// `answer`. Each member keeps its in-process shape.
export interface AdapterToRenderer {
  // [LAW:effects-at-boundaries] exception: the feed's draw of one frame of a
  // subscribed session, null while the session has no view.
  renderFrame(sessionId: SessionId, fps: number, at: Instant): FeedFrame | null;
  // [LAW:effects-at-boundaries] exception: the lanes the session's view
  // switches on, null while it has no view.
  viewLanes(sessionId: SessionId): LaneSwitches | null;
  // [LAW:effects-at-boundaries] exception: the feed's pin on the session's
  // view; releasing it retires what the feed drew.
  pin(sessionId: SessionId): () => void;
  // [LAW:effects-at-boundaries] exception: the session's state revision, which
  // the feed's watch reacts to.
  revision(sessionId: SessionId): number;
  // [LAW:effects-at-boundaries] exception: the stats reply's reads of the
  // renderer's state.
  stats(): RendererStats;
  // [LAW:effects-at-boundaries] exception: the debug reply's projection of
  // the most recently drawn view.
  debug(what: DebugWhat): DebugSnapshot;
  // [LAW:effects-at-boundaries] exception: a host part's write of a click
  // error into the session's state: a run's end, a lane setup's failure.
  holdClickError(sessionId: SessionId, text: string, at: Instant): void;
  // [LAW:effects-at-boundaries] exception: every entry's reload, when file
  // events resume.
  reloadEvery(cause: EveryEntryLoad): void;
  // [LAW:effects-at-boundaries] exception: the reload of the config `origin`
  // resolves to, after a write.
  reloadConfig(origin: RenderOrigin): void;
  // [LAW:effects-at-boundaries] exception: the daemon's close of the
  // renderer's views, and of its session state, which flushes it: two steps of
  // its teardown, the session state last.
  closeViews(): void;
  closeSessionState(): void;
}

// What the stats reply reads of the renderer's state.
export interface RendererStats {
  readonly renderCache: RenderCacheStats;
  readonly effectCache: StatsSnapshot["effectCache"];
  readonly sessionState: StatsSnapshot["sessionState"];
}
