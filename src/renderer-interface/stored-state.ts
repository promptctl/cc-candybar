// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import type { SessionId } from "../daemon/foundations/session-id";
import type { Crosses } from "./crosses";
import type { HistoryState, SessionHistory } from "./history-storage";

// [LAW:one-source-of-truth] Every store the profile holds, as it stands: each
// session's picks and its settings history, in recency order, oldest first.
export interface StoredState {
  readonly sessions: Readonly<
    Record<SessionId, Readonly<Record<string, string>>>
  >;
  readonly history: HistoryState;
}

// The profile's stores, empty: a profile nothing was ever stored under.
export const EMPTY_STORED_STATE: StoredState = {
  sessions: {},
  history: {},
};

// [LAW:types-are-the-program] One entry of one store as a turn left it: a
// session's picks or history, which null drops.
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
    };

// [LAW:types-are-the-program] Plain data, so a boot and a turn's output carry
// them as they are.
export const STORED_CROSSES: Crosses<StoredState> = true;
export const WRITES_CROSS: Crosses<StoreWrite> = true;
