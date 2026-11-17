// A session's frames, pushed to whoever subscribes to them (epic
// candybar-animation-wbxz, ticket .jmm.usl). Claude Code reruns the statusline
// once a second at best; a subscriber here — a patched Claude Code, a mod, a
// renderer outside Claude Code — receives each frame the moment the renderer
// draws it, and the renderer draws at the rate the bar moves.
//
// Data and frames travel separately. A session's data arrives as ordinary
// render requests, from the statusline client on Claude Code's own schedule:
// `note` keeps the latest valid one. Its frames are drawn from that request at
// each instant they are drawn, so a frame between two of Claude Code's ticks is
// the same bar the next tick would draw, at a later instant.
//
// [LAW:decomposition] The host owns who watches and what each was sent; the
// renderer owns when a frame is drawn (src/renderer/feeds.ts). The host
// derives its viewers from its own sources and announces each change; the
// renderer draws every frame it owes and pushes it, and each subscriber here
// is sent the frames that changed what its lane shows.

import {
  REFRESH_TRIGGERS,
  type RefreshTrigger,
} from "../utils/refresh-ledger.js";
import { parseFrame, type Frame } from "../render/frame";
import { PROTOCOL_VERSION, type Refusal } from "./foundations/protocol";
import {
  answerOf,
  LANE_NAMES,
  perLane,
  type Lane,
  type LaneSwitches,
} from "../config/lanes";
import { laneOffReason } from "../config/menu-places";
import type { Timekeeper } from "../time";
import type { SessionId } from "./foundations/session-id";
import type { FeedStats } from "./foundations/stats-snapshot";
import type { Level } from "../renderer-interface/adapter";
import type {
  Answers,
  PushedFrame,
  SessionViewers,
  Viewers,
} from "../renderer-interface/interface";

// A subscriber: each frame's bar, which a lane drawing it elsewhere encodes,
// and its lane's answer as the renderer serialized it once for every
// subscriber of that lane.
export type Sink = (bar: Frame, json: string) => void;

// One subscription: the lane it serves, where its frames go, where its
// refusal goes — the last thing it receives, since a refused subscription is
// over — and whether it draws the bar where its lane puts it now. A client's
// subscription draws whatever it is sent; the daemon's own tmux status line
// draws a session only while that status line shows the session's pane, and
// says when that changes (`changed`, below).
export interface Subscriber {
  readonly lane: Lane;
  readonly frame: Sink;
  readonly refused: (resp: Refusal) => void;
  readonly drawing: () => boolean;
}

export interface FeedDeps<Req> {
  // The monotonic clock a session's watch is timed on, for its summary.
  clock: Pick<Timekeeper, "monotonic">;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // The first session watched: whatever runs only while some session is
  // watched starts, and the returned stop is called when the last is not.
  watching(): () => void;
  // [LAW:single-enforcer] Who watches some session may have changed: the
  // viewers are owed to the renderer, read whole as their turn comes.
  changed(): void;
  // Every source's refreshes so far, by trigger (the daemon's one ledger):
  // a session's summary says how many ran while it was watched, beside the
  // frames it was pushed, so frames that read nothing fresh are seen to.
  refreshes(): Readonly<Record<RefreshTrigger, number>>;
  log(level: Level, line: string): void;
}

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

// A session someone watches: each subscriber with the answer it was last
// sent, the last frame the renderer pushed, which a new subscriber is sent at
// once, and what its summary counts.
interface Watch {
  readonly sessionId: SessionId;
  // [LAW:one-source-of-truth] What each subscriber was last sent lives on
  // the subscriber's own entry and dies with it: a session watched again
  // starts with nothing sent.
  readonly subscribers: Map<Subscriber, string | null>;
  last: { readonly bar: Frame; readonly answers: Answers } | null;
  // Where its latest subscriber came among every join (`SessionViewers`).
  joined: number;
  readonly since: number;
  pushed: number;
  sent: number;
  // The ledger's refreshes when the watch began.
  readonly refreshesAtOpen: Readonly<Record<RefreshTrigger, number>>;
}

/**
 * [LAW:no-shared-mutable-globals] Every session's latest request and every
 * watched session's subscribers: one owner, the daemon.
 */
