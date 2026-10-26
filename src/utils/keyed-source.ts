import { failed, type Outcome } from "./outcome";
import type {
  RefreshLedger,
  RefreshTrigger,
  Refreshes,
  SourceRecord,
  SourceScope,
} from "./refresh-ledger";
import type { DaemonLogger } from "./logger";
import type { Holds, Release } from "./holds";
import { Period, periodOf, type Every } from "./period";
import {
  answerPending,
  currentOf,
  renew,
  settle,
  unread,
  type Lane,
  type Readable,
} from "./reading";

// What asks a keyed source to read: every trigger but a request, which only a
// session's own lanes take.
export type KeyedTrigger = Exclude<RefreshTrigger, "request">;

// Ends one supersede of a key. The last of a key's outstanding supersedes to
// resume starts its one fresh read. Calling it again does nothing.
export type Resume = () => void;

// [LAW:verifiable-goals] What a source has done since the daemon started, as
// its owner reports it: how many entries it keeps, and its record in the
// ledger — its refreshes by trigger, its failures, its last refresh's length.
export interface SourceStats extends Omit<SourceRecord, "name" | "scope"> {
  readonly entries: number;
}

// A keyed source's stats add the entries a home holds — the ones its period
// visits.
export interface KeyedSourceStats extends SourceStats {
  readonly held: number;
}

// [LAW:one-type-per-behavior] Everything one keyed source varies by, as data:
// a tmux pane's session name and a plugin's session file are instances.
export interface KeyedSourceSpec<I, T> {
  // Names the source in its hold keys, its refresh events and its record.
  readonly name: string;
  readonly scope: SourceScope;
  // The read's identity: two inputs with one key are one reading.
  readonly keyOf: (input: I) => string;
  // The entry's logfmt fields on a refresh event.
  readonly fields: (input: I) => string;
  readonly read: (input: I) => Promise<Outcome<T>>;
  // [LAW:types-are-the-program] The source's refresh, as data: a period, on
  // which a held entry is read again and which a hold's return resumes; or
  // none (`null`), when only a change reads an entry again, and a hold's
  // return to a kept entry re-reads it once.
  readonly every: Every | null;
  // How many entries nothing holds are kept, least recently read first out.
  readonly maxEntries: number;
  readonly logger: DaemonLogger;
  readonly ledger: RefreshLedger;
}

interface Entry<I, T> extends Readable<T> {
  readonly key: string;
  readonly input: I;
  readonly revisit: Revisit;
  holders: number;
  // The read whose answer will be stored, or none out. A read superseded or
  // dropped finds another token here and stores nothing.
  flight: object | null;
  // A change arrived while a read was out: one re-read follows its landing.
  changed: boolean;
  // Supersedes of this key not resumed yet. While any is out, every trigger
  // is held back.
  superseding: number;
}

// [LAW:single-enforcer] The one owner of a keyed source's reads
// (brandon-unfiled-3248.8ro6, step 1). A read never refreshes: it takes the
// stored value, and only a value not read yet is awaited. The stored value is
// refreshed by the entry's period, which runs only while a home holds the
// entry, or by a change; the LRU bounds the entries nobody holds.
//
// What a trigger does while a read is out is decided by its kind, one rule
// for every source (SOURCES-AND-FRAMES.md, "Refresh"): a first read or a tick
// ASKS for a reading, and shares the one in flight, which answers it; a
// change says the world moved since the read began, so it queues exactly one
// re-read after it and the last change always lands; a supersede says the
// daemon itself changed what the key reads, so the read in flight is
// abandoned, the value is pending, and the key reads again only once every
// supersede of it has resumed.
export class KeyedSource<I, T> {
  private readonly entries = new Map<string, Entry<I, T>>();
  private readonly refreshes: Refreshes<KeyedTrigger>;

  constructor(private readonly spec: KeyedSourceSpec<I, T>) {
    this.refreshes = spec.ledger.declare({
      name: spec.name,
      scope: spec.scope,
      // [LAW:types-are-the-program] exception: a source with no period
      // declares no tick, but its handle is typed for every keyed trigger;
      // only the absent period keeps it from recording one.
      refresh:
        spec.every === null
          ? ["first", "change", "supersede"]
          : ["first", "period", "change", "supersede"],
    });
  }

  // [LAW:single-enforcer] The one way into an entry: `holds` takes it — the
  // home holds it until a declaration of the home's takes it no more, or the
  // home is disposed, which keeps the entry for its next hold — and the lane
  // reads it as it stands, never awaited and taking nothing. A key never read
  // is created pending and read once, its first refresh.
  //
  // [LAW:no-silent-failure] The owner logs its own failures — each refresh's
  // by that refresh — so its caller logs none. A declaration that THROWS is a
  // bug none of those saw, reported by the view's declaration (declareLanes).
  declare(holds: Holds, input: I): Lane<T> {
    const key = this.spec.keyOf(input);
    const entry = this.touched(key) ?? this.firstRead(this.created(key, input));
    holds.take(`${this.spec.name}:${key}`, () => this.hold(entry));
    return { current: () => currentOf(entry) };
  }

