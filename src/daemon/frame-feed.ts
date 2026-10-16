// A session's frames, pushed to whoever subscribes to them (epic
// candybar-animation-wbxz, ticket .jmm.usl). Claude Code reruns the statusline
// once a second at best; a subscriber here — a patched Claude Code, a mod, a
// renderer outside Claude Code — receives each frame the moment the daemon
// draws it, and the daemon draws at the rate the bar moves.
//
// Data and frames travel separately. A session's data arrives as ordinary
// render requests, from the statusline client on Claude Code's own schedule:
// `note` keeps the latest valid one. Its frames are drawn from that request at
// each instant they are drawn, so a frame between two of Claude Code's ticks is
// the same bar the next tick would draw, at a later instant.

import type { Response } from "./protocol";

// What one render produced for a feed: the response its subscribers receive
// (the one a render request is answered with) and whether anything on the bar
// moves, which decides when the next frame is due.
export interface FeedFrame {
  readonly resp: Response;
  readonly moving: boolean;
}

// Milliseconds from the start of one frame to the next: while the bar moves,
// and while it is still (when only its data and the clock change it).
export interface FeedPeriods {
  readonly moving: number;
  readonly still: number;
}

// 30 fps is the rate rich-js's effects were signed off at (EFFECT_CURVES), and
// one a second the rate Claude Code itself reaches.
export const FEED_PERIODS: FeedPeriods = { moving: 1000 / 30, still: 1000 };

export type Sink = (resp: Response) => void;

export interface FeedDeps<Req> {
  render(req: Req): Promise<FeedFrame>;
  // Calls `onChange` whenever the session's own state changes (a click opening
  // a menu), so its next frame is drawn at once rather than when it falls due.
  // Returns the disposer.
  watch(sessionId: string, onChange: () => void): () => void;
  periods: FeedPeriods;
  now(): number;
  log(level: "info" | "warn" | "error", line: string): void;
}

// [LAW:no-ambient-temporal-coupling] Where a feed's frame clock stands, as
// state: no request to draw from yet; the next frame due at a timer; or a frame
// being drawn, with whether a change arrived while it was (`again`: draw the
// next one as soon as this one is out).
type Phase =
  | { readonly kind: "waiting" }
  | { readonly kind: "due"; readonly timer: ReturnType<typeof setTimeout> }
  | { kind: "drawing"; again: boolean };

interface Feed {
  readonly sessionId: string;
  readonly sinks: Set<Sink>;
  readonly unwatch: () => void;
  phase: Phase;
  // The last frame pushed, as sent, so an unchanged frame is never sent twice
  // and a new subscriber gets the bar at once.
  last: { readonly resp: Response; readonly bytes: string } | null;
  readonly since: number;
  drawn: number;
  pushed: number;
  drawMs: number;
  summarizedAt: number;
}

// How often a long-lived feed writes its summary to the log.
const SUMMARY_EVERY_MS = 60_000;
// Sessions whose latest request is kept, least recently noted evicted first.
const MAX_REQUESTS = 256;

export interface FeedStats {
  readonly feeds: number;
  readonly subscribers: number;
  readonly drawn: number;
  readonly pushed: number;
}

/**
 * [LAW:no-shared-mutable-globals] Every session's latest request and every
 * subscribed session's feed: one owner, the daemon. A feed exists exactly while
 * the session has a subscriber; its frames are drawn one at a time, so two
 * subscribers to one session share every render.
 */
export class FrameFeeds<Req> {
  private readonly requests = new Map<string, Req>();
  private readonly feeds = new Map<string, Feed>();
  private drawn = 0;
  private pushed = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // The session's latest valid render request, which its frames are drawn
  // from from now on.
  note(sessionId: string, req: Req): void {
    this.requests.delete(sessionId);
    this.requests.set(sessionId, req);
    for (const oldest of this.requests.keys()) {
      if (this.requests.size <= MAX_REQUESTS) break;
      this.requests.delete(oldest);
    }
    this.wake(sessionId);
  }

