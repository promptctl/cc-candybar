// A writer for a stream of states where only the newest matters — a bar's
// frames. A reader slower than the writes gets the newest state when the stream
// drains, never a backlog of stale ones, so a stalled reader costs one state of
// memory rather than every state written while it stalled.

import type { Writable } from "node:stream";

// [LAW:no-ambient-temporal-coupling] Whether a chunk is written now or held is
// the stream's own drain state, read at each write, never a guess at timing.
export function newestWins(
  out: Writable,
): (chunk: string | Uint8Array) => void {
  let pending: string | Uint8Array | null = null;
  out.on("drain", () => {
    const next = pending;
    pending = null;
    if (next !== null) out.write(next);
  });
  return (chunk) => {
    // A reader that hung up: what ends the stream is its close, not a write.
    if (!out.writable) return;
    if (out.writableNeedDrain) {
      pending = chunk;
      return;
    }
    out.write(chunk);
  };
}
