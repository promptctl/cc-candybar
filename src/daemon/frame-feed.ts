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

import {
  REFRESH_TRIGGERS,
  type RefreshTrigger,
} from "../utils/refresh-ledger.js";
import { inspect } from "node:util";
import type { Instant } from "../utils/instant";
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
// when the bar it drew next changes, and — for a render that threw — the render
// event describing it, logged when that failure is first pushed. It is drawn
// for the feed (`drawing.by` "feed"), so it shows the feed's ceiling where a
// render request's answer shows that it is polled.
// [LAW:decomposition] A frame says only what was drawn. Whether anyone can see
// it is the feed's question, asked when it schedules the next.
// A frame's two answers: the bar, which a lane drawing it elsewhere draws,
// and what Claude Code's statusline shows — the bar, or the handoff line in
// its place while a lane draws it elsewhere (src/daemon/lane-handoff.ts).
export interface FeedFrame {
  readonly resp: Response;
  readonly statusline: Response;
  // The moment, in wall seconds, the drawn bar next changes without new data
  // (an effect's next step, a template's next frame, the closing flash's next
  // turn), or Infinity: when the feed draws it next, within its spacing.
  readonly nextChange: number;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // Records what the frame's copy clicks copy, once it went out to a follower.
  readonly delivered: () => void;
  readonly failure: LogLine | null;
}

type Level = "info" | "warn" | "error";
export interface LogLine {
  readonly level: Level;
  readonly line: string;
}

// Milliseconds from the start of one frame to the next: the closest a feed
// draws a bar on a screen, and the furthest apart it draws any bar — what a
// bar that says nothing of its next change, or sits on no screen, is drawn at,
// since its data and the clock (an age, a time of day) still move it.
export interface FeedPeriods {
  readonly moving: number;
  readonly still: number;
}

// 30 fps is the rate rich-js's effects were signed off at (EFFECT_CURVES), so a
// continuous effect is drawn at it, and one a second the rate Claude Code
// itself reaches.
export const FEED_PERIODS: FeedPeriods = {
  moving: 1000 / MOVING_FPS,
  still: 1000,
};

// The window a lane's frame rate is counted over, in seconds of the frames'
// own instants.
const RATE_WINDOW_S = 1;

// [LAW:no-ambient-temporal-coupling] How far the wall clock read at a draw may
// fall short of the instant its timer was set for when nothing is wrong, in
// seconds: the daemon's wall reading is truncated to the millisecond, a Node
// timer fires up to a millisecond early against it (libuv sets timers from its
// cached loop time), and a system clock being slewed moves the wall against the
// timer's clock by well under a millisecond across the longest wait, the still
// period — past the bound, that last term costs one extra draw, never a frame
// drawn before its change. A frame is drawn for the instant it was set for
// within this of the wall, so a frame set for a change shows it however its
// timer fires, and a wall clock stepped back is followed at the next draw.
const TIMER_RESOLUTION_S = 0.002;

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
  // Draws a frame of the session `req` is from, for the wall instant `at`.
  // `fps` is the feed's ceiling, the most frames a second it draws this bar
  // at, which the frame shows.
  // [LAW:one-source-of-truth] The ceiling the feed's spacing sets, not a count
  // of frames (`feedsOf` counts pushes) nor the gap between two: a frame
  // showing either changes whenever it does — an extra draw for a click, the
  // frame's own push, a bar's own beat — and is pushed for it, so a still bar
  // would never be still.
  // [LAW:effects-at-boundaries] Synchronous by type: a frame only reads what
  // its sources stored, so drawing one can await nothing and refresh nothing.
  // [LAW:types-are-the-program] Null when the session has no view to draw
  // yet: a frame opens none (src/daemon/cache/render.ts `holdView`), so the
  // feed waits for the event that opens one.
  render(sessionId: string, fps: number, at: Instant): FeedFrame | null;
  // Which animation lanes the session's settings switch on now, as its view
  // draws them — never a copy taken when a frame was drawn, so a toggle turned
  // on is honoured at the next subscribe. Null while it has no view.
  lanes(sessionId: string): LaneSwitches | null;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // The first feed opened: whatever runs only while some feed exists starts,
  // and the returned stop is called when the last feed closes.
  watching(): () => void;
  // Calls `onChange` whenever the session's own state changes (a click opening
  // a menu), so its next frame is brought forward (`wake`). Returns the
  // disposer.
  watch(sessionId: string, onChange: () => void): () => void;
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open, and the
  // entry it is of, from the feed's open to its close: the feed being open is
  // what keeps it, not its frames reading it. Returns the release.
  pin(sessionId: string): () => void;
  // Every source's refreshes so far, by trigger (the daemon's one ledger):
  // the feed's summary says how many ran while it was open, beside the frames
  // it drew, so a feed that drew without refreshing anything is seen to.
  refreshes(): Readonly<Record<RefreshTrigger, number>>;
  periods: FeedPeriods;
  // Milliseconds on a clock that never steps back: a feed measures only
  // durations with it — its spacing, how long it has run, a draw's cost.
  now(): number;
  // The wall clock: the instant a frame is drawn for, which its cells' next
  // change is a time on.
  instant(): Instant;
  log(level: Level, line: string): void;
}

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), or which panes are on a screen changed (`visibility`).
const WAKE_CAUSES = ["data", "state", "reload", "visibility"] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

