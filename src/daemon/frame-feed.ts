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
import {
  failedWith,
  renderFailed,
  FEED_ANSWERS,
} from "./foundations/render-answers";
import type { FrameSource } from "../click/link-signer.js";
import type { RendererName } from "./foundations/renderer-name.js";
import type { PublishFrame } from "./foundations/frame-publication.js";
import {
  LANES,
  LANE_NAMES,
  perLane,
  type Lane,
  type LaneSwitches,
} from "../config/lanes";
import { laneOffReason } from "../config/menu-places";
import type { SessionId } from "./foundations/session-id";
import type { FeedStats } from "./foundations/stats-snapshot";
import type { LogLevel } from "../utils/logger";
import { sameDaemonEvent, type DaemonEvent } from "../utils/event-hold.js";
import type { Pointer } from "../click/gesture";
import type {
  FeedFrame,
  LaneViewers,
  PushedFrame,
  SessionViewers,
  Viewers,
} from "../renderer-interface/interface";

// A subscriber holds the ANSI answer for its own display.
type Delivered = (delivered: boolean) => void;

// [LAW:one-source-of-truth] A follower that sees the pointer over the surface
// it draws: its id, and what it last said of the pointer. Held by the feed for
// as long as the follower's subscription stands.
export interface PointerOwner {
  readonly id: string;
  readonly pointer: Pointer;
}

export interface Subscriber {
  readonly lane: Lane;
  // The owner a subscriber that sees the pointer is, or null for one that
  // sees none.
  readonly owner: PointerOwner | null;
  // The writer reports completion or replacement for each offered chunk.
  readonly frame: (json: string, done: Delivered) => void;
  readonly refused: (resp: Refusal) => void;
  readonly drawing: () => boolean;
  // An enrolled pane keeps following while hidden. Only a shown, current
  // assignment can confirm that its physical display took an offered frame.
  readonly presenting?: () => boolean;
}

