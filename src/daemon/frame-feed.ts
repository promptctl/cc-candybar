// A session's frames, pushed to whoever subscribes to them (epic
// candybar-animation-wbxz, ticket .jmm.usl). Claude Code reruns the statusline
// once a second at best; attached Claude Code and tmux panes can receive
// each frame the moment the renderer
// draws it, and the renderer draws at the rate the bar moves.
//
// Data and frames travel separately. A session's data arrives as ordinary
// render requests, from the statusline client on Claude Code's own schedule:
// `note` keeps the latest valid one. The host owns who watches: it hands the
// renderer every session's viewers, whole, and the renderer's feeds decide
// when each frame is drawn (src/renderer/feeds.ts). Each frame drawn comes back
// in a turn's output, and the host sends each subscriber what changed for it.

import { inspect } from "node:util";
import { PROTOCOL_VERSION, type Refusal } from "./foundations/protocol";
import { answerOf, type Lane, type LaneSwitches } from "../config/lanes";
import { laneOffReason } from "../config/menu-places";
import type { SessionId } from "./foundations/session-id";
import type { FeedStats } from "./foundations/stats-snapshot";
import type { Level } from "../renderer-interface/adapter";
import type {
  Answers,
  LaneViewers,
  PushedFrame,
  SessionViewers,
  Viewers,
} from "../renderer-interface/interface";

// A subscriber holds the ANSI answer for its own display.
export interface Subscriber {
  readonly lane: Lane;
  readonly frame: (json: string) => void;
  readonly refused: (resp: Refusal) => void;
  readonly drawing: () => boolean;
}

export interface FeedDeps<Req> {
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // The first session watched: whatever runs only while someone watches
  // starts, and the returned stop is called when the last stops.
  watching(): () => void;
  // [LAW:single-enforcer] Hands the renderer every session's viewers, as
  // `make` reads them when the input's slot comes: one turn, which resolves
  // once it has ended.
  deliver(make: () => Viewers): Promise<{ readonly kind: string }>;
  log(level: Level, line: string): void;
}

// Sessions whose latest request is kept, least recently noted evicted first —
// except a session someone is watching, whose subscribers it is shown to.
const MAX_REQUESTS = 256;

// A session's latest request and `order`: where it came in the order the
// daemon received requests, which is what makes one request later than another
// when their renders finish out of order.
interface Noted<Req> {
  readonly req: Req;
  readonly order: number;
}

interface Watched {
  // Each subscriber, with the bytes it was last sent: a lane whose answer a
  // frame left as it was is not sent it again; and where it joined.
  readonly followers: Map<Subscriber, { sent: string | null; joined: number }>;
  // The last frame drawn: what a subscriber is handed as it joins.
  last: Answers | null;
  pushed: number;
}

// [LAW:no-ambient-temporal-coupling] Where the viewers stand with the
// renderer: the last handed in still stands, a delivery is owed and waits in
// the mailbox (it reads them whole as its slot comes, so announcements
// meanwhile coalesce into it), or the daemon has closed.
type Delivery = "current" | "owed" | "closed";

/**
 * [LAW:no-shared-mutable-globals] Every session's latest request and every
 * watched session's subscribers: one owner, the host.
 */
export class FrameFeeds<Req> {
  private readonly requests = new Map<SessionId, Noted<Req>>();
  private readonly watched = new Map<SessionId, Watched>();
  // The lanes each session with a view switches on, as the renderer's last
  // output said: a subscriber is gated by its lane.
  private lanes: Readonly<Record<SessionId, LaneSwitches>> = {};
  // [LAW:no-ambient-temporal-coupling] The stop of what runs while anyone
  // watches: held exactly from the first session watched to the last.
  private stopWatching: (() => void) | null = null;
  private delivery: Delivery = "current";
  // The viewers as the renderer was last handed them, serialized; null when
  // what it holds is unknown (a delivery failed).
  private handed: string | null = JSON.stringify({});
  private joins = 0;
  private pushed = 0;
  private refused = 0;
  private lookups = 0;
  private found = 0;

