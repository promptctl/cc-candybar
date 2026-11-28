// Each watched session's frames, as the renderer schedules them: a feed is
// open while the host's
// viewers name its session, and decides, on the renderer's ticks, when its
// next frame is drawn. The host owns who watches and what each was sent: a
// frame drawn here goes out in the turn's output, and the host judges, per
// subscriber, whether it changed.
//
// [LAW:no-ambient-temporal-coupling] A feed's schedule is state: the tick its
// next frame falls due, or none while its session has no view to draw. A wake
// brings an ordinary frame forward, never closer to the last frame than the
// feed's spacing. A thrown draw has a retry tick wakes cannot move.

import {
  distributionOf,
  durationHistogram,
  encodedOf,
  recordMs,
  type Histogram,
} from "../daemon/foundations/durations.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  LANE_NAMES,
  MOVING_FPS,
  perLane,
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
} from "../config/lanes.js";
import type { Frame } from "../render/frame.js";
import type { PrepareDelivery } from "./draw-bar.js";
import type { Pointer } from "../click/gesture.js";
import {
  type FeedFrame,
  type PushedFrame,
  type SessionViewers,
  type Viewers,
} from "../renderer-interface/interface.js";
import type { LogLevel } from "../utils/logger.js";
import {
  earliestOf,
  type Instant,
  type Readings,
  type Tick,
} from "../utils/instant.js";
import { runEach } from "../utils/run-each.js";
import {
  changedDraw,
  comparisonOf,
  type FeedAdvance,
  type FeedComparisons,
  type FeedSchedule,
  type FeedHistory,
  type FeedResume,
  type FeedUpdate,
  RATE_WINDOW_S,
  activeTicks,
} from "../renderer-interface/feed-history.js";

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
  "interaction",
] as const;

export type WakeCause = (typeof WAKE_CAUSES)[number];

// [LAW:no-ambient-temporal-coupling] How far after the due's wall instant the
// change a frame was set for may lie, and the frame still be drawn for the
// change: the wall reads whole milliseconds and a change lands at an exact
// instant, so a frame drawn for the reading would show the step before its
// change and be drawn again. Scheduling never reads this instant.
const TIMER_RESOLUTION_S = 0.002;

// How often a long-lived feed writes its summary to the log.
const SUMMARY_EVERY_S = 60;

// One draw, what it cost in parts, and the render event if it failed.
export interface FeedDraw {
  readonly frame: FeedFrame<Frame>;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // How many strip items dividing cells too wide for a line added.
  readonly cellBreaks: number;
  readonly failure: { readonly level: LogLevel; readonly line: string } | null;
}

export interface FeedDeps {
  // Draws a frame of the session for each lane, with the pointer over it, at
  // the wall instant `at`, or null while it has no view: a frame opens none.
  // `fps` is the feed's ceiling, which the frame shows.
  // [LAW:one-source-of-truth] The ceiling the feed's spacing sets, never a
  // count of frames or the gap between two: a frame showing either changes
  // whenever it does, and is pushed for it, so a still bar would never be
  // still.
  readonly draw: (
    sessionId: SessionId,
    lanes: ReadonlyArray<readonly [Lane, Pointer | null]>,
    fps: number,
    readings: Readings,
    feeds: LaneFeeds,
    prepare: PrepareDelivery,
  ) => ReadonlyArray<readonly [Lane, FeedDraw]> | null;
  // A lane started or stopped following the session: its surface's drawer
  // changed.
  readonly turned: (sessionId: SessionId, lane: Lane) => void;
  // [LAW:no-ambient-temporal-coupling] Holds the session's view open from the
  // feed's open to its close, and wakes the feed whenever the session's own
  // state changes: the feed being open is what keeps them.
  readonly pin: (sessionId: SessionId) => () => void;
  readonly log: (level: LogLevel, line: string) => void;
  readonly periods: FeedPeriods;
}

interface Feed {
  readonly sessionId: SessionId;
  viewers: SessionViewers;
  schedule: FeedSchedule;
  // The tick the last frame was drawn at: what a wake is spaced from.
  last: Tick;
  // Each lane's last frame drawn, which its rate counts changes against.
  frames: FeedComparisons;
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
  private observation?: { wake?: Tick; advances?: FeedAdvance[] };
  private reportingTo?: { changes?: Map<SessionId, FeedUpdate> };
  private sequence = 0;
  private rebuilding?: ReadonlySet<SessionId>;

