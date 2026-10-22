// What `cc-candybar doctor` asks the running daemon, in one daemon-stats
// request: for the install check, the bundle it runs and each session's
// latest client (`bundle` and `clients`, src/daemon/render-sightings.ts — the
// command is no statusline client itself, so these are the only clients it
// can judge); for the daemon check, the daemon as it reports itself
// (`daemon`, src/daemon/limits.ts `serving`).

import { fetchStats, shapeSkew } from "../daemon/client-stats.js";
import type { StatsSnapshot } from "../daemon/stats.js";
import { describeFailure } from "../daemon/client-transport.js";
import { sanitizeClient } from "../daemon/protocol.js";
import {
  FRAMES_SEEN,
  RATE_LIMITS_SEEN,
  SIGHTING_ROLES,
  type RenderSighting,
} from "../daemon/render-sightings.js";
import type { Asked } from "./checks.js";
import type {
  MemoryReading,
  PostMortem,
  ServingDaemon,
} from "../daemon/limits.js";
import type { StoresRead } from "./edge.js";
import { parseMarkBook } from "./mark-book.js";
import { parseClickedTerminals } from "./clicked-terminals.js";
import { parsePostMortemsRead } from "./post-mortems-read.js";

export interface DaemonClients {
  readonly bundle: string;
  readonly clients: ReadonlyArray<
    Pick<RenderSighting, "client" | "sessionId" | "ago">
  >;
}

// What each recent render said of the rate-limit windows, and the Claude Code
// directory it ran with.
export type RateLimitSightings = ReadonlyArray<
  Pick<RenderSighting, "rateLimits" | "claudeConfigDir" | "sessionId" | "ago">
>;

// Where each recent render's transcript is, and how long ago it rendered.
export type TranscriptSightings = ReadonlyArray<
  Pick<RenderSighting, "transcript" | "sessionId" | "ago">
>;

// What each recent render drew, whose it was, how often its session's bar
// was redrawn, and where its session reads its settings: the Claude Code
// directory it ran with and its project.
export type FrameSightings = ReadonlyArray<
  Pick<
    RenderSighting,
    | "role"
    | "frame"
    | "claudeConfigDir"
    | "projectDir"
    | "ago"
    | "sessionId"
    | "since"
    | "redrawn"
  >
>;

// Whose each recent render was, which client drew it, and the width it
// measured.
export type WidthSightings = ReadonlyArray<
  Pick<RenderSighting, "sessionId" | "ago" | "role" | "termCols">
>;

type SightingRecord = Partial<Record<keyof RenderSighting, unknown>>;

// Each entry of the stats' `clients` as a record of unread fields — a
// non-object entry has none — for each parser to hold to its own shape.
function sightingRecords(stats: StatsSnapshot): SightingRecord[] {
  return (stats.clients as unknown[]).map((c) =>
    typeof c === "object" && c !== null ? (c as SightingRecord) : {},
  );
}

