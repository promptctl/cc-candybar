import type { Timekeeper } from "../time.js";
import type { FileEventDelivery } from "./cache/file-events";
import type { GitEnvAsk } from "../git-env";
import type { RenderCache } from "./cache/render";
import type { WatcherRegistry } from "./cache/watchers";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import type { FrameFeeds } from "./frame-feed.js";
import type { LaneSetups } from "./lane-setup.js";
import type { LinkIdAllocator } from "./link-id-allocator.js";
import type { LimitsHandle } from "./limits";
import type { RendererLinks } from "../click/renderer-links.js";
import type { MenuIdle } from "./menu-idle.js";
import type { PayloadProviders } from "./payload-providers";
import type { RenderSightings } from "./render-sightings";
import type { SessionRecorder } from "./session-recorder.js";
import type { RenderWarningRecords } from "./render-warnings.js";
import type { Runs } from "./runs.js";
import type { SourceRuns } from "../var-system/source-runs.js";
import type { RuntimeStats } from "./stats";
import type { SessionSource } from "./session-source.js";
import type { SessionState, SessionStateRW } from "./session-state";
import type { RequestDraw } from "./draw-bar.js";
import type { TmuxStatusLines } from "./tmux-status.js";
import type { UpdateWatch } from "./update-notice";
import type { VerbContext } from "./verbs";
import type { DoctorStores } from "../doctor/edge";
import type { JournalTurns } from "./journal-turns";
import type { ProbeArrivals } from "../doctor/handler-probe";
import type { RefreshLedger } from "../utils/refresh-ledger";
import type { DaemonLogger } from "../utils/logger";
import type { Launcher } from "../proc/launch";
import type { EffectSessions } from "../render/effect.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { StoredRoot } from "./foundations/stored-path";
import type { MismatchRuns } from "./mismatch-runs.js";
import type { HeldSessionOf } from "./session-pane.js";

// [LAW:one-source-of-truth] What one daemon holds, built once by `createDaemon`
// (src/daemon/daemon.ts) and read by the request handling, which keeps none of
// its own.
export interface DaemonParts {
  // The user's home: the default Claude Code directory is under it.
  readonly home: string;
  // The directory a stored home path is relative to (paths.ts storedRoot): a
  // requested config file in the home is spelled from it.
  readonly storedRoot: StoredRoot;
  // The temporary directory a click's handoff writes under.
  readonly tmp: string;
  // The session a Claude Code process holds, by its own record: what makes a
  // request's session the one its tmux pane runs.
  readonly heldSession: HeldSessionOf;
  readonly clock: Timekeeper;
  readonly launcher: Launcher;
  readonly log: DaemonLogger;
  readonly bundle: string;
  readonly sourceDigest: string | null;
  readonly doctorStores: DoctorStores;
  readonly stats: RuntimeStats;
  readonly handlerProbes: ProbeArrivals;
  readonly renderSightings: RenderSightings;
  // Each session's run of mismatched pane stamps: the request arm writes it,
  // through the verb context's same instance, and the draw reads its verdict.
  readonly mismatchRuns: MismatchRuns;
  readonly watcherRegistry: WatcherRegistry;
  readonly refreshLedger: RefreshLedger;
  readonly fileEvents: FileEventDelivery;
  // Whether git named the variables the daemon's environment was cleaned of:
  // a failed ask is every bar's ⚠.
  readonly gitEnv: GitEnvAsk;
  readonly payloadProviders: PayloadProviders;
  // [LAW:single-enforcer] The daemon's one store of session state, which
  // refuses a write made while no journal turn is held: what the request and
  // click paths read and write, and its gauges for the stats reply. Its
  // close is the daemon's own.
  readonly sessionState: SessionStateRW &
    Pick<SessionState, "size" | "observers" | "latestRevision">;
  // [LAW:one-source-of-truth] This renderer's name, as every record of its
  // work and the tmux rows it draws carry it.
  readonly rendererName: string;
  // The draw a request's arm reaches once its turn is over.
  readonly draw: RequestDraw;
  readonly effectSessions: EffectSessions<RenderedLine>;
  readonly menuIdle: MenuIdle;
  // Whose links this daemon draws and verifies: its home's name and its key.
  readonly links: RendererLinks;
  readonly runs: Runs;
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs, which the stats reply reads.
  readonly sourceRuns: SourceRuns;
  readonly laneSetups: LaneSetups;
  readonly tmuxStatusLines: TmuxStatusLines;
  readonly frameFeeds: FrameFeeds<CheckedRenderRequest>;
  // The home's link-id counter: its fault is every bar's ⚠, and its counts are
  // the stats reply's.
  readonly linkIds: LinkIdAllocator;
  readonly renderWarnings: RenderWarningRecords;
  readonly renderCache: RenderCache<SessionSource, CheckedRenderRequest>;
  // The sessions' recordings, over the render cache's views
  // (src/daemon/session-recorder.ts).
  readonly recorder: SessionRecorder;
  readonly updateWatch: UpdateWatch;
  readonly limits: LimitsHandle;
  readonly journalTurns: Pick<JournalTurns, "getStats">;
  readonly verbCtx: Omit<VerbContext, "arrival" | "gone" | "described">;
}
