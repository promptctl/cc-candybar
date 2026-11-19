// [LAW:one-way-deps] The adapter: every reach between the renderer and the
// host, spelled in shared types. The host's parts satisfy `AdapterToHost`
// structurally where it calls the renderer's start, so no renderer file names
// a host type. The host reaches the renderer only by an `AdapterPush`, plain
// data a process can carry, answered by its `AdapterReply`.

import type { Crosses, Reaches } from "./crosses.js";
import type {
  MenuIdleStats,
  RenderCacheStats,
  StatsSnapshot,
} from "../daemon/foundations/stats-snapshot.js";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types.js";
import type { HeldEvent } from "../utils/event-hold.js";

export type Level = "info" | "warn" | "error";

// [LAW:effects-at-boundaries] exception: what the renderer reaches in the
// host that crosses a process: each a notice, which answers nothing, so a
// turn never waits on the host.
export interface AdapterToHost {
  // A line into the host's one log, which rotates itself: two writers would
  // each shift its generations.
  readonly log: (level: Level, line: string) => void;
  // An answer carrying a daemon-wide held event (the launcher's pipe event,
  // the last renderer's end) reached its client.
  readonly eventAnswered: (event: HeldEvent) => void;
}

// [LAW:types-are-the-program] Every reach crosses: the build fails on one a
// process could not carry, naming it.
export const REACHES_CROSS: Reaches<AdapterToHost> = true;

// [LAW:effects-at-boundaries] exception: what the host reaches in the
// renderer, each a push it hands in as an `adapter` input
// (src/renderer-interface/interface.ts), answered by a reply of its own kind.
// The list is the work left: each later step deletes an arm.
export type AdapterPush =
  // The stats reply's reads of the renderer's state.
  | { readonly kind: "stats" }
  // The debug reply's projection of the most recently drawn view.
  | { readonly kind: "debug"; readonly what: DebugWhat }
  // The daemon's teardown, in its two renderer steps: no click begins after
  // the first, and the views close.
  | { readonly kind: "close-journal" }
  | { readonly kind: "close-views" };

// The replies that carry what their push read.
type Reading =
  | { readonly kind: "stats"; readonly stats: RendererStats }
  | { readonly kind: "debug"; readonly snapshot: DebugSnapshot };
type ReadingPush = Reading["kind"];

// What each push answers, of its own kind: what it read, or nothing.
export type AdapterReply =
  | Reading
  | { readonly kind: Exclude<AdapterPush["kind"], ReadingPush> };

// The reply a push of kind `K` answers.
export type ReplyTo<K extends AdapterPush["kind"]> = K extends ReadingPush
  ? Extract<Reading, { readonly kind: K }>
  : { readonly kind: K };

// [LAW:types-are-the-program] Every push and reply is plain data: the build
// fails on one a process could not carry, naming where it fails.
export const PUSHES_CROSS: Crosses<AdapterPush> = true;
export const REPLIES_CROSS: Crosses<AdapterReply> = true;

// What the stats reply reads of the renderer's state.
export interface RendererStats {
  readonly renderCache: RenderCacheStats;
  readonly effectCache: StatsSnapshot["effectCache"];
  readonly sessionState: StatsSnapshot["sessionState"];
  readonly menuIdle: MenuIdleStats;
  readonly rendererTurns: StatsSnapshot["rendererTurns"];
  // Frames the renderer's feeds drew.
  readonly framesDrawn: number;
}