  // A boot opens the same views and fires their initial data reactions.
  // The host already supplied the deadline for those views. A waiting feed
  // can still be awakened by its first available view, and a viewer change
  // still wakes a scheduled feed.
  rebuildViews(
    resumes: readonly FeedResume[] | undefined,
    open: () => void,
  ): void {
    if (!resumes?.length) return open();
    const before = this.rebuilding;
    this.rebuilding = new Set(
      resumes
        .filter((r) => r.history?.schedule.kind === "frame")
        .map((r) => r.session),
    );
    try {
      open();
    } finally {
      this.rebuilding = before;
    }
  }

  // [LAW:effects-at-boundaries] The existing turn carries only the schedules
  // that moved and which presentations changed. Its frames already carry
  // every run the next draw must compare against.
  reporting(): Disposable & { updates(): readonly FeedUpdate[] } {
    const before = this.reportingTo;
    const report: { changes?: Map<SessionId, FeedUpdate> } = {};
    this.reportingTo = report;
    return {
      updates: () => (report.changes ? [...report.changes.values()] : []),
      [Symbol.dispose]: () => {
        this.reportingTo = before;
      },
    };
  }

  private report(feed: Feed, change?: Pick<FeedUpdate, "changed" | "viewers">) {
    const sequence = ++this.sequence;
    const report = this.reportingTo;
    if (!report) return sequence;
    const changes = (report.changes ??= new Map());
    changes.set(feed.sessionId, {
      ...changes.get(feed.sessionId),
      sequence,
      ...change,
      session: feed.sessionId,
      schedule: feed.schedule,
    });
    return sequence;
  }

  constructor(private readonly deps: FeedDeps) {}

  // [LAW:carrying-cost] Only a reaction which actually moves a feed's
  // deadline contributes a wake. An unrelated commit visits no feed.
  observe(
    apply: () => void,
    keepAdvances = false,
  ): { readonly wake?: Tick; readonly advances?: readonly FeedAdvance[] } {
    const advanced: { wake?: Tick; advances?: FeedAdvance[] } = keepAdvances
      ? { advances: [] }
      : {};
    this.observation = advanced;
    try {
      apply();
      return advanced.advances?.length === 0 ? {} : advanced;
    } finally {
      this.observation = undefined;
    }
  }

  // [LAW:one-source-of-truth] Who watches each session now, whole: a feed
  // opens for a session named and closes for one no longer named, and a feed
  // whose viewers moved is brought forward, since who follows it is drawn
  // into its frame. A feed's first frame falls due at once, in a later turn
  // than this one.
  // Each feed is its own error boundary: one whose pin or unpin throws keeps
  // no other feed from opening or closing.
  view(
    viewers: Viewers,
    tick: Tick,
    resumes: readonly FeedResume[] = [],
  ): void {
    const histories = new Map(
      resumes.map(({ session, history }) => [session, history]),
    );
    runEach([
      ...[...this.feeds.values()]
        .filter((feed) => !Object.hasOwn(viewers, feed.sessionId))
        .map((feed) => () => this.close(feed, tick)),
      ...(Object.entries(viewers) as Array<[SessionId, SessionViewers]>).map(
        ([sessionId, seen]) =>
          () =>
            this.see(sessionId, seen, tick, histories.get(sessionId)),
      ),
    ]);
  }

  private see(
    sessionId: SessionId,
    seen: SessionViewers,
    tick: Tick,
    history?: FeedHistory | null,
  ): void {
    let feed = this.feeds.get(sessionId);
    if (feed && history === null) {
      this.close(feed, tick);
      feed = undefined;
    }
    if (!feed) {
      feed = this.open(sessionId, seen, tick);
      if (!history) return;
    }
    if (history) {
      feed.schedule = history.schedule;
      feed.last = history.last ?? (-Infinity as Tick);
      feed.frames = history.frames;
      feed.viewers = history.viewers;
      feed.rates.clear();
      for (const [lane, ticks] of Object.entries(history.rates))
        feed.rates.set(lane as Lane, activeTicks(ticks, tick));
      this.report(feed, { viewers: true });
    }
    const before = feed.viewers;
    feed.viewers = seen;
    this.keepRates(feed);
    const cause =
      before.shown !== seen.shown
        ? "visibility"
        : JSON.stringify(before) !== JSON.stringify(seen)
          ? "viewers"
          : null;
    if (cause) {
      this.wake(sessionId, cause, tick);
      this.report(feed, { viewers: true });
    }
  }

