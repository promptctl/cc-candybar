// [LAW:parse-dont-validate] What a stats client reads of a daemon's stats
// reply, declared against this build's types, so a reply of another build is
// read as this build's only where it is this build's shape: every field, every
// arm and every word this client reads. `tsc` refuses a declaration that
// leaves one out, so a field or an arm added to a type is read here at once.

import {
  entries,
  flag,
  list,
  nullable,
  number,
  object,
  oneOf,
  parsedText,
  tagged,
  text,
  word,
  type Shape,
} from "../../utils/wire-shape.js";
import {
  REFRESH_TRIGGERS,
  type SourceRecord,
} from "../../utils/refresh-ledger.js";
import type { KeyedSourceStats } from "../../utils/keyed-source.js";
import { CLIENT_KINDS, type ClientHint } from "../../client-hint.js";
import type { RendererStats } from "../../renderer-interface/renderer-stats.js";
import type { Asked } from "../../utils/outcome.js";
import {
  FRAMES_SEEN,
  RATE_LIMITS_SEEN,
  type RenderSighting,
} from "./sightings.js";
import { SIGHTING_ROLES } from "./sighting-roles.js";
import { parseSessionId } from "./session-id.js";
import { parsedRendererName } from "./renderer-name.js";
import type {
  MemoryReading,
  OwnUsage,
  ProcessMemory,
  ReadCharge,
} from "./memory-limit.js";
import type {
  Delivery,
  Durations,
  RendererMemoryPanel,
  RendererPanel,
  StatsSnapshot,
} from "./stats-snapshot.js";

const DURATIONS = object<Durations>({
  count: number,
  p50Ms: number,
  p90Ms: number,
  p99Ms: number,
  p999Ms: number,
  maxMs: number,
  meanMs: number,
  stddevMs: number,
});

const REFRESHES = entries<SourceRecord["refreshes"]>(
  oneOf(REFRESH_TRIGGERS),
  number,
);

const KEYED_SOURCE = object<KeyedSourceStats>({
  refreshes: REFRESHES,
  failures: number,
  abandoned: number,
  lastMs: nullable(number),
  entries: number,
  held: number,
});

const SCOPE = word<SourceRecord["scope"]>({
  daemon: true,
  configDir: true,
  repo: true,
  directory: true,
  session: true,
  view: true,
  pane: true,
});

const DELIVERY = tagged<Delivery>({
  delivering: { unreported: list(number), missedSince: nullable(number) },
  stalled: { missedSince: number },
  unmeasured: { since: number, reason: text, missedSince: nullable(number) },
});

const CLIENT_HINT = object<ClientHint>({
  kind: oneOf(CLIENT_KINDS),
  bundle: text,
  source: nullable(text),
});

const SIGHTING = object<RenderSighting>({
  client: nullable(CLIENT_HINT),
  termCols: nullable(number),
  rateLimits: oneOf(RATE_LIMITS_SEEN),
  claudeConfigDir: text,
  projectDir: text,
  transcript: object({ path: text, answered: flag }),
  frame: oneOf(FRAMES_SEEN),
  role: oneOf(SIGHTING_ROLES),
  sessionId: parsedText((raw) => {
    const parsed = parseSessionId(raw);
    return parsed.ok ? parsed.id : null;
  }),
  ago: number,
});

const USAGE = tagged<OwnUsage>({
  read: { sizes: object({ rss: number, heapTotal: number }) },
  unread: { why: text },
});

const CHARGE = tagged<ReadCharge>({
  charged: {
    measure: word({ phys_footprint: true, rss: true }),
    bytes: number,
  },
  "stand-in": { rss: number, gap: number, unread: text },
  unread: { gap: number, unread: text },
});

const READING = tagged<MemoryReading>({
  unmeasured: {},
  measured: { ageMs: number, charge: CHARGE, usage: USAGE },
});

const PROCESS_MEMORY = object<ProcessMemory>({
  pid: number,
  memory: READING,
  limit: number,
  nearAt: number,
});

