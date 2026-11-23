// [LAW:single-enforcer] The host's collector (docs/design/host-and-renderer.md
// §6): the one reader of every session's world. It keeps one record per
// session the host has had a request from, holds the owners' entries that
// session reads (the built-in lanes at the keys its newest request names, and
// each plugin source its renderer subscribes to), stamps one world state from
// what they hold, and hands it to the renderer. A renderer declares nothing,
// holds no lane and stamps nothing.
//
// [LAW:no-ambient-temporal-coupling] The renderer receives each session's
// documents in the order the collector made them: a request's document is the
// one `requested` returns, which goes with the session's `context` ahead of the
// request, and every later stamp that moved is handed in alone, from here.
//
// [LAW:no-ambient-temporal-coupling] The collector owns the session's
// lifetime: a session idle across a whole sweep, with no open feed and no
// turn in flight, is retired, and its record goes once the retire settles.

import { inspect } from "node:util";
import {
  compareStructural,
  computed,
  observable,
  observableRef,
  reaction,
  runInAction,
  when,
  type IComputedValue,
  type IObservableValue,
} from "mobx";
import {
  type DaemonFacts,
  type WorldState,
  stampFailureOf,
  shortDigest,
} from "../facts/world-state.js";
import {
  type Event,
  type Subscription,
  type Subscriptions,
} from "../renderer-interface/interface.js";
import type { Timekeeper } from "../time.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { Holds } from "../utils/holds.js";
import type { DaemonLogger } from "../utils/logger.js";
import { failed, ok, type Failed, type Ok } from "../utils/outcome.js";
import { assembleFacts, failedStamp } from "./facts-assembly.js";
import {
  declareLanes,
  readingsOf,
  settledLanes,
  type DeclaredLanes,
  type Locator,
  type Readings,
  type RenderPayloadDeps,
} from "./readings.js";
import {
  type Subscribed,
  type ViewFacts,
} from "../renderer-interface/request-context.js";
import type { SessionId } from "./foundations/session-id.js";
import { judgeRun } from "./foundations/judge-run.js";
import type { SessionEnvironment } from "./foundations/session-env.js";
import { valueOf } from "../utils/logfmt.js";
import type { CollectorStats } from "./foundations/stats-snapshot";
import { awaitsReading } from "../facts/awaited.js";

// [LAW:no-ambient-temporal-coupling] The collector's one timer, armed by the
// first session and stopped with the last: every interval it retires each
// session no request named since the interval before and no open feed draws,
// which releases its holds, so an owner's period stops visiting a repo, pane
// or session file 2.5 to 5 minutes after the session's last request.
export const SESSION_SWEEP_MS = 150_000;

// What the collector hands a renderer of its own accord.
export type HandedIn = Extract<Event, { kind: "world-state" | "retire" }>;

export interface CollectorDeps {
  // The owners every lane is read from, and the log for those whose owner
  // does not log.
  readonly owners: RenderPayloadDeps;
  // The daemon diagnostics every session's document carries. An observable
  // change restamps every session.
  readonly daemon: () => DaemonFacts;
  readonly clock: Pick<Timekeeper, "now" | "every" | "detach">;
  // [LAW:one-source-of-truth] Whether an open feed draws the session: the
  // frame feeds are the one record of who is watching.
  readonly watched: (session: SessionId) => boolean;
  // The host's one path to its renderer, for what the collector hands in
  // alone; it settles once the renderer's turn did, and the collector reads
  // nothing of how it ended.
  readonly deliver: (event: HandedIn) => Promise<unknown>;
  readonly log: DaemonLogger;
}

interface CollectedRequest<Context extends ViewFacts> {
  readonly context: Context;
  readonly environment: SessionEnvironment;
}

// [LAW:one-source-of-truth] A declaration keeps its request beside the lanes
// read at its keys. The same request can configure a replacement renderer.
interface Declared<
  Context extends ViewFacts,
> extends CollectedRequest<Context> {
  readonly lanes: DeclaredLanes;
}

// What a declaration takes the session's holds for: its keys and its
// subscriptions.
interface DeclaredFor<Context extends ViewFacts> {
  readonly session: SessionId;
  readonly request: CollectedRequest<Context>;
  readonly subscriptions: Subscribed;
}

// The session's latest document and the read it was stamped from.
interface Stamped {
  document: WorldState;
  from: StampInputs;
}

