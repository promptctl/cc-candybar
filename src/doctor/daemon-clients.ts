// What `cc-candybar doctor` asks the running daemon for the install check:
// the bundle it runs and each session's latest client (daemon-stats'
// `bundle` and `clients`, src/daemon/client-sightings.ts). The command is no
// statusline client itself, so these are the only clients it can judge.

import { fetchStats } from "../daemon/client-stats.js";
import { describeFailure } from "../daemon/client-transport.js";
import { sanitizeClient } from "../daemon/protocol.js";
import type { ClientSighting } from "../daemon/client-sightings.js";
import type { Asked } from "./checks.js";

export interface DaemonClients {
  readonly bundle: string;
  readonly clients: readonly ClientSighting[];
}

// [LAW:parse-dont-validate] Socket JSON from whichever daemon is running
// becomes DaemonClients here or a failure naming why: one from before this
// check carries neither field, and a sighting's client crosses the same
// checkpoint a render's hint does (sanitizeClient), so a malformed one reads
// as unreported, never as a half-trusted client.
export function parseDaemonClients(
  version: string,
  raw: { readonly bundle?: unknown; readonly clients?: unknown },
): Asked<DaemonClients> {
  const { bundle, clients } = raw;
  if (typeof bundle !== "string" || !Array.isArray(clients)) {
    return {
      kind: "failed",
      reason: `the running daemon (${version}) predates this check`,
    };
  }
  const sightings = (clients as unknown[]).map((c) =>
    typeof c === "object" && c !== null
      ? (c as { client?: unknown; ago?: unknown })
      : {},
  );
  if (!sightings.every((c) => typeof c.ago === "number")) {
    return {
      kind: "failed",
      reason: `the running daemon (${version}) reported clients without their age: ${JSON.stringify(clients)}`,
    };
  }
  return {
    kind: "ok",
    value: {
      bundle,
      clients: sightings.map((c) => ({
        client: sanitizeClient(c.client) ?? null,
        ago: c.ago as number,
      })),
    },
  };
}

export async function askDaemonClients(): Promise<Asked<DaemonClients>> {
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    return {
      kind: "failed",
      reason: describeFailure(outcome).split("\n").join(" — "),
    };
  }
  return parseDaemonClients(outcome.value.version, outcome.value);
}
