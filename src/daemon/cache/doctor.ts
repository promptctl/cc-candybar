// [LAW:single-enforcer] The host's one reader of the doctor's facts: a
// session's renderer subscribes with what its run asks (src/doctor/gather.ts),
// and the reading lands in the session's world state as its `doctor` fact
// (docs/design/host-and-renderer.md §7). No renderer reads Claude Code's
// settings or spawns a probe; the verdicts it folds are made of this reading.
//
// [LAW:dataflow-not-control-flow] A run is read once: an ask is its run, so a
// new run is a new key and the reading never refreshes on its own. A reading
// lives as long as the session's subscription names its run.

import type { Timekeeper } from "../../time";
import type { Holds } from "../../utils/holds";
import { KeyedSource, NO_WATCH } from "../../utils/keyed-source";
import type { DaemonLogger } from "../../utils/logger";
import {
  REFRESH_TRIGGERS,
  type RefreshLedger,
} from "../../utils/refresh-ledger";
import type { Lane } from "../../utils/reading";
import { valueOf } from "../../utils/logfmt";
import { ok, type Outcome } from "../../utils/outcome";
import { instantAt, type Instant } from "../../utils/instant";
import type { ClientHints } from "../foundations/protocol";
import type { SessionId } from "../foundations/session-id";
import type { RenderSighting } from "../foundations/sightings";
import type { ServingDaemon } from "../foundations/memory-limit";
import type { DoctorAsk, DoctorReading } from "../../doctor/gather";
import { readDoctor } from "../../doctor/read";
import type { DoctorMachineEdge } from "../../doctor/ports";
import { barsOf, sessionWidth } from "../../doctor/sightings";
import { installFacts } from "../../doctor/edge";

// Sessions whose readings nobody holds, kept for a hold's return.
const MAX_ENTRIES = 16;

// What one session's doctor subscription is read with: the session, the
// hints its newest request reported, and its renderer's ask.
export interface DoctorRead {
  readonly session: SessionId;
  readonly hints: ClientHints;
  readonly ask: DoctorAsk;
}

export interface DoctorSourceDeps {
  readonly edge: DoctorMachineEdge;
  // What the sessions' renders said, which the reading judges the session's
  // own bars by, as this process saw them.
  readonly sightings: (
    session: SessionId,
    now: Instant,
  ) => readonly RenderSighting[];
  // This daemon as the doctor's daemon row judges it (src/daemon/limits.ts).
  readonly serving: () => ServingDaemon;
  // The bundle this daemon runs, which the install check judges the clients
  // against.
  readonly bundle: string;
  readonly clock: Pick<Timekeeper, "monotonic" | "after" | "now">;
  readonly logger: DaemonLogger;
  readonly ledger: RefreshLedger;
}

export class DoctorSource {
  private readonly readings: KeyedSource<DoctorRead, DoctorReading>;

  constructor(deps: DoctorSourceDeps) {
    this.readings = new KeyedSource({
      name: "doctor",
      scope: "session",
      // The session and its ask: the hints are what the first declaration
      // of a run reported, so a request that moves them reads no run again.
      keyOf: ({ session, ask }) => `${session}\n${JSON.stringify(ask)}`,
      fields: ({ session, ask }) => `sid=${valueOf(session)} run=${ask.run}`,
      read: (input) => readDoctorRun(deps, input),
      every: () => null,
      watch: NO_WATCH,
      maxEntries: MAX_ENTRIES,
      lines: REFRESH_TRIGGERS,
      logger: deps.logger,
      ledger: deps.ledger,
      clock: deps.clock,
    });
  }

  declare(holds: Holds, input: DoctorRead): Lane<DoctorReading> {
    return this.readings.declare(holds, input);
  }

  close(): void {
    this.readings.close();
  }
}

// [LAW:no-silent-failure] A read that throws — a probe the rate limit refused
// (`DoctorBusy`) among them — is the run's failed reading, which the renderer
// shows on the session's bar; no report is made of facts the doctor did not
// see.
export async function readDoctorRun(
  deps: Pick<
    DoctorSourceDeps,
    "edge" | "sightings" | "serving" | "bundle" | "clock"
  >,
  { session, hints, ask }: DoctorRead,
): Promise<Outcome<DoctorReading>> {
  try {
    const said = deps.sightings(session, instantAt(deps.clock));
    const machine = await readDoctor(deps.edge, hints, ask, {
      serving: { kind: "ok", value: deps.serving() },
      rateLimits: { kind: "ok", value: said.map((s) => s.rateLimits) },
      transcripts: { kind: "ok", value: said.map((s) => s.transcript) },
      bars: { kind: "ok", value: barsOf(ask.sighted, said) },
      width: sessionWidth(session, said),
    });
    return ok({
      run: ask.run,
      kind: "read",
      machine,
      // The clients that drew the session's bars, and the daemon the run
      // reached — this process.
      install: installFacts(
        deps.edge.install,
        deps.bundle,
        said.map((s) => s.client),
      ),
    });
  } catch (e) {
    return ok({
      run: ask.run,
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}
