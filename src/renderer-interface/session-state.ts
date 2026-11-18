// The per-session state store's ports: what a draw reads, what a click
// writes, and the storage the store saves through (src/renderer/session-state.ts).

import type { SessionId } from "../daemon/foundations/session-id";

export interface SessionStateReader {
  get(sessionId: SessionId, key: string): string | null;
  // The store's revision when this session's state last changed — a write
  // of a value it did not hold, a clear of a key it did — or 0 while it holds
  // none. Two reads that return one revision read one state, whoever wrote it.
  revision(sessionId: SessionId): number;
}

// [LAW:locality-or-seam] Renderer needs to *cache* per-session random picks
// so subsequent renders are stable. Writing them back into the same store
// click verbs use keeps state in one place — no parallel cache to drift.
//
// setBatch commits multiple (key, value) pairs as a single reactive
// transaction: observers fire ONCE after every pair has landed, never
// between pairs. The set-state verb's batched-pair URL (a Menu click that
// writes the chosen value AND collapses the menu) depends on this — if
// observers saw the first write before the second, an autorun could
// render half-applied state. The atomicity contract lives in the seam,
// not in each consumer. [LAW:single-enforcer]
export interface SessionStateRW extends SessionStateReader {
  set(sessionId: SessionId, key: string, value: string): void;
  setBatch(
    sessionId: SessionId,
    pairs: ReadonlyArray<{ key: string; value: string }>,
  ): void;
  clear(sessionId: SessionId, key: string): void;
}
