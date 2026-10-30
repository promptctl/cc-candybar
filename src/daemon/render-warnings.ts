// What each renderer's draw could not honour, kept between its frames
// (src/dsl/render.ts RenderWarning). A render warning is only known after the
// walk, but the indicator that counts it is drawn by the walk, so a draw shows
// the warnings its renderer recorded and the record follows the frames.
//
// [LAW:one-source-of-truth] One record per session and renderer (a request's
// answer, the feed's frames): they draw at their own widths and roots, so each
// owns its own and neither overwrites the other's.
//
// [LAW:no-silent-failure] Every frame's warnings are the record's next value,
// compared by value: a warning that starts or stops while nothing else about
// the frame moved is counted, or cleared, by the very next frame.

import type { Drawing } from "../config/lanes.js";
import type { RenderWarning } from "../dsl/render.js";

// The same bound session state and effect memory keep, so an idle session's
// record goes when they would.
const MAX_RECORDS = 512;

// [LAW:no-shared-mutable-globals] Single owner, hard cap, least recently drawn
// evicted first.
export class RenderWarningRecords {
  private readonly records = new Map<string, readonly RenderWarning[]>();

  constructor(private readonly maxRecords: number = MAX_RECORDS) {}

  // The warnings `by` last recorded for `sessionId`; none before its first.
  of(sessionId: string, by: Drawing["by"]): readonly RenderWarning[] {
    return this.records.get(keyOf(sessionId, by)) ?? [];
  }

  // Records what a frame warned. Says whether that changed the record, which
  // is what the renderer's next frame shows.
  drawn(
    sessionId: string,
    by: Drawing["by"],
    warnings: readonly RenderWarning[],
  ): boolean {
    const key = keyOf(sessionId, by);
    const held = this.records.get(key) ?? [];
    this.records.delete(key);
    this.records.set(key, warnings);
    for (const oldest of this.records.keys()) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(oldest);
    }
    return JSON.stringify(held) !== JSON.stringify(warnings);
  }
}

const keyOf = (sessionId: string, by: Drawing["by"]): string =>
  `${by}\0${sessionId}`;
