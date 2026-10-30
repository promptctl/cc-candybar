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
// whether the bar it drew moves, and — for a render that threw — the render
// event describing it, logged when that failure is first pushed. It is drawn
// for the feed (`drawing.by` "feed"), so it shows the feed's pace where a
// render request's answer shows that it is polled.
// [LAW:decomposition] A frame says only what was drawn. Whether anyone can see
// it is the feed's question, asked when it schedules the next.
// A frame's two answers: the bar, which a lane drawing it elsewhere draws,
// and what Claude Code's statusline shows — the bar, or the handoff line in
// its place while a lane draws it elsewhere (src/daemon/lane-handoff.ts).
export interface FeedFrame {
  // The instant the frame was drawn at: what its push is counted under in its
  // lanes' frame rates (`feedsOf`).
  readonly at: Instant;
  readonly resp: Response;
  readonly statusline: Response;
  readonly moves: boolean;
  // How many of the view's parts the frame evaluated (src/dsl/parts.ts).
  readonly evaluated: number;
  // Drawing it moved what the session's next frame shows (its renderer's
  // warning record, src/daemon/render-warnings.ts): the feed wakes for it
  // once this frame is pushed, so an idle bar does not keep a stale count.
  readonly wakes: boolean;
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

// The window a lane's frame rate is counted over, in seconds of the frames'
// own instants.
const RATE_WINDOW_S = 1;

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
  // [LAW:effects-at-boundaries] Synchronous by type: a frame only reads what
  // its sources stored, so drawing one can await nothing and refresh nothing.
  // [LAW:types-are-the-program] Null when the session has no view to draw
  // yet: a frame opens none (src/daemon/cache/render.ts `holdView`), so the
  // feed waits for the event that opens one.
  render(sessionId: string, fps: number): FeedFrame | null;
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
  // durations with it — periods, the rate window, how long it has run.
  now(): number;
  log(level: Level, line: string): void;
}

// Why a feed's next frame was brought forward: a value its bar reads changed
// (`data`), its session's own state moved (`state`), its config reloaded
// (`reload`), which panes are on a screen changed (`visibility`), or a frame's
// own draw moved what the next one shows (`frame`).
const WAKE_CAUSES = ["data", "state", "reload", "visibility", "frame"] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

