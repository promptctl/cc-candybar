// A writer for a stream of states where only the newest matters — a bar's
// frames. A reader slower than the writes gets the newest state when the stream
// drains, never a backlog of stale ones, so a stalled reader costs one state of
// memory rather than every state written while it stalled.

import type { Writable } from "node:stream";

// [LAW:no-ambient-temporal-coupling] Whether a chunk is written now or held is
// the stream's own drain state, read at each write, never a guess at timing.
// A writer that is made and never writes leaves nothing on the stream: the
// drain is heard only while a chunk waits for it.
export function newestWins(
  out: Writable,
): (chunk: string | Uint8Array) => void {
  let pending: string | Uint8Array | null = null;
  const flush = (): void => {
    const next = pending!;
    pending = null;
    out.write(next);
  };
  return (chunk) => {
    // A reader that hung up: what ends the stream is its close, not a write.
    if (!out.writable) return;
    if (out.writableNeedDrain) {
      if (pending === null) out.once("drain", flush);
      pending = chunk;
      return;
    }
    out.write(chunk);
  };
}
