// Each watched session's frames, as the renderer schedules them (epic
// candybar-animation-wbxz, ticket .jmm.usl): a feed is open while the host's
// viewers name its session, and decides, on the renderer's ticks, when its
// next frame is drawn. The host owns who watches and what each was sent: a
// frame drawn here goes out in the turn's output, and the host judges, per
// subscriber, whether it changed.
//
// [LAW:no-ambient-temporal-coupling] A feed's schedule is state: the tick its
// next frame falls due, or none while its session has no view to draw. A wake
// brings it forward, never closer to the last frame than the feed's spacing,
// and the renderer's wake (`Subscriptions.wake`) is the earliest of them.

import {
  distributionOf,
  durationHistogram,
  encodedOf,
  recordMs,
  type Histogram,
} from "../daemon/foundations/durations.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  answerOf,
  MOVING_FPS,
  perLane,
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
} from "../config/lanes.js";
import type { Frame } from "../render/frame.js";
import {
  followingOf,
  type Answers,
  type PushedFrame,
  type SessionViewers,
  type Viewers,
} from "../renderer-interface/interface.js";
import type { Level } from "../renderer-interface/adapter.js";
import type { Instant, Readings, Tick } from "../utils/instant.js";
import { runEach } from "../utils/run-each.js";

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

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), its pane came on or off a screen (`visibility`), or who watches
// it changed (`viewers`), which its frame draws.
export const WAKE_CAUSES = [
  "data",
  "state",
  "reload",
  "visibility",
  "viewers",
] as const;

export type WakeCause = (typeof WAKE_CAUSES)[number];

// The window a lane's frame rate is counted over, in seconds of ticks.
const RATE_WINDOW_S = 1;

// [LAW:no-ambient-temporal-coupling] How far after the due's wall instant the
// change a frame was set for may lie, and the frame still be drawn for the
// change: the wall reads whole milliseconds and a change lands at an exact
// instant, so a frame drawn for the reading would show the step before its
// change and be drawn again. Scheduling never reads this instant.
const TIMER_RESOLUTION_S = 0.002;

// How often a long-lived feed writes its summary to the log.
const SUMMARY_EVERY_S = 60;

// One frame as the renderer drew it for a feed: its bar, its answers, what it
// cost in parts, and, for a render that threw, the render event describing it.
export interface FeedDraw {
  // [LAW:types-are-the-program] Every frame has a bar: one that failed draws
  // its diagnostic Frame, so a lane holds no failure branch.
  readonly bar: Frame;
  readonly answers: Answers;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // How many strip items dividing cells too wide for a line added.
  readonly cellBreaks: number;
  readonly failure: { readonly level: Level; readonly line: string } | null;
}

export interface FeedDeps {
  // Draws a frame of the session for the wall instant `at`, or null while it
  // has no view: a frame opens none. `fps` is the feed's ceiling, which the
  // frame shows. [LAW:one-source-of-truth] The ceiling the feed's spacing
  // sets, never a count of frames or the gap between two: a frame showing
  // either changes whenever it does, and is pushed for it, so a still bar
  // would never be still.
  readonly draw: (
    sessionId: SessionId,
    fps: number,
    readings: Readings,
    following: ReadonlySet<Lane>,
    feeds: LaneFeeds,
  ) => FeedDraw | null;
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open from the
  // feed's open to its close, and wakes the feed whenever the session's own
  // state changes: the feed being open is what keeps them.
  readonly pin: (sessionId: SessionId) => () => void;
  readonly log: (level: Level, line: string) => void;
  readonly periods: FeedPeriods;
}