  // Something the session's bar shows changed, for `cause`: its next frame,
  // if anyone watches it, falls due as soon as the feed's spacing allows.
  wake(sessionId: SessionId, cause: WakeCause, tick: Tick): void {
    const feed = this.feeds.get(sessionId);
    if (feed === undefined) return;
    if (
      (cause === "data" || cause === "reload") &&
      this.rebuilding?.has(sessionId)
    )
      return;
    feed.woke[cause]++;
    const { kind, next } = feed.schedule;
    // [LAW:no-ambient-temporal-coupling] A visible control that changed in
    // this click can respond on the next host turn, including while an
    // animation is at its frame ceiling. Background data and animation keep
    // their budget. Several clicks before the draw share that draw.
    const soonest =
      (cause === "interaction" || this.observation !== undefined) &&
      feed.viewers.shown
        ? tick
        : (Math.max(tick, feed.last + this.spacingOf(feed)) as Tick);
    if (kind === "retry" || (next !== null && next <= soonest)) {
      feed.coalesced++;
      return;
    }
    feed.schedule = { kind: "frame", next: soonest, change: null };
    const sequence = this.report(feed);
    this.observation?.advances?.push({
      sequence,
      session: sessionId,
      next: soonest,
    });
    if (
      this.observation &&
      (this.observation.wake === undefined || soonest < this.observation.wake)
    )
      this.observation.wake = soonest;
  }

  // The earliest tick a feed's next frame falls due, or null when none waits
  // on a tick.
  next(): Tick | null {
    return earliestOf(
      [...this.feeds.values()].map((feed) => feed.schedule.next),
    );
  }