// What a session reads: the holds its declaration took, and what the owners
// hold at them.
interface Reader<Context extends ViewFacts> {
  readonly holds: Holds;
  readonly declared: IObservableValue<Declared<Context>>;
  // [LAW:one-source-of-truth] The one read of the owners a request's stamp
  // and every landing's stamp take, so a request's stamp is not taken again
  // by the reaction its declaration wakes.
  readonly inputs: IComputedValue<StampInputs>;
}

// [LAW:types-are-the-program] A session the collector reads, or one whose
// retire is on its way to the renderer, which holds nothing and reads nothing.
interface Live<Context extends ViewFacts> extends Reader<Context> {
  readonly kind: "live";
  readonly stop: () => void;
}
type Phase<Context extends ViewFacts> =
  | Live<Context>
  | { readonly kind: "retiring" };

interface SessionRecord<Context extends ViewFacts> {
  readonly session: SessionId;
  readonly stamped: Stamped;
  subscriptions: Subscribed;
  // Whether a request named the session since the last sweep.
  active: boolean;
  // The renderer's turns on the session still under way: each holds the
  // session as an open feed does.
  turns: number;
  phase: Phase<Context>;
}

// What a stamp reads: what the session's owners read, or what stopped them
// reading (a derivation that throws is a stamp that did not complete, not a
// reaction that never ran), and the daemon's own facts, read apart from them,
// so owners that fail to read leave the daemon's facts current, and a move of
// the daemon's facts re-reads no owner.
interface StampInputs {
  readonly owners: Ok<Readings> | Failed;
  readonly daemon: DaemonFacts;
}

const locatorOf = ({
  context: { hookData, cwd, hints },
  environment,
}: CollectedRequest<ViewFacts>): Locator => ({
  hookData,
  cwd,
  hints,
  environment,
});

// [LAW:single-enforcer] A set is judged where it arrives, and only for the
// digests new to it: a run the session already subscribed keeps its verdict,
// so a request, which declares the set again, judges nothing.
const sourcesOf = (
  subscriptions: readonly Subscription[],
  prior: Subscribed,
): Subscribed => ({
  plugins: new Map(
    subscriptions.flatMap((s) =>
      s.kind === "plugin" ? [[s.source, s.folder] as const] : [],
    ),
  ),
  runs: new Map(
    subscriptions.flatMap((s) =>
      s.kind === "run"
        ? [
            [
              s.run.digest,
              prior.runs.get(s.run.digest) ?? judgeRun(s.run),
            ] as const,
          ]
        : [],
    ),
  ),
  env: [
    ...new Set(
      subscriptions.flatMap((s) => (s.kind === "env" ? [s.name] : [])),
    ),
  ].sort(),
});

// [LAW:one-source-of-truth] A run is its digest, so two sets naming the same
// digests are the same set.
const sameSources = (a: Subscribed, b: Subscribed): boolean =>
  a.plugins.size === b.plugins.size &&
  [...a.plugins].every(([name, folder]) => b.plugins.get(name) === folder) &&
  a.runs.size === b.runs.size &&
  [...a.runs.keys()].every((digest) => b.runs.has(digest)) &&
  a.env.length === b.env.length &&
  a.env.every((name, i) => b.env[i] === name);

// A live session's reads stop and its holds close.
function release({
  stop,
  holds,
}: Pick<Live<ViewFacts>, "stop" | "holds">): void {
  stop();
  holds.close();
}

export class Collector<Context extends ViewFacts = ViewFacts> {
  // [LAW:one-source-of-truth] Observable as far as a request's wait reads
  // them (`settled`): which sessions are read, each one's phase, its latest
  // stamp and its subscriptions.
  private readonly records = observable.map<SessionId, SessionRecord<Context>>(
    undefined,
    { deep: false },
  );
  private stopSweep: (() => void) | null = null;

  constructor(private readonly deps: CollectorDeps) {}

  // [LAW:one-source-of-truth] The daemon's facts, derived once for every
  // session, and moved only when what they say moved.
  private readonly daemon = computed(() => this.deps.daemon(), {
    equals: compareStructural,
  });

  // [LAW:single-enforcer] A request names the session's keys: they are
  // declared again and stamped in one action, and that stamp is returned to
  // go with the session's `context`. The record's reaction runs when the action ends,
  // finds the read this stamp took, and hands in nothing alone. A request for
  // a retiring session makes it live again.
  requested(context: Context, environment: SessionEnvironment): WorldState {
    const request = { context, environment };
    const sessionId = context.hookData.session_id;
    const document = runInAction(() => {
      const held = this.records.get(sessionId);
      if (held === undefined) {
        const opened = this.open(sessionId, request);
        this.records.set(sessionId, opened);
        return opened.stamped.document;
      }
      held.active = true;
      const { phase } = held;
      if (phase.kind === "live")
        phase.declared.set(this.declared({ ...held, request }, phase.holds));
      const live = phase.kind === "live" ? phase : this.live(held, request);
      held.phase = live;
      this.stamp(held, live.inputs.get());
      return held.stamped.document;
    });
    this.armSweep();
    return document;
  }

