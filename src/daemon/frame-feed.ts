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
import type { Frame } from "../render/frame";
import type { Instant } from "../utils/instant";
import { PROTOCOL_VERSION, type Refusal } from "./foundations/protocol";
import { renderFailed } from "./foundations/render-answers";
import {
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
import type { Timekeeper } from "../time";
import type { SessionId } from "./foundations/session-id";
import { failureOf } from "./foundations/verb-error.js";
import type { FeedStats } from "./foundations/stats-snapshot";
import {
  type FeedFrame,
  type Level,
  WAKE_CAUSES,
  type WakeCause,
} from "../renderer-interface/adapter";

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
// seconds: the daemon's wall reading is truncated to the millisecond, and a
// system clock being slewed moves the wall against the timer's clock by well
// under a millisecond across the longest wait, the still period — past the
// bound, that last term costs one extra draw, never a frame drawn before its
// change. A timer firing early is not in the bound: `fire` waits it out. A
// frame is drawn for the instant it was set for within this of the wall, so a
// frame set for a change shows it however its timer fires, and a wall clock
// stepped back is followed at the next draw.
const TIMER_RESOLUTION_S = 0.002;

// A subscriber: each frame's bar, which a lane drawing it elsewhere encodes,
// and its lane's answer as the feed serialized it once for every subscriber of
// that lane.
export type Sink = (bar: Frame, json: string) => void;

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
  // The daemon's clock: the monotonic reading every frame moment is on (a clock
  // that never steps back: a feed measures only durations with it — its spacing,
  // how long it has run, a draw's cost), and the timer its next frame waits on.
  clock: Pick<Timekeeper, "monotonic" | "after">;
  // Draws a frame of the session `req` is from, for the wall instant `at`.
  // `fps` is the feed's ceiling, the most frames a second it draws this bar
  // at, which the frame shows.
  // [LAW:one-source-of-truth] The ceiling the feed's spacing sets, not a count
  // of frames (`feedsOf` counts pushes) nor the gap between two: a frame
  // showing either changes whenever it does — an extra draw for a click, the
  // frame's own push, a bar's own beat — and is pushed for it, so a still bar
  // would never be still.
  // `following` and `feeds` are the feed's own (`following`, `feedsOf`), read
  // as it asks, so the draw reads no feed.
  // [LAW:effects-at-boundaries] A frame only reads what its sources stored, so
  // it refreshes nothing; it is drawn in the renderer's turn and arrives
  // later, and the feed's phase says what happens meanwhile.
  // [LAW:types-are-the-program] Null when the session has no view to draw
  // yet: a frame opens none (src/renderer/render-cache.ts `holdView`), so the
  // feed waits for the event that opens one.
  frame(
    sessionId: SessionId,
    fps: number,
    at: Instant,
    following: readonly Lane[],
    feeds: LaneFeeds,
  ): Promise<FeedFrame | null>;
  // Which animation lanes the session's settings switch on now, as its view
  // draws them — never a copy taken when a frame was drawn, so a toggle turned
  // on is honoured at the next subscribe. Null while it has no view.
  lanes(sessionId: SessionId): Promise<LaneSwitches | null>;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // The first feed opened: whatever runs only while some feed exists starts,
  // and the returned stop is called when the last feed closes.
  watching(): () => void;
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open, and the
  // entry it is of, from the feed's open (`pin`) to its close (`unpin`): the
  // feed being open is what keeps it, not its frames reading it. The pin also
  // wakes the feed whenever the session's own state changes (a click opening
  // a menu), as `wake` "state". Neither is awaited: the renderer takes them
  // in the order they were sent, before and after the feed's frames.
  pin(sessionId: SessionId): void;
  unpin(sessionId: SessionId): void;
  // Every source's refreshes so far, by trigger (the daemon's one ledger):
  // the feed's summary says how many ran while it was open, beside the frames
  // it drew, so a feed that drew without refreshing anything is seen to.
  refreshes(): Readonly<Record<RefreshTrigger, number>>;
  periods: FeedPeriods;
  // The wall clock: the instant a frame is drawn for, which its cells' next
  // change is a time on.
  instant(): Instant;
  log(level: Level, line: string): void;
}