interface Feed {
  readonly sessionId: SessionId;
  viewers: SessionViewers;
  // When the next frame falls due; null while the session has no view, until
  // the event that opens one wakes it.
  next: Tick | null;
  // The wall instant of the change the next frame was set for, if any.
  change: Instant | null;
  // The tick the last frame was drawn at: what a wake is spaced from.
  last: Tick;
  // The last frame's answers, which a lane's rate counts changes against.
  answers: Answers | null;
  // The ticks at which each followed lane's answer changed, within the
  // window: a subscriber's hand-over on joining is not one.
  readonly rates: Map<Lane, Tick[]>;
  readonly opened: Tick;
  summarizedAt: Tick;
  drawn: number;
  // Frames due that found no view to draw, and waited.
  noView: number;
  // Next frames set sooner than the still period, because the bar changes
  // sooner on a screen, and those held to it only because it was on no
  // screen: counts of the decision.
  moving: number;
  unseen: number;
  failed: number;
  evaluated: number;
  cellBreaks: number;
  readonly woke: Record<WakeCause, number>;
  // Wakes that found the next frame already as early as the spacing allows.
  coalesced: number;
  // [LAW:nothing-unseen] How late each frame was drawn, from the tick it fell
  // due to the tick of the turn that drew it.
  readonly lateness: Histogram;
  readonly unpin: () => void;
}

// [LAW:one-source-of-truth] The frames a second a spacing allows: the most a
// feed draws its bar at, never a time it measured.
const paceOf = (period: number): number => Math.round(1000 / period);

// [LAW:no-shared-mutable-globals] Every watched session's feed: one owner, the
// renderer.
export class Feeds {
  private readonly feeds = new Map<SessionId, Feed>();
  private drawnTotal = 0;

  constructor(private readonly deps: FeedDeps) {}

  // [LAW:one-source-of-truth] Who watches each session now, whole: a feed
  // opens for a session named and closes for one no longer named, and a feed
  // whose viewers moved is brought forward, since who follows it is drawn
  // into its frame. A feed's first frame falls due at once, in a later turn
  // than this one.
  view(viewers: Viewers, tick: Tick): void {
    for (const feed of [...this.feeds.values()])
      if (!Object.hasOwn(viewers, feed.sessionId)) this.close(feed, tick);
    for (const [sessionId, seen] of Object.entries(viewers) as Array<
      [SessionId, SessionViewers]
    >) {
      const feed = this.feeds.get(sessionId);
      if (feed === undefined) {
        this.open(sessionId, seen, tick);
        continue;
      }
      const before = feed.viewers;
      feed.viewers = seen;
      this.keepRates(feed);
      if (before.shown !== seen.shown) this.wake(sessionId, "visibility", tick);
      else if (JSON.stringify(before) !== JSON.stringify(seen))
        this.wake(sessionId, "viewers", tick);
    }
  }