  subscribe(sessionId: string, sink: Sink): () => void {
    const feed = this.feeds.get(sessionId) ?? this.open(sessionId);
    feed.sinks.add(sink);
    if (feed.last !== null) sink(feed.last.resp);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed subscribers=${feed.sinks.size} data=${this.requests.has(sessionId) ? "Y" : "N"}`,
    );
    this.wake(sessionId);
    return () => this.unsubscribe(feed, sink);
  }

  // Draw the session's next frame now, if anyone is watching it.
  wake(sessionId: string): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    switch (feed.phase.kind) {
      case "drawing":
        feed.phase.again = true;
        return;
      case "due":
        clearTimeout(feed.phase.timer);
        void this.draw(feed);
        return;
      case "waiting":
        void this.draw(feed);
        return;
    }
  }

  getStats(): FeedStats {
    let subscribers = 0;
    for (const feed of this.feeds.values()) subscribers += feed.sinks.size;
    return {
      feeds: this.feeds.size,
      subscribers,
      drawn: this.drawn,
      pushed: this.pushed,
    };
  }

  private open(sessionId: string): Feed {
    const now = this.deps.now();
    const feed: Feed = {
      sessionId,
      sinks: new Set(),
      unwatch: this.deps.watch(sessionId, () => this.wake(sessionId)),
      phase: { kind: "waiting" },
      last: null,
      since: now,
      drawn: 0,
      pushed: 0,
      drawMs: 0,
      summarizedAt: now,
    };
    this.feeds.set(sessionId, feed);
    return feed;
  }

  private unsubscribe(feed: Feed, sink: Sink): void {
    if (!feed.sinks.delete(sink) || feed.sinks.size > 0) return;
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    feed.unwatch();
    this.feeds.delete(feed.sessionId);
    this.summarize(feed, "closed");
  }

  private async draw(feed: Feed): Promise<void> {
    const req = this.requests.get(feed.sessionId);
    if (req === undefined) {
      feed.phase = { kind: "waiting" };
      return;
    }
    const phase: Phase = { kind: "drawing", again: false };
    feed.phase = phase;
    const started = this.deps.now();
    const frame = await this.deps
      .render(req)
      .catch((error: unknown): FeedFrame | null => {
        // [LAW:no-silent-failure] The render adapter answers a failed render
        // with its error response; reaching here is a fault in the adapter.
        this.deps.log(
          "error",
          `feed sid=${JSON.stringify(feed.sessionId)} render adapter threw: ${String(error)}`,
        );
        return null;
      });
    const finished = this.deps.now();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    if (frame !== null) this.push(feed, frame.resp);
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    if (phase.again) {
      void this.draw(feed);
      return;
    }
    const period =
      frame?.moving === true
        ? this.deps.periods.moving
        : this.deps.periods.still;
    // [LAW:no-ambient-temporal-coupling] The next frame is due a period after
    // this one STARTED, so the rate holds whatever a render costs, up to a
    // render as slow as the period, when frames are drawn back to back.
    feed.phase = {
      kind: "due",
      timer: setTimeout(
        () => void this.draw(feed),
        Math.max(0, started + period - finished),
      ),
    };
  }

  private push(feed: Feed, resp: Response): void {
    const bytes = JSON.stringify(resp);
    if (feed.last?.bytes === bytes) return;
    feed.last = { resp, bytes };
    this.pushed++;
    feed.pushed++;
    for (const sink of feed.sinks) sink(resp);
  }

  // [LAW:nothing-unseen] A feed's frames are not render requests, so they write
  // no render event each: a feed says what it drew in a summary, when it
  // closes and once a minute while it runs.
  private summarize(feed: Feed, state: "running" | "closed"): void {
    const now = this.deps.now();
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.sinks.size} for=${Math.round((now - feed.since) / 1000)}s drawn=${feed.drawn} pushed=${feed.pushed} meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
