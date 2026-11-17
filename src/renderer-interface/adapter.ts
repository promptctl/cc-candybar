// [LAW:one-way-deps] The adapter: every reach between the renderer and the
// host, spelled in shared types. The host's parts satisfy `AdapterToHost`
// structurally where it calls the renderer's start, so no renderer file names
// a host type. The host reaches the renderer only by an `AdapterPush`, plain
// data a process can carry, answered by its `AdapterReply`.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { Response } from "../daemon/foundations/protocol.js";
import type { RenderOrigin } from "../config-hint.js";
import type { Frame, WireFrame } from "../render/frame";
import type { Instant } from "../utils/instant.js";
import type { Lane, LaneFeeds, LaneSwitches } from "../config/lanes.js";
import type { Crosses, Reaches } from "./crosses.js";
import type {
  RenderCacheStats,
  StatsSnapshot,
} from "../daemon/foundations/stats-snapshot.js";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types.js";
import type {
  Deafness,
  Invalidation,
  WatchTargets,
} from "../daemon/foundations/watch-targets.js";
import type { HeldEvent } from "../utils/event-hold.js";

// A watch the renderer holds, named by the id it minted.
declare const WATCH_ID: unique symbol;
export type WatchId = number & { readonly [WATCH_ID]: true };

// A render state's hold on its storage folders, named by the id the renderer
// minted.
declare const STORAGE_HOLD_ID: unique symbol;
export type StorageHoldId = number & { readonly [STORAGE_HOLD_ID]: true };

// What one frame of the feed drew: the bar, the responses its subscribers
// receive, and — for a render that threw — the render event describing it,
// logged when that failure is first pushed. It is drawn for the feed
// (`drawing.by` "feed"), so it shows the feed's ceiling where a render
// request's answer shows that it is polled.
// [LAW:decomposition] A frame says only what was drawn. Whether anyone can see
// it is the feed's question, asked when it schedules the next.
// A frame's two answers: `resp`, which a lane drawing the bar elsewhere is sent,
// and `statusline`, what Claude Code's statusline shows — the bar, or the
// handoff line in its place while a lane draws it elsewhere
// (src/renderer/lane-handoff.ts).
export interface FeedFrame {
  // [LAW:types-are-the-program] Every frame has a bar: one that failed draws
  // its diagnostic Frame, so a lane holds no failure branch. Its `nextChange`
  // is when the feed draws next, within its spacing.
  readonly bar: Frame;
  readonly resp: Response;
  readonly statusline: Response;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // How many strip items dividing cells too wide for a line added.
  readonly cellBreaks: number;
  // The lanes the session's settings switched on as it drew, which the feed's
  // lane gate reads as the frame goes out. A frame that failed reads them from
  // the view, so a lane switched off while the render throws still ends; null
  // while the session has no view.
  readonly lanes: LaneSwitches | null;
  readonly failure: LogLine | null;
}

// A FeedFrame as it crosses a process: its bar's Infinity arrives as null, so
// the host reads it through `parseFrame`.
export type WireFeedFrame = Omit<FeedFrame, "bar"> & {
  readonly bar: WireFrame;
};

export type Level = "info" | "warn" | "error";

export interface LogLine {
  readonly level: Level;
  readonly line: string;
}