// [LAW:no-ambient-temporal-coupling] Where a feed's frame clock stands, as
// state: no view to draw yet; the next frame due `at` a timer, on the
// monotonic clock; or a frame being drawn.
type Phase =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "due";
      readonly at: number;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: "drawing" };

interface Feed {
  readonly sessionId: string;
  // Each subscriber, with the bytes it was last sent: a lane whose answer a
  // frame left as it was is not sent it again.
  readonly followers: Map<Subscriber, string | null>;
  // The instant of each frame of the last RATE_WINDOW_S that went out to each lane a
  // subscriber follows, oldest first: kept from the lane's first subscriber
  // joining to its last leaving, and not counting the frame a subscriber is
  // handed as it joins, which is the bar as it stood, not one more frame.
  readonly rates: Map<Lane, Instant[]>;
  readonly unwatch: () => void;
  readonly unpin: () => void;
  phase: Phase;
  // The moment the last frame was drawn for, on the monotonic clock: what a
  // wake's next frame is spaced from.
  lastStart: number;
  // The last frame pushed, as serialized, so an unchanged frame is never
  // pushed twice and a new subscriber gets the bar at once.
  last: {
    readonly answers: Answers;
  } | null;
  readonly since: number;
  drawn: number;
  noted: number;
  // Frames due that found no view to draw, and waited.
  noView: number;
  // Next frames set sooner than the still period, because the bar changes
  // sooner on a screen, and those held to it only because the bar was on no
  // screen: counts of the decision, since only the decision asks whether a bar
  // is seen.
  moving: number;
  unseen: number;
  failed: number;
  pushed: number;
  drawMs: number;
  // Parts its frames evaluated: between data changes, those reading the instant.
  evaluated: number;
  // The wakes of each cause, and how many of them found the next frame
  // already as early as the feed's spacing allows.
  readonly woke: Record<WakeCause, number>;
  coalesced: number;
  summarizedAt: number;
  // The ledger's refreshes when the feed opened.
  readonly refreshesAtOpen: Readonly<Record<RefreshTrigger, number>>;
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

// Note a frame going out to a lane at `at`, keeping only the sends of the
// window ending there, so a lane holds at most one window's worth however long
// it runs — and a wall clock stepped back, which leaves earlier sends stamped
// after `at`, cannot grow it.
export function noteSent(rate: Instant[], at: Instant): void {
  const kept = rate.filter((sent) => sent > at - RATE_WINDOW_S && sent <= at);
  rate.splice(0, rate.length, ...kept, at);
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
  LANES[lane].handsOff ? answers.bar : answers.statusline;

// [LAW:one-source-of-truth] The frames a second a spacing allows: the most a
// feed draws its bar at, never a time it measured. It is drawn into the frame,
// so a measured one (a render's duration, the gap to the next change) would
// move with each render and make frames whose bar did not change differ,
// defeating the dedupe; how many frames a lane was actually sent is feedsOf's
// count.
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
  // a session sent is where the feeds find the session: whether its pane is
  // shown, and which sessions a wake or a lookup matches. Its frames draw by
  // the request its view is declared with. One that arrived before it — a
  // slow render finishing late — is not the session's latest.
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
    // [LAW:single-enforcer] Noting wakes nothing: what the request changes
    // reaches the bar through its session's view, which says so as it opens,
    // as the request is declared and again as each refresh it started lands,
    // and each of those wakes the feed (`wake`, "data") — a feed waiting for
    // a view included.
    // [LAW:one-source-of-truth] Every frame a subscriber receives is one the
    // feed drew, as a frame (`drawing.by` is "feed", and the bar shows the
    // feed's ceiling): the request's own answer is its client's alone.
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off is refused here before any feed
  // opens, and one whose lane is switched off while it streams is ended in
  // `push`. A session with no view yet waits, and its first frame decides.
  subscribe(sessionId: string, sub: Subscriber): () => void {
    const lanes = this.deps.lanes(sessionId);
    if (lanes !== null && !lanes[sub.lane]) {
      this.refuse(sessionId, sub);
      return () => {};
    }
    const held = this.feeds.get(sessionId);
    const feed = held ?? this.open(sessionId);
    feed.followers.set(sub, null);
    if (!feed.rates.has(sub.lane)) feed.rates.set(sub.lane, []);
    // [LAW:no-ambient-temporal-coupling] A feed's clock starts when it opens:
    // its first frame falls due as a wake's would, in a later turn than the
    // subscribe, so a subscribe draws nothing in its caller's turn. A later
    // subscriber is handed the frame as it stands, and the next is brought
    // forward: who follows the session is drawn into it (`following`).
    if (held !== undefined) this.send(feed, sub);
    this.hasten(feed);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${feed.followers.size} view=${lanes === null ? "N" : "Y"}`,
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

  // Something the session's bar shows changed, for `cause`: its next frame,
  // if anyone is watching it, is drawn as soon as the feed's spacing allows.
  wake(sessionId: string, cause: WakeCause): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    feed.woke[cause]++;
    if (!this.hasten(feed)) feed.coalesced++;
  }

  // Wake, for `cause`, every watched session whose latest request `match`
  // accepts.
  wakeWhere(cause: WakeCause, match: (req: Req) => boolean): void {
    for (const { sessionId, req } of this.watched())
      if (match(req)) this.wake(sessionId, cause);
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

  // The latest request the daemon holds of `sessionId`, or null when it
  // holds none.
  latest(sessionId: string): Req | null {
    return this.requests.get(sessionId)?.req ?? null;
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
  // [LAW:one-source-of-truth] Counted against the instant of the draw asking,
  // never a clock of the feed's own, so a frame's count is a function of the
  // frames before it and its own instant: like every value relative to now,
  // it is the draw's, and it changes nothing the feed wakes on.
  feedsOf(sessionId: string, at: Instant): LaneFeeds {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return UNFOLLOWED_FEEDS;
    const since = at - RATE_WINDOW_S;
    const shown = this.shown(feed);
    return perLane((lane) => {
      const rate = feed.rates.get(lane);
      if (rate === undefined) return UNFOLLOWED;
      let subscribers = 0;
      for (const sub of feed.followers.keys())
        if (sub.lane === lane) subscribers++;
      let fps = 0;
      for (const sent of rate) if (sent > since && sent <= at) fps++;
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
      unwatch: this.deps.watch(sessionId, () => this.wake(sessionId, "state")),
      unpin: this.deps.pin(sessionId),
      phase: { kind: "waiting" },
      // Never drawn: its first frame may be drawn now.
      lastStart: -Infinity,
      last: null,
      since: now,
      drawn: 0,
      noted: 0,
      noView: 0,
      moving: 0,
      unseen: 0,
      failed: 0,
      pushed: 0,
      drawMs: 0,
      evaluated: 0,
      woke: { data: 0, state: 0, reload: 0, visibility: 0 },
      coalesced: 0,
      summarizedAt: now,
      refreshesAtOpen: this.deps.refreshes(),
    };
    this.feeds.set(sessionId, feed);
    this.stopWatching ??= this.deps.watching();
    return feed;
  }

  // The daemon's close: every feed ends as its last subscriber's leaving ends
  // it, and the pane follow with the last of them.
  close(): void {
    for (const feed of [...this.feeds.values()])
      for (const sub of [...feed.followers.keys()]) this.unsubscribe(feed, sub);
  }

  private unsubscribe(feed: Feed, sub: Subscriber): void {
    if (!feed.followers.delete(sub)) return;
    if (![...feed.followers.keys()].some((s) => s.lane === sub.lane))
      feed.rates.delete(sub.lane);
    // Who follows the session is drawn into its frame (`following`).
    if (feed.followers.size > 0) {
      this.hasten(feed);
      return;
    }
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    feed.unwatch();
    feed.unpin();
    this.feeds.delete(feed.sessionId);
    if (this.feeds.size === 0) {
      this.stopWatching?.();
      this.stopWatching = null;
    }
    this.summarize(feed, "closed");
  }

  // [LAW:single-enforcer] The one fault path of a feed's frame step: a throw
  // anywhere in it — the render adapter, the lane gate, a subscriber's sink —
  // is logged as the feed's fault, and the feed's next frame is set as a
  // still frame's is. A frame step runs off a timer, so a throw it let go
  // would be an unhandled rejection, which exits the daemon.
  // [LAW:no-ambient-temporal-coupling] The frame is drawn for the instant its
  // timer was set for, kept within TIMER_RESOLUTION_S of the wall clock: a
  // frame set for a change shows it however early its timer fires, and none is
  // ever drawn further ahead of the wall than that, so nothing carries from
  // one frame to the next. Its moment on the monotonic clock is that instant's.
  private draw(feed: Feed, due: Instant): void {
    feed.phase = { kind: "drawing" };
    const started = this.deps.now();
    const wall = this.deps.instant();
    const at = Math.min(
      Math.max(due, wall),
      wall + TIMER_RESOLUTION_S,
    ) as Instant;
    const moment = started + (at - wall) * 1000;
    try {
      this.step(feed, started, moment, at);
    } catch (error) {
      // A frame that faulted spaces the next as a drawn one does, so a feed
      // woken while its adapter throws still draws at its spacing.
      feed.lastStart = moment;
      this.deps.log(
        "error",
        `feed sid=${JSON.stringify(feed.sessionId)} threw: ${inspect(error)}`,
      );
      if (this.feeds.get(feed.sessionId) !== feed) return;
      this.schedule(feed, null, at);
    }
  }

  private step(feed: Feed, started: number, moment: number, at: Instant): void {
    // The render adapter answers a failed render with its error frame; a throw
    // out of it is a fault in the adapter, `draw`'s to report.
    const frame = this.deps.render(
      feed.sessionId,
      paceOf(this.spacingOf(feed)),
      at,
    );
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits,
    // with no timer, until the event that opens one wakes it.
    // A draw that found no view drew nothing, so it spaces nothing: the
    // frame the view's opening wakes is drawn at once.
    if (frame === null) {
      feed.noView++;
      feed.phase = { kind: "waiting" };
      return;
    }
    feed.lastStart = moment;
    const finished = this.deps.now();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    feed.evaluated += frame.evaluated;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    this.countFailure(feed, frame);
    this.push(feed, frame, at);
    if (this.feeds.get(feed.sessionId) !== feed) return;
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    this.schedule(feed, frame, at);
  }

  // [LAW:no-ambient-temporal-coupling] The next frame is due when the bar
  // next changes, measured from the instant this one was drawn for — no
  // sooner than the feed's spacing allows and no later than the still period
  // — so a 1 s beat is drawn once a second, for the moment it turns, and a
  // continuous effect at the moving rate. Set as an instant, so the time this
  // frame took to draw comes off the wait and the rate holds whatever a render
  // costs. A frame step that faulted is followed as a still frame is.
  // [LAW:dataflow-not-control-flow] One clamp over values: a still bar's
  // next change is Infinity, and an unseen bar's spacing is the still period.
  private schedule(feed: Feed, frame: FeedFrame | null, at: Instant): void {
    const { moving, still } = this.deps.periods;
    const until = ((frame?.nextChange ?? Infinity) - at) * 1000;
    const shownPeriod = Math.min(Math.max(until, moving), still);
    const shown = this.shown(feed);
    if (shownPeriod < still && shown) feed.moving++;
    if (shownPeriod < still && !shown) feed.unseen++;
    const period = shown ? shownPeriod : still;
    this.arm(feed, (at + period / 1000) as Instant, this.deps.instant());
  }

  // [LAW:single-enforcer] The one bound on how close a feed's frames are: the
  // moving period while its bar is on a screen, the still period while it is
  // not. No cause of a wake sets the rate, so an unseen feed draws at most
  // once a still period however often it is woken.
  private spacingOf(feed: Feed): number {
    return this.shown(feed)
      ? this.deps.periods.moving
      : this.deps.periods.still;
  }

  // [LAW:single-enforcer] The one way a feed's next frame is brought forward:
  // to the earliest its spacing allows after the last frame was drawn for,
  // never later than it already falls due. Answers whether it moved anything:
  // a wake that did not was coalesced into a frame already due. Spaced on the
  // monotonic clock, so a wall clock stepped back cannot stall a wake.
  // [LAW:no-ambient-temporal-coupling] A frame is drawn in one synchronous
  // turn and opens nothing, so a wake while it draws is the draw's own, and
  // the frame reads what that moved: it is coalesced into that frame.
  private hasten(feed: Feed): boolean {
    const { phase } = feed;
    if (phase.kind === "drawing") return false;
    const now = this.deps.now();
    const at = Math.max(now, feed.lastStart + this.spacingOf(feed));
    if (phase.kind === "due" && phase.at <= at) return false;
    const wall = this.deps.instant();
    this.arm(feed, (wall + (at - now) / 1000) as Instant, wall);
    return true;
  }

  // [LAW:single-enforcer] The feed's one timer, set to draw its next frame for
  // the wall instant `due`, in a later turn than the caller's however soon
  // that is. Its wait is measured from `wall`, the caller's own reading, so
  // the instant a caller set is never rebuilt from a second, truncated one;
  // its monotonic due time is what a wake compares against.
  private arm(feed: Feed, due: Instant, wall: Instant): void {
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    const delay = Math.max(0, (due - wall) * 1000);
    feed.phase = {
      kind: "due",
      at: this.deps.now() + delay,
      timer: setTimeout(() => this.draw(feed, due), delay),
    };
  }

  private shown(feed: Feed): boolean {
    const noted = this.requests.get(feed.sessionId);
    return noted === undefined || this.deps.shown(noted.req);
  }

  private countFailure(feed: Feed, frame: FeedFrame): void {
    if (frame.failure !== null) feed.failed++;
  }

  private push(feed: Feed, frame: FeedFrame, at: Instant): void {
    // The lanes the session's settings switch on as this frame goes out.
    const lanes = this.deps.lanes(feed.sessionId);
    if (lanes !== null) {
      for (const sub of [...feed.followers.keys()]) {
        if (lanes[sub.lane]) continue;
        this.unsubscribe(feed, sub);
        this.refuse(feed.sessionId, sub);
      }
    }
    if (feed.followers.size === 0) return;
    // [LAW:one-source-of-truth] A frame whose bytes match the last one shows
    // the same links, so what they copy is this frame's, pushed or not.
    frame.delivered();
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
    for (const [lane, rate] of feed.rates)
      if (
        before === null ||
        answerOf(before, lane).bytes !== answerOf(answers, lane).bytes
      )
        noteSent(rate, at);
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
  //
  // `daemonRefreshed=` is every refresh the daemon made while the feed ran,
  // whichever session's: a frame refreshes nothing, so it bounds what the
  // feed's `drawn=` frames could have read fresh, and is never their own.
  private summarize(feed: Feed, state: "running" | "closed"): void {
    const now = this.deps.now();
    const refreshes = this.deps.refreshes();
    // The rate it drew at over its life, beside the most it draws at now: a
    // bar that changes less often than the ceiling is drawn as often as it
    // changes.
    const seconds = (now - feed.since) / 1000;
    const achieved =
      seconds === 0 ? "-" : `${(feed.drawn / seconds).toFixed(1)}fps`;
    const refreshed = REFRESH_TRIGGERS.map(
      (by) => `${by}:${refreshes[by] - feed.refreshesAtOpen[by]}`,
    ).join(",");
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.followers.size} lanes=${[...feed.followers.keys()].map((s) => s.lane).join(",") || "-"} for=${Math.round(seconds)}s drawn=${feed.drawn} noted=${feed.noted} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} pushed=${feed.pushed} ceiling=${paceOf(this.spacingOf(feed))}fps achieved=${achieved} evaluated=${feed.evaluated} woke=${WAKE_CAUSES.map((cause) => `${cause}:${feed.woke[cause]}`).join(",")} coalesced=${feed.coalesced} daemonRefreshed=${refreshed} meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