// [LAW:parse-dont-validate] Socket JSON from whichever daemon is running
// becomes DaemonClients here or a failure naming why. A daemon of another
// build is told by the one shape comparison daemon-stats makes (shapeSkew),
// and a sighting's client crosses the same checkpoint a render's hint does
// (sanitizeClient), so a malformed one reads as unreported, never as a
// half-trusted client.
export function parseDaemonClients(stats: StatsSnapshot): Asked<DaemonClients> {
  const skew = shapeSkew(stats, ["bundle", "clients"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  if (typeof stats.bundle !== "string") {
    return {
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported its bundle as ${JSON.stringify(stats.bundle)}`,
    };
  }
  const sightings = sightingRecords(stats);
  if (
    !sightings.every(
      (c) => typeof c.ago === "number" && typeof c.sessionId === "string",
    )
  ) {
    return {
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported clients without their age or session: ${JSON.stringify(stats.clients)}`,
    };
  }
  return {
    kind: "ok",
    value: {
      bundle: stats.bundle,
      clients: sightings.map((c) => ({
        client: sanitizeClient(c.client) ?? null,
        sessionId: c.sessionId as string,
        ago: c.ago as number,
      })),
    },
  };
}

const isPostMortem = (m: unknown): m is PostMortem => {
  const { identity, artifacts } = (m ?? {}) as Partial<PostMortem>;
  return (
    typeof identity === "string" &&
    typeof artifacts === "object" &&
    artifacts !== null &&
    Object.values(artifacts).every((f) => typeof f === "string")
  );
};

// A reading as the daemon spelled it: none yet, or a charge — the platform's
// own measure, or RSS standing in with why — beside its unread run and the RSS
// and heap it was read with.
const isMemoryReading = (m: unknown): m is MemoryReading => {
  const r = (m ?? {}) as {
    kind?: unknown;
    charge?: Partial<Record<"kind" | "measure" | "bytes" | "unread", unknown>>;
    unreadRun?: unknown;
    rss?: unknown;
    heapTotal?: unknown;
  };
  if (r.kind === "unmeasured") return true;
  const c = r.charge;
  return (
    r.kind === "measured" &&
    typeof r.unreadRun === "number" &&
    typeof r.rss === "number" &&
    typeof r.heapTotal === "number" &&
    typeof c?.bytes === "number" &&
    ((c.kind === "charged" &&
      (c.measure === "phys_footprint" || c.measure === "rss")) ||
      (c.kind === "stand-in" && typeof c.unread === "string"))
  );
};

// [LAW:parse-dont-validate] The daemon's report of itself becomes a
// ServingDaemon here or a failure naming why — an older daemon carries no
// `daemon` field (shapeSkew), and anything else misshapen is named whole.
// [LAW:parse-dont-validate] An `Asked<T>` as another build spelled it: its
// failure kept in the daemon's own words, its value re-read by `parse` — or
// `misshapen`, with why, for the caller to name the answer it sat in.
function askedOnWire<T>(
  wire: unknown,
  parse: (value: unknown) => Asked<T>,
): Asked<T> | { readonly kind: "misshapen"; readonly reason: string } {
  const w = wire as {
    kind?: unknown;
    value?: unknown;
    reason?: unknown;
  } | null;
  if (w?.kind === "failed" && typeof w.reason === "string") {
    return { kind: "failed", reason: w.reason };
  }
  if (w?.kind !== "ok")
    return { kind: "misshapen", reason: "is not an answer" };
  const parsed = parse(w.value);
  return parsed.kind === "ok"
    ? parsed
    : { kind: "misshapen", reason: parsed.reason };
}

export function parseServingDaemon(stats: StatsSnapshot): Asked<ServingDaemon> {
  const skew = shapeSkew(stats, ["daemon"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const d = stats.daemon as Partial<ServingDaemon> | null;
  const postMortems = askedOnWire(d?.postMortems, (v) =>
    Array.isArray(v) && v.every(isPostMortem)
      ? { kind: "ok", value: v }
      : { kind: "failed", reason: "is not a list of post-mortems" },
  );
  const wellFormed =
    typeof d?.pid === "number" &&
    isMemoryReading(d.memory) &&
    typeof d.limit === "number" &&
    postMortems.kind !== "misshapen";
  return wellFormed
    ? { kind: "ok", value: { ...(d as ServingDaemon), postMortems } }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported itself as ${JSON.stringify(stats.daemon)}`,
      };
}

// [LAW:parse-dont-validate] [LAW:one-type-per-behavior] One half of the
// sightings, read on its own so a daemon older than it fails only the check
// that reads it: every sighting is the `E` that `holds` proves it is, or the
// answer names, as `lacking`, what the daemon reported its renders without.
function sightingHalf<E extends SightingRecord>(
  stats: StatsSnapshot,
  holds: (c: SightingRecord) => c is E,
  lacking: string,
): Asked<readonly E[]> {
  const skew = shapeSkew(stats, ["clients"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const sightings = sightingRecords(stats);
  return sightings.every(holds)
    ? { kind: "ok", value: sightings }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its renders without ${lacking} — restart it on this build: ${JSON.stringify(stats.clients)}`,
      };
}

const isRole = (c: SightingRecord): boolean =>
  (SIGHTING_ROLES as readonly unknown[]).includes(c.role);

// The rate-limit half: the segment-data check's, leaving the install check
// its clients.
export const parseRateLimitSightings = (
  stats: StatsSnapshot,
): Asked<RateLimitSightings> =>
  sightingHalf(
    stats,
    (c): c is RateLimitSightings[number] =>
      typeof c.ago === "number" &&
      typeof c.sessionId === "string" &&
      typeof c.claudeConfigDir === "string" &&
      (RATE_LIMITS_SEEN as readonly unknown[]).includes(c.rateLimits),
    "the rate-limit windows they carried",
  );

// The transcript half: the session-data check's.
export const parseTranscriptSightings = (
  stats: StatsSnapshot,
): Asked<TranscriptSightings> =>
  sightingHalf(
    stats,
    (c): c is TranscriptSightings[number] => {
      const t = c.transcript as Partial<Record<string, unknown>> | undefined;
      return (
        typeof c.ago === "number" &&
        typeof c.sessionId === "string" &&
        typeof t?.path === "string" &&
        typeof t.answered === "boolean"
      );
    },
    "their transcripts",
  );

// The frame half: the effect-refresh check's.
export const parseFrameSightings = (
  stats: StatsSnapshot,
): Asked<FrameSightings> =>
  sightingHalf(
    stats,
    (c): c is FrameSightings[number] =>
      typeof c.ago === "number" &&
      typeof c.claudeConfigDir === "string" &&
      typeof c.projectDir === "string" &&
      typeof c.sessionId === "string" &&
      typeof c.since === "number" &&
      // A record holds its latest render's second, so a list is never empty.
      Array.isArray(c.redrawn) &&
      c.redrawn.length > 0 &&
      c.redrawn.every(Number.isInteger) &&
      isRole(c) &&
      (FRAMES_SEEN as readonly unknown[]).includes(c.frame),
    "what they drew, when, and from which project",
  );

// The width half: the terminal-width check's.
export const parseWidthSightings = (
  stats: StatsSnapshot,
): Asked<WidthSightings> =>
  sightingHalf(
    stats,
    (c): c is WidthSightings[number] =>
      typeof c.sessionId === "string" &&
      typeof c.ago === "number" &&
      isRole(c) &&
      (c.termCols === null || typeof c.termCols === "number"),
    "whose they were or the width they measured",
  );

// [LAW:parse-dont-validate] One store as the daemon read it: what it holds,
// re-read by the store's own parser (the wire is another build's word), or
// why the daemon could not read it.
function answeredStore<T>(
  stats: StatsSnapshot,
  name: keyof StoresRead,
  parse: (doc: unknown) => Asked<T>,
): Asked<T> {
  const wire = (
    stats.doctorStores as Partial<Record<keyof StoresRead, unknown>> | null
  )?.[name];
  const answered = askedOnWire(wire, parse);
  return answered.kind === "misshapen"
    ? {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its ${name} as ${JSON.stringify(wire)}, which ${answered.reason}`,
      }
    : answered;
}

// What the doctor's stores hold, as the daemon that owns them read them — a
// daemon older than the field reads as that skew in every store.
export function parseDoctorStores(stats: StatsSnapshot): StoresRead {
  const skew = shapeSkew(stats, ["doctorStores"]);
  if (skew !== null) {
    const failed = { kind: "failed", reason: skew } as const;
    return { marks: failed, clicked: failed, postMortemsRead: failed };
  }
  return {
    marks: answeredStore(stats, "marks", parseMarkBook),
    clicked: answeredStore(stats, "clicked", parseClickedTerminals),
    postMortemsRead: answeredStore(
      stats,
      "postMortemsRead",
      parsePostMortemsRead,
    ),
  };
}

// Each fact the doctor asks the daemon for, parsed on its own: one that does
// not read fails its own check, never the other's.
export interface DaemonAnswer {
  readonly clients: Asked<DaemonClients>;
  readonly rateLimits: Asked<RateLimitSightings>;
  readonly transcripts: Asked<TranscriptSightings>;
  readonly frames: Asked<FrameSightings>;
  readonly widths: Asked<WidthSightings>;
  readonly serving: Asked<ServingDaemon>;
  readonly stores: StoresRead;
}

export async function askDaemon(): Promise<DaemonAnswer> {
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    const failed = {
      kind: "failed",
      reason: describeFailure(outcome).split("\n").join(" — "),
    } as const;
    return {
      clients: failed,
      rateLimits: failed,
      transcripts: failed,
      frames: failed,
      widths: failed,
      serving: failed,
      stores: { marks: failed, clicked: failed, postMortemsRead: failed },
    };
  }
  return {
    clients: parseDaemonClients(outcome.value),
    rateLimits: parseRateLimitSightings(outcome.value),
    transcripts: parseTranscriptSightings(outcome.value),
    frames: parseFrameSightings(outcome.value),
    widths: parseWidthSightings(outcome.value),
    serving: parseServingDaemon(outcome.value),
    stores: parseDoctorStores(outcome.value),
  };
}
