// [LAW:effects-at-boundaries] One UTF-8 read edge for the host's declared
// files. Callers supply their own refresh and missing-file policy.

import { readFile } from "node:fs/promises";

type FileReading =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "error";
      readonly code: string | undefined;
      readonly message: string;
    };

interface QueuedRead {
  readonly callers: Set<AbortSignal>;
  readonly result: Promise<FileReading>;
}

type ReadUtf8 = (file: string, signal: AbortSignal) => Promise<string>;

export class SourceFiles {
  private readonly queued = new Map<string, QueuedRead>();

  constructor(
    private readonly readUtf8: ReadUtf8 = (file, signal) =>
      readFile(file, { encoding: "utf8", signal }),
  ) {}

  // [LAW:single-enforcer] Every request queued for this path before dispatch
  // shares one read. A request after dispatch may follow a write the earlier
  // read missed, so it starts a fresh batch.
  read(file: string, signal: AbortSignal): Promise<FileReading> {
    const queued = this.queued.get(file);
    if (queued !== undefined) {
      queued.callers.add(signal);
      return queued.result;
    }
    const callers = new Set([signal]);
    const result = Promise.resolve().then(() => {
      this.queued.delete(file);
      return this.dispatch(file, callers);
    });
    this.queued.set(file, { callers, result });
    return result;
  }

  private async dispatch(
    file: string,
    callers: ReadonlySet<AbortSignal>,
  ): Promise<FileReading> {
    // [LAW:no-ambient-temporal-coupling] Each caller owns its own lifetime.
    // Only the last cancellation ends the shared read.
    const abort = new AbortController();
    const cancelled = () => {
      for (const signal of callers) if (!signal.aborted) return;
      abort.abort();
    };
    for (const signal of callers)
      signal.addEventListener("abort", cancelled, { once: true });
    try {
      cancelled();
      abort.signal.throwIfAborted();
      return { kind: "text", text: await this.readUtf8(file, abort.signal) };
    } catch (error) {
      const err =
        error instanceof Error ? (error as NodeJS.ErrnoException) : null;
      return {
        kind: "error",
        code: err?.code,
        message: err?.message ?? String(error),
      };
    } finally {
      for (const signal of callers)
        signal.removeEventListener("abort", cancelled);
    }
  }
}
