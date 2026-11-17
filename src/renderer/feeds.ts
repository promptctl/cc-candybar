// Each watched session's feed of frames (epic candybar-animation-wbxz): when
// its next frame is drawn. Claude Code reruns the statusline once a second at
// best; a lane subscribed to a session's frames receives each one as the
// renderer draws it, at the rate the bar moves.
//
// [LAW:decomposition] The renderer owns when a frame is drawn; the host owns
// who watches and what each was sent. The host hands in its viewers whole
// (`view`); a feed exists exactly while its session has one, and every frame
// it draws goes out: whether a subscriber is sent it is the host's question.
// [LAW:no-ambient-temporal-coupling] No timer: each feed holds the instant its
// next frame falls due, the renderer's wake declares the earliest, and the
// host's `due` draws every feed due by its instant.

import {
  answerOf,
  LANE_NAMES,
  MOVING_FPS,
  perLane,
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
} from "../config/lanes.js";
import type { Frame } from "../render/frame.js";
import type { Instant } from "../utils/instant.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { Level } from "../renderer-interface/adapter.js";
import type {
  Answers,
  SessionViewers,
  Viewers,
} from "../renderer-interface/interface.js";

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

// How often a long-lived feed writes its summary, in seconds of its frames'
// instants.
const SUMMARY_EVERY_S = 60;

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), or whether its pane is on a screen changed (`visibility`).
export const WAKE_CAUSES = ["data", "state", "reload", "visibility"] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

// What one frame of a feed drew: the bar, whose `nextChange` is when the feed
// draws next within its spacing, and its answers. A frame that threw draws
// its diagnostic bar, so a lane holds no failure branch, and carries its
// render event, said when that failure is first drawn.
export interface FeedFrame {
  readonly bar: Frame;
  readonly answers: Answers;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // How many strip items dividing cells too wide for a line added.
  readonly cellBreaks: number;
  readonly failure: { readonly level: Level; readonly line: string } | null;
}

export interface FeedsDeps {
  // Draws one frame of the session for the instant `at`. `fps` is the feed's
  // ceiling, the most frames a second it draws this bar at, which the frame
  // shows; `following` and `feeds` are the feed's own, read as it asks.
  // [LAW:types-are-the-program] Null while the session has no view: a frame
  // opens none, so the feed waits for the event that opens one.
  readonly draw: (
    sessionId: SessionId,
    at: Instant,
    fps: number,
    following: ReadonlySet<Lane>,
    feeds: LaneFeeds,
  ) => FeedFrame | null;
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open from the
  // feed's open to its close, the returned release: the feed being open is
  // what keeps it, not its frames reading it.
  readonly pin: (sessionId: SessionId) => () => void;
  readonly periods: FeedPeriods;
  readonly log: (level: Level, line: string) => void;
}

interface Feed {
  readonly sessionId: SessionId;
  viewers: SessionViewers;
  readonly release: () => void;
  // When its next frame falls due, or null while it waits for a view.
  next: Instant | null;
  // The instant its last frame was drawn for: what a wake's next frame is
  // spaced from.
  last: Instant | null;
  // The last frame's answers, which a lane's rate counts changes against.
  answers: Answers | null;
  // The instants of each followed lane's frames of the last RATE_WINDOW_S
  // that changed what that lane shows, oldest first.
  readonly rates: Map<Lane, Instant[]>;
  since: Instant;
  summarizedAt: Instant;
  drawn: number;
  // Frames due that found no view to draw, and waited.
  noView: number;
  // Next frames set sooner than the still period, because the bar changes
  // sooner on a screen, and those held to it only because it was on none.
  moving: number;
  unseen: number;
  failed: number;
  evaluated: number;
  cellBreaks: number;
  // The wakes of each cause, and how many found the next frame already as
  // early as the feed's spacing allows.
  readonly woke: Record<WakeCause, number>;
  coalesced: number;
}

// [LAW:one-source-of-truth] The frames a second a spacing allows: the most a
// feed draws its bar at, never a time it measured. It is drawn into the frame,
// so a measured one would move with each render and make frames whose bar did
// not change differ.
const paceOf = (period: number): number => Math.round(1000 / period);

// Note a frame going out to a lane at `at`, keeping only the frames of the
// window ending there, so a lane holds at most one window's worth.
export function noteSent(rate: Instant[], at: Instant): void {
  const kept = rate.filter((sent) => sent > at - RATE_WINDOW_S);
  rate.splice(0, rate.length, ...kept, at);
}

const sameViewers = (a: SessionViewers, b: SessionViewers): boolean =>
  a.shown === b.shown &&
  a.joined === b.joined &&
  LANE_NAMES.every(
    (lane) =>
      a.lanes[lane].subscribers === b.lanes[lane].subscribers &&
      a.lanes[lane].drawing === b.lanes[lane].drawing,
  );

export class Feeds {
  private readonly feeds = new Map<SessionId, Feed>();

  constructor(private readonly deps: FeedsDeps) {}

