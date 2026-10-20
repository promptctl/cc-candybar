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
import type { PostMortem, ServingDaemon } from "../daemon/limits.js";
import type { StoresRead } from "./edge.js";
import { parseMarkBook } from "./mark-book.js";
import { parseClickedTerminals } from "./clicked-terminals.js";
import { parsePostMortemsRead } from "./post-mortems-read.js";

export interface DaemonClients {
  readonly bundle: string;
  readonly clients: ReadonlyArray<Pick<RenderSighting, "client" | "ago">>;
}

// What each recent render said of the rate-limit windows, and the Claude Code
// directory it ran with.
export type RateLimitSightings = ReadonlyArray<
  Pick<RenderSighting, "rateLimits" | "claudeConfigDir" | "ago">
>;

// Where each recent render's transcript is, and how long ago it rendered.
export type TranscriptSightings = ReadonlyArray<
  Pick<RenderSighting, "transcript" | "ago">
>;

// What each recent render drew, and the Claude Code directory it ran with.
export type FrameSightings = ReadonlyArray<
  Pick<RenderSighting, "role" | "frame" | "claudeConfigDir" | "ago">
>;

// Each entry of the stats' `clients` as a record of unread fields — a
// non-object entry has none — for each parser to hold to its own shape.
function sightingRecords(
  stats: StatsSnapshot,
): Array<Partial<Record<keyof RenderSighting, unknown>>> {
  return (stats.clients as unknown[]).map((c) =>
    typeof c === "object" && c !== null
      ? (c as Partial<Record<keyof RenderSighting, unknown>>)
      : {},
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
  if (!sightings.every((c) => typeof c.ago === "number")) {
    return {
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported clients without their age: ${JSON.stringify(stats.clients)}`,
    };
  }
  return {
    kind: "ok",
    value: {
      bundle: stats.bundle,
      clients: sightings.map((c) => ({
        client: sanitizeClient(c.client) ?? null,
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

// [LAW:parse-dont-validate] The daemon's report of itself becomes a
// ServingDaemon here or a failure naming why — an older daemon carries no
// `daemon` field (shapeSkew), and anything else misshapen is named whole.
export function parseServingDaemon(stats: StatsSnapshot): Asked<ServingDaemon> {
  const skew = shapeSkew(stats, ["daemon"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const d = stats.daemon as Partial<ServingDaemon> | null;
  const postMortems = d?.postMortems as
    | { kind?: unknown; value?: unknown; reason?: unknown }
    | undefined;
  const wellFormed =
    typeof d?.pid === "number" &&
    typeof d.rss === "number" &&
    typeof d.rssLimit === "number" &&
    ((postMortems?.kind === "ok" &&
      Array.isArray(postMortems.value) &&
      postMortems.value.every(isPostMortem)) ||
      (postMortems?.kind === "failed" &&
        typeof postMortems.reason === "string"));
  return wellFormed
    ? { kind: "ok", value: d as ServingDaemon }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported itself as ${JSON.stringify(stats.daemon)}`,
      };
}

// [LAW:parse-dont-validate] The rate-limit half of the same sightings, read
// on its own so a daemon older than it fails the segment-data check alone and
// leaves the install check its clients.
export function parseRateLimitSightings(
  stats: StatsSnapshot,
): Asked<RateLimitSightings> {
  const skew = shapeSkew(stats, ["clients"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const sightings = sightingRecords(stats);
  const wellFormed = sightings.every(
    (c) =>
      typeof c.ago === "number" &&
      typeof c.claudeConfigDir === "string" &&
      (RATE_LIMITS_SEEN as readonly unknown[]).includes(c.rateLimits),
  );
  return wellFormed
    ? {
        kind: "ok",
        value: sightings as RateLimitSightings,
      }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its renders without the rate-limit windows they carried — restart it on this build: ${JSON.stringify(stats.clients)}`,
      };
}

// [LAW:parse-dont-validate] The transcript half of the same sightings, read
// on its own so a daemon older than it fails the session-data check alone.
export function parseTranscriptSightings(
  stats: StatsSnapshot,
): Asked<TranscriptSightings> {
  const skew = shapeSkew(stats, ["clients"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const sightings = sightingRecords(stats);
  const wellFormed = sightings.every((c) => {
    const t = c.transcript as Partial<Record<string, unknown>> | undefined;
    return (
      typeof c.ago === "number" &&
      typeof t?.path === "string" &&
      typeof t.answered === "boolean"
    );
  });
  return wellFormed
    ? { kind: "ok", value: sightings as TranscriptSightings }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its renders without their transcripts — restart it on this build: ${JSON.stringify(stats.clients)}`,
      };
}

// [LAW:parse-dont-validate] The frame half of the same sightings, read on its
// own so a daemon older than it fails the effect-refresh check alone.
export function parseFrameSightings(
  stats: StatsSnapshot,
): Asked<FrameSightings> {
  const skew = shapeSkew(stats, ["clients"]);
  if (skew !== null) return { kind: "failed", reason: skew };
  const sightings = sightingRecords(stats);
  const wellFormed = sightings.every(
    (c) =>
      typeof c.ago === "number" &&
      typeof c.claudeConfigDir === "string" &&
      (SIGHTING_ROLES as readonly unknown[]).includes(c.role) &&
      (FRAMES_SEEN as readonly unknown[]).includes(c.frame),
  );
  return wellFormed
    ? { kind: "ok", value: sightings as FrameSightings }
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its renders without what they drew — restart it on this build: ${JSON.stringify(stats.clients)}`,
      };
}

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
  )?.[name] as
    | { kind?: unknown; value?: unknown; reason?: unknown }
    | undefined;
  if (wire?.kind === "failed" && typeof wire.reason === "string") {
    return { kind: "failed", reason: wire.reason };
  }
  const parsed: Asked<T> =
    wire?.kind === "ok"
      ? parse(wire.value)
      : { kind: "failed", reason: "is not a store's answer" };
  return parsed.kind === "ok"
    ? parsed
    : {
        kind: "failed",
        reason: `the running daemon (${stats.version}) reported its ${name} as ${JSON.stringify(wire)}, which ${parsed.reason}`,
      };
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
      serving: failed,
      stores: { marks: failed, clicked: failed, postMortemsRead: failed },
    };
  }
  return {
    clients: parseDaemonClients(outcome.value),
    rateLimits: parseRateLimitSightings(outcome.value),
    transcripts: parseTranscriptSightings(outcome.value),
    frames: parseFrameSightings(outcome.value),
    serving: parseServingDaemon(outcome.value),
    stores: parseDoctorStores(outcome.value),
  };
}
