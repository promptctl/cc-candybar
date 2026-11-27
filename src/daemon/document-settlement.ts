import { restamp } from "../facts/fact.js";
import {
  TORN_WRITE_SETTLE_MS,
  type DocumentSettlement,
  type DocumentPublication,
  type PublishedDocument,
  type RunFact,
  type WorldState,
} from "../facts/world-state.js";
import type { Readings, Tick } from "../utils/instant.js";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "./environment-output.js";
import type { RunReading } from "./readings.js";

// [LAW:effects-at-boundaries] A command receiving different environment values
// is a different producer. Its identity stays with the host observation.
const DOCUMENT_RUN = Symbol("document producer");
type StampedRun = RunFact & { readonly [DOCUMENT_RUN]?: string };
const BINDINGS = Symbol("keyed document declarations");
interface BoundRun extends StampedRun {
  readonly [BINDINGS]?: {
    readonly shared: StampedRun;
    readonly byId: ReadonlyMap<string, StampedRun>;
  };
}

function publication(held: StampedRun): PublishedDocument | undefined {
  if (held.reading.kind === "pending") return held.beforeRead ?? undefined;
  return {
    reading: held.reading,
    ...(held.settling && { settling: held.settling }),
  };
}

// [LAW:no-ambient-temporal-coupling] The routed view went away. Release all
// live watches and children. Only the data a replacement can reclaim from
// the same document producer is held for the remaining session lifetime.
export function releasedDocuments(
  runs: Readonly<Record<string, StampedRun>>,
): WorldState["runs"] {
  return Object.fromEntries(
    Object.entries(runs).filter(([, run]) => run[DOCUMENT_RUN] !== undefined),
  );
}

export function stampRun(
  prior: StampedRun | undefined,
  observation: RunReading,
  { at, tick }: Readings,
): StampedRun {
  const { documentRun, fault } = observation;
  const held = prior?.[DOCUMENT_RUN] === documentRun ? prior : undefined;
  const preceding = held?.beforeRead?.reading ?? held?.reading;
  const reading = restamp(preceding, observation.reading, at);
  const privateOutput = isEnvironmentOutput(observation);
  // The raw answer, fault and producer are the only inputs. No polling or
  // unrelated world stamp can extend a document's original deadline.
  if (
    held &&
    held.reading === reading &&
    held.fault === fault &&
    (isEnvironmentOutput(held) === privateOutput ||
      (reading.kind === "pending" && held.beforeRead))
  )
    return held;

  const last =
    documentRun !== undefined && held ? publication(held) : undefined;
  const beforeRead =
    reading.kind === "pending" && documentRun !== undefined
      ? (last ?? null)
      : undefined;
  let settling: DocumentSettlement | undefined;
  if (
    documentRun !== undefined &&
    reading.kind === "failed" &&
    reading.failedAt === "parse"
  ) {
    if (last?.reading === reading) settling = last.settling;
    else {
      const priorHold = last?.settling;
      const previous =
        last?.reading.kind === "ok"
          ? last.reading
          : priorHold && tick < priorHold.until
            ? priorHold.previous
            : null;
      settling = {
        until: (tick + TORN_WRITE_SETTLE_MS / 1000) as Tick,
        previous,
      };
    }
  }
  const retainedPrivate =
    held !== undefined &&
    isEnvironmentOutput(held) &&
    (beforeRead != null || settling?.previous != null);
  return environmentOutput(
    {
      reading,
      fault,
      ...(fault !== null && {
        faultAt: held?.fault === fault ? (held.faultAt ?? at) : at,
      }),
      ...(settling && { settling }),
      ...(beforeRead !== undefined && { beforeRead }),
      ...(documentRun !== undefined && { [DOCUMENT_RUN]: documentRun }),
    },
    privateOutput || retainedPrivate,
  );
}

// [LAW:decomposition] Run observations are shared by digest. Only a keyed
// declaration can move between runs while holding a different answer. Its
// record contains just the fields that differ from the shared publication.
function difference(
  shared: StampedRun,
  bound: StampedRun,
): DocumentPublication | undefined {
  if (shared === bound) return undefined;
  const at =
    bound.reading.kind !== "pending" &&
    shared.reading.kind !== "pending" &&
    bound.reading.at !== shared.reading.at
      ? bound.reading.at
      : undefined;
  if (
    at === undefined &&
    bound.beforeRead === shared.beforeRead &&
    bound.settling?.until === shared.settling?.until &&
    bound.settling?.previous === shared.settling?.previous
  )
    return undefined;
  return {
    ...(at !== undefined && { at }),
    ...(bound.beforeRead !== undefined && { beforeRead: bound.beforeRead }),
    ...(bound.settling && { settling: bound.settling }),
  };
}

type RunTable = Readonly<Record<string, BoundRun>>;

export function stampRuns(
  prior: RunTable | undefined,
  released: RunTable | undefined,
  observations: ReadonlyMap<string, RunReading>,
  time: Readings,
): WorldState["runs"] {
  let bindings: Map<string, StampedRun> | undefined;
  const preceding = (id: string) => {
    if (!bindings) {
      bindings = new Map();
      for (const table of [released, prior]) {
        if (!table) continue;
        for (const run of Object.values(table))
          for (const [key, value] of run[BINDINGS]?.byId ?? [])
            bindings.set(key, value);
      }
    }
    return bindings.get(id);
  };
  const runs: Record<string, BoundRun> = Object.create(null);
  for (const [digest, observation] of observations) {
    const old = prior?.[digest] ?? released?.[digest];
    const held = old?.[BINDINGS];
    const priorShared = held?.shared ?? old;
    const shared = stampRun(priorShared, observation, time);
    const names = observation.documents;
    if (!names?.length || observation.documentRun === undefined) {
      runs[digest] = shared;
      continue;
    }
    if (
      old &&
      held &&
      shared === priorShared &&
      names.length === held.byId.size &&
      names.every((id) => held.byId.has(id))
    ) {
      runs[digest] = old;
      continue;
    }
    const byId = new Map<string, StampedRun>();
    const documents: Record<string, DocumentPublication> = Object.create(null);
    for (const id of names) {
      const before = preceding(id);
      const bound =
        before === priorShared ? shared : stampRun(before, observation, time);
      const delta = difference(shared, bound);
      if (delta) documents[id] = delta;
      byId.set(id, delta ? bound : shared);
    }
    runs[digest] = environmentOutput(
      {
        ...shared,
        ...(Object.keys(documents).length && { documents }),
        [BINDINGS]: { shared, byId },
      },
      isEnvironmentOutput(shared) ||
        [...byId.values()].some(isEnvironmentOutput),
    );
  }
  return runs;
}
