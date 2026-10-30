// What each renderer's draw could not honour, kept between its frames
// (src/dsl/render.ts RenderWarning). A render warning is only known after the
// walk, but the indicator that counts it is drawn by the walk, so a draw shows
// the warnings its renderer recorded and the record follows the frames.
//
// [LAW:one-source-of-truth] One record per session and renderer (a request's
// answer, the feed's frames): they draw at their own widths and roots, so each
// owns its own and neither overwrites the other's. A record holds only for the
// config and width it was drawn from: a reloaded config or a resized terminal
// may draw past what another walk met, so a draw from another scope reads
// none until its own walk records, never a stale count.
//
// [LAW:no-silent-failure] Every frame's warnings are the record's next value,
// compared by value: a warning that starts or stops while nothing else about
// the frame moved is counted, or cleared, by the renderer's next frame.

import type { Drawing } from "../config/lanes.js";
import type { RenderWarning } from "../dsl/render.js";

// The same bound session state and effect memory keep, so an idle session's
// record goes when they would.
const MAX_RECORDS = 512;

// What a walk's warnings are a function of, beside the values it read.
export interface RecordScope {
  readonly config: object;
  readonly width: number;
}

interface WarningRecord {
  readonly scope: RecordScope;
  readonly warnings: readonly RenderWarning[];
}

// [LAW:no-shared-mutable-globals] Single owner, hard cap, least recently drawn
// evicted first.
export class RenderWarningRecords {
  private readonly records = new Map<string, WarningRecord>();

  constructor(private readonly maxRecords: number = MAX_RECORDS) {}

  // The warnings `by` last recorded for `sessionId` in `scope`; none before
  // its first, or once its last frame was drawn from another scope.
  of(
    sessionId: string,
    by: Drawing["by"],
    scope: RecordScope,
  ): readonly RenderWarning[] {
    const held = this.records.get(keyOf(sessionId, by));
    return held !== undefined &&
      held.scope.config === scope.config &&
      held.scope.width === scope.width
      ? held.warnings
      : [];
  }

  // Records what a frame warned. Says whether that changed what the
  // renderer's next frame in `scope` shows.
  drawn(
    sessionId: string,
    by: Drawing["by"],
    scope: RecordScope,
    warnings: readonly RenderWarning[],
  ): boolean {
    const held = this.of(sessionId, by, scope);
    const key = keyOf(sessionId, by);
    this.records.delete(key);
    this.records.set(key, { scope, warnings });
    for (const oldest of this.records.keys()) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(oldest);
    }
    return JSON.stringify(held) !== JSON.stringify(warnings);
  }
}

const keyOf = (sessionId: string, by: Drawing["by"]): string =>
  `${by}\0${sessionId}`;