export interface FeedDeps<Req> {
  readonly publishFrame: PublishFrame;
  readonly acknowledgeDisplayed: (events: readonly DaemonEvent[]) => void;
  // Which accepted request changed independently of a renderer's declaration.
  readonly requestChanged: (
    session: SessionId,
    previous: Req | undefined,
  ) => void;
  // Whether the bar of the session `req` is from is on a screen now: a bar
  // nobody can see is drawn at the still rate however it moves.
  shown(req: Req): boolean;
  // A session gained its first subscriber or lost its last one.
  watchingChanged(session: SessionId, watching: boolean): void;
  // A lane of the session gained its first subscriber or lost its last: its
  // surface's drawer changed.
  laneFollowed(session: SessionId, lane: Lane, followed: boolean): void;
  // [LAW:single-enforcer] Hands the renderer every session's viewers, as
  // `make` reads them when the input's slot comes: one turn, which resolves
  // once it has ended.
  deliver(make: () => Viewers): Promise<{ readonly kind: string }>;
  log(level: LogLevel, line: string): void;
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

interface PendingWrite {
  readonly answer: EncodedAnswer;
  done: Delivered | undefined;
}

interface Follower {
  confirmed: EncodedAnswer | null;
  // [LAW:single-enforcer] The transport bounds its outstanding writes. Each
  // carries at most one candidate, replaced when the latest draw is identical.
  readonly writes: Set<PendingWrite>;
  // What the follower last said of the pointer, where its subscription
  // declared an owner.
  owner: HeldPointer | null;
}

// An owner's facts of its pointer as the feed holds them, and `said`: where its
// last word came in the order of the feed's owners' words, which is what makes
// one owner's pointer its lane's.
interface HeldPointer extends PointerOwner {
  readonly said: number;
}

interface Watched {
  readonly followers: Map<Subscriber, Follower>;
  // Each lane's last frame drawn: what a subscriber of that lane is handed as
  // it joins.
  readonly last: Map<Lane, EncodedAnswer>;
  // [LAW:single-enforcer] Only the host knows when a new subscriber needs a
  // first draw. Its demand survives count-preserving viewer coalescing.
  frameDemand: number;
  pushed: number;
}

// [LAW:one-source-of-truth] A lane's pointer is the one its owner that spoke
// last holds: the pointer over that surface is where the user last moved it,
// and an owner that opens or reconnects speaks for itself once. Each surface
// is drawn from its own pointer, never another lane's. It is derived from who
// follows the session, never stored beside them, so when that owner ends the
// one that spoke before it owns the lane's pointer again.
function ownerOf(watched: Watched, lane: Lane): HeldPointer | null {
  let found: HeldPointer | null = null;
  for (const [sub, { owner }] of watched.followers)
    if (
      sub.lane === lane &&
      sub.presenting?.() !== false &&
      owner !== null &&
      (found === null || owner.said > found.said)
    )
      found = owner;
  return found;
}

// Whether any subscriber of the session follows `lane`.
const followsLane = (watched: Watched, lane: Lane): boolean =>
  [...watched.followers.keys()].some((sub) => sub.lane === lane);

// Who owns each lane's pointer: what an owner change is told against.
type Owners = Readonly<Record<Lane, string | null>>;
const ownersOf = (watched: Watched | undefined): Owners =>
  perLane((lane) =>
    watched === undefined ? null : (ownerOf(watched, lane)?.id ?? null),
  );

// A frame as a lane's subscribers are sent it, and the failure it is when it
// is one.
interface EncodedAnswer {
  readonly json: string;
  readonly displayedEvents?: readonly DaemonEvent[];
}

const failedAnswer = (refusal: Refusal): EncodedAnswer => ({
  json: JSON.stringify(refusal),
});

function covers(prior: EncodedAnswer, offered: EncodedAnswer): boolean {
  if (prior.json !== offered.json) return false;
  // [LAW:one-source-of-truth] Equal indicator bytes may stand for different
  // events. A previous write covers the offer if it can confirm all of its
  // still-unanswered occurrences as well as its bytes.
  return (
    offered.displayedEvents === undefined ||
    offered.displayedEvents.every(
      (event) =>
        prior.displayedEvents?.some((seen) => sameDaemonEvent(seen, event)) ??
        false,
    )
  );
}

function settleWrite(write: PendingWrite, delivered: boolean): void {
  const done = write.done;
  write.done = undefined;
  done?.(delivered);
}

// [LAW:single-enforcer] Encode a lane's frame once, in the encoding its lane
// names, for all of that lane's subscribers. A throw is the caller's: a
// failure of this frame alone.
function encodeFeed(
  lane: Lane,
  frame: FeedFrame,
  publish: PublishFrame,
  source: FrameSource,
): EncodedAnswer {
  if (frame.kind === "failed") return failedAnswer(failedWith(frame.message));
  return {
    json: JSON.stringify(
      FEED_ANSWERS[LANES[lane].encoding](publish(frame.bar, source)),
    ),
    displayedEvents: frame.displayedEvents,
  };
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
  private delivery: Delivery = "current";
  // The viewers as the renderer was last handed them, serialized; null when
  // what it holds is unknown (a delivery failed).
  private handed: string | null = JSON.stringify({});
  private frameDemands = 0;
  private ownersSaid = 0;
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
    for (const [oldest, previous] of this.requests) {
      if (this.requests.size <= MAX_REQUESTS) break;
      if (!this.watched.has(oldest)) {
        this.requests.delete(oldest);
        this.deps.requestChanged(oldest, previous.req);
      }
    }
    this.deps.requestChanged(sessionId, held?.req);
    // A request whose pane is another, on or off a screen, moves the rate its
    // bar is drawn at.
    if (before !== null && before !== this.shown(sessionId)) this.announce();
  }

