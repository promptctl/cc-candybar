// The host's half of a session's frames (src/daemon/frame-feed.ts): it keeps
// each session's latest request, owns who subscribes on which lane, hands the
// renderer who watches each session, whole and coalesced, and sends each
// subscriber the frames the renderer drew, only where its lane's answer
// changed. When frames are drawn is the renderer's (test/unit/feeds.test.ts).
//
// [LAW:behavior-not-structure] Each case drives the feeds as the daemon does —
// requests noted, subscribers joining and leaving, a turn's frames and lanes
// taken — and reads what subscribers were sent and what the renderer was
// handed.

import {
  FrameFeeds,
  type FeedDeps,
  type Subscriber,
} from "../../src/daemon/frame-feed";
import type { Refusal } from "../../src/daemon/foundations/protocol";
import type { Lane, LaneSwitches } from "../../src/config/lanes";
import {
  renderFailedFrame,
  type Frame,
  type WireFrame,
} from "../../src/render/frame";
import type {
  Answers,
  PushedFrame,
  Viewers,
} from "../../src/renderer-interface/interface";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const S = sessionIdOf("s");
const T = sessionIdOf("t");

// A request as the daemon notes one: the pane it was drawn from, which the
// case says is on a screen or not.
interface Req {
  readonly pane: string;
}

// Feeds over a renderer the case answers: every delivery waits in `owed`
// until the case lets its slot come (`slot`), and reads the viewers then.
function rig() {
  const hidden = new Set<string>();
  const handed: Viewers[] = [];
  const owed: Array<{
    make: () => Viewers;
    end: (kind: string) => void;
    reject: (thrown: Error) => void;
  }> = [];
  const logged: string[] = [];
  const watching = { started: 0, stopped: 0 };
  const deps: FeedDeps<Req> = {
    shown: (req) => !hidden.has(req.pane),
    watching: () => {
      watching.started++;
      return () => void watching.stopped++;
    },
    deliver: (make) =>
      new Promise((resolve, reject) =>
        owed.push({ make, end: (kind) => resolve({ kind }), reject }),
      ),
    log: (level, line) => void logged.push(`${level} ${line}`),
  };
  const feeds = new FrameFeeds<Req>(deps);
  // The next delivery's slot comes: it reads the viewers and the turn ends
  // as `kind`.
  const slot = async (kind = "answered") => {
    const next = owed.shift();
    if (next === undefined) throw new Error("no delivery is owed");
    handed.push(next.make());
    next.end(kind);
    await Promise.resolve();
    await Promise.resolve();
  };
  // A delivery whose host path rejected after its slot read the viewers.
  const rejected = async () => {
    const next = owed.shift()!;
    handed.push(next.make());
    next.reject(new Error("the record broke"));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { feeds, hidden, handed, owed, logged, watching, slot, rejected };
}

// A subscriber on `lane`, recording the answers it was sent and its refusal.
function subscriber(lane: Lane, drawing = true) {
  const sent: string[] = [];
  const refusals: Refusal[] = [];
  const sub: Subscriber = {
    lane,
    frame: (json) => {
      sent.push(json);
    },
    refused: (resp) => void refusals.push(resp),
    drawing: () => drawing,
  };
  return { sub, sent, refusals };
}

const frame = (
  session = S,
  answers: Answers = { resp: "r", statusline: "s" },
): PushedFrame => ({
  session,
  answers,
});

describe("a session's requests", () => {
  test("the latest is the one received last, however late an earlier one's render finishes", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%2" }, 2);
    feeds.note(S, { pane: "%1" }, 1);
    expect(feeds.latest(S)).toEqual({ pane: "%2" });
    expect(feeds.latest(T)).toBeNull();
  });

  test("newestWhere finds the session of the newest request it matches, and counts its lookups", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%1" }, 1);
    feeds.note(T, { pane: "%1" }, 2);
    expect(feeds.newestWhere((req) => req.pane === "%1")).toBe(T);
    expect(feeds.newestWhere((req) => req.pane === "%9")).toBeNull();
    expect(feeds.getStats()).toMatchObject({ lookups: 2, found: 1 });
  });

  test("a watched session's request outlives the eviction of the least recently noted", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%0" }, 0);
    feeds.subscribe(S, subscriber("pane").sub);
    for (let i = 1; i <= 300; i++)
      feeds.note(sessionIdOf(`other${i}`), { pane: `%${i}` }, i);
    expect(feeds.latest(S)).toEqual({ pane: "%0" });
    expect(feeds.latest(sessionIdOf("other1"))).toBeNull();
    expect(feeds.watchedRequests()).toEqual([{ pane: "%0" }]);
  });
});