  // [LAW:dataflow-not-control-flow] The frames due by this turn's tick, each
  // drawn into `frames` and its next set, in the order the feeds opened. Each
  // feed is its own error boundary, so one that throws keeps no other's frame
  // from going out, and it is due again a still period on: a feed that throws
  // on every frame throws once a still period, never at every turn.
  drawDue(
    readings: Readings,
    frames: PushedFrame[],
    prepare: PrepareDelivery,
  ): void {
    const { tick } = readings;
    runEach(
      [...this.feeds.values()]
        .flatMap((feed) => {
          const { next } = feed.schedule;
          return next !== null && next <= tick ? [{ feed, next }] : [];
        })
        .map(({ feed, next }) => () => {
          recordMs(feed.lateness, (tick - next) * 1000);
          try {
            frames.push(...this.drawOne(feed, readings, prepare));
            if (tick - feed.summarizedAt >= SUMMARY_EVERY_S)
              this.summarize(feed, "running", tick);
          } catch (thrown) {
            feed.schedule = {
              kind: "retry",
              next: (tick + this.deps.periods.still / 1000) as Tick,
            };
            this.report(feed);
            throw thrown;
          }
        }),
    );
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
      schedule: { kind: "frame", next: tick, change: null },
      last: -Infinity as Tick,
      frames: {},
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
      woke: {
        data: 0,
        state: 0,
        reload: 0,
        visibility: 0,
        viewers: 0,
        interaction: 0,
      },
      coalesced: 0,
      lateness: durationHistogram(),
      unpin: this.deps.pin(sessionId),
    };
    this.feeds.set(sessionId, feed);
    this.keepRates(feed);
    this.report(feed, { viewers: true });
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} opened lanes=${lanesOf(viewers)}`,
    );
    return feed;
  }

  private close(feed: Feed, tick: Tick): void {
    this.feeds.delete(feed.sessionId);
    runEach([
      ...[...feed.rates.keys()].map(
        (lane) => () => this.deps.turned(feed.sessionId, lane),
      ),
      () => feed.unpin(),
    ]);
    this.summarize(feed, "closed", tick);
  }

  // [LAW:one-source-of-truth] A lane's rate and last frame are kept from its
  // first subscriber joining to its last leaving, both by the one list of
  // lanes that follow the session, and its surface's drawer turns at each.
  private keepRates(feed: Feed): void {
    const { lanes } = feed.viewers;
    const followed = (lane: Lane): boolean => lanes[lane] !== undefined;
    const turned = LANE_NAMES.filter(
      (lane) => feed.rates.has(lane) !== followed(lane),
    );
    for (const lane of turned)
      if (followed(lane)) feed.rates.set(lane, []);
      else feed.rates.delete(lane);
    feed.frames = Object.fromEntries(
      Object.entries(feed.frames).filter(([lane]) => followed(lane as Lane)),
    );
    runEach(turned.map((lane) => () => this.deps.turned(feed.sessionId, lane)));
  }

  // [LAW:single-enforcer] The interval between scheduled frames, in
  // seconds: the moving period while its bar is on a screen, the still period
  // while it is not. Interaction can wake a visible feed immediately. An unseen feed draws
  // at most once a still period however often it is woken.
  private spacingOf(feed: Feed): number {
    const { moving, still } = this.deps.periods;
    return (feed.viewers.shown ? moving : still) / 1000;
  }

  // [LAW:one-source-of-truth] One frame for each lane following the session,
  // each from that surface's own pointer and accepted presentation, all at
  // one instant: one surface's frame never stands for another's.
  private drawOne(
    feed: Feed,
    readings: Readings,
    prepare: PrepareDelivery,
  ): PushedFrame[] {
    const { at, tick } = readings;
    // A frame due for a change is drawn for that change's instant when the
    // due's wall reading falls just short of it.
    const change = feed.schedule.kind === "frame" ? feed.schedule.change : null;
    const drawAt =
      change !== null && change >= at && change - at <= TIMER_RESOLUTION_S
        ? change
        : at;
    const fps = paceOf(this.spacingOf(feed) * 1000);
    const drawn = this.deps.draw(
      feed.sessionId,
      LANE_NAMES.flatMap((lane) => {
        const seen = feed.viewers.lanes[lane];
        return seen === undefined ? [] : [[lane, seen.pointer] as const];
      }),
      fps,
      { at: drawAt, tick },
      this.feedsOf(feed.sessionId, tick),
      prepare,
    );
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits
    // until the event that opens one wakes it. A frame not drawn spaces
    // nothing.
    if (drawn === null) {
      feed.noView++;
      feed.schedule = { kind: "waiting", next: null };
      this.report(feed);
      return [];
    }
    feed.last = tick;
    feed.drawn++;
    this.drawnTotal++;
    const frames = { ...feed.frames };
    const changes: Lane[] = [];
    let nextChange = Infinity;
    for (const [lane, draw] of drawn) {
      feed.evaluated += draw.evaluated;
      feed.cellBreaks += draw.cellBreaks;
      const comparison = comparisonOf(draw.frame);
      const changed = changedDraw(feed.frames[lane], comparison);
      frames[lane] = comparison;
      // [LAW:nothing-unseen] A failing frame's render event, which names its
      // lane, is logged when that lane's failure first shows: one that keeps
      // throwing the same way draws the same bytes, and the summary counts it.
      if (draw.failure !== null && changed)
        this.deps.log(draw.failure.level, draw.failure.line);
      if (draw.frame.kind === "drawn")
        nextChange = Math.min(nextChange, draw.frame.bar.nextChange);
      const rate = feed.rates.get(lane);
      if (rate === undefined || !changed) continue;
      noteSent(rate, tick);
      changes.push(lane);
    }
    if (drawn.some(([, draw]) => draw.failure !== null)) feed.failed++;
    feed.frames = frames;
    this.schedule(feed, nextChange, drawAt, tick);
    this.report(feed, { changed: changes });
    return drawn.map(([lane, { frame }]) => ({
      session: feed.sessionId,
      lane,
      frame,
    }));
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
  private schedule(
    feed: Feed,
    nextChange: number,
    drawAt: Instant,
    tick: Tick,
  ) {
    const { moving, still } = this.deps.periods;
    const until = (nextChange - drawAt) * 1000;
    const shownPeriod = Math.min(Math.max(until, moving), still);
    const { shown } = feed.viewers;
    if (shownPeriod < still && shown) feed.moving++;
    if (shownPeriod < still && !shown) feed.unseen++;
    const period = shown ? shownPeriod : still;
    feed.schedule = {
      kind: "frame",
      next: (tick + period / 1000) as Tick,
      change: Number.isFinite(nextChange) ? (nextChange as Instant) : null,
    };
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
  const kept = activeTicks(rate, tick);
  rate.splice(0, rate.length, ...kept, tick);
}

const lanesOf = (viewers: SessionViewers): string =>
  Object.entries(viewers.lanes)
    .map(([lane, seen]) => `${lane}:${seen.subscribers}`)
    .join(",") || "-";