  // Something the session's bar shows changed, for `cause`: its next frame,
  // if anyone watches it, falls due as soon as the feed's spacing allows.
  wake(sessionId: SessionId, cause: WakeCause, tick: Tick): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    feed.woke[cause]++;
    const soonest = Math.max(tick, feed.last + this.spacingOf(feed)) as Tick;
    if (feed.next !== null && feed.next <= soonest) {
      feed.coalesced++;
      return;
    }
    feed.next = soonest;
    feed.change = null;
  }

  // The earliest tick a feed's next frame falls due, or null when none waits
  // on a tick.
  next(): Tick | null {
    let next: Tick | null = null;
    for (const feed of this.feeds.values())
      if (feed.next !== null && (next === null || feed.next < next))
        next = feed.next;
    return next;
  }

  // [LAW:dataflow-not-control-flow] The frames due by this turn's tick, each
  // drawn into `frames` and its next set, in the order the feeds opened. Each
  // feed is its own error boundary, so one that throws keeps no other's frame
  // from going out.
  drawDue(readings: Readings, frames: PushedFrame[]): void {
    const { tick } = readings;
    runEach(
      [...this.feeds.values()]
        .flatMap((feed) =>
          feed.next !== null && feed.next <= tick
            ? [{ feed, next: feed.next }]
            : [],
        )
        .map(({ feed, next }) => () => {
          recordMs(feed.lateness, (tick - next) * 1000);
          const frame = this.drawOne(feed, readings);
          if (frame !== null) frames.push(frame);
          if (tick - feed.summarizedAt >= SUMMARY_EVERY_S)
            this.summarize(feed, "running", tick);
        }),
    );
  }

  // The lanes that follow the session and draw it now.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    return followingOf(this.feeds.get(sessionId)?.viewers);
  }

  // [LAW:nothing-unseen] What each lane of the session's frames is doing at
  // `tick`: its subscribers, the frames that went out to it in the last
  // second, and whether the session's pane is on a screen. Like every value
  // relative to now it is the draw's, and it changes nothing a feed wakes on.
  feedsOf(sessionId: SessionId, tick: Tick): LaneFeeds {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return UNFOLLOWED_FEEDS;
    const since = tick - RATE_WINDOW_S;
    const { shown, lanes } = feed.viewers;
    return perLane((lane) => {
      const rate = feed.rates.get(lane);
      if (rate === undefined) return UNFOLLOWED;
      let fps = 0;
      for (const sent of rate) if (sent > since && sent <= tick) fps++;
      return { subscribers: lanes[lane]?.subscribers ?? 0, fps, shown };
    });
  }

  drawn(): number {
    return this.drawnTotal;
  }

  // The renderer's close: every feed ends, and says so.
  closeAll(tick: Tick): void {
    for (const feed of [...this.feeds.values()]) this.close(feed, tick);
  }

  private open(sessionId: SessionId, viewers: SessionViewers, tick: Tick) {
    const feed: Feed = {
      sessionId,
      viewers,
      next: tick,
      change: null,
      last: -Infinity as Tick,
      answers: null,
      rates: new Map(),
      opened: tick,
      summarizedAt: tick,
      drawn: 0,
      noView: 0,
      moving: 0,
      unseen: 0,
      failed: 0,
      evaluated: 0,
      cellBreaks: 0,
      woke: { data: 0, state: 0, reload: 0, visibility: 0, viewers: 0 },
      coalesced: 0,
      lateness: durationHistogram(),
      unpin: this.deps.pin(sessionId),
    };
    this.feeds.set(sessionId, feed);
    this.keepRates(feed);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} opened lanes=${lanesOf(viewers)}`,
    );
  }

  private close(feed: Feed, tick: Tick): void {
    this.feeds.delete(feed.sessionId);
    feed.unpin();
    this.summarize(feed, "closed", tick);
  }

  // A lane's rate is kept from its first subscriber joining to its last
  // leaving.
  private keepRates(feed: Feed): void {
    const { lanes } = feed.viewers;
    for (const lane of feed.rates.keys())
      if (lanes[lane] === undefined) feed.rates.delete(lane);
    for (const lane of Object.keys(lanes) as Lane[])
      if (!feed.rates.has(lane)) feed.rates.set(lane, []);
  }

  // [LAW:single-enforcer] The one bound on how close a feed's frames are, in
  // seconds: the moving period while its bar is on a screen, the still period
  // while it is not. No cause of a wake sets the rate, so an unseen feed draws
  // at most once a still period however often it is woken.
  private spacingOf(feed: Feed): number {
    const { moving, still } = this.deps.periods;
    return (feed.viewers.shown ? moving : still) / 1000;
  }

  private drawOne(feed: Feed, readings: Readings): PushedFrame | null {
    const { at, tick } = readings;
    // A frame due for a change is drawn for that change's instant when the
    // due's wall reading falls just short of it.
    const drawAt =
      feed.change !== null &&
      feed.change >= at &&
      feed.change - at <= TIMER_RESOLUTION_S
        ? feed.change
        : at;
    const drawn = this.deps.draw(
      feed.sessionId,
      paceOf(this.spacingOf(feed) * 1000),
      { at: drawAt, tick },
      this.following(feed.sessionId),
      this.feedsOf(feed.sessionId, tick),
    );
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits until
    // the event that opens one wakes it. A frame not drawn spaces nothing.
    if (drawn === null) {
      feed.noView++;
      feed.next = null;
      feed.change = null;
      return null;
    }
    feed.last = tick;
    feed.drawn++;
    this.drawnTotal++;
    feed.evaluated += drawn.evaluated;
    feed.cellBreaks += drawn.cellBreaks;
    const before = feed.answers;
    const changed = (lane: Lane | null): boolean =>
      before === null ||
      (lane === null
        ? before.resp !== drawn.answers.resp ||
          before.statusline !== drawn.answers.statusline
        : answerOf(before, lane) !== answerOf(drawn.answers, lane));
    if (drawn.failure !== null) {
      feed.failed++;
      // [LAW:nothing-unseen] A failing frame's render event is logged when its
      // failure first shows: one that keeps throwing the same way draws the
      // same bytes, and the summary counts it.
      if (changed(null)) this.deps.log(drawn.failure.level, drawn.failure.line);
    }
    for (const [lane, rate] of feed.rates)
      if (changed(lane)) noteSent(rate, tick);
    feed.answers = drawn.answers;
    this.schedule(feed, drawn.bar, drawAt, tick);
    return {
      session: feed.sessionId,
      bar: drawn.bar,
      answers: drawn.answers,
    };
  }

  // [LAW:no-ambient-temporal-coupling] The next frame falls due when the bar
  // next changes, measured from the instant this one was drawn for — no
  // sooner than the feed's spacing allows and no later than the still period
  // — so a 1 s beat is drawn once a second, for the moment it turns, and a
  // continuous effect at the moving rate. The span is a distance on the wall,
  // and the next frame's tick is this one's plus it, so a wall stepped
  // between two frames moves no schedule.
  // [LAW:dataflow-not-control-flow] One clamp over values: a still bar's next
  // change is Infinity, and an unseen bar's spacing is the still period.
  private schedule(feed: Feed, bar: Frame, drawAt: Instant, tick: Tick) {
    const { moving, still } = this.deps.periods;
    const until = (bar.nextChange - drawAt) * 1000;
    const shownPeriod = Math.min(Math.max(until, moving), still);
    const { shown } = feed.viewers;
    if (shownPeriod < still && shown) feed.moving++;
    if (shownPeriod < still && !shown) feed.unseen++;
    const period = shown ? shownPeriod : still;
    feed.next = (tick + period / 1000) as Tick;
    feed.change = Number.isFinite(bar.nextChange)
      ? (bar.nextChange as Instant)
      : null;
  }

  // [LAW:nothing-unseen] A feed's frames are not render requests, so they
  // write no render event each: a feed says what it drew in a summary, when
  // it closes and once a minute while it runs. Who it was sent to is the
  // host's line.
  private summarize(feed: Feed, state: "running" | "closed", tick: Tick) {
    const seconds = tick - feed.opened;
    const achieved =
      seconds === 0 ? "-" : `${(feed.drawn / seconds).toFixed(1)}fps`;
    const histogram =
      state === "running"
        ? ""
        : ` latenessHistogram=${encodedOf(feed.lateness)}`;
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} lanes=${lanesOf(feed.viewers)} for=${Math.round(seconds)}s drawn=${feed.drawn} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} ceiling=${paceOf(this.spacingOf(feed) * 1000)}fps achieved=${achieved} evaluated=${feed.evaluated} cellBreaks=${feed.cellBreaks} woke=${WAKE_CAUSES.map((cause) => `${cause}:${feed.woke[cause]}`).join(",")} coalesced=${feed.coalesced} lateness=${distributionOf(feed.lateness)}${histogram}`,
    );
    feed.summarizedAt = tick;
  }
}

// Note a frame going out to a lane at `tick`, keeping only the sends of the
// window ending there, so a lane holds at most one window's worth however long
// it runs.
export function noteSent(rate: Tick[], tick: Tick): void {
  const kept = rate.filter((sent) => sent > tick - RATE_WINDOW_S);
  rate.splice(0, rate.length, ...kept, tick);
}

const lanesOf = (viewers: SessionViewers): string =>
  Object.entries(viewers.lanes)
    .map(([lane, seen]) => `${lane}:${seen.subscribers}`)
    .join(",") || "-";
