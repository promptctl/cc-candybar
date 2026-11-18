// The host's hold of a registry's runs, through a real collector: the
// registry's subscriptions go to the collector as a renderer's output hands
// them back, the collector declares and judges them over the case's source
// runs, and each world state it hands in is what the runs read. `heldRuns`
// does this for each open view of a test that drives a render cache with no
// renderer: `hold` holds a view's runs, and the source answers each session's
// runs from its world state. Every other input of the view is not answered yet
// (`SOURCES_NOTHING`).

import { observable, reaction, runInAction } from "mobx";
import { Collector } from "../../src/daemon/collector";
import {
  registrySubscriptions,
  SOURCES_NOTHING,
  type SessionView,
  type SourceOf,
} from "../../src/renderer/render-cache";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { SourceRuns } from "../../src/daemon/source-runs";
import type { Environment } from "../../src/daemon/foundations/session-env";
import type { HostReadings, ViewSource } from "../../src/dsl/view-source";
import { awaitedReading } from "../../src/facts/awaited";
import {
  UNREAD_ENV,
  UNREAD_RUN,
  type WorldState,
} from "../../src/facts/world-state";
import type { Launcher } from "../../src/proc/launcher";
import { systemTimekeeper } from "../../src/time";
import { ownValue } from "../../src/utils/plain";
import type { SourceRegistry } from "../../src/var-system/sources";
import { daemonFactsOf } from "./daemon-facts";
import { absentOwners, withTranscriptLanes } from "./payload-owners";
import { TEST_ENV } from "./session-environment";
import { viewFacts } from "./view-facts";

export interface CollectedRuns {
  // What a view's source reads of the runs: each run's and each variable's
  // fact in the session's latest world state.
  readonly readings: HostReadings;
  // [LAW:no-ambient-temporal-coupling] Resolves when no run the registry
  // names has a reading a draw waits on, or when `signal` ends the wait, to
  // the stragglers by variable name.
  settled(signal: AbortSignal): Promise<readonly string[]>;
  close(): void;
}

// `registry`'s runs, held for session `session` in `cwd` by a collector over
// `sourceRuns`, with `environment` as the session's.
export function collectedRuns(
  sourceRuns: Pick<SourceRuns, "declare">,
  registry: SourceRegistry,
  environment: Environment = TEST_ENV,
  { cwd = "/tmp", session = "s1" }: { cwd?: string; session?: string } = {},
): CollectedRuns {
  const sid = sessionIdOf(session);
  const owners = withTranscriptLanes({ ...absentOwners(), sourceRuns });
  // The session's latest world state, as the collector last handed it in.
  const latest = observable.box<WorldState | null>(null, { deep: false });
  const collector = new Collector({
    owners,
    daemon: () => daemonFactsOf(),
    clock: systemTimekeeper,
    watched: () => false,
    deliver: async (event) => {
      if (event.kind === "world-state")
        runInAction(() => latest.set(event.worldState));
      return { kind: "answered" };
    },
    log: () => {},
  });
  runInAction(() =>
    latest.set(
      collector.requested(viewFacts(cwd, session), {
        kind: "ok",
        value: environment,
      }),
    ),
  );
  // [LAW:one-source-of-truth] The registry's set, whole, every time it moves:
  // what a renderer's output hands back for the session.
  const stop = reaction(
    () => registrySubscriptions(registry),
    (subscribed) => collector.subscribed({ sources: { [sid]: subscribed } }),
    { fireImmediately: true },
  );
  const document = (): WorldState => {
    const held = latest.get();
    if (held === null) throw new Error("the collector stamped no world state");
    return held;
  };
  const readings: HostReadings = {
    run: (digest) => document().runs[digest] ?? UNREAD_RUN,
    env: (name) => ownValue(document().env, name) ?? UNREAD_ENV,
  };
  const stragglers = () =>
    [...registry.namedRuns()]
      .filter(([, run]) => awaitedReading(readings.run(run.digest).reading))
      .map(([name]) => name);
  return {
    readings,
    // Asked again at its own continuation: a landing that answers a key
    // names the next run in a reaction of the same batch, which can run
    // after the collector's wait, so one wait can end between the answer and
    // the run it names.
    settled: async (signal) => {
      while (!signal.aborted && stragglers().length > 0)
        await collector.settled(sid, signal);
      return stragglers();
    },
    close: () => {
      stop();
      collector.close();
      owners.transcriptLanes.close();
    },
  };
}

export interface HeldRuns {
  readonly source: SourceOf<ViewSource>;
  // The session's runs, held from its view's registry from now on.
  hold(view: SessionView): void;
}

export function heldRuns(
  launcher: Launcher,
  cleanups: Array<() => void>,
): HeldRuns {
  const sourceRuns = new SourceRuns({ launcher, clock: systemTimekeeper });
  const holders = observable.map<SessionId, CollectedRuns>(undefined, {
    deep: false,
  });
  cleanups.push(() => {
    for (const held of holders.values()) held.close();
    sourceRuns.close();
  });
  return {
    source: (view) => ({
      ...SOURCES_NOTHING(view),
      run: (digest) =>
        holders.get(view.sessionId)?.readings.run(digest) ?? UNREAD_RUN,
      env: (name) =>
        holders.get(view.sessionId)?.readings.env(name) ?? UNREAD_ENV,
    }),
    hold: (view) => {
      const held = collectedRuns(sourceRuns, view.registry, TEST_ENV, {
        session: view.sessionId,
      });
      const prior = holders.get(view.sessionId);
      runInAction(() => holders.set(view.sessionId, held));
      prior?.close();
    },
  };
}
