// [LAW:single-enforcer] The one trigger of a session's transcript lanes
// (docs/design/host-and-renderer.md §6): the collector reads the world, and a
// request is not one of its triggers. One keyed entry per followed session,
// held by the session's declaration like every keyed lane. A watch on its
// transcript and on Claude Code's settings file reads it again after a write,
// and a backstop period catches an event the OS dropped. Each lane's owner
// gates its read on its file's stamp, so a read over an unchanged transcript
// reads nothing.

import { inspect } from "node:util";
import { ok, type Outcome } from "../../utils/outcome.js";
import {
  KeyedSource,
  type KeyedSourceStats,
} from "../../utils/keyed-source.js";
import type { Lane } from "../../utils/reading.js";
import type { Holds, Release } from "../../utils/holds.js";
import type { Every } from "../../utils/period.js";
import type {
  RefreshLedger,
  RefreshTrigger,
} from "../../utils/refresh-ledger.js";
import type { DaemonLogger } from "../../utils/logger.js";
import { valueOf } from "../../utils/logfmt.js";
import { REFRESH_LANES, type RefreshLane } from "../../facts/world-state.js";
import type { Timekeeper } from "../../time.js";
import type { SessionId } from "../foundations/session-id.js";
import { watchTargetsOf } from "../foundations/watch-targets.js";
import type { SessionUsageStore } from "./session-usage-store.js";
import type { ContextProvider } from "./context-provider.js";
import type { MetricsProvider } from "./metrics-provider.js";
import type { ActivityProvider } from "../../segments/activity.js";
import type { CacheExpiryProvider } from "../../segments/cache.js";
import type { AutoCompactProvider } from "./autocompact.js";
import type { RefreshFaults } from "../refresh-faults.js";
import type { WatcherRegistry } from "./watchers.js";

// The backstop for a write whose event the OS dropped: the watch is what
// makes a lane current, so this only bounds how stale a missed event leaves it.
export const TRANSCRIPT_PERIOD: Every = { okMs: 10_000, failedMs: 10_000 };

// Entries no session holds, kept so a session back from idle resumes its
// period rather than starting over; each keeps its watch until dropped.
const MAX_UNHELD = 16;

// What a session's lanes are read at: its transcript, and the settings file of
// its Claude Code directory, which holds the auto-compact window.
export interface Followed {
  readonly session: SessionId;
  readonly transcript: string;
  readonly settings: string;
}

// The owner each lane is read from, and the record of a lane whose read threw.
export interface LaneOwners {
  readonly usageStore: Pick<SessionUsageStore, "refresh">;
  readonly contextProvider: Pick<ContextProvider, "refresh">;
  readonly metricsProvider: Pick<MetricsProvider, "refresh">;
  readonly activityProvider: Pick<ActivityProvider, "refresh">;
  readonly cacheExpiry: Pick<CacheExpiryProvider, "refresh">;
  readonly autoCompact: Pick<AutoCompactProvider, "window">;
  readonly faults: RefreshFaults;
}

// [LAW:one-source-of-truth] An entry's identity, which its watch is keyed by
// too: two inputs with one key are one reading and one watch.
const keyOfFollowed = ({ session, transcript, settings }: Followed): string =>
  [session, transcript, settings].join("\0");

export class TranscriptLanes {
  private readonly source: KeyedSource<Followed, null>;

  constructor(
    private readonly deps: {
      readonly owners: LaneOwners;
      readonly watchers: Pick<WatcherRegistry, "acquire">;
      // [LAW:effects-at-boundaries] Arms each entry's period, times each read
      // and stamps the speed sample.
      readonly clock: Pick<
        Timekeeper,
        "monotonic" | "after" | "now" | "detach"
      >;
      readonly logger: DaemonLogger;
      readonly ledger: RefreshLedger;
      readonly every?: Every;
    },
  ) {
    this.source = new KeyedSource({
      name: "transcript",
      scope: "session",
      keyOf: keyOfFollowed,
      fields: ({ session }) => `sid=${valueOf(session)}`,
      read: (followed, _signal, by) => this.read(followed, by),
      every: () => deps.every ?? TRANSCRIPT_PERIOD,
      watch: (followed, changed) => this.watch(followed, changed),
      maxEntries: MAX_UNHELD,
      // [LAW:nothing-unseen] The period is a backstop for a dropped event, and
      // its clean read over a quiet session says nothing: it counts in the
      // ledger and writes no line, while a write's read writes one.
      lines: ["first", "change", "supersede"],
      logger: deps.logger,
      ledger: deps.ledger,
      clock: deps.clock,
    });
  }

  // [LAW:single-enforcer] A session's declaration of its lanes: `holds` takes
  // the entry, so a session no entry follows yet starts its first read now.
  declare(holds: Holds, followed: Followed): Lane<null> {
    return this.source.declare(holds, followed);
  }

  stats(): KeyedSourceStats {
    return this.source.stats();
  }

  close(): void {
    this.source.close();
  }

  // The transcript and the settings file, each polled at every hop of its
  // link chain, under one key per entry: their folders are busy trees (every
  // session's transcripts, Claude Code's own state), which an OS watch would
  // route here whole, and a settings file is often a link into a dotfiles
  // checkout, whose edits land at the link's target. [LAW:single-enforcer]
  // The hops are the one rule's (`watchTargetsOf`). A chain that loops is not
  // a fault here: the lane's own read of the path fails, loudly.
  private watch(followed: Followed, changed: () => void): Release {
    const { transcript, settings } = followed;
    const handle = this.deps.watchers.acquire(
      `transcript-lanes:${keyOfFollowed(followed)}`,
      watchTargetsOf({ named: [transcript, settings], whole: [] }).targets,
      changed,
    );
    return () => handle.release();
  }

  // Every lane, read at once.
  // [LAW:no-silent-failure] A lane's contract is to answer, never to throw,
  // so a throw is a bug its owner never saw: logged here, and kept as that
  // lane's failure (RefreshFaults) until a read of it runs clean, so the
  // world state reads it failed rather than not answered.
  private async read(
    { session, transcript, settings }: Followed,
    by: RefreshTrigger,
  ): Promise<Outcome<null>> {
    const { owners, clock, logger } = this.deps;
    // The one ingest the session and speed lanes share.
    const record = owners.usageStore.refresh(session, transcript, by);
    // [LAW:types-are-the-program] One read per lane, every lane named.
    const reads: Readonly<Record<RefreshLane, () => Promise<unknown>>> = {
      session: () => record.usage(),
      context: () => owners.contextProvider.refresh(session, transcript, by),
      metrics: () => owners.metricsProvider.refresh(session, transcript, by),
      activity: () => owners.activityProvider.refresh(session, transcript, by),
      cache: () => owners.cacheExpiry.refresh(session, transcript, by),
      speed: () => record.speed(clock.now()),
      autocompact: async () => owners.autoCompact.window(settings, by),
    };
    const lane = async (name: RefreshLane): Promise<void> => {
      let threw: string | null = null;
      try {
        await reads[name]();
      } catch (e) {
        logger("error", `${name} lane threw: ${inspect(e)}`);
        threw = `${name}: ${String(e)}`;
      }
      owners.faults.refreshed(session, name, threw);
    };
    await Promise.all(REFRESH_LANES.map(lane));
    return ok(null);
  }
}