export class FrameFeeds<Req> {
  private readonly requests = new Map<SessionId, Noted<Req>>();
  private readonly watches = new Map<SessionId, Watch>();
  // [LAW:one-source-of-truth] The lanes each session with an open view
  // switches on, as the renderer last declared them: the one gate.
  private lanes: Readonly<Record<SessionId, LaneSwitches>> = {};
  // [LAW:no-ambient-temporal-coupling] The stop of what runs while any
  // session is watched: held exactly from the first watch to the last.
  private stopWatching: (() => void) | null = null;
  // The daemon's close: no subscriber is taken after it.
  private closed = false;
  private joins = 0;
  private framed = 0;
  private pushed = 0;
  private refused = 0;
  private lookups = 0;
  private found = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon accepted `order`-th, among requests of
  // every kind. The latest request a session sent is where the feeds find
  // the session: whether its pane is shown, and which session a lookup
  // matches. Its frames draw by the request its view is declared with. One
  // that arrived before it — a slow render finishing late — is not the
  // session's latest.
  note(sessionId: SessionId, req: Req, order: number): void {
    const held = this.requests.get(sessionId);
    if (held !== undefined && held.order > order) return;
    this.requests.delete(sessionId);
    const noted = { req, order };
    this.requests.set(sessionId, noted);
    for (const oldest of this.requests.keys()) {
      if (this.requests.size <= MAX_REQUESTS) break;
      if (!this.watches.has(oldest)) this.requests.delete(oldest);
    }
    // [LAW:single-enforcer] The request is where a watched session's pane
    // is read from, so a request from a pane shown otherwise is a change of
    // its viewers, announced here.
    if (this.watches.has(sessionId) && this.shown(held) !== this.shown(noted))
      this.deps.changed();
  }

  // Whether the session's bar is on a screen, by its latest request: one
  // with none yet is taken as shown, so a frame is never held back on a guess.
  private shown(noted: Noted<Req> | undefined): boolean {
    return noted === undefined || this.deps.shown(noted.req);
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off is refused here, and one whose
  // lane is switched off while it streams is ended as the renderer declares
  // it (`declared`). A session with no view yet is admitted, and the lanes
  // its view declares decide. The returned unsubscribe is its leaving.
  subscribe(sessionId: SessionId, sub: Subscriber): () => void {
    // [LAW:nothing-unseen] Said, so a subscribe never vanishes from the log.
    if (this.closed) {
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} dropped lane=${sub.lane} daemon-closed`,
      );
      return () => {};
    }
    const lanes = this.lanes[sessionId];
    if (lanes !== undefined && !lanes[sub.lane]) {
      this.refuse(sessionId, sub);
      return () => {};
    }
    const watch = this.watches.get(sessionId) ?? this.open(sessionId);
    watch.subscribers.set(sub, null);
    watch.joined = ++this.joins;
    // [LAW:no-ambient-temporal-coupling] Handed the frame as it stands; the
    // renderer is told who follows the session, which its next frame draws.
    this.send(watch, sub);
    this.deps.changed();
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${watch.subscribers.size} view=${lanes === undefined ? "N" : "Y"}`,
    );
    return () => {
      const held = this.watches.get(sessionId);
      if (held !== undefined) this.unsubscribe(held, sub);
    };
  }

  // [LAW:single-enforcer] What the renderer's turn declared of each session's
  // lanes: a subscriber whose lane is now off is refused, and leaves.
  declared(lanes: Readonly<Record<SessionId, LaneSwitches>>): void {
    this.lanes = lanes;
    for (const watch of [...this.watches.values()]) {
      const switches = lanes[watch.sessionId];
      if (switches === undefined) continue;
      for (const sub of [...watch.subscribers.keys()]) {
        if (switches[sub.lane]) continue;
        this.unsubscribe(watch, sub);
        this.refuse(watch.sessionId, sub);
      }
    }
  }

  // A frame the renderer drew: each subscriber of its session is sent it,
  // unless its lane's answer is what that subscriber was last sent.
  frame(frame: PushedFrame): void {
    this.framed++;
    const watch = this.watches.get(frame.session);
    // Nobody watches it now: the renderer drew it before it heard.
    if (watch === undefined) return;
    // [LAW:parse-dont-validate] The receiving edge of a pushed frame.
    watch.last = { bar: parseFrame(frame.bar), answers: frame.answers };
    watch.pushed++;
    this.pushed++;
    for (const sub of [...watch.subscribers.keys()]) this.send(watch, sub);
  }

