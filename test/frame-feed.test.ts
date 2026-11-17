// The host's half of a session's frames (src/daemon/frame-feed.ts): who watches
// each session and what each subscriber was sent. The renderer decides when a
// frame is drawn (test/unit/feeds.test.ts) and pushes every one; here each
// subscriber is sent the frames that change what its lane shows, a lane its
// session switches off refuses or ends its subscribers, and every change to who
// watches is announced, for the renderer to read whole.

import { FrameFeeds, type Subscriber } from "../src/daemon/frame-feed";
import {
  REFRESH_TRIGGERS,
  type RefreshTrigger,
} from "../src/utils/refresh-ledger";
import type { Refusal } from "../src/daemon/foundations/protocol";
import type { Monotonic } from "../src/time";
import { perLane, type Lane, type LaneSwitches } from "../src/config/lanes";
import type { PushedFrame } from "../src/renderer-interface/interface";
import { barOf } from "./helpers/drawn-frame";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S = sessionIdOf("s");
const T = sessionIdOf("t");
const ALL_ON: LaneSwitches = perLane(() => true);

// The host's feeds over a monotonic clock the case moves, a pane each request
// names shown unless it is in `hidden`, and what they announce.
function harness() {
  const state = {
    monotonicMs: 0,
    hidden: new Set<string>(),
    // The sessions the viewers held at each announcement, as the renderer
    // reads them when the announcement's turn comes.
    announced: [] as string[][],
    opened: 0,
    stopped: 0,
  };
  const logged: string[] = [];
  // The daemon's refreshes so far, by trigger.
  const refreshed = Object.fromEntries(
    REFRESH_TRIGGERS.map((by) => [by, 0]),
  ) as Record<RefreshTrigger, number>;
  const feeds = new FrameFeeds<string>({
    clock: { monotonic: () => state.monotonicMs as Monotonic },
    shown: (req) => !state.hidden.has(req),
    watching: () => {
      state.opened++;
      return () => state.stopped++;
    },
    changed: () => void state.announced.push(Object.keys(feeds.viewers())),
    refreshes: () => ({ ...refreshed }),
    log: (_level, line) => logged.push(line),
  });
  return { feeds, state, logged, refreshed };
}

// A frame of S showing `text`, whose statusline lane shows `statusline`.
const pushed = (
  text: string,
  statusline = text,
  session = S,
): PushedFrame => ({
  session,
  bar: { ...barOf([{ text }]), nextChange: null },
  answers: {
    resp: JSON.stringify({ ok: true, output: text }),
    statusline: JSON.stringify({ ok: true, output: statusline }),
  },
});

// A subscriber of `lane`, recording the output of each answer it is sent and
// the refusal, if any, it ends with.
function subscriber(lane: Lane = "band", drawing = () => true) {
  const sent: string[] = [];
  const refusals: Refusal[] = [];
  const sub: Subscriber = {
    lane,
    frame: (_bar, json) =>
      sent.push((JSON.parse(json) as { output: string }).output),
    refused: (resp) => refusals.push(resp),
    drawing,
  };
  return { sub, sent, refusals };
}