  constructor(private readonly deps: FeedDeps<Req>) {}

  // A valid render request the daemon accepted `order`-th, among requests of
  // every kind. The latest request a session sent is where the host finds the
  // session: whether its pane is shown, and which session a lookup matches.
  // One that arrived before it — a slow render finishing late — is not the
  // session's latest.
  note(sessionId: SessionId, req: Req, order: number): void {
    const held = this.requests.get(sessionId);
    if (held !== undefined && held.order > order) return;
    const before = this.watched.has(sessionId) ? this.shown(sessionId) : null;
    this.requests.delete(sessionId);
    this.requests.set(sessionId, { req, order });
    for (const oldest of this.requests.keys()) {
      if (this.requests.size <= MAX_REQUESTS) break;
      if (!this.watched.has(oldest)) this.requests.delete(oldest);
    }
    // A request whose pane is another, on or off a screen, moves the rate its
    // bar is drawn at.
    if (before !== null && before !== this.shown(sessionId)) this.announce();
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off is refused here, and one whose
  // lane is switched off while it streams is ended as the renderer's output
  // says so (`switched`). A session with no view yet is admitted, and the
  // switches its view opens with decide.
  subscribe(sessionId: SessionId, sub: Subscriber): () => void {
    if (this.delivery === "closed") {
      // [LAW:nothing-unseen] Said, so a subscribe never vanishes from the log.
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} dropped lane=${sub.lane} daemon-closed`,
      );
      return () => {};
    }
    if (this.lanes[sessionId]?.[sub.lane] === false) {
      this.refuse(sessionId, sub);
      return () => {};
    }
    let watched = this.watched.get(sessionId);
    if (watched === undefined) {
      watched = { followers: new Map(), last: null, pushed: 0 };
      this.watched.set(sessionId, watched);
      this.stopWatching ??= this.deps.watching();
    }
    watched.followers.set(sub, { sent: null, joined: ++this.joins });
    // A subscriber is handed the frame as it stands; the renderer draws the
    // next, since who follows the session is drawn into it.
    this.send(watched, sub);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${watched.followers.size} view=${sessionId in this.lanes ? "Y" : "N"}`,
    );
    this.announce();
    return () => this.unsubscribe(sessionId, sub);
  }

  // [LAW:one-source-of-truth] Whether anyone watches the session: what keeps
  // its world state read.
  isWatched(sessionId: SessionId): boolean {
    return this.watched.has(sessionId);
  }

  // The latest request of every session someone watches.
  watchedRequests(): Req[] {
    return [...this.watched.keys()].flatMap((sessionId) => {
      const noted = this.requests.get(sessionId);
      return noted === undefined ? [] : [noted.req];
    });
  }

  // [LAW:one-source-of-truth] Who watches each session now, whole, as the
  // renderer's feeds are handed it: each lane's subscribers and whether any
  // draws the bar now, and whether the session's pane is on a screen.
  viewers(): Viewers {
    const viewers: Record<SessionId, SessionViewers> = {};
    for (const [sessionId, watched] of this.watched)
      viewers[sessionId] = this.seen(sessionId, watched);
    return viewers;
  }

  private seen(sessionId: SessionId, watched: Watched): SessionViewers {
    const lanes: Partial<Record<Lane, LaneViewers>> = {};
    let joined = 0;
    for (const [sub, follower] of watched.followers) {
      const seen = lanes[sub.lane];
      lanes[sub.lane] = {
        subscribers: (seen?.subscribers ?? 0) + 1,
        drawing: (seen?.drawing ?? false) || sub.drawing(),
      };
      joined = Math.max(joined, follower.joined);
    }
    return { lanes, shown: this.shown(sessionId), joined };
  }

