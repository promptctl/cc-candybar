// A writer for a stream of states where only the newest matters — a bar's
// frames. A reader slower than the writes gets the newest state when the stream
// drains, never a backlog of stale ones, so a stalled reader costs one state of
// memory rather than every state written while it stalled.

import type { Writable } from "node:stream";

type Delivered = (delivered: boolean) => void;

interface Write {
  readonly chunk: string | Uint8Array;
  readonly done: Delivered | undefined;
}

// [LAW:no-ambient-temporal-coupling] Plain writes use the stream's drain
// state. A write with a receipt holds one completion and the newest pending
// chunk, even if the stream could buffer more before asking us to drain.
export function newestWins(
  out: Writable,
): (chunk: string | Uint8Array, done?: Delivered) => void {
  let active: Write | undefined;
  let pending: Write | undefined;
  let listening = false;
  let ended = false;

  function listen(): void {
    if (listening) return;
    listening = true;
    out.on("drain", flush);
    out.on("error", stop);
    out.on("finish", stop);
    out.on("close", stop);
  }

  function unlisten(): void {
    listening = false;
    out.off("drain", flush);
    out.off("error", stop);
    out.off("finish", stop);
    out.off("close", stop);
  }

  // [LAW:single-enforcer] A terminal event owns every unfinished receipt.
  // A late write callback may still arrive after close, even without an error.
  function stop(): void {
    ended = true;
    const writing = active;
    const waiting = pending;
    active = pending = undefined;
    unlisten();
    try {
      writing?.done?.(false);
    } finally {
      waiting?.done?.(false);
    }
  }

  function write(next: Write): void {
    const { done } = next;
    if (done === undefined) {
      out.write(next.chunk);
      return;
    }
    active = next;
    listen();
    try {
      out.write(next.chunk, (error) => {
        if (active !== next) return;
        // Node reports a failed write here before it emits the error event.
        // Keep the listener until that event, which also settles the buffer.
        if (error || out.errored) return;
        if (out.destroyed) {
          stop();
          return;
        }
        active = undefined;
        if (pending === undefined) unlisten();
        try {
          done(true);
        } finally {
          flush();
        }
      });
    } catch {
      stop();
    }
  }

  function flush(): void {
    if (active !== undefined || pending === undefined || out.writableNeedDrain)
      return;
    const next = pending;
    pending = undefined;
    try {
      if (out.writable) write(next);
      else next.done?.(false);
    } finally {
      if (active === undefined && pending === undefined) unlisten();
    }
  }

  return (chunk, done) => {
    if (ended || !out.writable) {
      done?.(false);
      return;
    }
    const next: Write = { chunk, done };
    if (
      active === undefined &&
      pending === undefined &&
      !out.writableNeedDrain
    ) {
      write(next);
      return;
    }
    const superseded = pending;
    pending = next;
    listen();
    try {
      superseded?.done?.(false);
    } finally {
      flush();
    }
  };
}
