import { failed, type Outcome } from "./outcome";
import type { DaemonLogger } from "./logger";
import type { Holds, Release } from "./holds";
import { Period, periodOf, type Every } from "./period";
import {
  answerPending,
  currentOf,
  outcomeOf,
  pending,
  settle,
  type Current,
  type Readable,
} from "./reading";

// [LAW:verifiable-goals] What a source has done since the daemon started: how
// many entries it keeps, its refreshes by the trigger that asked for each,
// and how many failed. `Trigger` is the source's own vocabulary, so a count
// under a trigger the source has no way to fire cannot be written.
export interface SourceStats<Trigger extends string> {
  readonly entries: number;
  readonly refreshes: Readonly<Record<Trigger, number>>;
  readonly failures: number;
}

// [LAW:one-source-of-truth] The one spelling of a source's refresh event and
// of the counts its stats report, whatever schedules its reads: one event per
// refresh, a failed one at warn, so a read of the stored value never logs it
// again.
export class Refreshes<Trigger extends string> {
  private readonly counts: Record<Trigger, number>;
  private failures = 0;

  constructor(
    private readonly name: string,
    triggers: readonly Trigger[],
    private readonly logger: DaemonLogger,
  ) {
    this.counts = Object.fromEntries(triggers.map((t) => [t, 0])) as Record<
      Trigger,
      number
    >;
  }

  // `fields` is the refreshed entry's logfmt identity.
  recorded(
    fields: string,
    by: Trigger,
    outcome: Outcome<unknown>,
    took: number,
  ): void {
    this.counts[by]++;
    if (outcome.kind === "failed") this.failures++;
    const why =
      outcome.kind === "failed"
        ? ` reason=${JSON.stringify(outcome.reason)}`
        : "";
    this.logger(
      outcome.kind === "failed" ? "warn" : "info",
      `${this.name} refresh ${fields} by=${by} outcome=${outcome.kind}${why} took=${took}ms`,
    );
  }

  stats(entries: number): SourceStats<Trigger> {
    return { entries, refreshes: { ...this.counts }, failures: this.failures };
  }
}

// What asks a keyed source to read: a key's first read, its period's tick,
// or a supersede (the daemon itself changed what the key reads).
export type KeyedTrigger = "first" | "period" | "supersede";

// A keyed source's stats add the entries a home holds — the ones its period
// visits.
export interface KeyedSourceStats extends SourceStats<KeyedTrigger> {
  readonly held: number;
}

// [LAW:one-type-per-behavior] Everything one keyed source varies by, as data:
// a tmux pane's session name and memento's ceiling reading are two instances.
export interface KeyedSourceSpec<I, T> {
  // Names the source in its hold keys, its refresh events and its stats.
  readonly name: string;
  // The read's identity: two inputs with one key are one reading.
  readonly keyOf: (input: I) => string;
  // The entry's logfmt fields on a refresh event.
  readonly fields: (input: I) => string;
  readonly read: (input: I) => Promise<Outcome<T>>;
  readonly every: Every;
  // How many entries nothing holds are kept, least recently read first out.
  readonly maxEntries: number;
  readonly logger: DaemonLogger;
}

interface Entry<I, T> extends Readable<T> {
  readonly key: string;
  readonly input: I;
  readonly period: Period;
  holders: number;
  // The read whose answer will be stored, or none out. A read superseded or
  // dropped finds another token here and stores nothing.
  flight: object | null;
}

// [LAW:single-enforcer] The one owner of a keyed source's reads
// (brandon-unfiled-3248.8ro6, step 1). A read never refreshes: it takes the
// stored value, and only a value not read yet is awaited. The stored value is
// refreshed by the entry's period, which runs only while a home holds the
// entry, so an entry nobody draws costs nothing; the LRU bounds the entries
// nobody holds.
//
// What a trigger does while a read is out is decided by its kind: a first
// read or a tick ASKS for a reading, and shares the one in flight, which
// answers it; a supersede says the read in flight describes a world the
// daemon has since changed, so it is abandoned and the value is pending until
// a fresh read lands.
export class KeyedSource<I, T> {
  private readonly entries = new Map<string, Entry<I, T>>();
  private readonly refreshes: Refreshes<KeyedTrigger>;

  constructor(private readonly spec: KeyedSourceSpec<I, T>) {
    this.refreshes = new Refreshes(
      spec.name,
      ["first", "period", "supersede"],
      spec.logger,
    );
  }

  // The one read: the stored value as it stands, never awaited. `holds` is the
  // home reading: it holds the entry until it releases its holds (idle, or
  // disposed), which keeps the entry on its period. A key never read is
  // created pending and read once, its first refresh.
  //
  // [LAW:no-silent-failure] The owner logs its own failures — each refresh's
  // by that refresh — so its caller logs none. A read that THROWS is a bug
  // none of those saw, logged here where it surfaces, and answered as failed.
  current(holds: Holds, input: I): Current<T> {
    try {
      return currentOf(this.ask(holds, input));
    } catch (e) {
      return this.threw(e);
    }
  }