  // [LAW:one-source-of-truth] Who watches each session, derived whole from
  // the subscribers, whether each draws now, and the pane's visibility.
  viewers(): Viewers {
    const viewers: Record<SessionId, SessionViewers> = {};
    for (const watch of this.watches.values()) {
      const subs = [...watch.subscribers.keys()];
      const noted = this.requests.get(watch.sessionId);
      viewers[watch.sessionId] = {
        lanes: perLane((lane) => {
          const ofLane = subs.filter((sub) => sub.lane === lane);
          return {
            subscribers: ofLane.length,
            drawing: ofLane.some((sub) => sub.drawing()),
          };
        }),
        shown: this.shown(noted),
        joined: watch.joined,
      };
    }
    return viewers;
  }

  // The lanes whose subscribers follow the session's frames and draw them
  // now: the host's own reading of the viewers.
  following(sessionId: SessionId): ReadonlySet<Lane> {
    const subs = [...(this.watches.get(sessionId)?.subscribers.keys() ?? [])];
    return new Set(
      LANE_NAMES.filter((lane) =>
        subs.some((sub) => sub.lane === lane && sub.drawing()),
      ),
    );
  }

  // [LAW:one-source-of-truth] Whether someone watches the session.
  watched(sessionId: SessionId): boolean {
    return this.watches.has(sessionId);
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
  watchedRequests(): Array<{
    readonly sessionId: SessionId;
    readonly req: Req;
  }> {
    return [...this.watches.keys()].flatMap((sessionId) => {
      const noted = this.requests.get(sessionId);
      return noted === undefined ? [] : [{ sessionId, req: noted.req }];
    });
  }

  getStats(): FeedStats {
    let subscribers = 0;
    for (const watch of this.watches.values())
      subscribers += watch.subscribers.size;
    return {
      feeds: this.watches.size,
      subscribers,
      drawn: this.framed,
      pushed: this.pushed,
      refused: this.refused,
      lookups: this.lookups,
      found: this.found,
    };
  }

  // The daemon's close: every watch ends as its last subscriber's leaving
  // ends it.
  close(): void {
    this.closed = true;
    for (const watch of [...this.watches.values()])
      for (const sub of [...watch.subscribers.keys()])
        this.unsubscribe(watch, sub);
  }

  private open(sessionId: SessionId): Watch {
    const watch: Watch = {
      sessionId,
      subscribers: new Map(),
      last: null,
      joined: 0,
      since: this.deps.clock.monotonic(),
      pushed: 0,
      sent: 0,
      refreshesAtOpen: this.deps.refreshes(),
    };
    this.watches.set(sessionId, watch);
    this.stopWatching ??= this.deps.watching();
    return watch;
  }

  // [LAW:no-ambient-temporal-coupling] The change is announced once it is
  // whole: an idle mailbox makes the viewers turn inside the announcement, so
  // one made before the empty watch went would hand the renderer a session
  // nobody watches, and its feed would draw for no one.
  private unsubscribe(watch: Watch, sub: Subscriber): void {
    if (!watch.subscribers.delete(sub)) return;
    if (watch.subscribers.size === 0) {
      this.watches.delete(watch.sessionId);
      if (this.watches.size === 0) {
        this.stopWatching?.();
        this.stopWatching = null;
      }
      this.summarize(watch);
    }
    this.deps.changed();
  }

  // The last frame's answer for `sub`'s lane, unless it was sent that already.
  private send(watch: Watch, sub: Subscriber): void {
    if (watch.last === null) return;
    const json = answerOf(watch.last.answers, sub.lane);
    if (watch.subscribers.get(sub) === json) return;
    watch.subscribers.set(sub, json);
    watch.sent++;
    sub.frame(watch.last.bar, json);
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

  // [LAW:nothing-unseen] What a session's watch was pushed and sent, said as
  // it ends; the renderer's feed says what it drew.
  //
  // `daemonRefreshed=` is every refresh the daemon made while the session was
  // watched, whichever session's: a frame refreshes nothing, so it bounds what
  // the pushed frames could have read fresh, and is never their own.
  private summarize(watch: Watch): void {
    const refreshes = this.deps.refreshes();
    const seconds = (this.deps.clock.monotonic() - watch.since) / 1000;
    const refreshed = REFRESH_TRIGGERS.map(
      (by) => `${by}:${refreshes[by] - watch.refreshesAtOpen[by]}`,
    ).join(",");
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(watch.sessionId)} unwatched for=${Math.round(seconds)}s pushed=${watch.pushed} sent=${watch.sent} daemonRefreshed=${refreshed}`,
    );
  }
}
