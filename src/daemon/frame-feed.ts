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
import {
  LANE_NAMES,
  LANES,
  MOVING_FPS,
  perLane,
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
  type LaneSwitches,
} from "../config/lanes";
import { laneOffReason } from "../config/menu-places";

// What one frame of the feed drew: the response its subscribers receive,
// whether the bar it drew moves, and — for a render that threw — the render
// event describing it, logged when that failure is first pushed. It is drawn
// for the feed (`drawing.by` "feed"), so it shows the feed's pace where a
// render request's answer shows none.
// [LAW:decomposition] A frame says only what was drawn. Whether anyone can see
// it is the feed's question, asked when it schedules the next.
// A frame's two answers: the bar, which a lane drawing it elsewhere draws,
// and what Claude Code's statusline shows — the bar, or the handoff line in
// its place while a lane draws it elsewhere (src/daemon/lane-handoff.ts).
export interface FeedFrame {
  readonly resp: Response;
  readonly statusline: Response;
  readonly moves: boolean;
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
export const FEED_PERIODS: FeedPeriods = {
  moving: 1000 / MOVING_FPS,
  still: 1000,
};

// The window a lane's frame rate is counted over.
const RATE_WINDOW_MS = 1000;

// A subscriber: its lane's answer to each frame, and its JSON as the feed
// serialized it once for every subscriber of that lane.
export type Sink = (resp: Response, json: string) => void;

export type Refusal = Extract<Response, { ok: false }>;

// One subscription: the lane it serves, where its frames go, where its
// refusal goes — the last thing it receives, since a refused subscription is
// over — and whether it draws the bar where its lane puts it now. A client's
// subscription draws whatever it is sent; the daemon's own tmux status line
// draws a session only while that status line shows the session's pane.
export interface Subscriber {
  readonly lane: Lane;
  readonly frame: Sink;
  readonly refused: (resp: Refusal) => void;
  readonly drawing: () => boolean;
}

export interface FeedDeps<Req> {
  // Draws a frame of the session `req` is from. `fps` is the feed's pace, the
  // frames a second it draws this bar at, which the frame shows.
  // [LAW:one-source-of-truth] The pace the feed set, not a count of frames
  // (`feedsOf` counts pushes): a frame showing a count changes whenever the
  // count does — an extra draw for a click, the frame's own push — and is
  // pushed for it, so a still bar would never be still.
  render(req: Req, fps: number): Promise<FeedFrame>;
  // Which animation lanes the settings of the session `req` is from switch on
  // now — its config under its session's picks, never a copy taken when a
  // frame was drawn, so a toggle turned on is honoured at the next subscribe.
  lanes(req: Req): LaneSwitches;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // The first feed opened: whatever runs only while some feed exists starts,
  // and the returned stop is called when the last feed closes.
  watching(): () => void;
  // Calls `onChange` whenever the session's own state changes (a click opening
  // a menu), so its next frame is drawn at once rather than when it falls due.
  // Returns the disposer.
  watch(sessionId: string, onChange: () => void): () => void;
  periods: FeedPeriods;
  // Milliseconds on a clock that never steps back: a feed measures only
  // durations with it — periods, the rate window, how long it has run.
  now(): number;
  log(level: Level, line: string): void;
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
  // Each subscriber, with the bytes it was last sent: a lane whose answer a
  // frame left as it was is not sent it again.
  readonly followers: Map<Subscriber, string | null>;
  // When each frame of the last RATE_WINDOW_MS went out to each lane a
  // subscriber follows, oldest first: kept from the lane's first subscriber
  // joining to its last leaving, and not counting the frame a subscriber is
  // handed as it joins, which is the bar as it stood, not one more frame.
  readonly rates: Map<Lane, number[]>;
  readonly unwatch: () => void;
  phase: Phase;
  // The last frame pushed, as serialized, so an unchanged frame is never
  // pushed twice and a new subscriber gets the bar at once.
  last: {
    readonly answers: Answers;
  } | null;
  readonly since: number;
  drawn: number;
  noted: number;
  // Next frames set at the moving rate, and those set at the still rate
  // because the moving bar was on no screen: counts of the decision, since
  // only the decision asks whether a bar is seen.
  moving: number;
  unseen: number;
  failed: number;
  pushed: number;
  // The frames a second the feed draws at, as it last set the next frame.
  pace: number;
  drawMs: number;
  summarizedAt: number;
}

// The render event's `feeds=` field: each lane following the session as
// `<lane>:<subscribers>sub/<fps>fps/shown|offscreen`, `-` when none does.
export function feedsFact(feeds: LaneFeeds): string {
  return (
    LANE_NAMES.filter((lane) => feeds[lane].subscribers > 0)
      .map((lane) => {
        const { subscribers, fps, shown } = feeds[lane];
        return `${lane}:${subscribers}sub/${fps}fps/${shown ? "shown" : "offscreen"}`;
      })
      .join(",") || "-"
  );
}

// Note a frame going out to a lane at `now`, forgetting those older than the
// rate window, so a lane holds at most one window's worth however long it runs.
function noteSent(rate: number[], now: number): void {
  rate.push(now);
  const kept = rate.findIndex((at) => at > now - RATE_WINDOW_MS);
  rate.splice(0, kept);
}

interface Sent {
  readonly resp: Response;
  readonly bytes: string;
}
interface Answers {
  readonly bar: Sent;
  readonly statusline: Sent;
}
const sentOf = (resp: Response): Sent => ({
  resp,
  bytes: JSON.stringify(resp),
});

// [LAW:one-source-of-truth] A lane drawing the bar elsewhere draws the bar;
// the one drawing it in the statusline draws what the statusline shows.
const answerOf = (answers: Answers, lane: Lane): Sent =>
  LANES[lane].elsewhere === null ? answers.statusline : answers.bar;

// [LAW:one-source-of-truth] The frames a second a feed draws at: the period it
// set, never a time it measured. The pace is drawn into the frame, so a
// measured one (a render's duration) would move with each render and make
// frames whose bar did not change differ, defeating the dedupe; how many
// frames a lane was actually sent is feedsOf's count.
const paceOf = (period: number): number => Math.round(1000 / period);

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
  // `newestWhere` lookups (a tmux bar pane asking whose bar its pane holds),
  // and how many found a session.
  readonly lookups: number;
  readonly found: number;
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
  // [LAW:no-ambient-temporal-coupling] The stop of what runs while any feed
  // exists: held exactly from the first feed opening to the last closing.
  private stopWatching: (() => void) | null = null;
  private drawn = 0;
  private pushed = 0;
  private refused = 0;
  private lookups = 0;
  private found = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon received `order`-th. The latest request
  // a session sent is the one its frames are drawn from; one that arrived
  // before it — a slow render finishing late — is not the session's data.
  note(sessionId: string, req: Req, order: number): void {
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
    feed.noted++;
    // [LAW:one-source-of-truth] Every frame a subscriber receives is one the
    // feed drew, as a frame (`drawing.by` is "feed", and the bar shows the
    // feed's pace): the request's own answer is its client's alone, so the new data
    // is drawn at once instead of being pushed.
    this.wake(sessionId);
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
    feed.followers.set(sub, null);
    if (!feed.rates.has(sub.lane)) feed.rates.set(sub.lane, []);
    this.send(feed, sub);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${feed.followers.size} data=${this.requests.has(sessionId) ? "Y" : "N"}`,
    );
    return () => this.unsubscribe(feed, sub);
  }

  // The lanes whose subscribers follow the session's frames and draw them now.
  following(sessionId: string): ReadonlySet<Lane> {
    return new Set(
      [...(this.feeds.get(sessionId)?.followers.keys() ?? [])]
        .filter((s) => s.drawing())
        .map((s) => s.lane),
    );
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

  // Draw at once the next frame of every watched session whose latest request
  // `match` accepts.
  wakeWhere(match: (req: Req) => boolean): void {
    for (const { sessionId, req } of this.watched())
      if (match(req)) this.wake(sessionId);
  }

  // The session of the newest request `match` accepts, among the latest
  // request of each session the daemon holds, or null when none does.
  newestWhere(match: (req: Req) => boolean): string | null {
    let newest: { sessionId: string; order: number } | null = null;
    for (const [sessionId, { req, order }] of this.requests)
      if (match(req) && (newest === null || order > newest.order))
        newest = { sessionId, order };
    this.lookups++;
    if (newest !== null) this.found++;
    return newest?.sessionId ?? null;
  }

  // The latest request of every session someone is watching, by session.
  watched(): Array<{ readonly sessionId: string; readonly req: Req }> {
    return [...this.feeds.keys()].flatMap((sessionId) => {
      const noted = this.requests.get(sessionId);
      return noted === undefined ? [] : [{ sessionId, req: noted.req }];
    });
  }

  // [LAW:nothing-unseen] What each lane of `sessionId`'s frames is doing now:
  // its subscribers, the frames that went out to it in the last second, and
  // whether the session's pane is on a screen, which decides the rate a moving
  // bar is drawn at.
  feedsOf(sessionId: string): LaneFeeds {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return UNFOLLOWED_FEEDS;
    const since = this.deps.now() - RATE_WINDOW_MS;
    const shown = this.shown(feed);
    return perLane((lane) => {
      const rate = feed.rates.get(lane);
      if (rate === undefined) return UNFOLLOWED;
      let subscribers = 0;
      for (const sub of feed.followers.keys())
        if (sub.lane === lane) subscribers++;
      let fps = 0;
      for (const at of rate) if (at > since) fps++;
      return { subscribers, fps, shown };
    });
  }

  getStats(): FeedStats {
    let subscribers = 0;
    for (const feed of this.feeds.values()) subscribers += feed.followers.size;
    return {
      feeds: this.feeds.size,
      subscribers,
      drawn: this.drawn,
      pushed: this.pushed,
      refused: this.refused,
      lookups: this.lookups,
      found: this.found,
    };
  }

  private open(sessionId: string): Feed {
    const now = this.deps.now();
    const feed: Feed = {
      sessionId,
      followers: new Map(),
      rates: new Map(),
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
      // Not yet set: the first frame is drawn at once, before any period is
      // chosen, and shows the still pace; a moving bar's next frame, one
      // moving period later, shows the moving pace.
      pace: paceOf(this.deps.periods.still),
      drawMs: 0,
      summarizedAt: now,
    };
    this.feeds.set(sessionId, feed);
    this.stopWatching ??= this.deps.watching();
    // A feed's clock starts when it opens: its first frame is drawn at once,
    // and pushed to the subscriber that opened it once the render is out. A
    // later subscriber is handed the frame as it stands.
    void this.draw(feed);
    return feed;
  }

  private unsubscribe(feed: Feed, sub: Subscriber): void {
    if (!feed.followers.delete(sub)) return;
    if (![...feed.followers.keys()].some((s) => s.lane === sub.lane))
      feed.rates.delete(sub.lane);
    if (feed.followers.size > 0) return;
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    feed.unwatch();
    this.feeds.delete(feed.sessionId);
    if (this.feeds.size === 0) {
      this.stopWatching?.();
      this.stopWatching = null;
    }
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
    const phase: Phase = { kind: "drawing", again: false };
    feed.phase = phase;
    const started = this.deps.now();
    // The render adapter answers a failed render with its error frame; a throw
    // out of it is a fault in the adapter, `draw`'s to report.
    const frame = await this.deps.render(req, feed.pace);
    const finished = this.deps.now();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    this.countFailure(feed, frame);
    this.push(feed, frame);
    if (this.feeds.get(feed.sessionId) !== feed) return;
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    if (phase.again) {
      void this.draw(feed);
      return;
    }
    this.schedule(feed, frame, started, finished);
  }

  // [LAW:no-ambient-temporal-coupling] The next frame is due a period after
  // this one STARTED, so the rate holds whatever a render costs, up to a
  // render as slow as the period, when frames are drawn back to back. A frame
  // step that faulted is followed at the still rate.
  // [LAW:dataflow-not-control-flow] The moving period is for a bar that moves
  // where someone can see it, asked here, as the next frame is set.
  private schedule(
    feed: Feed,
    frame: FeedFrame | null,
    started: number,
    finished: number,
  ): void {
    const moves = frame?.moves === true;
    const seen = moves && this.shown(feed);
    if (seen) feed.moving++;
    if (moves && !seen) feed.unseen++;
    const period = seen ? this.deps.periods.moving : this.deps.periods.still;
    feed.pace = paceOf(period);
    feed.phase = {
      kind: "due",
      timer: setTimeout(
        () => void this.draw(feed),
        Math.max(0, started + period - finished),
      ),
    };
  }

  private shown(feed: Feed): boolean {
    const noted = this.requests.get(feed.sessionId);
    return noted === undefined || this.deps.shown(noted.req);
  }

  private countFailure(feed: Feed, frame: FeedFrame): void {
    if (frame.failure !== null) feed.failed++;
  }

  private push(feed: Feed, frame: FeedFrame): void {
    // The lanes the session's settings switch on as this frame goes out.
    const noted = this.requests.get(feed.sessionId);
    if (noted !== undefined) {
      const lanes = this.deps.lanes(noted.req);
      for (const sub of [...feed.followers.keys()]) {
        if (lanes[sub.lane]) continue;
        this.unsubscribe(feed, sub);
        this.refuse(feed.sessionId, sub);
      }
    }
    if (feed.followers.size === 0) return;
    const answers = {
      bar: sentOf(frame.resp),
      statusline: sentOf(frame.statusline),
    };
    if (
      feed.last?.answers.bar.bytes === answers.bar.bytes &&
      feed.last.answers.statusline.bytes === answers.statusline.bytes
    )
      return;
    const before = feed.last?.answers ?? null;
    feed.last = { answers };
    this.pushed++;
    feed.pushed++;
    // [LAW:nothing-unseen] A failing frame's render event is logged when that
    // failure is first pushed: one that keeps throwing the same way draws the
    // same bytes, which are not pushed again, and the summary counts it.
    if (frame.failure !== null)
      this.deps.log(frame.failure.level, frame.failure.line);
    const now = this.deps.now();
    for (const [lane, rate] of feed.rates)
      if (
        before === null ||
        answerOf(before, lane).bytes !== answerOf(answers, lane).bytes
      )
        noteSent(rate, now);
    for (const sub of feed.followers.keys()) this.send(feed, sub);
  }

  // The last frame's answer for `sub`'s lane, unless it was sent that already.
  private send(feed: Feed, sub: Subscriber): void {
    if (feed.last === null) return;
    const { resp, bytes } = answerOf(feed.last.answers, sub.lane);
    if (feed.followers.get(sub) === bytes) return;
    sub.frame(resp, bytes);
    feed.followers.set(sub, bytes);
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
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.followers.size} lanes=${[...feed.followers.keys()].map((s) => s.lane).join(",") || "-"} for=${Math.round((now - feed.since) / 1000)}s drawn=${feed.drawn} noted=${feed.noted} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} pushed=${feed.pushed} pace=${feed.pace}fps meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