describe("what a subscriber is sent", () => {
  test("each frame the renderer pushes, while it changes what the subscriber's lane shows", () => {
    const { feeds } = harness();
    const band = subscriber("band");
    feeds.subscribe(S, band.sub);
    feeds.frame(pushed("a"));
    feeds.frame(pushed("a"));
    feeds.frame(pushed("b"));
    expect(band.sent).toEqual(["a", "b"]);
  });

  test("while a lane draws the bar elsewhere, the statusline lane is sent the handoff line once, and the band every frame", () => {
    const { feeds } = harness();
    const band = subscriber("band");
    const line = subscriber("statusline");
    feeds.subscribe(S, band.sub);
    feeds.subscribe(S, line.sub);
    for (const text of ["a", "b", "c"])
      feeds.frame(pushed(text, "drawn in the band"));
    feeds.frame(pushed("d"));
    expect(band.sent).toEqual(["a", "b", "c", "d"]);
    expect(line.sent).toEqual(["drawn in the band", "d"]);
  });

  test("one joining later is sent the bar as it stands, at once", () => {
    const { feeds } = harness();
    feeds.subscribe(S, subscriber().sub);
    feeds.frame(pushed("a"));
    const late = subscriber("pane");
    feeds.subscribe(S, late.sub);
    expect(late.sent).toEqual(["a"]);
  });

  // [LAW:one-source-of-truth] What a subscriber was sent lives on its own
  // entry: a new subscriber has been sent nothing, so the renderer's next
  // frame reaches it though its bytes are the last frame's.
  test("a subscriber that leaves, and a new one subscribing before the next viewers turn, is sent the next frame, though it is byte-identical to the last", () => {
    const { feeds } = harness();
    const first = subscriber();
    const leave = feeds.subscribe(S, first.sub);
    feeds.frame(pushed("a"));
    leave();
    const second = subscriber();
    feeds.subscribe(S, second.sub);
    feeds.frame(pushed("a"));
    expect(first.sent).toEqual(["a"]);
    expect(second.sent).toEqual(["a"]);
  });

  test("a frame of a session nobody watches is counted and sent to no one", () => {
    const { feeds } = harness();
    const band = subscriber();
    feeds.subscribe(T, band.sub);
    feeds.frame(pushed("a"));
    expect(band.sent).toEqual([]);
    expect(feeds.getStats()).toMatchObject({ drawn: 1, pushed: 0 });
  });
});

describe("who watches, as the renderer reads it", () => {
  // [LAW:no-ambient-temporal-coupling] An idle mailbox takes the viewers turn
  // inside the announcement, so each one reads the change whole: the last
  // subscriber's leaving already shows no watch of its session.
  test("every subscribe and every leaving is announced, once the change is whole", () => {
    const { feeds, state } = harness();
    const leave = feeds.subscribe(S, subscriber().sub);
    expect(state.announced).toEqual([[S]]);
    leave();
    expect(state.announced).toEqual([[S], []]);
    leave();
    expect(state.announced).toEqual([[S], []]);
  });

  test("the viewers are each watched session's subscribers by lane, whether each draws it, and whether its pane is shown", () => {
    const { feeds, state } = harness();
    let drawing = false;
    feeds.subscribe(S, subscriber("band").sub);
    feeds.subscribe(S, subscriber("tmuxStatus", () => drawing).sub);
    feeds.note(S, "%1", 1);
    state.hidden.add("%1");
    expect(feeds.viewers()).toEqual({
      [S]: {
        lanes: perLane((lane) => ({
          subscribers: lane === "band" || lane === "tmuxStatus" ? 1 : 0,
          drawing: lane === "band",
        })),
        shown: false,
      },
    });
    drawing = true;
    expect([...feeds.following(S)]).toEqual(["band", "tmuxStatus"]);
  });

  test("a session with no request noted is shown, so its first frames move at the moving rate", () => {
    const { feeds } = harness();
    feeds.subscribe(S, subscriber().sub);
    expect(feeds.viewers()[S]!.shown).toBe(true);
  });

  test("what runs while any session is watched runs from the first watch to the last leaving", () => {
    const { feeds, state } = harness();
    const leaveS = feeds.subscribe(S, subscriber().sub);
    const leaveT = feeds.subscribe(T, subscriber().sub);
    expect(state.opened).toBe(1);
    leaveS();
    expect(state.stopped).toBe(0);
    leaveT();
    expect(state.stopped).toBe(1);
    expect(feeds.watched(S)).toBe(false);
  });
});

