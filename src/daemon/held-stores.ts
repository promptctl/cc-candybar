// [LAW:single-enforcer] The host's one holder of a renderer's stored state: the
// profile's stores, read once as the daemon serves, held in memory, handed to
// every renderer it builds, and moved only by the stored writes the renderer's
// turns return, each written behind to its file.

import type { SessionFileStorage, SessionPicks } from "./session-state-file.js";
import type { SessionHistory } from "../renderer-interface/history-storage.js";
import { runEach, throwAll } from "../utils/run-each.js";
import type {
  StoredState,
  StoreWrite,
} from "../renderer-interface/stored-state.js";
import type { Timekeeper } from "../time.js";
import { HeldFile, type HeldChange } from "./held-file.js";
import type { StoreReport, StoreStanding } from "./foundations/stored-file.js";

// Where a profile's stores are kept: its files, or nowhere.
export interface ProfileStorage {
  readonly session: SessionFileStorage<SessionPicks>;
  readonly history: SessionFileStorage<SessionHistory>;
}

export class HeldStores {
  // [LAW:one-source-of-truth] Each store's order is its renderer's, which
  // bounds it: the renderer's writes and hearings move these, and nothing
  // here evicts.
  private readonly sessions: HeldFile<SessionPicks>;
  private readonly history: HeldFile<SessionHistory>;

  constructor(
    private readonly storage: ProfileStorage,
    clock: Pick<Timekeeper, "after">,
    told: (standing: StoreStanding) => void,
  ) {
    this.sessions = new HeldFile("Session picks", storage.session, clock, told);
    this.history = new HeldFile(
      "Settings history",
      storage.history,
      clock,
      told,
    );
  }

  // [LAW:no-ambient-temporal-coupling] Read once the daemon serves, so a
  // daemon that won the socket reads what the one before it flushed in its
  // close.
  load(): readonly StoreReport[] {
    return [this.sessions.load().report, this.history.load().report];
  }

  // What a renderer built now is built from.
  // [LAW:locality-or-seam] The boot crosses to the renderer as JSON, so each
  // store goes as a record, and the renderer reads recency off its key order.
  // That order holds only because the session-id parse refuses an id that a
  // record would reorder (an array index), and `__proto__`, which the
  // records the renderer's lanes (renderer/main.ts) and the frame feed's
  // viewers (frame-feed.ts) are filled by assignment would take as their
  // prototype.
  current(): StoredState {
    return {
      sessions: Object.fromEntries(this.sessions.entries()),
      history: Object.fromEntries(this.history.entries()),
    };
  }

  // A turn's stored writes, in the order it made them, each store's saved
  // once. [LAW:no-silent-failure] A write a file refuses is told by its
  // storage where it lands (the history's at once, the others behind), and
  // the file stands behind on every bar until a write lands. A store whose
  // taking throws anyway throws once every store has taken its share. The
  // renderer holds the refused write too, and the store's next write saves
  // the copy held here whole.
  take(writes: readonly StoreWrite[]): void {
    const sessions: Array<HeldChange<SessionPicks>> = [];
    const history: Array<HeldChange<SessionHistory>> = [];
    for (const write of writes)
      switch (write.store) {
        case "session-state":
          sessions.push(write);
          break;
        case "settings-history":
          history.push(write);
          break;
        default:
          write satisfies never;
      }
    // [LAW:single-enforcer] Each store its own error boundary (`runEach`).
    runEach([
      () => this.sessions.take(sessions),
      () => this.history.take(history),
    ]);
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: what is pending
  // lands, and what is written after it (a render that was awaiting, a run
  // settling) stays in memory, so it never lands over the files a next
  // daemon has taken up.
  async close(): Promise<void> {
    const closed = await Promise.allSettled([
      this.sessions.close(),
      this.history.close(),
    ]);
    throwAll(
      closed.flatMap((c) => (c.status === "rejected" ? [c.reason] : [])),
    );
  }
}