// [LAW:no-ambient-temporal-coupling] Where a feed's frame clock stands, as
// state: no view to draw yet; the next frame due `at` a timer; or a frame
// being drawn.
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
  // When the last frame's draw started: what the next one is spaced from.
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
    // feed's pace): the request's own answer is its client's alone.
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
      // Not yet set: the first frame is drawn at once, before any period is
      // chosen, and shows the still pace; a moving bar's next frame, one
      // moving period later, shows the moving pace.
      pace: paceOf(this.deps.periods.still),
      drawMs: 0,
      evaluated: 0,
      woke: { data: 0, state: 0, reload: 0, visibility: 0, frame: 0 },
      coalesced: 0,
      summarizedAt: now,
      refreshesAtOpen: this.deps.refreshes(),
    };
    this.feeds.set(sessionId, feed);
    this.stopWatching ??= this.deps.watching();
    return feed;
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
  private draw(feed: Feed): void {
    feed.phase = { kind: "drawing" };
    const started = this.deps.now();
    try {
      this.step(feed, started);
    } catch (error) {
      // A frame that faulted spaces the next as a drawn one does, so a feed
      // woken while its adapter throws still draws at its spacing.
      feed.lastStart = started;
      this.deps.log(
        "error",
        `feed sid=${JSON.stringify(feed.sessionId)} threw: ${inspect(error)}`,
      );
      if (this.feeds.get(feed.sessionId) !== feed) return;
      this.schedule(feed, null, started);
    }
  }

  private step(feed: Feed, started: number): void {
    // The render adapter answers a failed render with its error frame; a throw
    // out of it is a fault in the adapter, `draw`'s to report.
    const frame = this.deps.render(feed.sessionId, feed.pace);
    // [LAW:no-ambient-temporal-coupling] No view to draw: the feed waits,
    // with no timer, until the event that opens one wakes it.
    // A draw that found no view drew nothing, so it spaces nothing: the
    // frame the view's opening wakes is drawn at once.
    if (frame === null) {
      feed.noView++;
      feed.phase = { kind: "waiting" };
      return;
    }
    feed.lastStart = started;
    const finished = this.deps.now();
    this.drawn++;
    feed.drawn++;
    feed.drawMs += finished - started;
    feed.evaluated += frame.evaluated;
    // Unsubscribed while this frame was drawn: the feed is gone, and so is
    // its clock.
    if (this.feeds.get(feed.sessionId) !== feed) return;
    this.countFailure(feed, frame);
    this.push(feed, frame);
    if (this.feeds.get(feed.sessionId) !== feed) return;
    if (finished - feed.summarizedAt >= SUMMARY_EVERY_MS)
      this.summarize(feed, "running");
    this.schedule(feed, frame, started);
    // [LAW:no-ambient-temporal-coupling] Woken after the frame is set, never
    // folded into the draw that moved it: the next frame reads the move.
    if (frame.wakes) this.wake(feed.sessionId, "frame");
  }

  // [LAW:no-ambient-temporal-coupling] The next frame is due a period after
  // this one STARTED, so the rate holds whatever a render costs, up to a
  // render as slow as the period, when frames are drawn back to back. A frame
  // step that faulted is followed as a still frame is.
  // [LAW:dataflow-not-control-flow] The moving period is for a bar that moves
  // where someone can see it, asked here, as the next frame is set.
  private schedule(feed: Feed, frame: FeedFrame | null, started: number): void {
    const moves = frame?.moves === true;
    const seen = moves && this.shown(feed);
    if (seen) feed.moving++;
    if (moves && !seen) feed.unseen++;
    const period = seen ? this.deps.periods.moving : this.deps.periods.still;
    feed.pace = paceOf(period);
    this.arm(feed, started + period);
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
  // to the earliest its spacing allows after the last frame started, never
  // later than it already falls due. Answers whether it moved anything: a
  // wake that did not was coalesced into a frame already due.
  // [LAW:no-ambient-temporal-coupling] A frame is drawn in one synchronous
  // turn and opens nothing, so a wake while it draws is the draw's own, and
  // the frame reads what that moved: it is coalesced into that frame.
  private hasten(feed: Feed): boolean {
    const { phase } = feed;
    if (phase.kind === "drawing") return false;
    const at = Math.max(this.deps.now(), feed.lastStart + this.spacingOf(feed));
    if (phase.kind === "due" && phase.at <= at) return false;
    this.arm(feed, at);
    return true;
  }

  // The feed's one timer, set to draw its next frame `at`, in a later turn
  // than the caller's however soon that is.
  private arm(feed: Feed, at: number): void {
    if (feed.phase.kind === "due") clearTimeout(feed.phase.timer);
    feed.phase = {
      kind: "due",
      at,
      timer: setTimeout(
        () => this.draw(feed),
        Math.max(0, at - this.deps.now()),
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
    const lanes = this.deps.lanes(feed.sessionId);
    if (lanes !== null) {
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
    for (const [lane, rate] of feed.rates)
      if (
        before === null ||
        answerOf(before, lane).bytes !== answerOf(answers, lane).bytes
      )
        noteSent(rate, frame.at);
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
    // The rate it drew at over its life, beside the pace it set: the gap is
    // what contention for the daemon's one thread cost it.
    const seconds = (now - feed.since) / 1000;
    const achieved =
      seconds === 0 ? "-" : `${(feed.drawn / seconds).toFixed(1)}fps`;
    const refreshed = REFRESH_TRIGGERS.map(
      (by) => `${by}:${refreshes[by] - feed.refreshesAtOpen[by]}`,
    ).join(",");
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} ${state} subscribers=${feed.followers.size} lanes=${[...feed.followers.keys()].map((s) => s.lane).join(",") || "-"} for=${Math.round(seconds)}s drawn=${feed.drawn} noted=${feed.noted} noView=${feed.noView} moving=${feed.moving} unseen=${feed.unseen} failed=${feed.failed} pushed=${feed.pushed} pace=${feed.pace}fps achieved=${achieved} evaluated=${feed.evaluated} woke=${WAKE_CAUSES.map((cause) => `${cause}:${feed.woke[cause]}`).join(",")} coalesced=${feed.coalesced} daemonRefreshed=${refreshed} meanDraw=${feed.drawn === 0 ? "-" : (feed.drawMs / feed.drawn).toFixed(2)}ms`,
    );
    feed.summarizedAt = now;
  }
}
