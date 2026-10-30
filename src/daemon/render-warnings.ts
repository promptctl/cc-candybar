// What each renderer's draw could not honour, kept between its frames
// (src/dsl/render.ts RenderWarning). A render warning is only known after the
// walk, but the indicator that counts it is drawn by the walk, so a draw shows
// the warnings its renderer recorded and the record follows the frames.
//
// [LAW:one-source-of-truth] One record per session and renderer (a request's
// answer, the feed's frames): they draw at their own widths and roots, so each
// owns its own and neither overwrites the other's.
//
// [LAW:no-ambient-temporal-coupling] A record is rewritten only when a frame
// is drawn from another source (src/render/frame-memory.ts sameSource). So a
// source's warnings are recorded once, by its first frame, and no frame
// records again from what its own indicator changed: the count cannot
// oscillate between frames of one source.

import type { Drawing } from "../config/lanes.js";
import type { RenderWarning } from "../dsl/render.js";
import { sameSource, type FrameSource } from "../render/frame-memory.js";

interface Recorded {
  readonly source: FrameSource;
  readonly warnings: readonly RenderWarning[];
}

// The same bound session state and effect memory keep, so an idle session's
// record goes when they would.
const MAX_RECORDS = 512;

// [LAW:no-shared-mutable-globals] Single owner, hard cap, least recently drawn
// evicted first.
export class RenderWarningRecords {
  private readonly records = new Map<string, Recorded>();

  constructor(private readonly maxRecords: number = MAX_RECORDS) {}

  // The warnings `by` last recorded for `sessionId`; none before its first.
  of(sessionId: string, by: Drawing["by"]): readonly RenderWarning[] {
    return this.records.get(keyOf(sessionId, by))?.warnings ?? [];
  }

  // Records what a frame drawn from `source` warned, unless its record already
  // holds that source. Says whether it recorded.
  drawn(
    sessionId: string,
    by: Drawing["by"],
    source: FrameSource,
    warnings: readonly RenderWarning[],
  ): boolean {
    const key = keyOf(sessionId, by);
    const held = this.records.get(key);
    this.records.delete(key);
    const kept =
      held !== undefined && sameSource(held.source, source)
        ? held
        : { source, warnings };
    this.records.set(key, kept);
    for (const oldest of this.records.keys()) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(oldest);
    }
    return kept !== held;
  }
}

const keyOf = (sessionId: string, by: Drawing["by"]): string =>
  `${by}\0${sessionId}`;