  // [LAW:single-enforcer] A request's wait on its world state (rule 1 of the
  // model): until the session's latest stamp has no fact its draw waits on
  // that has never answered, over the runs its renderer subscribes to now
  // (`awaitsReading`), or the session is no longer read, or `signal` ends it.
  // The wait triggers no read: the owners' reads follow the world, and each
  // stamp they move goes to the renderer ahead of the request, so the request
  // draws the world state the wait ended on. It reads the subscriptions as
  // they move, so a turn that drops a run (a view retired, a config that no
  // longer names it) ends the wait on that run.
  async settled(session: SessionId, signal: AbortSignal): Promise<void> {
    try {
      await when(
        () => {
          const record = this.records.get(session);
          return (
            record?.phase.kind !== "live" ||
            !awaitsReading(record.stamped.document, {
              plugins: record.subscriptions.plugins.keys(),
              runs: record.subscriptions.runs.keys(),
              env: record.subscriptions.env,
            })
          );
        },
        { signal },
      );
    } catch (e) {
      // The signal's abort is the one rejection the wait expects.
      if (!signal.aborted) throw e;
    }
  }

  // A click is a person's input naming the session, as a request is, so the
  // next sweep keeps it whatever the click's turn draws in the meantime. A
  // retiring session stays retiring: only a request reopens its reads.
  clicked(session: SessionId): void {
    const record = this.records.get(session);
    if (record?.phase.kind === "live") record.active = true;
  }

  // [LAW:one-source-of-truth] The aggregate of the renderers' subscriptions:
  // a session whose set moved is declared again, and one absent from them has
  // no plugin sources. A retiring session takes its set too, and holds none
  // of it.
  subscribed(subscriptions: Pick<Subscriptions, "sources">): void {
    // A record's own keys only, so a session named like an inherited member
    // (`constructor`) is a key absent.
    const sources = new Map(
      Object.entries(subscriptions.sources) as Array<
        [SessionId, readonly Subscription[]]
      >,
    );
    // [LAW:no-silent-failure] A renderer subscribes only for sessions the host
    // handed it, and the host keeps a session's record until its retire
    // settles: a session with no record is the host's bug.
    for (const session of sources.keys()) {
      if (!this.records.has(session))
        this.deps.log(
          "error",
          `subscriptions name session ${JSON.stringify(session)}, which the collector has no record of`,
        );
    }
    runInAction(() => {
      for (const record of this.records.values()) {
        const next = sourcesOf(
          sources.get(record.session) ?? [],
          record.subscriptions,
        );
        if (sameSources(next, record.subscriptions)) continue;
        // [LAW:nothing-unseen] A refusal is logged once, as its run joins
        // the set; a set that keeps it says nothing more.
        for (const [digest, judged] of next.runs)
          if (
            judged.kind === "refused" &&
            !record.subscriptions.runs.has(digest)
          )
            this.deps.log(
              "warn",
              `run refused sid=${JSON.stringify(record.session)} digest=${shortDigest(digest)} reason=${valueOf(judged.reason)}`,
            );
        record.subscriptions = next;
        const { phase } = record;
        if (phase.kind === "live")
          phase.declared.set(
            this.declared(
              { ...record, request: phase.declared.get() },
              phase.holds,
            ),
          );
      }
    });
  }

  // [LAW:no-ambient-temporal-coupling] A turn on a session holds it for as
  // long as it runs, however long that is, so no sweep retires the session
  // under a turn still drawing it. Its release says nothing of activity: only
  // a request keeps a session past the next sweep, so a turn the collector's
  // own deliveries start never keeps a session nobody draws. Only a live
  // session is held: a retiring one has released its reads, and its record
  // goes once the retire settles, as one with no record has gone.
  holding(session: SessionId): () => void {
    const record = this.records.get(session);
    if (record?.phase.kind !== "live") return () => {};
    record.turns++;
    return () => {
      record.turns--;
    };
  }

  // [LAW:one-source-of-truth] Every session the collector reads has its
  // request at the keys of its latest stamp. Restarting reads that pair
  // without reactivating a session or handing the renderer its environment.
  liveSessions(): ReadonlyArray<{ context: Context; worldState: WorldState }> {
    return [...this.records.values()].flatMap(({ phase, stamped }) =>
      phase.kind === "live"
        ? [
            {
              context: phase.declared.get().context,
              worldState: stamped.document,
            },
          ]
        : [],
    );
  }