export const RENDERER_STATS_SHAPE = object<RendererStats>({
  renderCache: object({
    size: number,
    held: number,
    retired: number,
    compiles: number,
    views: number,
    pinned: number,
    retiredViews: number,
    passages: number,
    accountedBytes: number,
    budgetBytes: number,
  }),
  effectCache: object({ sessions: number, effects: number }),
  menuIdle: object({ sessions: number, armed: number }),
  rendererTurns: object({
    parked: number,
    presents: number,
    deferrals: number,
  }),
  sessionState: object({
    sessions: number,
    observers: number,
    revision: number,
  }),
  framesDrawn: number,
});

const PANEL = object<RendererPanel>({
  name: parsedText(parsedRendererName),
  process: tagged<RendererMemoryPanel>({
    "in-host": {},
    "not-running": { why: text },
    process: { memory: PROCESS_MEMORY },
  }),
  mailbox: object({ holder: nullable(text), heldMs: number, queued: number }),
  stats: tagged<Asked<RendererStats>>({
    ok: { value: RENDERER_STATS_SHAPE },
    failed: { reason: text },
  }),
});

export const STATS_SHAPE: Shape<StatsSnapshot> = object<StatsSnapshot>({
  pid: number,
  version: text,
  sourceDigest: nullable(text),
  protocolVersion: number,
  startedAt: text,
  uptimeSec: number,
  rssBytes: number,
  heapUsedBytes: number,
  heapTotalBytes: number,
  externalBytes: number,
  arrayBuffersBytes: number,
  requests: object({
    total: number,
    environmentMisses: number,
    errored: number,
    timedOut: number,
    inFlight: number,
    took: DURATIONS,
  }),
  tasksThrew: number,
  unknownHookFields: list(text),
  gitCache: object({
    size: number,
    held: number,
    hits: number,
    misses: number,
    changes: number,
    watchers: number,
  }),
  usageCache: object({
    size: number,
    hits: number,
    misses: number,
    sweeps: number,
  }),
  sources: object({
    records: list(
      object<SourceRecord>({
        name: text,
        scope: SCOPE,
        refreshes: REFRESHES,
        failures: number,
        abandoned: number,
        lastMs: nullable(number),
      }),
    ),
    homes: object({
      daemon: number,
      configDir: number,
      repo: number,
      session: number,
      pane: number,
    }),
    held: object({
      git: number,
      tmux: number,
      host: number,
      today: number,
      pluginStorage: number,
      transcript: number,
    }),
    pluginStorage: object({
      folders: number,
      faults: object({
        unusable: number,
        unreadable: number,
        refused: number,
        error: number,
      }),
      lost: number,
    }),
  }),
  fileEvents: object({
    delivery: DELIVERY,
    stalls: number,
    catchUps: number,
    probes: number,
    probeFailures: number,
  }),
  sourceRuns: object({
    shell: KEYED_SOURCE,
    file: KEYED_SOURCE,
    watches: number,
  }),
  transcriptReads: object({
    reads: number,
    bytes: number,
    longLines: number,
    largestLine: number,
  }),
  collector: object({ sessions: number, retiring: number }),
  runs: object({
    started: number,
    failed: number,
    timedOut: number,
    refused: number,
    running: number,
  }),
  frameFeeds: object({
    feeds: number,
    subscribers: number,
    pushed: number,
    refused: number,
    lookups: number,
    found: number,
  }),
  watchers: object({
    active: number,
    opened: number,
    closed: number,
    refused: number,
    errors: number,
    dirs: object({ active: number, opened: number, closed: number }),
    polled: number,
  }),
  subprocesses: object({
    total: number,
    inFlight: number,
    lastMinute: number,
    byCategory: entries(text, number),
    refused: entries(text, number),
    draining: number,
    drainedBytes: number,
    drainsCut: number,
    pipeErrors: number,
    durations: entries(text, DURATIONS),
  }),
  clients: list(SIGHTING),
  bundle: text,
  linkKeyId: tagged<Asked<string>>({
    ok: { value: text },
    failed: { reason: text },
  }),
  host: PROCESS_MEMORY,
  renderers: list(PANEL),
});
