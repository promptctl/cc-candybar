// A session's frames, pushed to whoever subscribes to them (epic
// candybar-animation-wbxz, ticket .jmm.usl). Claude Code reruns the statusline
// once a second at best; a subscriber here — a patched Claude Code, a mod, a
// renderer outside Claude Code — receives each frame the moment the renderer
// draws it, and the renderer draws at the rate the bar moves.
//
// Data and frames travel separately. A session's data arrives as ordinary
// render requests, from the statusline client on Claude Code's own schedule:
// `note` keeps the latest valid one. Its frames are drawn by the renderer
// (src/renderer/feeds.ts), on its own clock, over who follows each session,
// which the host derives here whole (`viewers`) and hands in as it changes.
// The host keeps the subscribers: it gates each on its lane, hands each frame
// to those whose lane it changed, and a late joiner the frame as it stands.

import {
  REFRESH_TRIGGERS,
  type RefreshTrigger,
} from "../utils/refresh-ledger.js";
import type { Frame } from "../render/frame";
import { parseFrame } from "../render/frame";
import { PROTOCOL_VERSION, type Refusal } from "./foundations/protocol";
import {
  LANES,
  perLane,
  type Lane,
  type LaneSwitches,
  type Viewers,
} from "../config/lanes";
import { laneOffReason } from "../config/menu-places";
import type { SessionId } from "./foundations/session-id";
import type { FeedStats } from "./foundations/stats-snapshot";
import type { Level } from "../renderer-interface/adapter";
import type { PushedFrame } from "../renderer-interface/interface";

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
  // Which animation lanes the session's settings switch on now, as the
  // renderer last declared them, or null while it has no view: a subscribe is
  // gated on them.
  lanes(sessionId: SessionId): LaneSwitches | null;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // [LAW:one-source-of-truth] Who follows every session's frames moved: the
  // whole of it, for the renderer.
  viewersChanged(viewers: Readonly<Record<SessionId, Viewers>>): void;
  // The first feed opened: whatever runs only while some feed exists starts,
  // and the returned stop is called when the last feed closes.
  watching(): () => void;
  // Every source's refreshes so far, by trigger (the daemon's one ledger):
  // the feed's closing line says how many ran while it was open, beside the
  // frames it pushed, so a feed that drew without refreshing anything is seen
  // to.
  refreshes(): Readonly<Record<RefreshTrigger, number>>;
  log(level: Level, line: string): void;
}

interface Feed {
  readonly sessionId: SessionId;
  // Each subscriber, with the bytes it was last sent: a lane whose answer a
  // frame left as it was is not sent it again.
  readonly followers: Map<Subscriber, string | null>;
  // The last frame handed in: its bar, so a new subscriber gets the bar at
  // once, and its answers as serialized.
  last: { readonly bar: Frame; readonly answers: Answers } | null;
  noted: number;
  pushed: number;
  // The ledger's refreshes when the feed opened.
  readonly refreshesAtOpen: Readonly<Record<RefreshTrigger, number>>;
}

interface Answers {
  readonly resp: string;
  readonly statusline: string;
}

// [LAW:one-source-of-truth] A lane drawing the bar elsewhere draws the bar;
// the one drawing it in the statusline draws what the statusline shows.
const answerOf = (answers: Answers, lane: Lane): string =>
  LANES[lane].handsOff ? answers.resp : answers.statusline;

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
 * subscribed session's subscribers: one owner, the host. A feed exists
 * exactly while the session has a subscriber.
 */
