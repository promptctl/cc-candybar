// [LAW:no-shared-mutable-globals] The renderer's one owner of each followed
// session's frame clock (epic candybar-animation-wbxz): when its next pushed
// frame falls due, over who follows it, as the host's surfaces hand that in
// (`viewers`), and the frames it drew.
//
// [LAW:no-ambient-temporal-coupling] Time is handed in. A feed's next frame
// is DERIVED from its state — the instant its last frame was drawn for and
// that frame's next change, whether something it draws moved since, and
// whether its pane is on a screen — and the renderer declares the earliest of
// them as its wake. The `due` turn at that instant draws every feed due by
// then. Nothing here reads a clock or sets a timer, so nothing is remembered
// of what was asked: a wake the host has not yet answered is re-derived by
// every turn.
//
// A feed draws its next frame when the drawn frame next changes, no closer
// than the moving period while its pane is shown and no further apart than
// the still period, and at the still period while its pane is not. Whatever
// owes a frame (a value it draws moved, its session's state, a reload, its
// viewers) only brings the next frame forward, to a spacing after the last.
// A frame is never drawn in the turn that owed it: owing is a write, and the
// draw comes at the `due` the turn's wake asks for.

import {
  LANE_NAMES,
  MOVING_FPS,
  perLane,
  UNFOLLOWED,
  type Lane,
  type LaneFeeds,
  type Viewers,
} from "../config/lanes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { failureOf } from "../daemon/foundations/verb-error.js";
import {
  answerOf,
  type Answers,
  type FeedFrame,
  type Level,
} from "../renderer-interface/adapter.js";
import type { PushedFrame } from "../renderer-interface/interface.js";
import type { Instant } from "../utils/instant.js";

// Seconds from the instant one frame is drawn for to the next: the closest a
// feed draws a bar on a screen, and the furthest apart it draws any bar —
// what a bar that says nothing of its next change, or sits on no screen, is
// drawn at, since its data and the clock (an age, a time of day) still move
// it. 30 fps is the rate rich-js's effects were signed off at
// (EFFECT_CURVES), and one a second the rate Claude Code itself reaches.
export const FEED_PERIODS = { moving: 1 / MOVING_FPS, still: 1 } as const;

// The frames a second a spacing allows: the most a feed draws its bar at,
// never a rate it measured. [LAW:one-source-of-truth] It is drawn into the
// frame, so a measured one would move with each draw and make frames whose
// bar did not change differ, defeating the dedupe.
const STILL_FPS = 1;

// The window a lane's frame rate is counted over, in seconds of the frames'
// own instants.
const RATE_WINDOW_S = 1;

// How often a long-lived feed writes its summary, in seconds of its turns.
const SUMMARY_EVERY_S = 60;

// What owed a feed a frame: a value its bar reads changed, its session's own
// state moved, its config reloaded, or who follows it changed.
export const OWE_CAUSES = ["data", "state", "reload", "viewers"] as const;
export type OweCause = (typeof OWE_CAUSES)[number];

// Note a frame going out to a lane at `at`, keeping only the sends of the
// window ending there, so a lane holds at most one window's worth however long
// it runs, and a wall clock stepped back, which leaves earlier sends stamped
// after `at`, cannot grow it.
export function noteSent(rate: Instant[], at: Instant): void {
  const kept = rate.filter((sent) => sent > at - RATE_WINDOW_S && sent <= at);
  rate.splice(0, rate.length, ...kept, at);
}