describe("the viewers the renderer is handed", () => {
  test("name each watched session's lanes, their subscribers and whether any draws, and whether its pane is on a screen", async () => {
    const r = rig();
    r.feeds.note(S, { pane: "%1" }, 1);
    r.hidden.add("%1");
    r.feeds.subscribe(S, subscriber("pane", false).sub);
    r.feeds.subscribe(S, subscriber("pane", true).sub);
    r.feeds.subscribe(T, subscriber("statusline", false).sub);
    expect(r.feeds.viewers()).toEqual({
      [S]: {
        lanes: { pane: { subscribers: 2, drawing: true } },
        shown: false,
        joined: 2,
      },
      // A session with no request yet counts as shown.
      [T]: {
        lanes: { statusline: { subscribers: 1, drawing: false } },
        shown: true,
        joined: 3,
      },
    });
  });

  test("announcements before the delivery's slot comes are one delivery, read as its slot comes", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(Object.keys(r.handed[0]!)).toEqual([S, T]);
  });

  test("viewers that read as last handed are not handed again; a start's handing counts", async () => {
    const r = rig();
    const { sub } = subscriber("pane");
    r.feeds.subscribe(S, sub);
    await r.slot();
    r.feeds.announce();
    expect(r.owed).toHaveLength(0);
    // A renderer's start was handed these viewers: the one owed now is not.
    r.feeds.handedIn({});
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
  });

  test("a delivery that failed is made good by the next announcement, though the viewers did not change", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot("threw");
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed).toHaveLength(2);
  });

  test("a delivery that rejected is said, and the next announcement delivers again", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.rejected();
    expect(r.logged).toContainEqual(
      expect.stringMatching(
        /^error feed viewers delivery rejected: .*the record broke/,
      ),
    );
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed).toHaveLength(2);
  });

  test("a request whose pane comes off a screen is announced; one that changes nothing the renderer is handed is not", async () => {
    const r = rig();
    r.feeds.note(S, { pane: "%1" }, 1);
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot();
    r.feeds.note(S, { pane: "%1" }, 2);
    expect(r.owed).toHaveLength(0);
    r.hidden.add("%2");
    r.feeds.note(S, { pane: "%2" }, 3);
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed.at(-1)![S]!.shown).toBe(false);
  });
});

describe("a subscriber", () => {
  test("is sent each frame whose answer for its lane changed, and nothing for one that changed only another lane's", () => {
    const r = rig();
    const pane = subscriber("pane");
    const line = subscriber("statusline");
    r.feeds.subscribe(S, pane.sub);
    r.feeds.subscribe(S, line.sub);
    r.feeds.took([frame(S, { resp: "r1", statusline: "s1" })]);
    r.feeds.took([frame(S, { resp: "r2", statusline: "s1" })]);
    expect(pane.sent).toEqual(["r1", "r2"]);
    expect(line.sent).toEqual(["s1"]);
    expect(r.feeds.getStats()).toMatchObject({
      feeds: 1,
      subscribers: 2,
      pushed: 3,
    });
  });

  test("joining later is handed the bar as it stands, at once", () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    r.feeds.took([frame(S, { resp: "r1", statusline: "s1" })]);
    const late = subscriber("pane");
    r.feeds.subscribe(S, late.sub);
    expect(late.sent).toEqual(["r1"]);
  });

  test("of a session unwatched since the renderer drew it is sent nothing", () => {
    const r = rig();
    const { sub, sent } = subscriber("pane");
    const leave = r.feeds.subscribe(S, sub);
    leave();
    r.feeds.took([frame(S)]);
    expect(sent).toEqual([]);
    expect(r.feeds.isWatched(S)).toBe(false);
  });

  test("the feeds watch from the first subscriber to the last leaving, which is logged with what it was sent", () => {
    const r = rig();
    const leaveS = r.feeds.subscribe(S, subscriber("pane").sub);
    const leaveT = r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.watching).toEqual({ started: 1, stopped: 0 });
    r.feeds.took([frame(S)]);
    leaveS();
    expect(r.watching.stopped).toBe(0);
    leaveT();
    expect(r.watching).toEqual({ started: 1, stopped: 1 });
    expect(r.logged).toContain(`info feed sid="${S}" unwatched pushed=1`);
  });
});

describe("a subscription's lane", () => {
  const OFF: LaneSwitches = {
    statusline: true,
    pane: false,
  };

  test("switched off in the session's settings is refused at once, and opens nothing", () => {
    const r = rig();
    r.feeds.switched({ [S]: OFF });
    const { sub, refusals } = subscriber("pane");
    r.feeds.subscribe(S, sub);
    expect(refusals).toEqual([
      expect.objectContaining({ ok: false, code: "SWITCHED_OFF" }),
    ]);
    expect(r.feeds.isWatched(S)).toBe(false);
    expect(r.owed).toHaveLength(0);
    expect(r.feeds.getStats().refused).toBe(1);
  });

  test("of a session with no view yet is admitted, and the switches its view opens with decide", () => {
    const r = rig();
    const pane = subscriber("pane");
    const line = subscriber("statusline");
    r.feeds.subscribe(S, pane.sub);
    r.feeds.subscribe(S, line.sub);
    r.feeds.switched({ [S]: OFF });
    expect(pane.refusals).toHaveLength(1);
    expect(line.refusals).toHaveLength(0);
    // The other lane streams on.
    r.feeds.took([frame(S)]);
    expect(pane.sent).toEqual([]);
    expect(line.sent).toEqual(["s"]);
  });
});

describe("the daemon's close", () => {
  test("ends every subscriber, hands the renderer nothing more, and drops a subscribe after it, saying so", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot();
    r.feeds.close();
    expect(r.feeds.isWatched(S)).toBe(false);
    expect(r.watching.stopped).toBe(1);
    expect(r.owed).toHaveLength(0);
    r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.feeds.isWatched(T)).toBe(false);
    expect(r.logged.at(-1)).toBe(
      `info feed sid="${T}" dropped lane=pane daemon-closed`,
    );
  });
});
