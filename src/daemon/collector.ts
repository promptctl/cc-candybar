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
// one `requested` returns, which goes with the session's `config` ahead of the
// request, and every later stamp that moved is handed in alone, from here.
//
// [LAW:no-ambient-temporal-coupling] The collector owns the session's
// lifetime: a session idle across a whole sweep, with no open feed and no
// turn in flight, is retired, and its record goes once the retire settles.

import { inspect } from "node:util";
import {
  computed,
  observable,
  reaction,
  runInAction,
  type IComputedValue,
  type IObservableValue,
} from "mobx";
import type { Fact } from "../facts/fact.js";
import type { UpdateNotice, WorldState } from "../facts/world-state.js";
import type {
  Event,
  Subscription,
  Subscriptions,
} from "../renderer/interface.js";
import type { Timekeeper } from "../time.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { Holds } from "../utils/holds.js";
import type { DaemonLogger } from "../utils/logger.js";
import { failed } from "../utils/outcome.js";
import { sameKey, type StorageKey } from "./cache/managed-storage.js";
import {
  assembleFacts,
  failedStamp,
  stampFailureOf,
} from "./facts-assembly.js";
import {
  declareLanes,
  readingsOf,
  settledLanes,
  type DeclaredLanes,
  type Subscribed,
  type Readings,
  type RenderPayloadDeps,
  type ViewFacts,
} from "./render-payload.js";
import type { SessionId } from "./session-id.js";

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
  // The daemon's one update fact, stamped by its watch
  // (src/daemon/update-notice.ts): every session's document carries it.
  readonly update: () => Fact<UpdateNotice>;
  readonly clock: Pick<Timekeeper, "now" | "every">;
  // [LAW:one-source-of-truth] Whether an open feed draws the session: the
  // frame feeds are the one record of who is watching.
  readonly watched: (session: SessionId) => boolean;
  // The host's one path to its renderer, for what the collector hands in
  // alone; it settles once the renderer's turn did, and the collector reads
  // nothing of how it ended.
  readonly deliver: (event: HandedIn) => Promise<unknown>;
  readonly log: DaemonLogger;
}

// What a session's holds were declared for: the keys of its newest request,
// and the lanes that declaration took, written whole by each declaration so a
// read never joins one request's keys to another's lanes.
interface Declared {
  readonly locator: ViewFacts;
  readonly lanes: DeclaredLanes;
}

// What a declaration takes the session's holds for: its keys and its
// subscriptions.
interface DeclaredFor {
  readonly session: SessionId;
  readonly locator: ViewFacts;
  readonly subscriptions: Subscribed;
}

// The session's latest document, which its stamps replace and its `config`
// carries, and the read it was stamped from.
interface Stamped {
  document: WorldState;
  from: StampInputs;
}

// What a session reads: the holds its declaration took, and what the owners
// hold at them.
interface Reader {
  readonly holds: Holds;
  readonly declared: IObservableValue<Declared>;
  // [LAW:one-source-of-truth] The one read of the owners a request's stamp
  // and every landing's stamp take, so a request's stamp is not taken again
  // by the reaction its declaration wakes.
  readonly inputs: IComputedValue<StampInputs>;
}

// [LAW:types-are-the-program] A session the collector reads, or one whose
// retire is on its way to the renderer, which holds nothing and reads nothing.
interface Live extends Reader {
  readonly kind: "live";
  readonly stop: () => void;
}
type Phase = Live | { readonly kind: "retiring" };

interface SessionRecord {
  readonly session: SessionId;
  readonly stamped: Stamped;
  subscriptions: Subscribed;
  // Whether a request named the session since the last sweep.
  active: boolean;
  // The renderer's turns on the session still under way: each holds the
  // session as an open feed does.
  turns: number;
  phase: Phase;
}

// What a stamp reads, or what stopped it reading: a derivation that throws is
// a stamp that did not complete, not a reaction that never ran.
type StampInputs =
  | {
      readonly kind: "read";
      readonly readings: Readings;
      readonly update: Fact<UpdateNotice>;
    }
  | { readonly kind: "failed"; readonly reason: string };

export interface CollectorStats {
  readonly sessions: number;
  readonly retiring: number;
}