// [LAW:no-ambient-temporal-coupling] Where a feed's frame clock stands, as
// state: no view to draw yet; the next frame due `at` a timer, on the
// monotonic clock; or a frame out to the renderer, and whether a wake came
// while it was (`woken`): the frame may have been drawn before what woke it
// moved, so the wake is owed the next frame, at the feed's spacing.
type Phase =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "due";
      readonly at: number;
      readonly clear: () => void;
    }
  | { readonly kind: "drawing"; readonly woken: boolean };

interface Feed {
  readonly sessionId: SessionId;
  // Each subscriber, with the bytes it was last sent: a lane whose answer a
  // frame left as it was is not sent it again.
  readonly followers: Map<Subscriber, string | null>;
  // The instant of each frame of the last RATE_WINDOW_S that went out to each lane a
  // subscriber follows, oldest first: kept from the lane's first subscriber
  // joining to its last leaving, and not counting the frame a subscriber is
  // handed as it joins, which is the bar as it stood, not one more frame.
  readonly rates: Map<Lane, Instant[]>;
  phase: Phase;
  // The moment the last frame was drawn for, on the monotonic clock: what a
  // wake's next frame is spaced from.
  lastStart: number;
  // The last frame pushed: its answers as serialized, so an unchanged frame is
  // never pushed twice, and its bar, so a new subscriber gets the bar at once.
  last: {
    readonly bar: Frame;
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
  // [LAW:single-enforcer] The fault its frame step last said, so a step that
  // keeps throwing it (a renderer down for its backoff) says it once, and says
  // its recovery; and how many steps faulted.
  fault: string | null;
  faulted: number;
  pushed: number;
  drawMs: number;
  // Parts its frames evaluated: between data changes, those reading the instant.
  evaluated: number;
  // Strip items its frames' divided cells added: the feed is what shows how a
  // lane's width treats its bar, since that lane's requests draw a handoff row.
  cellBreaks: number;
  // The wakes of each cause, and how many of them found the next frame
  // already as early as the feed's spacing allows.
  readonly woke: Record<WakeCause, number>;
  coalesced: number;
  summarizedAt: number;
  // The ledger's refreshes when the feed opened.
  readonly refreshesAtOpen: Readonly<Record<RefreshTrigger, number>>;
}

// Note a frame going out to a lane at `at`, keeping only the sends of the
// window ending there, so a lane holds at most one window's worth however long
// it runs — and a wall clock stepped back, which leaves earlier sends stamped
// after `at`, cannot grow it.
export function noteSent(rate: Instant[], at: Instant): void {
  const kept = rate.filter((sent) => sent > at - RATE_WINDOW_S && sent <= at);
  rate.splice(0, rate.length, ...kept, at);
}

interface Answers {
  readonly resp: string;
  readonly statusline: string;
}

// [LAW:one-source-of-truth] A lane drawing the bar elsewhere draws the bar;
// the one drawing it in the statusline draws what the statusline shows.
const answerOf = (answers: Answers, lane: Lane): string =>
  LANES[lane].handsOff ? answers.resp : answers.statusline;

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

/**
 * [LAW:no-shared-mutable-globals] Every session's latest request and every
 * subscribed session's feed: one owner, the daemon. A feed exists exactly while
 * the session has a subscriber; its frames are drawn one at a time, so two
 * subscribers to one session share every render.
 */
// [LAW:no-ambient-temporal-coupling] What woke the feed while its frame was
// out is owed a frame after it, however that frame ended.
function wokenWhileOut(feed: Feed): boolean {
  return feed.phase.kind === "drawing" && feed.phase.woken;
}

export class FrameFeeds<Req> {
  private readonly requests = new Map<SessionId, Noted<Req>>();
  private readonly feeds = new Map<SessionId, Feed>();
  // [LAW:no-ambient-temporal-coupling] The stop of what runs while any feed
  // exists: held exactly from the first feed opening to the last closing.
  private stopWatching: (() => void) | null = null;
  // The daemon's close: no feed opens after it.
  private closed = false;
  private drawn = 0;
  private pushed = 0;
  private refused = 0;
  private lookups = 0;
  private found = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon accepted `order`-th, among requests of
  // every kind. The latest request
  // a session sent is where the feeds find the session: whether its pane is
  // shown, and which sessions a wake or a lookup matches. Its frames draw by
  // the request its view is declared with. One that arrived before it — a
  // slow render finishing late — is not the session's latest.
  note(sessionId: SessionId, req: Req, order: number): void {
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
  // [LAW:no-ambient-temporal-coupling] The lanes arrive from the renderer
  // later, so a subscriber is admitting until they do: nothing opens, and
  // nothing is sent it, before its lane is known to be on. One that leaves
  // while admitting is never admitted, and the returned unsubscribe is its
  // leaving whichever state it is in.
  subscribe(sessionId: SessionId, sub: Subscriber): () => void {
    let left = false;
    void this.deps
      .lanes(sessionId)
      .then((lanes) => {
        if (!left) this.admit(sessionId, sub, lanes);
      })
      // [LAW:no-silent-failure] A lanes read or an admission that threw is the
      // subscribe's failure, as a subscribe's own throw is its connection's:
      // said, the subscriber dropped wherever it got to, and answered
      // RENDER_FAILED, never an open socket nothing feeds.
      .catch((thrown: unknown) => {
        this.deps.log(
          "error",
          `feed sid=${JSON.stringify(sessionId)} admission threw: ${inspect(thrown)}`,
        );
        // One that left already heard its own leaving.
        if (left) return;
        const feed = this.feeds.get(sessionId);
        if (feed !== undefined) this.unsubscribe(feed, sub);
        sub.refused(renderFailed(thrown));
      });
    return () => {
      left = true;
      const feed = this.feeds.get(sessionId);
      if (feed !== undefined) this.unsubscribe(feed, sub);
    };
  }

  private admit(
    sessionId: SessionId,
    sub: Subscriber,
    lanes: LaneSwitches | null,
  ): void {
    // A daemon that closed while the lanes were out opens no feed: the
    // subscriber is dropped as the close dropped those it followed.
    // [LAW:nothing-unseen] Said, so a subscribe never vanishes from the log.
    if (this.closed) {
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} dropped lane=${sub.lane} daemon-closed`,
      );
      return;
    }
    if (lanes !== null && !lanes[sub.lane]) {
      this.refuse(sessionId, sub);
      return;
    }
    const held = this.feeds.get(sessionId);
    const feed = held ?? this.open(sessionId);
    feed.followers.set(sub, null);
    if (!feed.rates.has(sub.lane)) feed.rates.set(sub.lane, []);
    // [LAW:no-ambient-temporal-coupling] A feed's clock starts when it opens:
    // its first frame falls due as a wake's would, in a later turn than the
    // admission, so admitting draws nothing in its turn. A later subscriber is
    // handed the frame as it stands, and the next is brought forward: who
    // follows the session is drawn into it (`following`).
    if (held !== undefined) this.send(feed, sub);
    this.hasten(feed);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${feed.followers.size} view=${lanes === null ? "N" : "Y"}`,
    );
  }