interface Feed {
  viewers: Viewers;
  // The pin's release: the view held open, and its session's state heard.
  readonly release: () => void;
  // Whether something the bar draws moved since the last frame was drawn.
  owed: boolean;
  // The last frame drawn: the instant it was drawn for and when its bar next
  // changes (Infinity for a still bar, or a frame that faulted).
  last: { readonly at: Instant; readonly nextChange: number } | null;
  // [LAW:types-are-the-program] Whether the last attempt found no view to
  // draw: the feed waits, with no frame due, until the view's opening owes one.
  waiting: boolean;
  // The last frame sent: its answers and lanes as serialized, so an
  // unchanged frame is never sent twice.
  sent: { readonly answers: Answers; readonly lanes: string } | null;
  // The instant of each frame of the last RATE_WINDOW_S that went out to
  // each lane, oldest first.
  readonly rates: Map<Lane, Instant[]>;
  // [LAW:single-enforcer] The fault its frame last threw, so a feed that
  // keeps throwing it says it once, and says its recovery.
  fault: string | null;
  // [LAW:nothing-unseen] Its summary's counts.
  readonly since: Instant;
  summarizedAt: Instant;
  drawn: number;
  noView: number;
  moving: number;
  unseen: number;
  failed: number;
  faulted: number;
  pushed: number;
  evaluated: number;
  cellBreaks: number;
  readonly owedBy: Record<OweCause, number>;
  coalesced: number;
}

export interface FeedDeps {
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open, and
  // owes the feed a frame whenever the session's own state moves, from the
  // feed's open to its close: the returned release ends both.
  readonly pin: (sessionId: SessionId) => () => void;
  // Draws one frame of the session for `at`, or null while it has no view
  // (a frame opens none). `fps` is the feed's ceiling, which the frame shows.
  readonly draw: (
    sessionId: SessionId,
    fps: number,
    at: Instant,
    following: ReadonlySet<Lane>,
    feeds: LaneFeeds,
  ) => FeedFrame | null;
  readonly log: (level: Level, line: string) => void;
}

export class Feeds {
  private readonly feeds = new Map<SessionId, Feed>();
  private drawnTotal = 0;

  constructor(private readonly deps: FeedDeps) {}

  // [LAW:one-source-of-truth] Who follows every session's frames, whole: a
  // session newly named opens its feed, one no longer named closes it, and
  // one whose viewers moved is owed a frame, since who follows it is drawn
  // into its frame.
  viewersAre(viewers: Readonly<Record<SessionId, Viewers>>, at: Instant): void {
    for (const [sessionId, feed] of [...this.feeds])
      if (viewers[sessionId] === undefined) this.end(sessionId, feed, at);
    for (const [sessionId, each] of Object.entries(viewers) as Array<
      [SessionId, Viewers]
    >) {
      const feed = this.feeds.get(sessionId);
      if (feed === undefined) {
        this.open(sessionId, each, at);
        continue;
      }
      if (JSON.stringify(feed.viewers) === JSON.stringify(each)) continue;
      feed.viewers = each;
      this.owe(sessionId, "viewers");
    }
  }

