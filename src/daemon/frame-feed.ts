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

import { inspect } from "node:util";
import { PROTOCOL_VERSION, type Response } from "./protocol";
import { laneOffReason, type Lane, type LaneSwitches } from "../config/lanes";

// [LAW:types-are-the-program] Why the next frame falls due when it does: the
// bar moves and someone can see it; it moves where nobody can, so it is drawn
// at the still rate; or nothing on it moves.
export type Motion = "moving" | "unseen" | "still";

// What one render produced for a feed: the response its subscribers receive
// (the one a render request is answered with), the instant it was drawn at (ms
// since the epoch), how the bar moves, which decides when the next frame is
// due, and — for a render that threw — the render event describing it, logged
// when that failure is first pushed.
export interface FeedFrame {
  readonly resp: Response;
  readonly drawnAt: number;
  readonly motion: Motion;
  readonly failure: LogLine | null;
}

type Level = "info" | "warn" | "error";
export interface LogLine {
  readonly level: Level;
  readonly line: string;
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

// A subscriber: each frame's response, and its JSON as the feed serialized it
// once for every subscriber.
export type Sink = (resp: Response, json: string) => void;

export type Refusal = Extract<Response, { ok: false }>;

// One subscription: the lane it serves, where its frames go, and where its
// refusal goes — the last thing it receives, since a refused subscription is
// over.
export interface Subscriber {
  readonly lane: Lane;
  readonly frame: Sink;
  readonly refused: (resp: Refusal) => void;
}

export interface FeedDeps<Req> {
  render(req: Req): Promise<FeedFrame>;
  // Which animation lanes the settings of the session `req` is from switch on
  // now — its config under its session's picks, never a copy taken when a
  // frame was drawn, so a toggle turned on is honoured at the next subscribe.
  lanes(req: Req): LaneSwitches;
  // A feed opened: whatever runs only while some feed exists starts.
  opened(): void;
  // Calls `onChange` whenever the session's own state changes (a click opening
  // a menu), so its next frame is drawn at once rather than when it falls due.
  // Returns the disposer.
  watch(sessionId: string, onChange: () => void): () => void;
  periods: FeedPeriods;
  now(): number;
  log(level: Level, line: string): void;
}

// [LAW:no-ambient-temporal-coupling] Where a feed's frame clock stands, as
// state: no request to draw from yet; the next frame due at a timer; or a frame
// being drawn, with whether a change arrived while it was (`again`: draw the
// next one as soon as this one is out) and the noted frame that superseded it
// (`superseded`: the frame the next one is due from, when it was noted).
type Phase =
  | { readonly kind: "waiting" }
  | { readonly kind: "due"; readonly timer: ReturnType<typeof setTimeout> }
  | {
      kind: "drawing";
      again: boolean;
      superseded: { readonly frame: FeedFrame; readonly at: number } | null;
    };

interface Feed {
  readonly sessionId: string;
  readonly sinks: Set<Subscriber>;
  readonly unwatch: () => void;
  phase: Phase;
  // The last frame pushed, as sent, so an unchanged frame is never sent twice
  // and a new subscriber gets the bar at once.
  last: {
    readonly resp: Response;
    readonly bytes: string;
    readonly drawnAt: number;
  } | null;
  readonly since: number;
  drawn: number;
  noted: number;
  moving: number;
  unseen: number;
  failed: number;
  pushed: number;
  drawMs: number;
  summarizedAt: number;
}

// How often a long-lived feed writes its summary to the log.
const SUMMARY_EVERY_MS = 60_000;
// Sessions whose latest request is kept, least recently noted evicted first —
// except a session someone is watching, whose feed draws from it.
const MAX_REQUESTS = 256;

// A session's latest request and `order`: where it came in the order the
// daemon received requests, which is what makes one request later than another
// when their renders finish out of order.
interface Noted<Req> {
  readonly req: Req;
  readonly order: number;
}

export interface FeedStats {
  readonly feeds: number;
  readonly subscribers: number;
  readonly drawn: number;
  readonly pushed: number;
  // Subscriptions refused or ended because their lane was off.
  readonly refused: number;
}

/**
 * [LAW:no-shared-mutable-globals] Every session's latest request and every
 * subscribed session's feed: one owner, the daemon. A feed exists exactly while
 * the session has a subscriber; its frames are drawn one at a time, so two
 * subscribers to one session share every render.
 */
export class FrameFeeds<Req> {
  private readonly requests = new Map<string, Noted<Req>>();
  private readonly feeds = new Map<string, Feed>();
  private drawn = 0;
  private pushed = 0;
  private refused = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon received `order`-th, and `frame`: the
  // bar it was answered with. The latest request a session sent is the one its
  // frames are drawn from; one that arrived before it — a slow render finishing
  // late — is not the session's data, and its frame would step the bar back.
  // [LAW:one-source-of-truth] The answer IS the request's frame at this
  // instant, so it is pushed as one, and the next frame falls due a period
  // after it rather than being drawn again at once.
  note(sessionId: string, req: Req, order: number, frame: FeedFrame): void {
    const held = this.requests.get(sessionId);
    if (held !== undefined && held.order > order) return;
    this.requests.delete(sessionId);
    this.requests.set(sessionId, { req, order });
    for (const oldest of this.requests.keys()) {
      if (this.requests.size <= MAX_REQUESTS) break;
      if (!this.feeds.has(oldest)) this.requests.delete(oldest);
    }
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    // An answer drawn at an earlier instant than a frame already out would
    // step the bar back in time: the newer data is drawn afresh instead.
    if (feed.last !== null && frame.drawnAt < feed.last.drawnAt) {
      this.wake(sessionId);
      return;
    }
    feed.noted++;
    this.count(feed, frame);
    this.push(feed, frame);
    if (this.feeds.get(sessionId) !== feed) return;
    const now = this.deps.now();
    switch (feed.phase.kind) {
      case "drawing":
        // The frame being drawn is of the request this one replaced: it is
        // not pushed, and its draw schedules the next from this one.
        feed.phase.superseded = { frame, at: now };
        return;
      case "due":
        clearTimeout(feed.phase.timer);
        break;
      case "waiting":
        break;
    }
    this.schedule(feed, frame, now, now);
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off is refused here before any feed
  // opens, and one whose lane is switched off while it streams is ended in
  // `push`. A session the daemon holds no request of yet waits, and its first
  // frame decides.
  subscribe(sessionId: string, sub: Subscriber): () => void {
    const noted = this.requests.get(sessionId);
    if (noted !== undefined && !this.deps.lanes(noted.req)[sub.lane]) {
      this.refuse(sessionId, sub);
      return () => {};
    }
    const feed = this.feeds.get(sessionId) ?? this.open(sessionId);
    feed.sinks.add(sub);
    if (feed.last !== null) sub.frame(feed.last.resp, feed.last.bytes);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${feed.sinks.size} data=${this.requests.has(sessionId) ? "Y" : "N"}`,
    );
    return () => this.unsubscribe(feed, sub);
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

  // The latest request of every session someone is watching, by session.
  watched(): Array<{ readonly sessionId: string; readonly req: Req }> {
    return [...this.feeds.keys()].flatMap((sessionId) => {
      const noted = this.requests.get(sessionId);
      return noted === undefined ? [] : [{ sessionId, req: noted.req }];
    });
  }

  getStats(): FeedStats {
    let subscribers = 0;
    for (const feed of this.feeds.values()) subscribers += feed.sinks.size;
    return {
      feeds: this.feeds.size,
      subscribers,
      drawn: this.drawn,
      pushed: this.pushed,
      refused: this.refused,
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
      noted: 0,
      moving: 0,
      unseen: 0,
      failed: 0,
      pushed: 0,
      drawMs: 0,
      summarizedAt: now,
    };
    this.feeds.set(sessionId, feed);
    this.deps.opened();
    // A feed's clock starts when it opens: its first frame is drawn at once,
    // and pushed to the subscriber that opened it once the render is out. A
    // later subscriber is handed the frame as it stands.
    void this.draw(feed);
    return feed;
  }

  private unsubscribe(feed: Feed, sub: Subscriber): void {
    if (!feed.sinks.delete(sub) || feed.sinks.size > 0) return;
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    feed.unwatch();
    this.feeds.delete(feed.sessionId);
    this.summarize(feed, "closed");
  }

  // [LAW:single-enforcer] The one fault path of a feed's frame step: a throw
  // anywhere in it — the render adapter, the lane gate, a subscriber's sink —
  // is logged as the feed's fault, and the feed's next frame falls due at the
  // still rate. A frame step runs off a timer, so a throw it let go would be an
  // unhandled rejection, which exits the daemon.
  private draw(feed: Feed): Promise<void> {
    return this.step(feed).catch((error: unknown) => {
      this.deps.log(
        "error",
        `feed sid=${JSON.stringify(feed.sessionId)} threw: ${inspect(error)}`,
      );
      if (this.feeds.get(feed.sessionId) !== feed) return;
      const now = this.deps.now();
      this.schedule(feed, null, now, now);
    });
  }

  private async step(feed: Feed): Promise<void> {
    const noted = this.requests.get(feed.sessionId);
    if (noted === undefined) {
      feed.phase = { kind: "waiting" };
      return;
    }
    const { req } = noted;
    const phase: Phase = { kind: "drawing", again: false, superseded: null };
    feed.phase = phase;
    const started = this.deps.now();
    // The render adapter answers a failed render with its error frame; a throw
    // out of it is a fault in the adapter, `draw`'s to report.
    const frame = await this.deps.render(req);
    const finished = this.deps.now();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    this.count(feed, frame);
    // A request noted while this frame was drawn was pushed as its own frame;
    // this one, of the data before it, would step the bar back.
    if (this.requests.get(feed.sessionId) === noted) {
      this.push(feed, frame);
      if (this.feeds.get(feed.sessionId) !== feed) return;
    }
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    if (phase.again) {
      void this.draw(feed);
      return;
    }
    const basis = phase.superseded ?? { frame, at: started };
    this.schedule(feed, basis.frame, basis.at, finished);
  }

  // [LAW:no-ambient-temporal-coupling] The next frame is due a period after
  // this one STARTED, so the rate holds whatever a render costs, up to a
  // render as slow as the period, when frames are drawn back to back. A frame
  // step that faulted is followed at the still rate.
  private schedule(
    feed: Feed,
    frame: FeedFrame | null,
    started: number,
    finished: number,
  ): void {
    const period =
      frame?.motion === "moving"
        ? this.deps.periods.moving
        : this.deps.periods.still;
    feed.phase = {
      kind: "due",
      timer: setTimeout(
        () => void this.draw(feed),
        Math.max(0, started + period - finished),
      ),
    };
  }

  private count(feed: Feed, frame: FeedFrame): void {
    if (frame.motion === "moving") feed.moving++;
    if (frame.motion === "unseen") feed.unseen++;
    if (frame.failure !== null) feed.failed++;
  }

  private push(feed: Feed, frame: FeedFrame): void {
    // The lanes the session's settings switch on as this frame goes out.
    const noted = this.requests.get(feed.sessionId);
    if (noted !== undefined) {
      const lanes = this.deps.lanes(noted.req);
      for (const sub of [...feed.sinks]) {
        if (lanes[sub.lane]) continue;
        this.unsubscribe(feed, sub);
        this.refuse(feed.sessionId, sub);
      }
    }
    if (feed.sinks.size === 0) return;
    const { resp } = frame;
    const bytes = JSON.stringify(resp);
    if (feed.last?.bytes === bytes) return;
    feed.last = { resp, bytes, drawnAt: frame.drawnAt };
    this.pushed++;
    feed.pushed++;
    // [LAW:nothing-unseen] A failing frame's render event is logged when that
    // failure is first pushed: one that keeps throwing the same way draws the
    // same bytes, which are not pushed again, and the summary counts it.
    if (frame.failure !== null)
      this.deps.log(frame.failure.level, frame.failure.line);
    for (const sub of feed.sinks) sub.frame(resp, bytes);
  }

  // A subscription its lane's toggle refuses, told why.
  private refuse(sessionId: string, sub: Subscriber): void {
    this.refused++;
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} refused lane=${sub.lane} switched-off`,
    );
    sub.refused({
      ok: false,
      error: laneOffReason(sub.lane),
      code: "SWITCHED_OFF",
      daemonV: PROTOCOL_VERSION,
    });
  }

  // [LAW:nothing-unseen] A feed's frames are not render requests, so they write
  // no render event each: a feed says what it drew in a summary, when it
  // closes and once a minute while it runs.
  private summarize(feed: Feed, state: "running" | "closed"): void {
    const now = this.deps.now();
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.sinks.size} lanes=${[...feed.sinks].map((s) => s.lane).join(",") || "-"} for=${Math.round((now - feed.since) / 1000)}s drawn=${feed.drawn} noted=${feed.noted} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} pushed=${feed.pushed} meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
