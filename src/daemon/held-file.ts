// [LAW:one-type-per-behavior] The one holder of a per-session file: the
// session book and a renderer profile's picks and history are each a map
// whose insertion order is recency, read once from its file, moved by what
// its owner takes, and saved whole. Only the value each session holds, the
// bound and the storage differ, so each is an instance of this.

import type { SessionId } from "./foundations/session-id.js";
import type { Timekeeper } from "../time.js";
import { writeBase } from "./state-file.js";
import {
  nothingLoaded,
  type SessionFileStorage,
} from "./session-state-file.js";
import { asError } from "../utils/atomic-write.js";
import { putNewest, toNewest } from "../utils/recency.js";
import type { Found, StoreReport } from "./foundations/stored-file.js";

// [LAW:carrying-cost] How long a change of order alone waits for its write.
// Order is what the bound reads after a restart, and a write on every
// hearing would make the bar's load grow with its tick; once a period, at
// most, keeps it negligible, and a close writes what is left.
export const ORDER_PERIOD_MS = 5 * 60 * 1000;

// [LAW:types-are-the-program] One thing a turn did to a session: its value
// written (null drops it), or the session heard, which moves it to the
// newest end without changing what it holds.
export type HeldChange<V> =
  | { readonly kind: "put"; readonly key: SessionId; readonly value: V | null }
  | { readonly kind: "heard"; readonly key: SessionId };

// [LAW:no-ambient-temporal-coupling] Saved to only while open. Before the
// load a save would land over a file nobody has read; after the close, over
// the file a next daemon has taken up; and a file that did not read and
// could not be set aside is never saved over at all. What is taken outside
// the open phase stays in memory, and nothing reads it before the load.
type Phase = "unread" | "open" | "refused" | "closed";

export class HeldFile<V> {
  private held = new Map<SessionId, V>();
  private phase: Phase = "unread";
  // [LAW:no-ambient-temporal-coupling] What is taken before the load, replayed
  // over the file's sessions as it loads: a put, a drop, a hearing and the
  // bound each run one way, whenever they come.
  private early: Array<HeldChange<V>> = [];
  // [LAW:one-source-of-truth] Whether the storage is yet to be handed the map
  // as it stands: set by every change, cleared only once a save returns, so
  // one that throws (history's) is still owed to the next change and to the
  // close. Whether a write handed over lands is the storage's.
  private behind = false;
  private clearOrderTimer: (() => void) | null = null;

  constructor(
    // The store, as the bar names it.
    private readonly store: string,
    private readonly storage: SessionFileStorage<V>,
    // The daemon's clock: the order period is the daemon's to hold.
    private readonly clock: Pick<Timekeeper, "after">,
    // [LAW:carrying-cost] The most sessions it holds; past it the one heard
    // or written longest ago goes. A store whose renderer bounds it holds
    // what it is told.
    private readonly bound: number = Infinity,
    // Whether a value put is the one the session holds, which makes the put
    // a hearing: it moves only the session's place.
    private readonly same: (held: V, put: V) => boolean = Object.is,
  ) {}

  // [LAW:single-enforcer] Read once. A file that did not read is set aside by
  // the rule every state file keeps, before anything is written. What was
  // taken before the load is newer than anything the file holds, so it is
  // taken over the file's sessions, and saved, so a save made before the load
  // never lands without them. Returns what the store found, and the
  // sessions the bound dropped.
  load(): {
    readonly report: StoreReport;
    readonly evicted: readonly SessionId[];
  } {
    if (this.phase !== "unread")
      throw new Error(`${this.store} is loaded twice`);
    const observed = this.storage.observe();
    const { current, setAside } = writeBase(observed, nothingLoaded<V>());
    let found: Found;
    if (setAside !== null)
      try {
        found = {
          kind: "set-aside",
          reason: setAside.reason,
          to: this.storage.setAside(setAside.file).to,
        };
      } catch (e) {
        found = {
          kind: "refused",
          reason: setAside.reason,
          error: asError(e).message,
        };
      }
    else
      found =
        observed.source === null
          ? { kind: "absent" }
          : {
              kind: "read",
              sessions: current.sessions.size,
              dropped: current.dropped,
            };
    this.held = new Map(current.sessions);
    this.phase = found.kind === "refused" ? "refused" : "open";
    const early = this.early;
    this.early = [];
    return {
      report: { store: this.store, file: this.storage.file, found },
      evicted: this.take(early),
    };
  }

  // A turn's changes, in the order it made them, then one save: one write
  // per store per turn, or, when only the order moved, one within the
  // period. Returns the sessions the bound dropped.
  take(changes: ReadonlyArray<HeldChange<V>>): readonly SessionId[] {
    if (this.phase === "unread") {
      this.early.push(...changes);
      return [];
    }
    let content = false;
    for (const change of changes)
      if (change.kind === "heard" || this.holds(change.key, change.value)) {
        if (toNewest(this.held, change.key)) this.behind = true;
      } else if (putNewest(this.held, change.key, change.value)) {
        content = true;
        this.behind = true;
      }
    const evicted = this.evict();
    if (content || evicted.length > 0) this.save();
    else if (this.behind) this.orderDue();
    return evicted;
  }

  get(key: SessionId): V | undefined {
    return this.entries().get(key);
  }

  // The sessions as they stand, oldest first.
  entries(): ReadonlyMap<SessionId, V> {
    if (this.phase === "unread")
      throw new Error(`${this.store} is read before its load`);
    return this.held;
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: what the storage
  // is still owed is handed over now, what is pending lands, and what is
  // taken after it stays in memory.
  // A save that throws (history's is synchronous) rejects the close.
  async close(): Promise<void> {
    try {
      if (this.behind) this.save();
    } finally {
      this.phase = "closed";
    }
    await this.storage.flush();
  }

  private holds(key: SessionId, value: V | null): boolean {
    const held = this.held.get(key);
    return value !== null && held !== undefined && this.same(held, value);
  }

  private save(): void {
    this.clearOrderTimer?.();
    this.clearOrderTimer = null;
    if (this.phase !== "open") return;
    this.storage.save(this.held);
    this.behind = false;
  }

  // [LAW:no-ambient-temporal-coupling] Only an open file is owed an order
  // write: a closed or refused one saves nothing, so it arms no timer.
  private orderDue(): void {
    if (this.phase !== "open" || this.clearOrderTimer !== null) return;
    this.clearOrderTimer = this.clock.after(
      `${this.store} order write`,
      ORDER_PERIOD_MS,
      () => {
        this.clearOrderTimer = null;
        this.save();
      },
      { unref: true },
    );
  }

  private evict(): SessionId[] {
    const evicted: SessionId[] = [];
    for (const oldest of this.held.keys()) {
      if (this.held.size <= this.bound) break;
      this.held.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }
}