export class FrameFeeds<Req> {
  private readonly requests = new Map<SessionId, Noted<Req>>();
  private readonly feeds = new Map<SessionId, Feed>();
  // [LAW:no-ambient-temporal-coupling] The stop of what runs while any feed
  // exists: held exactly from the first feed opening to the last closing.
  private stopWatching: (() => void) | null = null;
  // The viewers last handed to the renderer, serialized.
  private told = JSON.stringify({});
  // The daemon's close: no feed opens after it.
  private closed = false;
  private pushed = 0;
  private refused = 0;
  private lookups = 0;
  private found = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon accepted `order`-th, among requests of
  // every kind. The latest request a session sent is where the feeds find the
  // session: whether its pane is shown, and which sessions a lookup matches.
  // One that arrived before it — a slow render finishing late — is not the
  // session's latest.
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
    // Its pane may have moved onto or off a screen.
    this.check();
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off, as the renderer declared them, is
  // refused here before any feed opens, and one whose lane is switched off
  // while it streams is ended as the frame saying so arrives (`framed`). A
  // session with no view yet is admitted, and its first frame decides.
  subscribe(sessionId: SessionId, sub: Subscriber): () => void {
    // A daemon that closed opens no feed: the subscriber is dropped as the
    // close dropped those it followed.
    // [LAW:nothing-unseen] Said, so a subscribe never vanishes from the log.
    if (this.closed) {
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} dropped lane=${sub.lane} daemon-closed`,
      );
      return () => {};
    }
    const lanes = this.deps.lanes(sessionId);
    if (lanes !== null && !lanes[sub.lane]) {
      this.refuse(sessionId, sub);
      return () => {};
    }
    const feed = this.feeds.get(sessionId) ?? this.open(sessionId);
    feed.followers.set(sub, null);
    // A later subscriber is handed the frame as it stands; who follows the
    // session is drawn into its next one.
    this.send(feed, sub);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${feed.followers.size} view=${lanes === null ? "N" : "Y"}`,
    );
    this.check();
    return () => {
      const held = this.feeds.get(sessionId);
      if (held !== undefined) this.unsubscribe(held, sub);
    };
  }

  // [LAW:one-source-of-truth] Who follows every session's frames, derived
  // whole from the subscribers and the panes on a screen: each lane's
  // subscribers and whether any of them draws it now.
  viewers(): Readonly<Record<SessionId, Viewers>> {
    return Object.fromEntries(
      [...this.feeds.values()].map((feed) => [
        feed.sessionId,
        {
          shown: this.shown(feed),
          lanes: perLane((lane) => {
            let subscribers = 0;
            let drawing = false;
            for (const sub of feed.followers.keys()) {
              if (sub.lane !== lane) continue;
              subscribers++;
              drawing ||= sub.drawing();
            }
            return { subscribers, drawing };
          }),
        },
      ]),
    );
  }

  // [LAW:single-enforcer] The one place the renderer is told who follows:
  // whenever what `viewers` derives moved, and only then. The daemon calls
  // it after anything outside this owner moves a pane on or off a screen.
  check(): void {
    const viewers = this.viewers();
    const said = JSON.stringify(viewers);
    if (said === this.told) return;
    this.told = said;
    this.deps.viewersChanged(viewers);
  }

  // The frames a renderer's turn drew, in order: each goes to the session's
  // subscribers whose lane its settings still switch on, and a subscriber
  // whose lane they switch off is refused.
  framed(frames: readonly PushedFrame[]): void {
    for (const { session, frame } of frames) {
      const feed = this.feeds.get(session);
      if (feed === undefined) continue;
      const { lanes } = frame;
      if (lanes !== null)
        for (const sub of [...feed.followers.keys()]) {
          if (lanes[sub.lane]) continue;
          this.unsubscribe(feed, sub);
          this.refuse(session, sub);
        }
      if (this.feeds.get(session) !== feed) continue;
      // [LAW:parse-dont-validate] The receiving edge of a feed frame.
      feed.last = {
        bar: parseFrame(frame.bar),
        answers: {
          resp: JSON.stringify(frame.resp),
          statusline: JSON.stringify(frame.statusline),
        },
      };
      this.pushed++;
      feed.pushed++;
      // [LAW:nothing-unseen] A failing frame's render event is logged when it
      // is pushed: one that keeps throwing the same way draws the same bytes,
      // which the renderer pushes once.
      if (frame.failure !== null)
        this.deps.log(frame.failure.level, frame.failure.line);
      for (const sub of feed.followers.keys()) this.send(feed, sub);
    }
  }

  // [LAW:one-source-of-truth] Whether anyone follows the session's frames.
  feedOpen(sessionId: SessionId): boolean {
    return this.feeds.has(sessionId);
  }

  // The lanes whose subscribers follow the session's frames and draw it now.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    return new Set(
      [...(this.feeds.get(sessionId)?.followers.keys() ?? [])]
        .filter((s) => s.drawing())
        .map((s) => s.lane),
    );
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

  getStats(): Omit<FeedStats, "drawn"> {
    let subscribers = 0;
    for (const feed of this.feeds.values()) subscribers += feed.followers.size;
    return {
      feeds: this.feeds.size,
      subscribers,
      pushed: this.pushed,
      refused: this.refused,
      lookups: this.lookups,
      found: this.found,
    };
  }

  private open(sessionId: SessionId): Feed {
    const feed: Feed = {
      sessionId,
      followers: new Map(),
      last: null,
      noted: 0,
      pushed: 0,
      refreshesAtOpen: this.deps.refreshes(),
    };
    this.feeds.set(sessionId, feed);
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
    if (feed.followers.size === 0) {
      this.feeds.delete(feed.sessionId);
      if (this.feeds.size === 0) {
        this.stopWatching?.();
        this.stopWatching = null;
      }
      this.summarize(feed);
    }
    // Who follows the session is drawn into its frame.
    this.check();
  }

  // The last frame's answer for `sub`'s lane, unless it was sent that already.
  private send(feed: Feed, sub: Subscriber): void {
    if (feed.last === null) return;
    const json = answerOf(feed.last.answers, sub.lane);
    if (feed.followers.get(sub) === json) return;
    sub.frame(feed.last.bar, json);
    feed.followers.set(sub, json);
  }

  private shown(feed: Feed): boolean {
    const noted = this.requests.get(feed.sessionId);
    return noted === undefined || this.deps.shown(noted.req);
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

  // [LAW:nothing-unseen] What the host saw of a feed, as its last subscriber
  // leaves: the requests noted and frames pushed while it ran. The renderer's
  // own line says what it drew.
  //
  // `daemonRefreshed=` is every refresh the daemon made while the feed ran,
  // whichever session's: a frame refreshes nothing, so it bounds what the
  // feed's frames could have read fresh, and is never their own.
  private summarize(feed: Feed): void {
    const refreshes = this.deps.refreshes();
    const refreshed = REFRESH_TRIGGERS.map(
      (by) => `${by}:${refreshes[by] - feed.refreshesAtOpen[by]}`,
    ).join(",");
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(feed.sessionId)} left noted=${feed.noted} pushed=${feed.pushed} daemonRefreshed=${refreshed}`,
    );
  }
}
