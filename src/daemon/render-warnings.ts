// What each renderer's draw could not honour, kept between its frames
// (src/dsl/render.ts RenderWarning). A render warning is only known after the
// walk, but the indicator that counts it is drawn by the walk, so a draw shows
// the warnings its renderer recorded and the record follows the frames.
//
// [LAW:one-source-of-truth] One record per session and renderer (a request's
// answer, the feed's frames): they draw at their own widths and roots, so each
// owns its own and neither overwrites the other's. The session's warnings are
// every renderer's together, in one fixed order, so every surface counts and
// pages the same list and a viewer opened on one surface finds its message on
// the other. A record holds only for the config it was drawn from, and the
// drawing renderer's own only for its width: a reloaded config or a resized
// terminal may draw past what another walk met, so it reads none until its own
// walk records, never a stale count. A config is named by a generation number,
// never held, so a record does not keep a retired config alive.
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
  readonly generation: number;
  readonly width: number;
  readonly warnings: readonly RenderWarning[];
}

// Every renderer, in the order the session's list takes them.
const RENDERERS: ReadonlyArray<Drawing["by"]> = ["request", "feed"];

const generations = new WeakMap<object, number>();
let nextGeneration = 0;
const generationOf = (config: object): number => {
  const held = generations.get(config);
  if (held !== undefined) return held;
  const minted = nextGeneration++;
  generations.set(config, minted);
  return minted;
};

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
      held.generation === generationOf(scope.config) &&
      held.width === scope.width
      ? held.warnings
      : [];
  }

  // The session's warnings as `by` draws them in `scope`: its own record, and
  // every other renderer's drawn from the same config, each warning once
  // across renderers (a warning two renderers met is one fact).
  ofSession(
    sessionId: string,
    by: Drawing["by"],
    scope: RecordScope,
  ): readonly RenderWarning[] {
    const generation = generationOf(scope.config);
    const listed: RenderWarning[] = [];
    for (const renderer of RENDERERS) {
      const held = this.records.get(keyOf(sessionId, renderer));
      const own =
        renderer === by
          ? this.of(sessionId, by, scope)
          : held?.generation === generation
            ? held.warnings
            : [];
      // Each earlier renderer's warning absorbs one equal warning here.
      const earlier = listed.map((w) => JSON.stringify(w));
      for (const w of own) {
        const at = earlier.indexOf(JSON.stringify(w));
        if (at === -1) listed.push(w);
        else earlier.splice(at, 1);
      }
    }
    return listed;
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
    this.records.set(key, {
      generation: generationOf(scope.config),
      width: scope.width,
      warnings,
    });
    for (const oldest of this.records.keys()) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(oldest);
    }
    return JSON.stringify(held) !== JSON.stringify(warnings);
  }
}

const keyOf = (sessionId: string, by: Drawing["by"]): string =>
  `${by}\0${sessionId}`;