  // [LAW:one-source-of-truth] The host's viewers, whole: a feed opens for a
  // session newly watched, its first frame due at once, in the turn after
  // this one; one no longer watched closes; one whose viewers moved draws
  // its next frame as soon as its spacing allows, since who follows it is
  // drawn into it. Viewers equal to a feed's own move nothing.
  view(viewers: Viewers, at: Instant): void {
    for (const feed of [...this.feeds.values()])
      if (!Object.hasOwn(viewers, feed.sessionId)) this.end(feed, at);
    for (const [sessionId, next] of Object.entries(viewers) as Array<
      [SessionId, SessionViewers]
    >) {
      const feed = this.feeds.get(sessionId);
      if (feed === undefined) {
        this.open(sessionId, next, at);
        continue;
      }
      if (sameViewers(feed.viewers, next)) continue;
      const shownMoved = feed.viewers.shown !== next.shown;
      feed.viewers = next;
      this.syncRates(feed);
      if (shownMoved) feed.woke.visibility++;
      this.hasten(feed, at);
    }
  }

  // Something the session's bar shows changed, for `cause`: its next frame,
  // if a feed draws it, is drawn as soon as the feed's spacing allows.
  owe(sessionId: SessionId, cause: WakeCause, at: Instant): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    feed.woke[cause]++;
    if (!this.hasten(feed, at)) feed.coalesced++;
  }

  // [LAW:one-source-of-truth] The lanes whose subscribers follow the session
  // and draw it now, as the host's viewers say.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    const viewers = this.feeds.get(sessionId)?.viewers;
    return new Set(
      viewers === undefined
        ? []
        : LANE_NAMES.filter((lane) => viewers.lanes[lane].drawing),
    );
  }

  // [LAW:nothing-unseen] What each lane of the session's frames is doing at
  // `at`: its subscribers, the frames that changed what it shows in the last
  // second, and whether the session's pane is on a screen.
  // [LAW:one-source-of-truth] Counted against the instant of the draw asking,
  // so a frame's count is a function of the frames before it and its own
  // instant, and changes nothing the feed wakes on.
  feedsOf(sessionId: SessionId, at: Instant): LaneFeeds {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return UNFOLLOWED_FEEDS;
    const since = at - RATE_WINDOW_S;
    const { shown } = feed.viewers;
    return perLane((lane) => {
      const rate = feed.rates.get(lane);
      if (rate === undefined) return UNFOLLOWED;
      let fps = 0;
      for (const sent of rate) if (sent > since) fps++;
      return { subscribers: feed.viewers.lanes[lane].subscribers, fps, shown };
    });
  }

  // The earliest instant a feed's next frame falls due, or null while none
  // is due.
  next(): Instant | null {
    let next: Instant | null = null;
    for (const feed of this.feeds.values())
      if (feed.next !== null && (next === null || feed.next < next))
        next = feed.next;
    return next;
  }

  // Draws every feed due by `at`, in the order the feeds opened, and returns
  // each frame drawn.
  due(at: Instant): ReadonlyArray<{
    readonly sessionId: SessionId;
    readonly frame: FeedFrame;
  }> {
    const drawn: Array<{ sessionId: SessionId; frame: FeedFrame }> = [];
    for (const feed of this.feeds.values()) {
      if (feed.next === null || feed.next > at) continue;
      const frame = this.draw(feed, at);
      if (frame !== null) drawn.push({ sessionId: feed.sessionId, frame });
    }
    return drawn;
  }

  // [LAW:no-ambient-temporal-coupling] The wall stepped back `seconds`
  // (src/renderer/turn-time.ts): every instant a feed holds moves back with
  // it, so its next frame keeps its spacing and nothing carries from an
  // instant read before the step.
  steppedBack(seconds: number): void {
    const back = (at: Instant): Instant => (at - seconds) as Instant;
    for (const feed of this.feeds.values()) {
      feed.next = feed.next === null ? null : back(feed.next);
      feed.last = feed.last === null ? null : back(feed.last);
      for (const rate of feed.rates.values())
        rate.splice(0, rate.length, ...rate.map(back));
      feed.since = back(feed.since);
      feed.summarizedAt = back(feed.summarizedAt);
    }
  }

  // The renderer's close: every feed ends, its pin released.
  close(at: Instant): void {
    for (const feed of [...this.feeds.values()]) this.end(feed, at);
  }

  private draw(feed: Feed, at: Instant): FeedFrame | null {
    const frame = this.deps.draw(
      feed.sessionId,
      at,
      paceOf(this.spacingOf(feed)),
      this.following(feed.sessionId),
      this.feedsOf(feed.sessionId, at),
    );
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits
    // until the event that opens one wakes it. It drew nothing, so it spaces
    // nothing: the frame the view's opening wakes is drawn at once.
    if (frame === null) {
      feed.noView++;
      feed.next = null;
      return null;
    }
    feed.last = at;
    feed.drawn++;
    feed.evaluated += frame.evaluated;
    feed.cellBreaks += frame.cellBreaks;
    if (frame.failure !== null) feed.failed++;
    const before = feed.answers;
    const moved =
      before === null ||
      before.resp !== frame.answers.resp ||
      before.statusline !== frame.answers.statusline;
    // [LAW:nothing-unseen] A failing frame's render event is said when that
    // failure is first drawn: one that keeps throwing the same way draws the
    // same bytes, and the summary counts it.
    if (frame.failure !== null && moved)
      this.deps.log(frame.failure.level, frame.failure.line);
    for (const [lane, rate] of feed.rates)
      if (
        before === null ||
        answerOf(before, lane) !== answerOf(frame.answers, lane)
      )
        noteSent(rate, at);
    feed.answers = frame.answers;
    this.schedule(feed, frame.bar, at);
    if (at - feed.summarizedAt >= SUMMARY_EVERY_S)
      this.summarize(feed, "running", at);
    return frame;
  }

  // [LAW:no-ambient-temporal-coupling] The next frame is due when the bar
  // next changes, measured from the instant this one was drawn for — no
  // sooner than the moving period and no later than the still period — so a
  // 1 s beat is drawn once a second, for the moment it turns, and a
  // continuous effect at the moving rate.
  // [LAW:dataflow-not-control-flow] One clamp over values: a still bar's next
  // change is Infinity, and an unseen bar's period is the still period.
  private schedule(feed: Feed, bar: Frame, at: Instant): void {
    const { moving, still } = this.deps.periods;
    const until = (bar.nextChange - at) * 1000;
    const shownPeriod = Math.min(Math.max(until, moving), still);
    const { shown } = feed.viewers;
    if (shownPeriod < still && shown) feed.moving++;
    if (shownPeriod < still && !shown) feed.unseen++;
    const period = shown ? shownPeriod : still;
    feed.next = (at + period / 1000) as Instant;
  }

  // [LAW:single-enforcer] The one bound on how close a feed's frames are: the
  // moving period while its bar is on a screen, the still period while it is
  // not. No cause of a wake sets the rate, so an unseen feed draws at most
  // once a still period however often it is woken.
  private spacingOf(feed: Feed): number {
    return feed.viewers.shown
      ? this.deps.periods.moving
      : this.deps.periods.still;
  }

  // [LAW:single-enforcer] The one way a feed's next frame is brought forward:
  // to the earliest its spacing allows after its last frame, never later
  // than it already falls due. Answers whether it moved anything: a wake that
  // did not was coalesced into a frame already due.
  private hasten(feed: Feed, at: Instant): boolean {
    const spaced =
      feed.last === null
        ? at
        : Math.max(at, feed.last + this.spacingOf(feed) / 1000);
    if (feed.next !== null && feed.next <= spaced) return false;
    feed.next = spaced as Instant;
    return true;
  }

  private open(sessionId: SessionId, viewers: SessionViewers, at: Instant) {
    const feed: Feed = {
      sessionId,
      viewers,
      release: this.deps.pin(sessionId),
      next: at,
      last: null,
      answers: null,
      rates: new Map(),
      since: at,
      summarizedAt: at,
      drawn: 0,
      noView: 0,
      moving: 0,
      unseen: 0,
      failed: 0,
      evaluated: 0,
      cellBreaks: 0,
      woke: { data: 0, state: 0, reload: 0, visibility: 0 },
      coalesced: 0,
    };
    this.syncRates(feed);
    this.feeds.set(sessionId, feed);
  }

  private end(feed: Feed, at: Instant): void {
    this.feeds.delete(feed.sessionId);
    feed.release();
    this.summarize(feed, "closed", at);
  }

  // A lane's rate is kept from its first subscriber joining to its last
  // leaving.
  private syncRates(feed: Feed): void {
    for (const lane of LANE_NAMES) {
      const followed = feed.viewers.lanes[lane].subscribers > 0;
      if (followed && !feed.rates.has(lane)) feed.rates.set(lane, []);
      if (!followed) feed.rates.delete(lane);
    }
  }

  // [LAW:nothing-unseen] A feed's frames are not render requests, so they
  // write no render event each: a feed says what it drew in a summary, when
  // it closes and once a minute while it runs.
  private summarize(
    feed: Feed,
    state: "running" | "closed",
    at: Instant,
  ): void {
    const seconds = at - feed.since;
    const achieved =
      seconds <= 0 ? "-" : `${(feed.drawn / seconds).toFixed(1)}fps`;
    const lanes =
      LANE_NAMES.filter((lane) => feed.viewers.lanes[lane].subscribers > 0)
        .map((lane) => `${lane}:${feed.viewers.lanes[lane].subscribers}`)
        .join(",") || "-";
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} lanes=${lanes} for=${Math.round(seconds)}s drawn=${feed.drawn} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} ceiling=${paceOf(this.spacingOf(feed))}fps achieved=${achieved} evaluated=${feed.evaluated} cellBreaks=${feed.cellBreaks} woke=${WAKE_CAUSES.map((cause) => `${cause}:${feed.woke[cause]}`).join(",")} coalesced=${feed.coalesced}`,
    );
    feed.summarizedAt = at;
  }
}