// What a session's declaration keys on, of the request that named it.
const locatorOf = (req: ViewFacts): ViewFacts => ({
  hookData: req.hookData,
  cwd: req.cwd,
  hints: req.hints,
});

const sourcesOf = (subscriptions: readonly Subscription[]): Subscribed => ({
  plugins: new Map(
    subscriptions.flatMap((s) =>
      s.kind === "plugin" ? [[s.source, s.storage] as const] : [],
    ),
  ),
  runs: new Map(
    subscriptions.flatMap((s) =>
      s.kind === "run" ? [[s.run.digest, s.run] as const] : [],
    ),
  ),
});

// [LAW:one-source-of-truth] A run is its digest, so two sets naming the same
// digests are the same set.
const sameSources = (a: Subscribed, b: Subscribed): boolean =>
  a.plugins.size === b.plugins.size &&
  [...a.plugins].every(([name, key]) => {
    const other: StorageKey | undefined = b.plugins.get(name);
    return other !== undefined && sameKey(key, other);
  }) &&
  a.runs.size === b.runs.size &&
  [...a.runs.keys()].every((digest) => b.runs.has(digest));

// A live session's reads stop and its holds close.
function release({ stop, holds }: Live): void {
  stop();
  holds.close();
}

export class Collector {
  private readonly records = new Map<SessionId, SessionRecord>();
  private stopSweep: (() => void) | null = null;

  constructor(private readonly deps: CollectorDeps) {}

  // [LAW:single-enforcer] A request names the session's keys: they are
  // declared again and stamped in one action, and that stamp is returned to
  // go with the session's `config`. The record's reaction runs when the action ends,
  // finds the read this stamp took, and hands in nothing alone. A request for
  // a retiring session makes it live again.
  requested(req: ViewFacts): WorldState {
    const locator = locatorOf(req);
    const sessionId = req.hookData.session_id;
    const document = runInAction(() => {
      const held = this.records.get(sessionId);
      if (held === undefined) {
        const opened = this.open(sessionId, locator);
        this.records.set(sessionId, opened);
        return opened.stamped.document;
      }
      held.active = true;
      const { phase } = held;
      if (phase.kind === "live")
        phase.declared.set(this.declared({ ...held, locator }, phase.holds));
      const live = phase.kind === "live" ? phase : this.live(held, locator);
      held.phase = live;
      this.stamp(held, live.inputs.get());
      return held.stamped.document;
    });
    this.armSweep();
    return document;
  }

  // A click is a person's input naming the session, as a request is, so the
  // next sweep keeps it whatever the click's turn draws in the meantime. A
  // retiring session stays retiring: only a request reopens its reads.
  clicked(session: SessionId): void {
    const record = this.records.get(session);
    if (record?.phase.kind === "live") record.active = true;
  }