  // Every session an open feed draws: what a renderer's complete start pins.
  openFeeds(): readonly SessionId[] {
    return [...this.feeds.keys()];
  }

  // [LAW:one-source-of-truth] Whether an open feed draws the session: the
  // fact its pin counts, from the feed's open to its close.
  feedOpen(sessionId: SessionId): boolean {
    return this.feeds.has(sessionId);
  }

  // The lanes whose subscribers follow the session's frames and draw them now.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    return new Set(
      [...(this.feeds.get(sessionId)?.followers.keys() ?? [])]
        .filter((s) => s.drawing())
        .map((s) => s.lane),
    );
  }

  // Something the session's bar shows changed, for `cause`: its next frame,
  // if anyone is watching it, is drawn as soon as the feed's spacing allows.
  wake(sessionId: SessionId, cause: WakeCause): void {
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
  newestWhere(match: (req: Req) => boolean): SessionId | null {
    let newest: { sessionId: SessionId; order: number } | null = null;
    for (const [sessionId, { req, order }] of this.requests)
      if (match(req) && (newest === null || order > newest.order))
        newest = { sessionId, order };
    this.lookups++;
    if (newest !== null) this.found++;
    return newest?.sessionId ?? null;
  }

  // The latest request the daemon holds of `sessionId`, or null when it
  // holds none.
  latest(sessionId: SessionId): Req | null {
    return this.requests.get(sessionId)?.req ?? null;
  }

  // The latest request of every session someone is watching, by session.
  watched(): Array<{ readonly sessionId: SessionId; readonly req: Req }> {
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
  feedsOf(sessionId: SessionId, at: Instant): LaneFeeds {
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

  private open(sessionId: SessionId): Feed {
    const now = this.deps.clock.monotonic();
    const feed: Feed = {
      sessionId,
      followers: new Map(),
      rates: new Map(),
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
      fault: null,
      faulted: 0,
      pushed: 0,
      drawMs: 0,
      evaluated: 0,
      cellBreaks: 0,
      woke: { data: 0, state: 0, reload: 0, visibility: 0 },
      coalesced: 0,
      summarizedAt: now,
      refreshesAtOpen: this.deps.refreshes(),
    };
    this.feeds.set(sessionId, feed);
    this.deps.pin(sessionId);
    this.stopWatching ??= this.deps.watching();
    return feed;
  }

  // The daemon's close: every feed ends as its last subscriber's leaving ends
  // it, and the pane follow with the last of them.
  close(): void {
    this.closed = true;
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
    if (feed.phase.kind === "due") feed.phase.clear();
    this.deps.unpin(feed.sessionId);
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
  private async draw(feed: Feed, due: Instant): Promise<void> {
    feed.phase = { kind: "drawing", woken: false };
    const started = this.deps.clock.monotonic();
    const wall = this.deps.instant();
    const at = Math.min(
      Math.max(due, wall),
      wall + TIMER_RESOLUTION_S,
    ) as Instant;
    const moment = started + (at - wall) * 1000;
    try {
      await this.step(feed, started, moment, at);
      // A step is whole only once nothing of it threw, its push included; a
      // feed closed while it drew recovers nothing.
      if (feed.fault !== null && this.feeds.get(feed.sessionId) === feed) {
        this.deps.log(
          "info",
          `feed sid=${JSON.stringify(feed.sessionId)} recovered after ${feed.fault}`,
        );
        feed.fault = null;
      }
    } catch (error) {
      // A frame that faulted spaces the next as a drawn one does, so a feed
      // woken while its adapter throws still draws at its spacing.
      const woken = wokenWhileOut(feed);
      feed.lastStart = moment;
      feed.faulted++;
      const said = failureOf(error).message;
      if (feed.fault !== said)
        this.deps.log(
          "error",
          `feed sid=${JSON.stringify(feed.sessionId)} threw: ${inspect(error)}`,
        );
      feed.fault = said;
      if (this.feeds.get(feed.sessionId) !== feed) return;
      this.schedule(feed, null, at);
      if (woken) this.hasten(feed);
    }
  }

  private async step(
    feed: Feed,
    started: number,
    moment: number,
    at: Instant,
  ): Promise<void> {
    // The renderer answers a failed render with its error frame; a rejection
    // is a fault in the adapter, `draw`'s to report.
    const frame = await this.deps.frame(
      feed.sessionId,
      paceOf(this.spacingOf(feed)),
      at,
      [...this.following(feed.sessionId)],
      this.feedsOf(feed.sessionId, at),
    );
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits,
    // with no timer, until the event that opens one wakes it.
    // A draw that found no view drew nothing, so it spaces nothing: the
    // frame the view's opening wakes is drawn at once.
    if (frame === null) {
      const woken = wokenWhileOut(feed);
      feed.noView++;
      feed.phase = { kind: "waiting" };
      if (woken && this.feeds.get(feed.sessionId) === feed) this.hasten(feed);
      return;
    }
    feed.lastStart = moment;
    const finished = this.deps.clock.monotonic();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    feed.evaluated += frame.evaluated;
    feed.cellBreaks += frame.cellBreaks;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    this.countFailure(feed, frame);
    this.push(feed, frame, at);
    if (this.feeds.get(feed.sessionId) !== feed) return;
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    // Read as the phase is replaced, so a wake the push raised (a lane it
    // ended, which redraws who follows) is owed as one while out is.
    const woken = wokenWhileOut(feed);
    this.schedule(feed, frame, at);
    if (woken) this.hasten(feed);
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
    const until = ((frame?.bar.nextChange ?? Infinity) - at) * 1000;
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
  // [LAW:no-ambient-temporal-coupling] A frame is drawn in the renderer's
  // turn and arrives later, so a wake while it is out may be of something it
  // did not read: the wake is held in the phase and brings the next frame
  // forward once this one lands. A draw writes nothing its view reacts to, so
  // none of these wakes is the draw's own.
  private hasten(feed: Feed): boolean {
    const { phase } = feed;
    if (phase.kind === "drawing") {
      if (phase.woken) return false;
      feed.phase = { kind: "drawing", woken: true };
      return true;
    }
    const now = this.deps.clock.monotonic();
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
    const delay = Math.max(0, (due - wall) * 1000);
    this.setTimer(feed, due, this.deps.clock.monotonic() + delay, delay);
  }

  private setTimer(
    feed: Feed,
    due: Instant,
    dueMoment: number,
    delay: number,
  ): void {
    // [LAW:single-enforcer] The one place a feed's timer is replaced, so the
    // one that was pending is cleared here whoever sets the next.
    if (feed.phase.kind === "due") feed.phase.clear();
    feed.phase = {
      kind: "due",
      at: dueMoment,
      clear: this.deps.clock.after(delay, () =>
        this.fire(feed, due, dueMoment),
      ),
    };
  }

  // [LAW:no-ambient-temporal-coupling] A timer that fires before its moment on
  // the monotonic clock waits out the rest instead of drawing. Node starts a
  // timer from the loop's cached time, so one armed late in a slow callback —
  // a draw on a busy machine — fires early by as long as that callback had
  // run, with no bound but the machine's load. Drawn then, its frame is clamped
  // to within TIMER_RESOLUTION_S of the wall, which falls in the turn before
  // `due`: that turn drawn twice and the one after it late. The wall clock is
  // not asked, so a wall stepped back, which leaves the monotonic moment
  // reached, still draws and is followed by `draw`.
  private fire(feed: Feed, due: Instant, dueMoment: number): void {
    const remaining = dueMoment - this.deps.clock.monotonic();
    if (remaining > 0) this.setTimer(feed, due, dueMoment, remaining);
    else void this.draw(feed, due);
  }

  private shown(feed: Feed): boolean {
    const noted = this.requests.get(feed.sessionId);
    return noted === undefined || this.deps.shown(noted.req);
  }

  private countFailure(feed: Feed, frame: FeedFrame): void {
    if (frame.failure !== null) feed.failed++;
  }

  private push(feed: Feed, frame: FeedFrame, at: Instant): void {
    // The lanes the session's settings switched on as this frame drew.
    const { lanes } = frame;
    if (lanes !== null) {
      for (const sub of [...feed.followers.keys()]) {
        if (lanes[sub.lane]) continue;
        this.unsubscribe(feed, sub);
        this.refuse(feed.sessionId, sub);
      }
    }
    if (feed.followers.size === 0) return;
    const answers = {
      resp: JSON.stringify(frame.resp),
      statusline: JSON.stringify(frame.statusline),
    };
    if (
      feed.last?.answers.resp === answers.resp &&
      feed.last.answers.statusline === answers.statusline
    )
      return;
    const before = feed.last?.answers ?? null;
    feed.last = { bar: frame.bar, answers };
    this.pushed++;
    feed.pushed++;
    // [LAW:nothing-unseen] A failing frame's render event is logged when that
    // failure is first pushed: one that keeps throwing the same way draws the
    // same bytes, which are not pushed again, and the summary counts it.
    if (frame.failure !== null)
      this.deps.log(frame.failure.level, frame.failure.line);
    for (const [lane, rate] of feed.rates)
      if (before === null || answerOf(before, lane) !== answerOf(answers, lane))
        noteSent(rate, at);
    for (const sub of feed.followers.keys()) this.send(feed, sub);
  }

  // The last frame's answer for `sub`'s lane, unless it was sent that already.
  private send(feed: Feed, sub: Subscriber): void {
    if (feed.last === null) return;
    const json = answerOf(feed.last.answers, sub.lane);
    if (feed.followers.get(sub) === json) return;
    sub.frame(feed.last.bar, json);
    feed.followers.set(sub, json);
  }

  // A subscription its lane's toggle refuses, told why.
  private refuse(sessionId: SessionId, sub: Subscriber): void {
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
    const now = this.deps.clock.monotonic();
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
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.followers.size} lanes=${[...feed.followers.keys()].map((s) => s.lane).join(",") || "-"} for=${Math.round(seconds)}s drawn=${feed.drawn} noted=${feed.noted} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} faulted=${feed.faulted} pushed=${feed.pushed} ceiling=${paceOf(this.spacingOf(feed))}fps achieved=${achieved} evaluated=${feed.evaluated} cellBreaks=${feed.cellBreaks} woke=${WAKE_CAUSES.map((cause) => `${cause}:${feed.woke[cause]}`).join(",")} coalesced=${feed.coalesced} daemonRefreshed=${refreshed} meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