// [LAW:effects-at-boundaries] exception: what the renderer reaches in the
// host that crosses a process: each a notice, which answers nothing, so a
// turn never waits on the host.
export interface AdapterToHost {
  // A feed's next frame brought forward.
  readonly wake: (sessionId: SessionId, cause: WakeCause) => void;
  // A line into the host's one log, which rotates itself: two writers would
  // each shift its generations.
  readonly log: (level: Level, line: string) => void;
  // Each session's idle clock and the timer that closes its menus. The draw's
  // idle period is read by the host and handed in with the input it draws.
  readonly menuIdle: {
    readonly clicked: (sessionId: SessionId, at: Instant) => void;
    readonly observe: (
      sessionId: SessionId,
      at: Instant,
      shown: boolean,
      timeoutS: number,
    ) => void;
  };
  // An answer carrying a daemon-wide held event (the launcher's pipe event,
  // the last renderer's end) reached its client.
  readonly eventAnswered: (event: HeldEvent) => void;
  // The renderer's watches, each held by the host's one registry under the
  // id the renderer minted, from its `watch` to its `unwatch`: every window
  // it hears comes back as a `watch` push.
  readonly watches: {
    readonly watch: (id: WatchId, key: string, targets: WatchTargets) => void;
    readonly unwatch: (id: WatchId) => void;
  };
  // [LAW:no-ambient-temporal-coupling] The storage folders each render state's
  // latest load named, held by the host's storage owner under the id the
  // renderer minted, from the state's first load to its reclaim: a folder's
  // watch lives as long as a build names it, never as long as a view. Every
  // load holds again, so a folder whose generation ended is keyed again at
  // the next load.
  readonly storage: {
    readonly hold: (id: StorageHoldId, folders: readonly string[]) => void;
    readonly release: (id: StorageHoldId) => void;
  };
}

// [LAW:types-are-the-program] Every reach crosses: the build fails on one a
// process could not carry, naming it.
export const REACHES_CROSS: Reaches<AdapterToHost> = true;

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), or which panes are on a screen changed (`visibility`).
export const WAKE_CAUSES = ["data", "state", "reload", "visibility"] as const;

export type WakeCause = (typeof WAKE_CAUSES)[number];

// What reloads every entry at once: the answers on disk moved, or file events
// resumed after a span in which an edit may have gone unheard.
export type EveryEntryLoad =
  | { readonly kind: "answers-watch"; readonly heard: Invalidation }
  | { readonly kind: "events-resumed"; readonly since: number };

// [LAW:effects-at-boundaries] exception: what the host reaches in the
// renderer, each a push it hands in as an `adapter` input
// (src/renderer-interface/interface.ts), answered by a reply of its own kind.
// The list is the work left: each later step deletes an arm.
export type AdapterPush =
  // The feed's draw of one frame of a subscribed session, with the lanes that
  // follow it and draw it now, what each lane was sent of late, and its idle
  // period.
  | {
      readonly kind: "frame";
      readonly session: SessionId;
      readonly fps: number;
      readonly following: readonly Lane[];
      readonly feeds: LaneFeeds;
      // When the idle period of the menus its last frame drew began, as the
      // host's idle clock reads it at the push.
      readonly idleSince: Instant | null;
    }
  // The lanes the session's view switches on, which a subscribe is gated by.
  | { readonly kind: "lanes"; readonly session: SessionId }
  // The feed's pin on the session's view, from its open to its close.
  | { readonly kind: "pin"; readonly session: SessionId }
  | { readonly kind: "unpin"; readonly session: SessionId }
  // The stats reply's reads of the renderer's state.
  | { readonly kind: "stats" }
  // The debug reply's projection of the most recently drawn view.
  | { readonly kind: "debug"; readonly what: DebugWhat }
  // Every entry's reload, when file events resume after `since`.
  | { readonly kind: "reload-every"; readonly since: number }
  // The reload of the config `origin` resolves to, after a write.
  | { readonly kind: "reload-config"; readonly origin: RenderOrigin }
  // What one of the renderer's watches heard: once as the host acquires it
  // (`heard` null), then for every window; and what of its targets the OS is
  // not listening to, as of the push.
  | {
      readonly kind: "watch";
      readonly id: WatchId;
      readonly heard: Invalidation | null;
      readonly deaf: readonly Deafness[];
    }
  // The daemon's teardown, in its three renderer steps: the journal in flight
  // commits, the views close, and the session state flushes, last.
  | { readonly kind: "close-journal" }
  | { readonly kind: "close-views" }
  | { readonly kind: "close-session-state" };

// The replies that carry what their push read.
type Reading =
  // Null while the session has no view.
  | { readonly kind: "frame"; readonly frame: WireFeedFrame | null }
  // Null while the session has no view.
  | { readonly kind: "lanes"; readonly lanes: LaneSwitches | null }
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
}