  // [LAW:single-enforcer] Who watches may have changed, or how: the renderer
  // is handed the viewers whole, once for every announcement made before its
  // slot comes, and not at all when they read as it was last handed them (a
  // poll that found every pane as it was). A delivery that failed is made
  // good by the next announcement.
  announce(): void {
    if (this.delivery !== "current") return;
    if (JSON.stringify(this.viewers()) === this.handed) return;
    this.delivery = "owed";
    void this.deps
      .deliver(() => {
        if (this.delivery === "owed") this.delivery = "current";
        const viewers = this.viewers();
        this.handed = JSON.stringify(viewers);
        return viewers;
      })
      .then(
        ({ kind }) => {
          if (kind !== "answered") this.handed = null;
        },
        // [LAW:no-silent-failure] A delivery that rejected is said, and what
        // it owed is owed to the next announcement.
        (thrown: unknown) => {
          this.deps.log(
            "error",
            `feed viewers delivery rejected: ${inspect(thrown)}`,
          );
          this.handed = null;
          if (this.delivery === "owed") this.delivery = "current";
        },
      );
  }

  // The renderer was handed the viewers some other way, a start's: null once
  // that turn failed, so what it holds is unknown, as after a failed delivery.
  handedIn(viewers: Viewers | null): void {
    this.handed = viewers === null ? null : JSON.stringify(viewers);
  }

  // [LAW:one-source-of-truth] The lanes each session's view switches on, as
  // a renderer's output declared them: every subscriber whose lane is now
  // off is ended, told why.
  switched(lanes: Readonly<Record<SessionId, LaneSwitches>>): void {
    this.lanes = lanes;
    for (const [sessionId, { followers }] of [...this.watched])
      for (const sub of [...followers.keys()]) {
        if (lanes[sessionId]?.[sub.lane] !== false) continue;
        this.unsubscribe(sessionId, sub);
        this.refuse(sessionId, sub);
      }
  }

  // The frames a renderer's turn drew: each kept as its session's last, and
  // sent to each of its subscribers whose lane's answer it changed.
  took(frames: readonly PushedFrame[]): void {
    for (const { session, answers } of frames) {
      const watched = this.watched.get(session);
      // Unwatched since the renderer drew it.
      if (watched === undefined) continue;
      watched.last = answers;
      for (const sub of watched.followers.keys()) this.send(watched, sub);
    }
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

  // The latest request and its arrival order, for consumers reconciling
  // declarations from sessions that have reported the same pane.
  latestWithOrder(sessionId: SessionId): Noted<Req> | undefined {
    return this.requests.get(sessionId);
  }

  // The frames the renderer drew are its own count (`RendererStats`).
  getStats(): Omit<FeedStats, "drawn"> {
    let subscribers = 0;
    for (const { followers } of this.watched.values())
      subscribers += followers.size;
    return {
      feeds: this.watched.size,
      subscribers,
      pushed: this.pushed,
      refused: this.refused,
      lookups: this.lookups,
      found: this.found,
    };
  }

  // The daemon's close: every subscriber leaves, and the renderer is handed
  // nothing more.
  close(): void {
    this.delivery = "closed";
    for (const [sessionId, { followers }] of [...this.watched])
      for (const sub of [...followers.keys()]) this.unsubscribe(sessionId, sub);
  }

  private unsubscribe(sessionId: SessionId, sub: Subscriber): void {
    const watched = this.watched.get(sessionId);
    if (watched === undefined || !watched.followers.delete(sub)) return;
    if (watched.followers.size === 0) {
      this.watched.delete(sessionId);
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} unwatched pushed=${watched.pushed}`,
      );
      if (this.watched.size === 0) {
        this.stopWatching?.();
        this.stopWatching = null;
      }
    }
    this.announce();
  }

  private shown(sessionId: SessionId): boolean {
    const noted = this.requests.get(sessionId);
    return noted === undefined || this.deps.shown(noted.req);
  }

  // The last frame's answer for `sub`'s lane, unless it was sent that already.
  private send(watched: Watched, sub: Subscriber): void {
    const follower = watched.followers.get(sub);
    if (watched.last === null || follower === undefined) return;
    const json = answerOf(watched.last, sub.lane);
    if (follower.sent === json) return;
    follower.sent = json;
    this.pushed++;
    watched.pushed++;
    sub.frame(json);
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
}
