import type { Timekeeper } from "../time.js";
import type { FileEventDelivery } from "./cache/file-events";
import type { RenderCache } from "./cache/render";
import type { WatcherRegistry } from "./cache/watchers";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import type { FrameFeeds } from "./frame-feed.js";
import type { LaneSetups } from "./lane-setup.js";
import type { LimitsHandle } from "./limits";
import type { LinkSigner } from "../click/link-signer.js";
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

// [LAW:one-source-of-truth] What one daemon holds, built once by `createDaemon`
// (src/daemon/daemon.ts) and read by the request handling, which keeps none of
// its own.
export interface DaemonParts {
  // The user's home: the default Claude Code directory is under it.
  readonly home: string;
  // The temporary directory a click's handoff writes under.
  readonly tmp: string;
  readonly clock: Timekeeper;
  readonly launcher: Launcher;
  readonly log: DaemonLogger;
  readonly bundle: string;
  readonly sourceDigest: string | null;
  readonly doctorStores: DoctorStores;
  readonly stats: RuntimeStats;
  readonly handlerProbes: ProbeArrivals;
  readonly renderSightings: RenderSightings;
  readonly watcherRegistry: WatcherRegistry;
  readonly refreshLedger: RefreshLedger;
  readonly fileEvents: FileEventDelivery;
  readonly payloadProviders: PayloadProviders;
  // [LAW:single-enforcer] What the request and click paths write session
  // state through, and read it through: the store's view the daemon was
  // built with, which under test refuses a write made while no journal turn
  // is held (test/helpers/writes-in-turn.ts).
  readonly sessionState: SessionStateRW;
  // The store's gauges, for the stats reply.
  readonly sessionGauges: Pick<
    SessionState,
    "size" | "observers" | "latestRevision"
  >;
  // [LAW:one-source-of-truth] This renderer's name, as every record of its
  // work and the tmux rows it draws carry it.
  readonly rendererName: string;
  // The draw a request's arm reaches once its turn is over.
  readonly draw: RequestDraw;
  readonly effectSessions: EffectSessions<RenderedLine>;
  readonly menuIdle: MenuIdle;
  readonly linkSigner: LinkSigner;
  readonly runs: Runs;
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs, which the stats reply reads.
  readonly sourceRuns: SourceRuns;
  readonly laneSetups: LaneSetups;
  readonly tmuxStatusLines: TmuxStatusLines;
  readonly frameFeeds: FrameFeeds<CheckedRenderRequest>;
  readonly renderWarnings: RenderWarningRecords;
  readonly renderCache: RenderCache<SessionSource, CheckedRenderRequest>;
  // The sessions' recordings, over the render cache's views
  // (src/daemon/session-recorder.ts).
  readonly recorder: SessionRecorder;
  readonly updateWatch: UpdateWatch;
  readonly limits: LimitsHandle;
  readonly journalTurns: Pick<JournalTurns, "getStats">;
  readonly verbCtx: Omit<VerbContext, "arrival" | "asker" | "described">;
}
