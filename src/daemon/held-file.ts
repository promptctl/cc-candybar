// [LAW:one-type-per-behavior] The one holder of a per-session file: the
// session book and a renderer profile's picks and history are each a map
// whose insertion order is recency, read once from its file, moved by what
// its owner takes, and saved whole. Only the value each session holds, the
// bound and the storage differ, so each is an instance of this.

import type { SessionId } from "./foundations/session-id.js";
import type { Timekeeper } from "../time.js";
import { writeBase } from "./state-file.js";
import type { Dropped, SessionFileStorage } from "./session-state-file.js";
import { asError } from "../utils/atomic-write.js";
import { newestOf, unreadText } from "./foundations/stored-file.js";

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

// [LAW:types-are-the-program] What a load found, as the daemon says it.
export type LoadReport =
  | { readonly kind: "read"; readonly dropped: readonly Dropped[] }
  // The file did not read and is kept under `to`; the store started empty.
  | { readonly kind: "set-aside"; readonly reason: string; readonly to: string }
  // The file did not read and could not be set aside: nothing is saved to it.
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly error: string;
    };

// [LAW:no-ambient-temporal-coupling] Saved to only while open. Before the
// load a save would land over a file nobody has read; after the close, over
// the file a next daemon has taken up; and a file that did not read and
// could not be set aside is never saved over at all. What is taken outside
// the open phase stays in memory.
type Phase = "unread" | "open" | "refused" | "closed";

export class HeldFile<V> {
  private held = new Map<SessionId, V>();
  private phase: Phase = "unread";
  // Whether the order moved since the file was last given the map.
  private reordered = false;
  private clearOrderTimer: (() => void) | null = null;

  constructor(
    private readonly name: string,
    private readonly storage: SessionFileStorage<V>,
    // The daemon's clock: the order period is the daemon's to hold.
    private readonly clock: Pick<Timekeeper, "after">,
    // [LAW:carrying-cost] The most sessions it holds; past it the one heard
    // or written longest ago goes. A store whose renderer bounds it holds
    // what it is told.
    private readonly bound: number = Infinity,
  ) {}

  // [LAW:single-enforcer] Read once. A file that did not read is set aside by
  // the rule every state file keeps, before anything is written. What was
  // taken before the load is newer than anything the file holds of it, so
  // it wins, and the file's sessions come first; it is saved, so a save made
  // before the load never lands without the file's sessions. Returns what
  // the load found, and the sessions the bound dropped.
  load(): {
    readonly report: LoadReport;
    readonly evicted: readonly SessionId[];
  } {
    const { current, setAside } = writeBase(this.storage.observe(), {
      sessions: new Map<SessionId, V>(),
      dropped: [],
    });
    let report: LoadReport;
    if (setAside === null) report = { kind: "read", dropped: current.dropped };
    else {
      const { reason, to } = setAside;
      try {
        this.storage.setAside(setAside);
        report = { kind: "set-aside", reason, to };
      } catch (e) {
        report = { kind: "refused", reason, error: asError(e).message };
      }
    }
    const taken = this.held;
    this.held = new Map(
      [...current.sessions].filter(([session]) => !taken.has(session)),
    );
    for (const [session, value] of taken) this.held.set(session, value);
    const evicted = this.evict();
    this.phase = report.kind === "refused" ? "refused" : "open";
    if (taken.size > 0 || evicted.length > 0) this.save();
    return { report, evicted };
  }

  // A turn's changes, in the order it made them, then one save: one write
  // per store per turn, or, when only the order moved, one within the
  // period. Returns the sessions the bound dropped.
  take(changes: ReadonlyArray<HeldChange<V>>): readonly SessionId[] {
    let content = false;
    for (const change of changes)
      if (change.kind === "put") {
        this.held.delete(change.key);
        if (change.value !== null) this.held.set(change.key, change.value);
        content = true;
      } else {
        const value = this.held.get(change.key);
        if (value === undefined || newestOf(this.held) === change.key) continue;
        this.held.delete(change.key);
        this.held.set(change.key, value);
        this.reordered = true;
      }
    const evicted = this.evict();
    if (content || evicted.length > 0) this.save();
    else if (this.reordered) this.orderDue();
    return evicted;
  }

  get(key: SessionId): V | undefined {
    return this.held.get(key);
  }

  // The sessions as they stand, oldest first.
  entries(): ReadonlyMap<SessionId, V> {
    if (this.phase === "unread")
      throw new Error(`${this.name} is read before its load`);
    return this.held;
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: an order still
  // waiting for its period is written now, what is pending lands, and what
  // is taken after it stays in memory.
  // A save that throws (history's is synchronous) rejects the close.
  async close(): Promise<void> {
    try {
      if (this.reordered) this.save();
    } finally {
      this.phase = "closed";
    }
    await this.storage.flush();
  }

  private save(): void {
    this.clearOrderTimer?.();
    this.clearOrderTimer = null;
    if (this.phase !== "open") return;
    this.reordered = false;
    this.storage.save(this.held);
  }

  private orderDue(): void {
    if (this.clearOrderTimer !== null) return;
    this.clearOrderTimer = this.clock.after(
      `${this.name} order write`,
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

// [LAW:one-source-of-truth] What the bar says of a load, or null for one with
// nothing to say: a file kept aside, one nothing is saved to, and what a load
// dropped, grouped by what and why so a renamed key dropped from every
// session is one line.
export function loadText(file: string, report: LoadReport): string | null {
  switch (report.kind) {
    case "set-aside":
      return `${file} ${unreadText(report.reason, `it is kept as ${report.to}, and this store started empty`)}`;
    case "refused":
      return `${file} ${unreadText(report.reason, `it stays where it is, since setting it aside failed (${report.error}), and nothing is saved to it until the daemon starts again`)}`;
    case "read":
      return report.dropped.length === 0
        ? null
        : `${file}: the load dropped what this build does not read: ${droppedText(report.dropped)}`;
  }
}

const SHOWN_SESSIONS = 3;

function droppedText(dropped: readonly Dropped[]): string {
  const groups = new Map<string, string[]>();
  for (const { session, part, why } of dropped) {
    const what = part === null ? `a session (${why})` : `${part} (${why})`;
    const sessions = groups.get(what);
    if (sessions === undefined) groups.set(what, [session]);
    else sessions.push(session);
  }
  return [...groups]
    .map(([what, sessions]) => {
      const shown = sessions
        .slice(0, SHOWN_SESSIONS)
        .map((s) => JSON.stringify(s));
      const more = sessions.length - shown.length;
      return `${what} in ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    })
    .join("; ");
}