  // Something the session's bar draws moved, for `cause`: its next frame,
  // if anyone follows it, falls due as soon as its spacing allows.
  owe(sessionId: SessionId, cause: OweCause): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    feed.owedBy[cause]++;
    if (feed.owed) feed.coalesced++;
    feed.owed = true;
  }

  // The lanes that follow the session and draw it now.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    const feed = this.feeds.get(sessionId);
    return new Set(
      feed === undefined
        ? []
        : LANE_NAMES.filter((lane) => feed.viewers.lanes[lane].drawing),
    );
  }

  // [LAW:nothing-unseen] What each lane of the session's frames is doing at
  // `at`: its subscribers, the frames that went out to it in the window
  // ending there, and whether the pane is on a screen. Counted against the
  // instant of the draw asking, so a frame's count is a function of the
  // frames before it and its own instant, and changes nothing that owes one.
  feedsOf(sessionId: SessionId, at: Instant): LaneFeeds {
    const feed = this.feeds.get(sessionId);
    return perLane((lane) => {
      const subscribers = feed?.viewers.lanes[lane].subscribers ?? 0;
      if (feed === undefined || subscribers === 0) return UNFOLLOWED;
      let fps = 0;
      for (const sent of feed.rates.get(lane) ?? [])
        if (sent > at - RATE_WINDOW_S && sent <= at) fps++;
      return { subscribers, fps, shown: feed.viewers.shown };
    });
  }

  // [LAW:dataflow-not-control-flow] The earliest instant a feed's next frame
  // falls due, as of the turn at `at`, or null for none.
  next(at: Instant): Instant | null {
    let soonest: Instant | null = null;
    for (const feed of this.feeds.values()) {
      const due = nextOf(feed, at);
      if (due !== null && (soonest === null || due < soonest)) soonest = due;
    }
    return soonest;
  }

  // The `due` turn at `at`: every feed due by then is drawn, and each frame
  // that differs from the last sent goes out in `frames`.
  // [LAW:single-enforcer] The one fault path of a feed's frame: a throw is
  // the feed's own, said once with its recovery, and its next frame is
  // spaced as a still frame's, so one session's fault slows no other.
  due(at: Instant, frames: PushedFrame[]): void {
    for (const [sessionId, feed] of this.feeds) {
      const due = nextOf(feed, at);
      if (due === null || due > at) continue;
      // [LAW:no-ambient-temporal-coupling] Whatever the attempt finds, it
      // answers what owed it: a session with no view waits for the view's
      // opening, which owes the next.
      feed.owed = false;
      try {
        this.draw(sessionId, feed, at, frames);
        if (feed.fault !== null) {
          this.deps.log(
            "info",
            `feed sid=${JSON.stringify(sessionId)} recovered after ${feed.fault}`,
          );
          feed.fault = null;
        }
      } catch (error) {
        feed.faulted++;
        feed.last = { at, nextChange: Infinity };
        const said = failureOf(error);
        if (feed.fault !== said.message)
          this.deps.log(
            "error",
            `feed sid=${JSON.stringify(sessionId)} threw: ${said.detail}`,
          );
        feed.fault = said.message;
      }
      if (at - feed.summarizedAt >= SUMMARY_EVERY_S)
        this.summarize(sessionId, feed, "running", at);
    }
  }

  // Frames drawn for every feed, pushed or not.
  get drawn(): number {
    return this.drawnTotal;
  }

  // The renderer's close: every feed ends, and its pin with it.
  close(at: Instant): void {
    for (const [sessionId, feed] of [...this.feeds])
      this.end(sessionId, feed, at);
  }

  private draw(
    sessionId: SessionId,
    feed: Feed,
    at: Instant,
    frames: PushedFrame[],
  ): void {
    const { shown } = feed.viewers;
    const frame = this.deps.draw(
      sessionId,
      shown ? MOVING_FPS : STILL_FPS,
      at,
      this.following(sessionId),
      this.feedsOf(sessionId, at),
    );
    if (frame === null) {
      feed.noView++;
      feed.waiting = true;
      return;
    }
    feed.waiting = false;
    feed.last = { at, nextChange: frame.bar.nextChange };
    this.drawnTotal++;
    feed.drawn++;
    feed.evaluated += frame.evaluated;
    feed.cellBreaks += frame.cellBreaks;
    if (frame.failure !== null) feed.failed++;
    const until = frame.bar.nextChange - at;
    if (until < FEED_PERIODS.still && shown) feed.moving++;
    if (until < FEED_PERIODS.still && !shown) feed.unseen++;
    const answers = {
      resp: JSON.stringify(frame.resp),
      statusline: JSON.stringify(frame.statusline),
    };
    const lanes = JSON.stringify(frame.lanes);
    const before = feed.sent;
    if (
      before?.answers.resp === answers.resp &&
      before.answers.statusline === answers.statusline &&
      before.lanes === lanes
    )
      return;
    feed.sent = { answers, lanes };
    feed.pushed++;
    for (const lane of LANE_NAMES) {
      if (feed.viewers.lanes[lane].subscribers === 0) continue;
      if (
        before !== null &&
        answerOf(before.answers, lane) === answerOf(answers, lane)
      )
        continue;
      const rate = feed.rates.get(lane) ?? [];
      noteSent(rate, at);
      feed.rates.set(lane, rate);
    }
    const { resp: _resp, statusline: _statusline, ...drawn } = frame;
    frames.push({ session: sessionId, frame: { ...drawn, answers } });
  }

  private open(sessionId: SessionId, viewers: Viewers, at: Instant): void {
    this.feeds.set(sessionId, {
      viewers,
      release: this.deps.pin(sessionId),
      // A feed's first frame falls due at once, in the `due` its opening
      // turn's wake asks for.
      owed: true,
      last: null,
      waiting: false,
      sent: null,
      rates: new Map(),
      fault: null,
      since: at,
      summarizedAt: at,
      drawn: 0,
      noView: 0,
      moving: 0,
      unseen: 0,
      failed: 0,
      faulted: 0,
      pushed: 0,
      evaluated: 0,
      cellBreaks: 0,
      owedBy: { data: 0, state: 0, reload: 0, viewers: 0 },
      coalesced: 0,
    });
  }

  private end(sessionId: SessionId, feed: Feed, at: Instant): void {
    this.feeds.delete(sessionId);
    feed.release();
    this.summarize(sessionId, feed, "closed", at);
  }

  // [LAW:nothing-unseen] A feed's frames are not render requests, so they
  // write no render event each: a feed says what it drew in a summary, when
  // it closes and once a minute while it runs.
  private summarize(
    sessionId: SessionId,
    feed: Feed,
    state: "running" | "closed",
    at: Instant,
  ): void {
    const seconds = at - feed.since;
    const achieved =
      seconds <= 0 ? "-" : `${(feed.drawn / seconds).toFixed(1)}fps`;
    const lanes =
      LANE_NAMES.flatMap((lane) =>
        Array<Lane>(feed.viewers.lanes[lane].subscribers).fill(lane),
      ).join(",") || "-";
    const subscribers = LANE_NAMES.reduce(
      (sum, lane) => sum + feed.viewers.lanes[lane].subscribers,
      0,
    );
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} ${state} subscribers=${subscribers} lanes=${lanes} for=${Math.round(seconds)}s drawn=${feed.drawn} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} faulted=${feed.faulted} pushed=${feed.pushed} ceiling=${feed.viewers.shown ? MOVING_FPS : STILL_FPS}fps achieved=${achieved} evaluated=${feed.evaluated} cellBreaks=${feed.cellBreaks} owed=${OWE_CAUSES.map((cause) => `${cause}:${feed.owedBy[cause]}`).join(",")} coalesced=${feed.coalesced}`,
    );
    feed.summarizedAt = at;
  }
}

// [LAW:dataflow-not-control-flow] When a feed's next frame falls due, as of
// the turn at `at`: one clamp over values. A frame owed falls due a spacing
// after the last; otherwise the next falls at the bar's next change, no
// sooner than the moving period and no later than the still period while
// shown, and at the still period while not. A feed never drawn falls due at
// once when owed; one waiting for its view falls due at no instant until
// something owes it a frame.
// [LAW:no-ambient-temporal-coupling] The bar's next change is measured from
// the instant its frame was drawn for, and the wait is spaced from that
// instant or the turn's, whichever is earlier, so a wall clock stepped back
// is followed at the frame's own pace rather than drawn ahead of.
function nextOf(feed: Feed, at: Instant): Instant | null {
  const { moving, still } = FEED_PERIODS;
  const spacing = feed.viewers.shown ? moving : still;
  if (feed.last === null) return feed.owed ? at : null;
  if (feed.waiting && !feed.owed) return null;
  const lastAt = Math.min(feed.last.at, at);
  if (feed.owed) return (lastAt + spacing) as Instant;
  const until = Math.min(
    Math.max(feed.last.nextChange - feed.last.at, moving),
    still,
  );
  return (lastAt + (feed.viewers.shown ? until : still)) as Instant;
}