  // [LAW:single-enforcer] The one gate on the lanes: a subscription whose
  // lane the session's settings switch off is refused here, and one whose
  // lane is switched off while it streams is ended as the renderer's output
  // says so (`switched`). A session with no view yet is admitted, and the
  // switches its view opens with decide.
  private moving = false;
  subscribe(
    sessionId: SessionId,
    sub: Subscriber,
    replaces?: () => void,
  ): () => void {
    if (replaces === undefined) return this.join(sessionId, sub);
    // [LAW:no-ambient-temporal-coupling] A physical pane changing sessions
    // exposes only the complete move to even a synchronous viewer reader.
    this.moving = true;
    try {
      const leave = this.join(sessionId, sub);
      replaces();
      return leave;
    } finally {
      this.moving = false;
      this.announce();
    }
  }

  private join(sessionId: SessionId, sub: Subscriber): () => void {
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
      watched = {
        followers: new Map(),
        last: new Map(),
        frameDemand: 0,
        pushed: 0,
      };
      this.watched.set(sessionId, watched);
      this.deps.watchingChanged(sessionId, true);
    }
    if (watched.followers.has(sub))
      return () => this.unsubscribe(sessionId, sub);
    const follower: Follower = {
      confirmed: null,
      writes: new Set(),
      owner: sub.owner === null ? null : this.held(sub.owner),
    };
    const owned = ownersOf(watched);
    const laneJoined = !followsLane(watched, sub.lane);
    watched.followers.set(sub, follower);
    this.ownerMoved(sessionId, owned, watched);
    if (laneJoined) this.deps.laneFollowed(sessionId, sub.lane, true);
    this.handover(sessionId, watched, sub, follower);
    this.deps.log(
      "info",
      `feed sid=${JSON.stringify(sessionId)} subscribed lane=${sub.lane} subscribers=${watched.followers.size} view=${sessionId in this.lanes ? "Y" : "N"}`,
    );
    this.announce();
    return () => this.unsubscribe(sessionId, sub);
  }

  // [LAW:single-enforcer] A hot join takes the encoded frame from the host.
  // A missing frame or a declined handover still needs a draw. A newer write
  // or a departing subscriber has already settled the need for this offer.
  private handover(
    sessionId: SessionId,
    watched: Watched,
    sub: Subscriber,
    follower: Follower,
  ): void {
    const last = watched.last.get(sub.lane);
    if (last === undefined) {
      watched.frameDemand = ++this.frameDemands;
      return;
    }
    this.send(sessionId, watched, sub, last, (delivered) => {
      if (
        !delivered &&
        watched.followers.get(sub) === follower &&
        follower.confirmed === null &&
        follower.writes.size === 0
      ) {
        watched.frameDemand = ++this.frameDemands;
        this.announce();
      }
    });
  }

  // [LAW:single-enforcer] An owner's facts of its pointer, as a subscribe and
  // each report admit them: its latest, and the latest word of any owner.
  private held(owner: PointerOwner): HeldPointer {
    return { ...owner, said: ++this.ownersSaid };
  }

  // An owner's report of its pointer: held for the owner, which then owns its
  // lane's pointer, and the renderer is handed the change like any change
  // of who watches. An owner that does not follow the session is refused.
  pointerOf(
    sessionId: SessionId,
    owner: PointerOwner,
  ):
    | { readonly kind: "ok" }
    | { readonly kind: "refused"; readonly reason: string } {
    const watched = this.watched.get(sessionId);
    const reporting = [...(watched?.followers ?? [])].flatMap(
      ([sub, follower]) =>
        follower.owner?.id === owner.id && sub.presenting?.() !== false
          ? [follower]
          : [],
    );
    if (watched === undefined || reporting.length === 0)
      return {
        kind: "refused",
        reason: `no owner ${JSON.stringify(owner.id)} follows session ${JSON.stringify(sessionId)}`,
      };
    // A stream that reconnects over its old one holds the owner's facts twice.
    const owned = ownersOf(watched);
    const admitted = this.held(owner);
    for (const follower of reporting) follower.owner = admitted;
    this.ownerMoved(sessionId, owned, watched);
    this.announce();
    return { kind: "ok" };
  }

  // [LAW:nothing-unseen] Who holds a lane's pointer is said when it changes
  // hands, not on each report, which move at the pointer's speed.
  private ownerMoved(
    sessionId: SessionId,
    before: Owners,
    watched: Watched | undefined,
  ): void {
    const after = ownersOf(watched);
    for (const lane of LANE_NAMES)
      if (after[lane] !== before[lane])
        this.deps.log(
          "info",
          `feed sid=${JSON.stringify(sessionId)} lane=${lane} pointer owner=${JSON.stringify(after[lane])} was=${JSON.stringify(before[lane])}`,
        );
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
  // renderer's feeds are handed it: each lane's subscribers, whether any draws
  // the bar now and the pointer over its surface, and whether the session's
  // pane is on a screen.
  viewers(): Viewers {
    const viewers: Record<SessionId, SessionViewers> = {};
    for (const [sessionId, watched] of this.watched)
      viewers[sessionId] = this.seen(sessionId, watched);
    return viewers;
  }

  private seen(sessionId: SessionId, watched: Watched): SessionViewers {
    const followers = [...watched.followers.keys()];
    // [LAW:one-source-of-truth] Each followed lane's facts, once per lane and
    // in the lanes' own order, so a replacement within a lane that changes
    // follower order still reads as the same view. Its pointer is its owner's.
    const lanes = LANE_NAMES.flatMap((lane) => {
      const subs = followers.filter((sub) => sub.lane === lane);
      if (subs.length === 0) return [];
      const viewers: LaneViewers = {
        subscribers: subs.length,
        drawing: subs.some((sub) => sub.drawing()),
        pointer: ownerOf(watched, lane)?.pointer ?? null,
      };
      return [[lane, viewers] as const];
    });
    return {
      lanes: Object.fromEntries(lanes),
      shown: followers.some(
        (sub) => sub.presenting?.() ?? this.shown(sessionId),
      ),
      joined: watched.frameDemand,
    };
  }

  // [LAW:single-enforcer] Who watches may have changed, or how: the renderer
  // is handed the viewers whole, once for every announcement made before its
  // slot comes, and not at all when they read as it was last handed them (a
  // poll that found every pane as it was). A delivery that failed is made
  // good by the next announcement.
  announce(): void {
    if (this.moving || this.delivery !== "current") return;
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

  // The frames a renderer's turn drew: each kept as its lane's last while the
  // lane has a subscriber, and sent to each of that lane's subscribers it
  // changed.
  took(
    renderer: RendererName,
    frames: readonly PushedFrame[],
    settled: (pushed: PushedFrame, delivered: boolean) => void,
  ): void {
    for (const pushed of frames) {
      const { session, lane, frame } = pushed;
      const watched = this.watched.get(session);
      if (watched === undefined) {
        settled(pushed, false);
        continue;
      }
      let encoded: EncodedAnswer;
      let drawn = frame.kind === "drawn";
      try {
        encoded = encodeFeed(lane, frame, this.deps.publishFrame, {
          renderer,
          session,
          displayed: frame.kind === "drawn" ? frame.displayed : undefined,
        });
      } catch (error) {
        // [LAW:no-silent-failure] A bad presentation is visible to the lane,
        // and leaves other lanes' and sessions' frames deliverable.
        const refused = renderFailed(error);
        encoded = failedAnswer(refused);
        if (watched.last.get(lane)?.json !== encoded.json)
          this.deps.log(
            "error",
            `frame sid=${JSON.stringify(session)} lane=${lane} error=${JSON.stringify(refused.error)}`,
          );
        drawn = false;
      }
      // [LAW:one-source-of-truth] A lane's last frame lives exactly as long as
      // the lane has a subscriber: one drawn before its last left is not kept.
      if (followsLane(watched, lane)) watched.last.set(lane, encoded);
      if (drawn) {
        this.publish(session, watched, lane, encoded, (ok) =>
          settled(pushed, ok),
        );
      } else {
        this.publish(session, watched, lane, encoded);
        settled(pushed, false);
      }
    }
  }

  private publish(
    session: SessionId,
    watched: Watched,
    lane: Lane,
    encoded: EncodedAnswer,
    settled?: Delivered,
  ): void {
    const subscribers = [...watched.followers.keys()].filter(
      (sub) => sub.lane === lane,
    );
    let remaining = subscribers.length;
    let complete = false;
    // [LAW:single-enforcer] Any confirmed subscriber presents the draw.
    // Failures finish it only when every subscriber in this publication has
    // declined.
    const done: Delivered | undefined =
      settled &&
      ((delivered) => {
        if (complete) return;
        if (delivered || --remaining === 0) {
          complete = true;
          settled(delivered);
        }
      });
    if (remaining === 0) settled?.(false);
    for (const sub of subscribers)
      this.send(session, watched, sub, encoded, done);
  }

  // Keep the published feed counters for the legacy pane-session wire query.
  notePaneLookup(session: SessionId | null): void {
    this.lookups++;
    if (session !== null) this.found++;
  }

  // The latest request the daemon holds of `sessionId`, or null when it
  // holds none.
  latest(sessionId: SessionId): Req | null {
    return this.requests.get(sessionId)?.req ?? null;
  }

  *knownRequests(): IterableIterator<Req> {
    for (const { req } of this.requests.values()) yield req;
  }

  // The frames each renderer drew are its own count, on its panel.
  getStats(): FeedStats {
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
    const follower = watched?.followers.get(sub);
    if (watched === undefined || follower === undefined) return;
    const owned = ownersOf(watched);
    watched.followers.delete(sub);
    this.ownerMoved(sessionId, owned, watched);
    const laneLeft = !followsLane(watched, sub.lane);
    if (laneLeft) watched.last.delete(sub.lane);
    if (watched.followers.size === 0) {
      this.watched.delete(sessionId);
      this.deps.log(
        "info",
        `feed sid=${JSON.stringify(sessionId)} unwatched pushed=${watched.pushed}`,
      );
    }
    if (laneLeft) this.deps.laneFollowed(sessionId, sub.lane, false);
    if (watched.followers.size === 0)
      this.deps.watchingChanged(sessionId, false);
    this.announce();
    const writes = [...follower.writes];
    follower.writes.clear();
    for (const write of writes) settleWrite(write, false);
  }

  private shown(sessionId: SessionId): boolean {
    const noted = this.requests.get(sessionId);
    return noted === undefined || this.deps.shown(noted.req);
  }

  // The offered frame's answer for this lane. An identical outstanding write
  // can carry the latest candidate, but only the writer can confirm it.
  private send(
    session: SessionId,
    watched: Watched,
    sub: Subscriber,
    answer: EncodedAnswer,
    done?: Delivered,
  ): void {
    const follower = watched.followers.get(sub);
    if (follower === undefined) {
      done?.(false);
      return;
    }
    let latest: PendingWrite | undefined;
    for (const write of follower.writes) latest = write;
    if (latest !== undefined && covers(latest.answer, answer)) {
      const superseded = latest.done;
      latest.done = done;
      superseded?.(false);
      return;
    }
    if (
      latest === undefined &&
      follower.confirmed !== null &&
      covers(follower.confirmed, answer)
    ) {
      done?.(sub.presenting?.() ?? sub.drawing());
      return;
    }
    const write: PendingWrite = { answer, done };
    follower.writes.add(write);
    this.pushed++;
    watched.pushed++;
    const finished: Delivered = (delivered) => {
      // [LAW:effects-at-boundaries] A refusal can detach the subscription
      // while the socket flushes its previous frame. That confirmed write
      // still carried the daemon's event, even after the view receipt ended.
      const displayed = delivered && (sub.presenting?.() ?? sub.drawing());
      if (displayed && answer.displayedEvents !== undefined)
        this.deps.acknowledgeDisplayed(answer.displayedEvents);
      if (!follower.writes.delete(write)) return;
      if (delivered) follower.confirmed = answer;
      settleWrite(write, displayed);
    };
    try {
      sub.frame(answer.json, finished);
    } catch (error) {
      this.deps.log(
        "error",
        `frame sid=${JSON.stringify(session)} lane=${sub.lane} send failed: ${inspect(error)}`,
      );
      finished(false);
    }
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
