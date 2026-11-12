// [LAW:one-source-of-truth] exception: `check` builds a registry with no host,
// so nothing holds the runs its `shell` and `file` sources name. This holds
// them, through the one step from a set of runs to its lanes the collector
// takes (`declareRuns`), and answers the view's `run` from those lanes. It adds
// no step of its own between them. candybar-host-renderer-x96a.f27 deletes it:
// once `check` draws through `Renderer.answer` with a collector in process, as
// the demo does, the collector holds these runs.

import { observable, reaction, runInAction, when } from "mobx";
import {
  declareRuns,
  type SourceLane,
  type SourceRuns,
} from "./daemon/source-runs.js";
import { awaitedReading } from "./daemon/render-payload.js";
import { judgeRun } from "./daemon/judge-run.js";
import { restamp } from "./facts/fact.js";
import { UNREAD_RUN, type RunFact } from "./facts/world-state.js";
import { Holds } from "./utils/holds.js";
import type { Current } from "./utils/reading.js";
import type { JsonValue } from "./var-system/types.js";
import type { Instant } from "./utils/instant.js";
import type { SourceRegistry } from "./var-system/sources.js";

export class CheckRuns {
  private readonly holds = new Holds();
  // The lane each held run reads, by digest: observable, so a publish and the
  // wait are reactions over the lanes held now.
  private readonly lanes = observable.map<string, SourceLane>(undefined, {
    deep: false,
  });
  // The fact each run last answered, by digest, beside the lane's answer it
  // was made from: a lane holds one object until its answer moves, so a run
  // that moved nothing answers the same fact, and the registry's publish,
  // which compares by reference, publishes nothing again.
  private readonly answered = new Map<
    string,
    { readonly from: Current<JsonValue>; readonly fact: RunFact }
  >();
  // [LAW:no-silent-failure] A run whose declaration threw, which a reaction
  // would only log: the wait throws it, failing the check.
  private readonly thrown = observable.box<{ readonly error: unknown } | null>(
    null,
    { deep: false },
  );
  private readonly stop: () => void;

  constructor(
    sourceRuns: Pick<SourceRuns, "declare">,
    private readonly registry: SourceRegistry,
    // The instant every pass is drawn at, which each answered reading carries.
    private readonly at: Instant,
  ) {
    this.stop = reaction(
      () => registry.subscriptions(),
      (runs) => {
        const { result } = this.holds.declare(() =>
          declareRuns(
            sourceRuns,
            this.holds,
            // The registry's set moved, so this is where it arrives: each
            // run is judged here, once per move.
            new Map(runs.map((run) => [run.digest, judgeRun(run)])),
            (_, declare) => declare(),
          ),
        );
        for (const digest of this.answered.keys())
          if (!result.has(digest)) this.answered.delete(digest);
        runInAction(() => this.lanes.replace([...result]));
      },
      {
        fireImmediately: true,
        onError: (error) => runInAction(() => this.thrown.set({ error })),
      },
    );
  }

  // What the view's source answers for a run: the lane's reading as it
  // stands, or a run not held yet.
  run(digest: string): RunFact {
    const lane = this.lanes.get(digest);
    if (lane === undefined) return UNREAD_RUN;
    const from = lane.current();
    const fault = lane.fault();
    const prior = this.answered.get(digest);
    if (prior?.from === from && prior.fact.fault === fault) return prior.fact;
    const fact: RunFact = { reading: restamp(undefined, from, this.at), fault };
    this.answered.set(digest, { from, fact });
    return fact;
  }

  // [LAW:no-ambient-temporal-coupling] Resolves when no run the registry
  // names has a reading a draw waits on (`awaitedReading`, the request's own
  // rule), or when `signal` ends the wait, to the stragglers by variable name.
  // Asked again at its own continuation: a landing that answers a key names
  // the next run in a reaction of the same batch, which can run after this
  // wait's, so one evaluation can see nothing pending between the answer and
  // the run it names.
  async settled(signal: AbortSignal): Promise<readonly string[]> {
    while (!signal.aborted && this.awaited().length > 0) {
      try {
        await when(() => this.awaited().length === 0, { signal });
      } catch (e) {
        // The signal's abort is the one rejection the wait expects.
        if (!signal.aborted) throw e;
      }
    }
    return this.awaited();
  }

  private awaited(): string[] {
    const thrown = this.thrown.get();
    if (thrown !== null) throw thrown.error;
    return [...this.registry.namedRuns()]
      .filter(([, run]) => awaitedReading(this.run(run.digest).reading))
      .map(([name]) => name);
  }

  close(): void {
    this.stop();
    this.holds.close();
  }
}