  // One sweep. Public so a test can run it at an instant it chose.
  sweep(): void {
    for (const record of this.records.values()) {
      if (record.phase.kind !== "live") continue;
      if (record.active) record.active = false;
      else if (record.turns === 0 && !this.deps.watched(record.session))
        this.retire(record, record.phase);
    }
  }

  stats(): CollectorStats {
    const all = [...this.records.values()];
    return {
      sessions: all.length,
      retiring: all.filter((r) => r.phase.kind === "retiring").length,
    };
  }

  // Every session's holds close with the daemon.
  close(): void {
    this.disarmSweep();
    for (const { phase } of this.records.values())
      if (phase.kind === "live") release(phase);
    runInAction(() => this.records.clear());
  }

  private open(
    session: SessionId,
    request: CollectedRequest<Context>,
  ): SessionRecord<Context> {
    const subscriptions: Subscribed = {
      plugins: new Map(),
      runs: new Map(),
      env: [],
    };
    const reader = this.reader({ session, request, subscriptions });
    const first = reader.inputs.get();
    // [LAW:no-silent-failure] A session's first stamp has no document to keep:
    // one that fails fails the request that named it, and takes nothing.
    let document: WorldState;
    try {
      if (first.owners.kind === "failed") throw new Error(first.owners.reason);
      document = assembleFacts(
        undefined,
        session,
        first.owners.value,
        first.daemon,
        instantAt(this.deps.clock),
      );
    } catch (e) {
      reader.holds.close();
      throw e;
    }
    const stamped: Stamped = observable(
      { document, from: first },
      { document: observableRef, from: false },
    );
    return observable(
      {
        session,
        stamped,
        subscriptions,
        active: true,
        turns: 0,
        phase: this.watch(session, stamped, reader),
      },
      {
        session: false,
        stamped: false,
        subscriptions: observableRef,
        active: false,
        turns: false,
        phase: observableRef,
      },
    );
  }

  // A retiring record read again: holds at the request's keys, and its stamps
  // go on from the document it kept.
  private live(
    record: SessionRecord<Context>,
    request: CollectedRequest<Context>,
  ): Live<Context> {
    return this.watch(
      record.session,
      record.stamped,
      this.reader({ ...record, request }),
    );
  }

  private reader(keys: DeclaredFor<Context>): Reader<Context> {
    const holds = new Holds();
    const declared = observable.box(this.declared(keys, holds), {
      deep: false,
    });
    const owners = computed(() => this.read(declared.get()));
    return {
      holds,
      declared,
      inputs: computed(() => ({
        owners: owners.get(),
        daemon: this.daemon.get(),
      })),
    };
  }

  // [LAW:no-ambient-temporal-coupling] The stamp of every owner landing is
  // taken in a reaction's effect, not a derivation: a stamp is the instant of
  // its turn, and a computed that read the clock and its own prior answer
  // would answer by when it ran.
  private watch(
    session: SessionId,
    stamped: Stamped,
    reader: Reader<Context>,
  ): Live<Context> {
    const stop = reaction(
      () => reader.inputs.get(),
      (moved) =>
        runInAction(() => {
          // The read a request's stamp already took.
          if (moved === stamped.from) return;
          // [LAW:no-ambient-temporal-coupling] A stamp and its delivery are
          // one action, so a request's wait (`settled`) sees only a stamp
          // whose world state is already in the mailbox, ahead of its turn.
          if (this.stamp({ session, stamped }, moved))
            this.deps.clock.detach(`world state delivery ${session}`, () =>
              this.deps.deliver({
                kind: "world-state",
                worldState: stamped.document,
              }),
            );
        }),
      {
        // The expression cannot throw; the effect's catch is `stamp`.
        onError: (e) =>
          this.deps.log(
            "error",
            `world state stamp threw sid=${JSON.stringify(session)}: ${inspect(e)}`,
          ),
      },
    );
    return { kind: "live", ...reader, stop };
  }

