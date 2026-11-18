// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import type {
  SessionEntries,
  SessionId,
} from "../daemon/foundations/session-id";
import type {
  DoctorStoreValues,
  StoresRead,
} from "../daemon/foundations/stats-snapshot";
import type { Crosses } from "./crosses";
import type { HistoryState, SessionHistory } from "./history-storage";

// [LAW:one-source-of-truth] Every store the profile holds, as it stands: each
// session's picks and its settings history, in recency order, oldest first,
// and the doctor's documents, each as it read, so one that did not read is
// handed in as that failure and nothing is filed over it.
export interface StoredState {
  readonly sessions: SessionEntries<Readonly<Record<string, string>>>;
  readonly history: HistoryState;
  readonly doctor: StoresRead;
}

// [LAW:one-source-of-truth] What each doctor document holds while its file is
// absent, which its file store reads it as.
export const DOCTOR_EMPTIES: DoctorStoreValues = {
  marks: {},
  clicked: [],
  postMortemsRead: { through: null },
};

// The profile's stores, empty: a profile nothing was ever stored under.
export const EMPTY_STORED_STATE: StoredState = {
  sessions: [],
  history: [],
  doctor: {
    marks: { kind: "ok", value: DOCTOR_EMPTIES.marks },
    clicked: { kind: "ok", value: DOCTOR_EMPTIES.clicked },
    postMortemsRead: { kind: "ok", value: DOCTOR_EMPTIES.postMortemsRead },
  },
};

// [LAW:types-are-the-program] One entry of one store as a turn left it: a
// session's picks or history, which null drops, or a doctor document, whole.
// A write of an entry already held moves it to the end of its store's
// recency order, as the renderer's own store moved it.
export type StoreWrite =
  | {
      readonly store: "session-state";
      readonly key: SessionId;
      readonly value: Readonly<Record<string, string>> | null;
    }
  | {
      readonly store: "settings-history";
      readonly key: SessionId;
      readonly value: SessionHistory | null;
    }
  | {
      readonly [K in keyof DoctorStoreValues]: {
        readonly store: K;
        readonly value: DoctorStoreValues[K];
      };
    }[keyof DoctorStoreValues];

// [LAW:types-are-the-program] Plain data, so a boot and a turn's output carry
// them as they are.
export const STORED_CROSSES: Crosses<StoredState> = true;
export const WRITES_CROSS: Crosses<StoreWrite> = true;