  // [LAW:one-source-of-truth] The one supersede rule (SOURCES-AND-FRAMES.md):
  // the daemon itself is changing what this key reads (a click's move). The
  // value is pending (`superseded`) and the read in flight is abandoned, so no
  // draw after the click shows the value from before it. Every trigger of the
  // key is held back until every supersede of it has resumed, so no read
  // during the move stores the world from before it; the last resume starts
  // one fresh read. A key never read is created for it, and its first read is
  // that resume's.
  supersede(input: I): Resume {
    const key = this.spec.keyOf(input);
    const entry = this.touched(key) ?? this.created(key, input);
    entry.superseding++;
    renew(entry, "superseded");
    entry.flight = null;
    entry.changed = false;
    this.evict();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      entry.superseding--;
      // A dropped entry has nothing left to read for.
      if (this.entries.get(entry.key) === entry)
        this.refresh(entry, "supersede");
    };
  }

  // The world changed under every held entry `affected` names (a watched file
  // was written): each is read again, after the read in flight when one is
  // out. An entry nobody holds is read when a hold returns to it.
  changed(affected: (input: I) => boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.holders > 0 && affected(entry.input)) {
        this.refresh(entry, "change");
      }
    }
  }

  // Whether some home holds an entry `match` names now.
  isHeld(match: (input: I) => boolean): boolean {
    for (const entry of this.entries.values()) {
      if (entry.holders > 0 && match(entry.input)) return true;
    }
    return false;
  }

  stats(): KeyedSourceStats {
    let held = 0;
    for (const entry of this.entries.values()) if (entry.holders > 0) held++;
    const { refreshes, failures, lastMs } = this.refreshes.record();
    return { entries: this.entries.size, held, refreshes, failures, lastMs };
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

  // In place before any read, so a read's answer finds its entry stored.
  private created(key: string, input: I): Entry<I, T> {
    const entry: Entry<I, T> = {
      key,
      input,
      reading: unread(),
      holders: 0,
      flight: null,
      changed: false,
      superseding: 0,
      revisit: revisitOf(this.spec.every, {
        period: () => this.refresh(entry, "period"),
        holdReturned: () => this.refresh(entry, "change"),
      }),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private firstRead(entry: Entry<I, T>): Entry<I, T> {
    this.refresh(entry, "first");
    return entry;
  }

  private refresh(entry: Entry<I, T>, by: KeyedTrigger): void {
    // [LAW:no-ambient-temporal-coupling] Held back while a supersede is out:
    // its last resume starts the one read that answers this trigger too.
    if (entry.superseding > 0) return;
    if (entry.flight !== null) {
      // [LAW:dataflow-not-control-flow] The trigger's kind is the one branch:
      // a change queues one re-read, a first read or a tick shares the read.
      entry.changed ||= by === "change";
      return;
    }
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
    // [LAW:no-ambient-temporal-coupling] The revisit lands and a queued
    // change re-reads however the settle ends, so a held entry is always
    // visited again and the last change always lands.
    try {
      settle(entry, outcome);
    } finally {
      entry.revisit.landed(outcome);
      if (entry.changed) {
        entry.changed = false;
        this.refresh(entry, "change");
      }
    }
  }

  private hold(entry: Entry<I, T>): Release {
    entry.holders++;
    entry.revisit.hold(true);
    this.evict();
    return () => {
      entry.holders--;
      entry.revisit.hold(entry.holders > 0);
    };
  }

  // A held entry is never evicted, so held entries are bounded by their
  // holders (the render cache's budget).
  // [LAW:single-enforcer] Run by every claim that can add an entry (a hold, a
  // supersede). An entry mid-supersede is kept like a held one: dropped, a
  // hold returning during the move would read the world from before it.
  private evict(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.entries.size <= this.spec.maxEntries) return;
      if (entry.holders === 0 && entry.superseding === 0) this.drop(entry);
    }
  }

  private drop(entry: Entry<I, T>): void {
    this.entries.delete(entry.key);
    entry.flight = null;
    entry.revisit.dispose();
    answerPending(entry, failed(`${this.spec.name} entry dropped`));
  }
}

// What visits a kept entry again, by the source's refresh. The hold path is
// one for both (`hold`): a period resumes where it left off, and a source with
// no period re-reads.
interface Revisit {
  landed(outcome: Outcome<unknown>): void;
  hold(held: boolean): void;
  dispose(): void;
}

function revisitOf(
  every: Every | null,
  read: { readonly period: () => void; readonly holdReturned: () => void },
): Revisit {
  if (every === null) return new HoldReturn(read.holdReturned);
  const period = new Period(read.period);
  return {
    landed: (outcome) => period.landed(periodOf(every, outcome)),
    hold: (held) => period.hold(held),
    dispose: () => period.dispose(),
  };
}

// [LAW:no-ambient-temporal-coupling] A source with no period: nothing visits
// an entry while nobody holds it, so a file written while a session was away
// would never reach its bar. A hold's return to an entry that has answered
// re-reads it once, and the entry keeps its value while that read is out — a
// session back from idle draws its last value while it is re-read. An entry
// never answered has its first read out already.
class HoldReturn implements Revisit {
  private state: "released" | "held" | "disposed" = "released";
  private answered = false;

  constructor(private readonly reread: () => void) {}

  landed(): void {
    this.answered = true;
  }

  hold(held: boolean): void {
    if (this.state === "disposed") return;
    const returned = held && this.state === "released" && this.answered;
    this.state = held ? "held" : "released";
    if (returned) this.reread();
  }

  dispose(): void {
    this.state = "disposed";
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
