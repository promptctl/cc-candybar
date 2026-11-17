// [LAW:single-enforcer] The host's one holder of a renderer's stored state: the
// profile's stores, read once as the daemon serves, held in memory, handed to
// every renderer it builds, and moved only by the stored writes the renderer's
// turns return, each written behind to its file.

import type { DaemonLogger } from "../utils/logger.js";
import type { SessionId } from "./foundations/session-id.js";
import type { SessionStorage } from "../renderer-interface/session-state.js";
import type {
  HistoryStorage,
  SessionHistory,
} from "../renderer-interface/history-storage.js";
import type { DoctorStores } from "../doctor/ports.js";
import type { StoresRead } from "./foundations/stats-snapshot.js";
import { readStores } from "../doctor/gather.js";
import {
  EMPTY_STORED_STATE,
  type StoredState,
  type StoreWrite,
} from "../renderer-interface/stored-state.js";

// Where a profile's stores are kept: its files, or nowhere.
export interface ProfileStorage {
  readonly session: SessionStorage;
  readonly history: HistoryStorage;
  readonly doctor: DoctorStores;
}

// [LAW:dataflow-not-control-flow] A store kept nowhere: it loads nothing and
// writes nothing, so a daemon that keeps no files (the page) holds its stores
// in memory alone, through the same path.
export const EPHEMERAL_SESSION_STORAGE: SessionStorage = {
  load: () => new Map(),
  save: () => {},
  flush: () => {},
};
export const EPHEMERAL_HISTORY_STORAGE: HistoryStorage = {
  load: () => new Map(),
  save: () => {},
};

export class HeldStores {
  // [LAW:types-are-the-program] Insertion order is each store's recency
  // order, as the renderer's own: a write moves its entry to the end.
  private sessions = new Map<SessionId, Readonly<Record<string, string>>>();
  private history = new Map<SessionId, SessionHistory>();
  private doctor: StoresRead = EMPTY_STORED_STATE.doctor;
  private closed = false;

  constructor(
    private readonly storage: ProfileStorage,
    private readonly log: DaemonLogger,
  ) {}

  // [LAW:no-ambient-temporal-coupling] Read once the daemon serves, so a
  // daemon that won the socket reads what the one before it flushed in its
  // close.
  load(): void {
    this.sessions = new Map(this.storage.session.load());
    this.history = new Map(this.storage.history.load());
    this.doctor = readStores(this.storage.doctor);
  }

  // What a renderer built now is built from.
  current(): StoredState {
    return {
      sessions: Object.fromEntries(this.sessions),
      history: Object.fromEntries(this.history),
      doctor: this.doctor,
    };
  }

  // The doctor's documents as the host holds them, which daemon-stats answers.
  documents(): StoresRead {
    return this.doctor;
  }

  // A turn's stored writes, in the order it made them.
  // [LAW:no-silent-failure] A write its file refused is said: the renderer
  // holds it, and so does this copy, which the next write, and the close's
  // flush, write again.
  take(writes: readonly StoreWrite[]): void {
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
          this.hold(write);
          break;
      }
    if (this.closed) return;
    if (sessions) this.storage.session.save(Object.fromEntries(this.sessions));
    if (history) this.saveHistory();
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: what is pending
  // lands, and what is written after it (a render that was awaiting, a run
  // settling) stays in memory, so it never lands over the files a next
  // daemon has taken up.
  close(): void {
    this.storage.session.flush();
    this.closed = true;
  }

  private saveHistory(): void {
    try {
      this.storage.history.save(Object.fromEntries(this.history));
    } catch (thrown) {
      this.log(
        "error",
        thrown instanceof Error ? thrown.message : String(thrown),
      );
    }
  }

  private hold(write: Extract<StoreWrite, { store: keyof StoresRead }>): void {
    // [LAW:no-silent-failure] A renderer files only a document that read, so
    // one filed over a failure is a renderer's bug, refused and said.
    if (this.doctor[write.store].kind !== "ok") {
      this.log(
        "error",
        `stored: the renderer filed ${write.store}, which did not read; nothing was written`,
      );
      return;
    }
    this.doctor = {
      ...this.doctor,
      [write.store]: { kind: "ok", value: write.value },
    };
    if (this.closed) return;
    let filed: StoresRead[typeof write.store];
    try {
      filed = fileDocument(this.storage.doctor, write);
    } catch (thrown) {
      filed = {
        kind: "failed",
        reason: thrown instanceof Error ? thrown.message : String(thrown),
      };
    }
    if (filed.kind === "failed")
      this.log("error", `stored: ${write.store} not filed: ${filed.reason}`);
  }
}

// A store's entry as a write leaves it: moved to the end, or gone.
function moved<V>(store: Map<SessionId, V>, key: SessionId, value: V | null) {
  store.delete(key);
  if (value !== null) store.set(key, value);
}

// [LAW:types-are-the-program] exception: each document's write and its file
// are of one name, which the switch cannot carry to the file's type.
function fileDocument(
  doctor: DoctorStores,
  write: Extract<StoreWrite, { store: keyof StoresRead }>,
): StoresRead[keyof StoresRead] {
  const file = doctor[write.store] as {
    update: (
      next: (current: unknown) => unknown,
    ) => StoresRead[keyof StoresRead];
  };
  return file.update(() => write.value);
}
