import type { Collector } from "./collector.js";
import type { Timekeeper } from "../time.js";
import type { FileEventDelivery } from "./cache/file-events";
import type { WatcherRegistry } from "./cache/watchers";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { FrameFeeds } from "./frame-feed.js";
import type { LaneSetups } from "./lane-setup.js";
import type { LimitsHandle } from "./limits";
import type { MenuIdle } from "./menu-idle.js";
import type { RenderPayloadDeps } from "./readings";
import type { RenderSightings } from "./render-sightings";
import type { Runs } from "./runs.js";
import type { SourceRuns } from "./source-runs.js";
import type { RuntimeStats } from "./stats";
import type { TmuxStatusLines } from "./tmux-status.js";
import type { UpdateWatch } from "./update-notice";
import type { DoctorStores } from "../doctor/ports";
import type { RendererHost } from "./renderer-host.js";
import type { ClicksInFlight } from "./clicks-in-flight.js";
import type { ProbeArrivals } from "../doctor/handler-probe";
import type { RefreshLedger } from "../utils/refresh-ledger";
import type { DaemonLogger } from "../utils/logger";
import type { Launcher } from "../proc/launcher";
import type { LinkSigner } from "../click/link-signer";

// [LAW:one-source-of-truth] What one daemon holds, built once by `createDaemon`
// (src/daemon/daemon.ts) and read by the request handling, which keeps none of
// its own.
export interface DaemonParts {
  // The user's home: the default Claude Code directory is under it.
  readonly home: string;
  // The temporary directory a click's handoff writes under.
  readonly tmp: string;
  readonly clock: Timekeeper;
  // [LAW:single-enforcer] The one verifier of every click's link.
  readonly links: LinkSigner;
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
  readonly payloadProviders: RenderPayloadDeps;
  readonly menuIdle: MenuIdle;
  readonly runs: Runs;
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs, which the stats reply reads.
  readonly sourceRuns: SourceRuns;
  readonly laneSetups: LaneSetups;
  readonly tmuxStatusLines: TmuxStatusLines;
  readonly frameFeeds: FrameFeeds<CheckedRenderRequest>;
  readonly updateWatch: UpdateWatch;
  readonly limits: LimitsHandle;
  // The host's one path to the main renderer (src/daemon/renderer-host.ts).
  readonly renderer: RendererHost;
  // The clicks whose turns run, and whether each one's client has left.
  readonly clicks: ClicksInFlight;
  // [LAW:single-enforcer] The host's one reader of every session's world
  // (src/daemon/collector.ts).
  readonly collector: Collector;
}
