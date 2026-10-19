// What `cc-candybar doctor` asks the running daemon, in one daemon-stats
// request: for the install check, the bundle it runs and each session's
// latest client (`bundle` and `clients`, src/daemon/client-sightings.ts — the
// command is no statusline client itself, so these are the only clients it
// can judge); for the daemon check, the daemon as it reports itself
// (`daemon`, src/daemon/limits.ts `serving`).

import { fetchStats, shapeSkew } from "../daemon/client-stats.js";
import type { StatsSnapshot } from "../daemon/stats.js";
import { describeFailure } from "../daemon/client-transport.js";
import { sanitizeClient } from "../daemon/protocol.js";
import type { ClientSighting } from "../daemon/client-sightings.js";
import type { Asked } from "./checks.js";
import type { PostMortem, ServingDaemon } from "../daemon/limits.js";

export interface DaemonClients {
  readonly bundle: string;
  readonly clients: readonly ClientSighting[];
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
  const sightings = (stats.clients as unknown[]).map((c) =>
    typeof c === "object" && c !== null
      ? (c as { client?: unknown; ago?: unknown })
      : {},
  );
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

// Each fact the doctor asks the daemon for, parsed on its own: one that does
// not read fails its own check, never the other's.
export interface DaemonAnswer {
  readonly clients: Asked<DaemonClients>;
  readonly serving: Asked<ServingDaemon>;
}

export async function askDaemon(): Promise<DaemonAnswer> {
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    const failed = {
      kind: "failed",
      reason: describeFailure(outcome).split("\n").join(" — "),
    } as const;
    return { clients: failed, serving: failed };
  }
  return {
    clients: parseDaemonClients(outcome.value),
    serving: parseServingDaemon(outcome.value),
  };
}
