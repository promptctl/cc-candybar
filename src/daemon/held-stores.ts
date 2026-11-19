// [LAW:single-enforcer] The host's one holder of a renderer's stored state: the
// profile's stores, read once as the daemon serves, held in memory, handed to
// every renderer it builds, and moved only by the stored writes the renderer's
// turns return, each written behind to its file.

import type { SessionId } from "./foundations/session-id.js";
import type { SessionFileStorage, SessionPicks } from "./session-state-file.js";
import type {
  HistoryStorage,
  SessionHistory,
} from "../renderer-interface/history-storage.js";
import type { DoctorStores } from "../doctor/ports.js";
import type { StoresRead } from "./foundations/stats-snapshot.js";
import { readStores } from "../doctor/gather.js";
import { runEach } from "../utils/run-each.js";
import {
  EMPTY_STORED_STATE,
  type StoredState,
  type StoreWrite,
} from "../renderer-interface/stored-state.js";

// Where a profile's stores are kept: its files, or nowhere.
export interface ProfileStorage {
  readonly session: SessionFileStorage<SessionPicks>;
  readonly history: HistoryStorage;
  readonly doctor: DoctorStores;
}

// [LAW:dataflow-not-control-flow] A history kept nowhere, as a session file
// kept nowhere (`ephemeralSessionFile`).
export const EPHEMERAL_HISTORY_STORAGE: HistoryStorage = {
  load: () => new Map(),
  save: () => {},
};

export class HeldStores {
  // [LAW:types-are-the-program] Insertion order is each store's recency
  // order, as the renderer's own: a write moves its entry to the end.
  private sessions = new Map<SessionId, SessionPicks>();
  private history = new Map<SessionId, SessionHistory>();
  private doctor: StoresRead = EMPTY_STORED_STATE.doctor;
  private closed = false;

  constructor(private readonly storage: ProfileStorage) {}

  // [LAW:no-ambient-temporal-coupling] Read once the daemon serves, so a
  // daemon that won the socket reads what the one before it flushed in its
  // close.
  load(): void {
    this.sessions = new Map(this.storage.session.load());
    this.history = new Map(this.storage.history.load());
    this.doctor = readStores(this.storage.doctor);
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
      sessions: Object.fromEntries(this.sessions),
      history: Object.fromEntries(this.history),
      doctor: this.doctor,
    };
  }

  // A turn's stored writes, in the order it made them.
  // [LAW:no-silent-failure] Every write is held, and what its file refused
  // throws once all are, so the host's taking says it on every bar. The
  // renderer holds the refused write too, and the store's next write saves
  // the copy held here whole.
  take(writes: readonly StoreWrite[]): void {
    // [LAW:single-enforcer] Each step its own error boundary (`runEach`).
    const steps: Array<() => void> = [];
    let sessions = false;
    let history = false;
    for (const write of writes)
      switch (write.store) {
        case "session-state":
          moved(this.sessions, write.key, write.value);
          sessions = true;
          break;
        case "settings-history":
          moved(this.history, write.key, write.value);
          history = true;
          break;
        case "marks":
        case "clicked":
        case "postMortemsRead":
          steps.push(() => this.file(write));
          break;
      }
    if (sessions && !this.closed)
      steps.push(() => this.storage.session.save(this.sessions));
    if (history && !this.closed)
      steps.push(() => this.storage.history.save(this.history));
    runEach(steps);
  }

  private file(write: DocumentWrite): void {
    // [LAW:no-silent-failure] A renderer files only a document that read, so
    // one filed over a failure is a renderer's bug, refused.
    if (this.doctor[write.store].kind !== "ok")
      throw new Error(
        `the renderer filed ${write.store}, which did not read; nothing was written`,
      );
    this.doctor = {
      ...this.doctor,
      [write.store]: { kind: "ok", value: write.value },
    };
    if (this.closed) return;
    const filed = fileDocument(this.storage.doctor, write);
    if (filed.kind === "failed")
      throw new Error(`${write.store} not filed: ${filed.reason}`);
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: what is pending
  // lands, and what is written after it (a render that was awaiting, a run
  // settling) stays in memory, so it never lands over the files a next
  // daemon has taken up.
  close(): Promise<void> {
    this.closed = true;
    return this.storage.session.flush();
  }
}

type DocumentWrite = Extract<StoreWrite, { store: keyof StoresRead }>;

// A store's entry as a write leaves it: moved to the end, or gone.
function moved<V>(store: Map<SessionId, V>, key: SessionId, value: V | null) {
  store.delete(key);
  if (value !== null) store.set(key, value);
}

// [LAW:types-are-the-program] exception: each document's write and its file
// are of one name, which the switch cannot carry to the file's type.
function fileDocument(
  doctor: DoctorStores,
  write: DocumentWrite,
): StoresRead[keyof StoresRead] {
  const file = doctor[write.store] as {
    update: (
      next: (current: unknown) => unknown,
    ) => StoresRead[keyof StoresRead];
  };
  return file.update(() => write.value);
}