describe("a subscription's lane", () => {
  test("switched off in the session's settings is refused before any watch opens", () => {
    const { feeds, state, logged } = harness();
    feeds.declared({ [S]: { ...ALL_ON, pane: false } });
    const pane = subscriber("pane");
    feeds.subscribe(S, pane.sub);
    expect(pane.refusals).toEqual([
      expect.objectContaining({ ok: false, code: "SWITCHED_OFF" }),
    ]);
    expect(feeds.watched(S)).toBe(false);
    expect(state.announced).toEqual([]);
    expect(logged).toContain(`feed sid="s" refused lane=pane switched-off`);
  });

  test("of a session with no view yet is admitted, and the lanes its view declares decide", () => {
    const { feeds } = harness();
    const pane = subscriber("pane");
    feeds.subscribe(S, pane.sub);
    expect(pane.refusals).toEqual([]);
    feeds.declared({ [S]: { ...ALL_ON, pane: false } });
    expect(pane.refusals).toHaveLength(1);
  });

  test("switched off while it streams ends that subscriber, and leaves the other lanes' streaming", () => {
    const { feeds, state } = harness();
    const pane = subscriber("pane");
    const band = subscriber("band");
    feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, band.sub);
    feeds.declared({ [S]: ALL_ON });
    feeds.frame(pushed("a"));
    const changesBefore = state.announced.length;
    feeds.declared({ [S]: { ...ALL_ON, pane: false } });
    feeds.frame(pushed("b"));
    expect(pane.sent).toEqual(["a"]);
    expect(pane.refusals).toHaveLength(1);
    expect(band.sent).toEqual(["a", "b"]);
    expect(state.announced.length).toBe(changesBefore + 1);
  });

  test("a session the renderer declares no lanes of keeps its subscribers", () => {
    const { feeds } = harness();
    const band = subscriber();
    feeds.subscribe(S, band.sub);
    feeds.declared({ [S]: ALL_ON });
    feeds.declared({});
    feeds.frame(pushed("a"));
    expect(band.sent).toEqual(["a"]);
    expect(band.refusals).toEqual([]);
  });
});

describe("the requests the host keeps", () => {
  test("a request that arrived before the one held is not the session's latest, however late it is noted", () => {
    const { feeds } = harness();
    feeds.note(S, "newer", 2);
    feeds.note(S, "older", 1);
    expect(feeds.latest(S)).toBe("newer");
  });

  test("a watched session's request outlives the eviction of the least recently noted", () => {
    const { feeds } = harness();
    feeds.note(S, "watched", 0);
    feeds.subscribe(S, subscriber().sub);
    for (let i = 1; i <= 300; i++) feeds.note(sessionIdOf(`other${i}`), "x", i);
    expect(feeds.latest(S)).toBe("watched");
    expect(feeds.latest(sessionIdOf("other1"))).toBeNull();
    expect(feeds.watchedRequests()).toEqual([{ sessionId: S, req: "watched" }]);
  });

  test("newestWhere finds the session of the newest request it matches, and counts its lookups", () => {
    const { feeds } = harness();
    feeds.note(S, "%1", 1);
    feeds.note(T, "%1", 2);
    expect(feeds.newestWhere((req) => req === "%1")).toBe(T);
    expect(feeds.newestWhere((req) => req === "%9")).toBeNull();
    expect(feeds.getStats()).toMatchObject({ lookups: 2, found: 1 });
  });
});

test("a session's watch says what it was pushed and sent as it ends, beside the refreshes the daemon ran meanwhile", () => {
  const { feeds, state, logged, refreshed } = harness();
  const leave = feeds.subscribe(S, subscriber().sub);
  refreshed.period += 3;
  feeds.frame(pushed("a"));
  feeds.frame(pushed("a"));
  state.monotonicMs = 61_000;
  leave();
  expect(logged.at(-1)).toMatch(
    /^feed sid="s" unwatched for=61s pushed=2 sent=1 daemonRefreshed=first:0,period:3,change:0,supersede:0$/,
  );
});

test("the daemon's close ends every subscriber, and a subscribe after it is said and dropped", () => {
  const { feeds, state, logged } = harness();
  feeds.subscribe(S, subscriber().sub);
  feeds.close();
  expect(feeds.watched(S)).toBe(false);
  expect(state.stopped).toBe(1);
  const late = subscriber();
  feeds.subscribe(S, late.sub);
  feeds.frame(pushed("a"));
  expect(late.sent).toEqual([]);
  expect(logged.at(-1)).toBe(`feed sid="s" dropped lane=band daemon-closed`);
});