  // [LAW:single-enforcer] The one taker of a session's holds: every keyed
  // entry at its locator's keys and each subscribed plugin source, taken in
  // one body, so the entry a moved key names is held before the one it left
  // is released (`Holds.declare`).
  // [LAW:no-silent-failure] A declaration that throws keeps the holds it had,
  // and its lanes answer its failure, naming the cause, which is logged here.
  private declared(
    { session, request, subscriptions }: DeclaredFor<Context>,
    holds: Holds,
  ): Declared<Context> {
    const sid = JSON.stringify(session);
    try {
      const {
        result: { lanes, faults },
        acquired,
        released,
      } = holds.declare(() =>
        declareLanes(
          this.deps.owners,
          holds,
          locatorOf(request),
          subscriptions,
        ),
      );
      for (const fault of faults)
        this.deps.log("error", `session declaration threw sid=${sid} ${fault}`);
      // [LAW:verifiable-goals] A declaration that moved a hold — a request
      // naming another key, a subscription moving — says so; one that kept
      // what the session held writes nothing.
      if (acquired + released > 0)
        this.deps.log(
          "info",
          `session declared sid=${sid} acquired=${acquired} released=${released} held=${holds.size}`,
        );
      return { ...request, lanes };
    } catch (e) {
      this.deps.log(
        "error",
        `session declaration threw sid=${sid}: ${inspect(e)}`,
      );
      return {
        ...request,
        lanes: settledLanes(
          failed(`session declaration threw: ${String(e)}`, "read"),
          subscriptions,
        ),
      };
    }
  }

  private inputsOf(locator: Locator) {
    return { ...locator, deps: this.deps.owners };
  }

  private read(declared: Declared<Context>): Ok<Readings> | Failed {
    try {
      return ok(readingsOf(this.inputsOf(locatorOf(declared)), declared.lanes));
    } catch (e) {
      return failed(`reading the owners: ${String(e)}`, "read");
    }
  }

  // [LAW:single-enforcer] The one stamp of a session's document, against the
  // one it replaces: the document itself when nothing it holds moved, and a
  // failed stamp keeps the prior readings and says why (`failedStamp`).
  // Answers whether the document moved.
  private stamp(
    { session, stamped }: Pick<SessionRecord<Context>, "session" | "stamped">,
    moved: StampInputs,
  ): boolean {
    const prior = stamped.document;
    const { owners, daemon } = moved;
    const next =
      owners.kind === "failed"
        ? failedStamp(prior, owners.reason, daemon)
        : this.assembled(
            prior,
            owners.value,
            daemon,
            instantAt(this.deps.clock),
          );
    const failure = next === prior ? null : stampFailureOf(next);
    // [LAW:no-silent-failure] Told to the log as well as to the bar.
    if (failure !== null)
      this.deps.log(
        "error",
        `world state sid=${JSON.stringify(session)}: ${failure}`,
      );
    stamped.document = next;
    stamped.from = moved;
    return next !== prior;
  }

  private assembled(
    prior: WorldState,
    readings: Readings,
    daemon: DaemonFacts,
    at: Instant,
  ): WorldState {
    try {
      return assembleFacts(prior, prior.session, readings, daemon, at);
    } catch (e) {
      return failedStamp(
        prior,
        `stamping the world state: ${String(e)}`,
        daemon,
      );
    }
  }

  // [LAW:no-ambient-temporal-coupling] A retired session holds nothing at
  // once, and its record stays `retiring` until the retire settles: an output
  // taken meanwhile may still name it. A settled retire, answered or threw,
  // leaves the renderer holding none of the session's document
  // (src/renderer-interface/interface.ts), so the record goes either way. It goes only
  // from the retiring period this retire began: a record a request revived,
  // or one retired again since, is not this retire's to remove.
  private retire(record: SessionRecord<Context>, live: Live<Context>): void {
    release(live);
    const retiring = { kind: "retiring" } as const;
    runInAction(() => (record.phase = retiring));
    this.deps.log(
      "info",
      `session retired sid=${JSON.stringify(record.session)}`,
    );
    // [LAW:no-ambient-temporal-coupling] The record leaves however the
    // retire ended: one that threw reaches the clock, and keeping the record
    // would only hold a session nothing will retire again.
    this.deps.clock.detach(`session retire ${record.session}`, async () => {
      try {
        await this.deps.deliver({ kind: "retire", session: record.session });
      } finally {
        if (
          record.phase === retiring &&
          this.records.get(record.session) === record
        )
          runInAction(() => this.records.delete(record.session));
        if (this.records.size === 0) this.disarmSweep();
      }
    });
  }

  private armSweep(): void {
    if (this.stopSweep !== null) return;
    this.stopSweep = this.deps.clock.every(
      "session sweep",
      SESSION_SWEEP_MS,
      () => this.sweep(),
      { unref: true },
    );
  }

  private disarmSweep(): void {
    this.stopSweep?.();
    this.stopSweep = null;
  }
}
