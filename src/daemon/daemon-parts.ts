import type { Timekeeper } from "../time.js";
import type { FileEventDelivery } from "./cache/file-events";
import type { RenderCache } from "./cache/render";
import type { WatcherRegistry } from "./cache/watchers";
import type { CheckedRenderRequest } from "../renderer/request-context.js";
import type { FrameFeeds } from "./frame-feed.js";
import type { LaneSetups } from "./lane-setup.js";
import type { LimitsHandle } from "./limits";
import type { LinkSigner } from "../click/link-signer.js";
import type { MenuIdle } from "./menu-idle.js";
import type { PayloadProviders } from "./payload-providers";
import type { RenderSightings } from "./render-sightings";
import type { RenderWarningRecords } from "./render-warnings.js";
import type { Runs } from "./runs.js";
import type { SourceRuns } from "../var-system/source-runs.js";
import type { RuntimeStats } from "./stats";
import type { SessionSource } from "./session-source.js";
import type { SessionState } from "./session-state";
import type { TmuxStatusLines } from "./tmux-status.js";
import type { UpdateWatch } from "./update-notice";
import type { VerbContext } from "./verbs";
import type { DoctorStores } from "../doctor/edge";
import type { JournalTurns } from "./journal-turns";
import type { RendererHost } from "./renderer-host.js";
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
  readonly sessionState: SessionState;
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
  readonly updateWatch: UpdateWatch;
  readonly limits: LimitsHandle;
  readonly journalTurns: Pick<JournalTurns, "getStats">;
  // The host's one path to the main renderer (src/daemon/renderer-host.ts).
  readonly renderer: RendererHost;
  readonly verbCtx: Omit<
    VerbContext,
    "arrival" | "placeWaited" | "gatherTook" | "turnWaited" | "clientGone"
  >;
}