  // The read's answer, waited for while it is not answered yet: one ask, so
  // one hold, then the entry's own landing — which answers a key the LRU
  // drops meanwhile as dropped. The promise never rejects.
  read(holds: Holds, input: I): Promise<Outcome<T>> {
    try {
      return outcomeOf(this.ask(holds, input));
    } catch (e) {
      return Promise.resolve(this.threw(e));
    }
  }

  private ask(holds: Holds, input: I): Readable<T> {
    const key = this.spec.keyOf(input);
    const entry = this.touched(key) ?? this.created(key, input);
    holds.take(`${this.spec.name}:${key}`, () => this.hold(entry));
    return entry;
  }

  private threw(e: unknown): Outcome<never> {
    this.spec.logger("error", `${this.spec.name} read threw: ${String(e)}`);
    return failed(`${this.spec.name}: ${String(e)}`);
  }

  // The daemon itself changed what this key reads (a memento move): the read
  // in flight is abandoned, and the value is pending until a fresh read
  // lands — never the reading from before. A key never read has nothing to
  // supersede; its first read is its reader's.
  supersede(input: I): void {
    const entry = this.entries.get(this.spec.keyOf(input));
    if (entry === undefined) return;
    if (entry.reading.kind === "read") entry.reading = pending();
    entry.flight = null;
    this.refresh(entry, "supersede");
  }

  stats(): KeyedSourceStats {
    let held = 0;
    for (const entry of this.entries.values()) if (entry.holders > 0) held++;
    return { ...this.refreshes.stats(this.entries.size), held };
  }

  // Ends every entry's period: a held entry's period re-arms on every landing,
  // so an owner that is not closed keeps its timers for good.
  close(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry);
  }

  // LRU touch: re-inserting moves the entry to the newest end.
  private touched(key: string): Entry<I, T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  // In place first, then read: the read's answer finds its entry stored.
  private created(key: string, input: I): Entry<I, T> {
    const entry: Entry<I, T> = {
      key,
      input,
      reading: pending(),
      holders: 0,
      flight: null,
      period: new Period(() => this.refresh(entry, "period")),
    };
    this.entries.set(key, entry);
    this.refresh(entry, "first");
    return entry;
  }

  private refresh(entry: Entry<I, T>, by: KeyedTrigger): void {
    if (entry.flight !== null) return;
    const flight = {};
    entry.flight = flight;
    const startedAt = Date.now();
    void attempt(() => this.spec.read(entry.input))
      .then((outcome) => {
        // [LAW:no-silent-failure] Every read that ran is an event, one a
        // supersede or a drop abandoned included: its answer is not stored,
        // but it ran, and a failure it met is still a fact.
        const stored = entry.flight === flight;
        try {
          this.refreshes.recorded(
            `${this.spec.fields(entry.input)} stored=${stored ? "Y" : "N"}`,
            by,
            outcome,
            Date.now() - startedAt,
          );
        } finally {
          if (stored) this.store(entry, outcome);
        }
      })
      .catch((e: unknown) => {
        this.spec.logger(
          "error",
          `${this.spec.name} refresh threw (${this.spec.fields(entry.input)}): ${String(e)}`,
        );
      });
  }

  private store(entry: Entry<I, T>, outcome: Outcome<T>): void {
    entry.flight = null;
    // [LAW:no-ambient-temporal-coupling] The period lands however the settle
    // ends, so a held entry is always visited again.
    try {
      settle(entry, outcome);
    } finally {
      entry.period.landed(periodOf(this.spec.every, outcome));
    }
  }

  private hold(entry: Entry<I, T>): Release {
    entry.holders++;
    entry.period.hold(true);
    this.evict();
    return () => {
      entry.holders--;
      entry.period.hold(entry.holders > 0);
    };
  }

  // A held entry is never evicted, so held entries are bounded by their
  // holders (the render cache's budget).
  private evict(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.entries.size <= this.spec.maxEntries) return;
      if (entry.holders === 0) this.drop(entry);
    }
  }

  private drop(entry: Entry<I, T>): void {
    this.entries.delete(entry.key);
    entry.flight = null;
    entry.period.dispose();
    answerPending(entry, failed(`${this.spec.name} entry dropped`));
  }
}

// [LAW:no-silent-failure] A read that throws, at once or later, is a bug its
// owner reports as the read's failure: the refresh still lands, so the entry
// is visited again rather than stalled.
function attempt<T>(read: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  const threw = (e: unknown): Outcome<T> => failed(`read threw: ${String(e)}`);
  try {
    return read().catch(threw);
  } catch (e) {
    return Promise.resolve(threw(e));
  }
}