  // [LAW:one-source-of-truth] Every renderer output's subscriptions, whole:
  // a session whose set moved is declared again, and one absent from them has
  // no plugin sources. A retiring session takes its set too, and holds none
  // of it.
  subscribed({ sources }: Subscriptions): void {
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
        const next = sourcesOf(sources.get(record.session) ?? []);
        if (sameSources(next, record.subscriptions)) continue;
        record.subscriptions = next;
        const { phase } = record;
        if (phase.kind === "live")
          phase.declared.set(
            this.declared(
              { ...record, locator: phase.declared.get().locator },
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
    this.records.clear();
  }

  private open(session: SessionId, locator: ViewFacts): SessionRecord {
    const subscriptions: Subscribed = { plugins: new Map(), runs: new Map() };
    const reader = this.reader({ session, locator, subscriptions });
    const first = reader.inputs.get();
    // [LAW:no-silent-failure] A session's first stamp has no document to keep:
    // one that fails fails the request that named it, and takes nothing.
    let document: WorldState;
    try {
      if (first.kind === "failed") throw new Error(first.reason);
      document = assembleFacts(
        undefined,
        session,
        first.readings,
        first.update,
        instantAt(this.deps.clock),
      );
    } catch (e) {
      reader.holds.close();
      throw e;
    }
    const stamped: Stamped = { document, from: first };
    return {
      session,
      stamped,
      subscriptions,
      active: true,
      turns: 0,
      phase: this.watch(session, stamped, reader),
    };
  }

  // A retiring record read again: holds at the request's keys, and its stamps
  // go on from the document it kept.
  private live(record: SessionRecord, locator: ViewFacts): Live {
    return this.watch(
      record.session,
      record.stamped,
      this.reader({ ...record, locator }),
    );
  }

  private reader(keys: DeclaredFor): Reader {
    const holds = new Holds();
    const declared = observable.box(this.declared(keys, holds), {
      deep: false,
    });
    return {
      holds,
      declared,
      inputs: computed(() => this.read(declared.get())),
    };
  }

  // [LAW:no-ambient-temporal-coupling] The stamp of every owner landing is
  // taken in a reaction's effect, not a derivation: a stamp is the instant of
  // its turn, and a computed that read the clock and its own prior answer
  // would answer by when it ran.
  private watch(session: SessionId, stamped: Stamped, reader: Reader): Live {
    const stop = reaction(
      () => reader.inputs.get(),
      (moved) =>
        runInAction(() => {
          // The read a request's stamp already took.
          if (moved === stamped.from) return;
          if (this.stamp({ session, stamped }, moved))
            void this.deps.deliver({
              kind: "world-state",
              worldState: stamped.document,
            });
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
    { session, locator, subscriptions }: DeclaredFor,
    holds: Holds,
  ): Declared {
    const sid = JSON.stringify(session);
    try {
      const {
        result: { lanes, faults },
        acquired,
        released,
      } = holds.declare(() =>
        declareLanes(this.deps.owners, holds, locator, subscriptions),
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
      return { locator, lanes };
    } catch (e) {
      this.deps.log(
        "error",
        `session declaration threw sid=${sid}: ${inspect(e)}`,
      );
      return {
        locator,
        lanes: settledLanes(
          failed(`session declaration threw: ${String(e)}`, "read"),
          subscriptions,
        ),
      };
    }
  }

  private inputsOf(locator: ViewFacts) {
    return { ...locator, deps: this.deps.owners };
  }

  private read({ locator, lanes }: Declared): StampInputs {
    try {
      return {
        kind: "read",
        readings: readingsOf(this.inputsOf(locator), lanes),
        update: this.deps.update(),
      };
    } catch (e) {
      return { kind: "failed", reason: `reading the owners: ${String(e)}` };
    }
  }

  // [LAW:single-enforcer] The one stamp of a session's document, against the
  // one it replaces: the document itself when nothing it holds moved, and a
  // failed stamp keeps the prior readings and says why (`failedStamp`).
  // Answers whether the document moved.
  private stamp(
    { session, stamped }: Pick<SessionRecord, "session" | "stamped">,
    moved: StampInputs,
  ): boolean {
    const prior = stamped.document;
    const next =
      moved.kind === "failed"
        ? failedStamp(prior, moved.reason)
        : this.assembled(prior, moved, instantAt(this.deps.clock));
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
    moved: Extract<StampInputs, { kind: "read" }>,
    at: Instant,
  ): WorldState {
    try {
      return assembleFacts(
        prior,
        prior.session,
        moved.readings,
        moved.update,
        at,
      );
    } catch (e) {
      return failedStamp(prior, `stamping the world state: ${String(e)}`);
    }
  }

  // [LAW:no-ambient-temporal-coupling] A retired session holds nothing at
  // once, and its record stays `retiring` until the retire settles: an output
  // taken meanwhile may still name it. A settled retire, answered or threw,
  // leaves the renderer holding none of the session's document
  // (src/renderer/interface.ts), so the record goes either way. It goes only
  // from the retiring period this retire began: a record a request revived,
  // or one retired again since, is not this retire's to remove.
  private retire(record: SessionRecord, live: Live): void {
    release(live);
    const retiring = { kind: "retiring" } as const;
    record.phase = retiring;
    this.deps.log(
      "info",
      `session retired sid=${JSON.stringify(record.session)}`,
    );
    void this.deps
      .deliver({ kind: "retire", session: record.session })
      .then(() => {
        if (
          record.phase === retiring &&
          this.records.get(record.session) === record
        )
          this.records.delete(record.session);
        if (this.records.size === 0) this.disarmSweep();
      });
  }

  private armSweep(): void {
    if (this.stopSweep !== null) return;
    this.stopSweep = this.deps.clock.every(
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
