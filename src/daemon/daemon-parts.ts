import type { SessionBook } from "./session-book.js";
import type { Collector } from "./collector.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { Timekeeper } from "../time.js";
import type { FileEventDelivery } from "./cache/file-events";
import type { WatcherRegistry } from "./cache/watchers";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { FrameFeeds } from "./frame-feed.js";
import type { LimitsHandle } from "./limits";
import type { PayloadProviders } from "./payload-providers";
import type { RenderSightings } from "./render-sightings";
import type { Runs } from "./runs.js";
import type { SourceRuns } from "./source-runs.js";
import type { RuntimeStats } from "./stats";
import type { RetiredTmuxStatus } from "./retired-tmux-status.js";
import type { RendererHost } from "./renderer-host.js";
import type { PublishFrame } from "./foundations/frame-publication.js";
import type { RefreshLedger } from "../utils/refresh-ledger";
import type { DaemonLogger } from "../utils/logger";
import type { Launcher } from "../proc/launcher";

// [LAW:one-source-of-truth] What one daemon holds, built once by `createDaemon`
// (src/daemon/daemon.ts) and read by the request handling, which keeps none of
// its own.
export interface DaemonParts {
  // The user's home: the default Claude Code directory is under it.
  readonly home: string;
  // The temporary directory a click's handoff writes under.
  readonly clock: Timekeeper;
  readonly launcher: Launcher;
  readonly log: DaemonLogger;
  readonly bundle: string;
  readonly sourceDigest: string | null;
  readonly sessionBook: SessionBook;
  readonly stats: RuntimeStats;
  // What every click is opened with before any renderer sees it.
  readonly linkSigner: LinkSigner;
  readonly publishFrame: PublishFrame;
  readonly renderSightings: RenderSightings;
  readonly watcherRegistry: WatcherRegistry;
  readonly refreshLedger: RefreshLedger;
  readonly fileEvents: FileEventDelivery;
  readonly payloadProviders: PayloadProviders;
  readonly runs: Runs;
  // [LAW:single-enforcer] The daemon's one owner of every declared source's
  // runs, which the stats reply reads.
  readonly sourceRuns: SourceRuns;
  readonly retiredTmuxStatus: Pick<RetiredTmuxStatus, "observe">;
  readonly frameFeeds: FrameFeeds<CheckedRenderRequest>;
  readonly limits: LimitsHandle;
  // The host's one path to the main renderer (src/daemon/renderer-host.ts).
  readonly renderer: RendererHost;
  // The daemon's close, which ends a request's wait.
  readonly closing: AbortSignal;
  // [LAW:single-enforcer] The host's one reader of every session's world
  // (src/daemon/collector.ts).
  readonly collector: Collector;
}
