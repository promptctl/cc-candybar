// The host's side of a session's frames (src/daemon/frame-feed.ts): who
// subscribes to them, gated on the lanes the session's settings switch on,
// handed to the renderer whole as who follows each session (`viewers`), and
// each frame the renderer pushed sent to the subscribers whose lane it
// changed. The renderer decides when a frame is drawn (test/renderer-feeds.
// test.ts); here a case hands frames in as a turn's output would.
//
// [LAW:behavior-not-structure] A case reads what each subscriber received,
// what the renderer was told, and what was said.

import {
  REFRESH_TRIGGERS,
  type RefreshTrigger,
} from "../src/utils/refresh-ledger";
import { FrameFeeds, type Subscriber } from "../src/daemon/frame-feed";
import type { Refusal, Response } from "../src/daemon/foundations/protocol";
import type { PushedFrame } from "../src/renderer-interface/interface";
import type { LogLine } from "../src/renderer-interface/adapter";
import {
  perLane,
  type Lane,
  type LaneSwitches,
  type Viewers,
} from "../src/config/lanes";
import { plainOf, renderFailedFrame, type Frame } from "../src/render/frame";
import { barOf } from "./helpers/drawn-frame";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";

const S = sessionIdOf("s");
const B = sessionIdOf("b");
const BEFORE_CLEAR = sessionIdOf("before-clear");
const ELSEWHERE = sessionIdOf("elsewhere");
const AFTER_CLEAR = sessionIdOf("after-clear");

const ALL_ON: LaneSwitches = perLane(() => true);

// The host's book over a renderer the case plays. `state.lanes` is what the
// renderer last declared of the session's lanes (null while it has no view),
// and a request whose text starts "hidden" is from a pane on no screen.
// `told` holds each viewers the renderer was handed, in order; `opened` and
// `stopped` count the watch's starts and stops, and `refreshes` is the
// daemon's ledger's totals.
function harness() {
  const state = {
    lanes: ALL_ON as LaneSwitches | null,
    opened: 0,
    stopped: 0,
    refreshes: Object.fromEntries(
      REFRESH_TRIGGERS.map((by) => [by, 0]),
    ) as Record<RefreshTrigger, number>,
  };
  const told: Array<Readonly<Record<SessionId, Viewers>>> = [];
  const log: string[] = [];
  const feeds = new FrameFeeds<string>({
    lanes: () => state.lanes,
    shown: (req) => !req.startsWith("hidden"),
    viewersChanged: (viewers) => told.push(viewers),
    watching: () => {
      state.opened++;
      return () => void state.stopped++;
    },
    refreshes: () => ({ ...state.refreshes }),
    log: (_level, line) => log.push(line),
  });
  let order = 0;
  const note = (sessionId: SessionId, req: string, at = ++order): void =>
    feeds.note(sessionId, req, at);
  return { feeds, state, told, log, note };
}

// A frame of `session` drawing `output`, whose statusline shows `handoff` in
// the bar's place, if any, as the renderer pushes one.
function pushed(
  session: SessionId,
  output: string,
  opts: {
    readonly handoff?: string;
    readonly lanes?: LaneSwitches | null;
    readonly failure?: LogLine;
  } = {},
): PushedFrame {
  return {
    session,
    frame: {
      bar: barOf([{ text: output }]),
      resp: { ok: true, output },
      statusline: { ok: true, output: opts.handoff ?? output },
      evaluated: 0,
      cellBreaks: 0,
      lanes: opts.lanes === undefined ? ALL_ON : opts.lanes,
      failure: opts.failure ?? null,
    },
  };
}

// A subscriber of `lane`, drawing while `drawing` says, whose frames' answers
// go to `got` and whose refusal, if any, to `refused`.
function subscriber(
  lane: Lane = "band",
  drawing: () => boolean = () => true,
): Subscriber & {
  readonly got: string[];
  readonly bars: string[];
  readonly refusals: Refusal[];
} {
  const got: string[] = [];
  const bars: string[] = [];
  const refusals: Refusal[] = [];
  return {
    lane,
    frame: (bar: Frame, json: string) => {
      bars.push(plainOf(bar.rows[0]!.runs));
      const resp = JSON.parse(json) as Response;
      got.push(resp.ok && "output" in resp ? resp.output : json);
    },
    refused: (resp) => refusals.push(resp),
    drawing,
    got,
    bars,
    refusals,
  };
}

// What a session's viewers say of `lane`.
const laneOf = (viewers: Viewers | undefined, lane: Lane) =>
  viewers?.lanes[lane];

describe("who follows a session", () => {
  test("is told the renderer whole as each subscriber comes and goes, and only when it moved", () => {
    const { feeds, told, note } = harness();
    note(S, "bar");
    const leaveBand = feeds.subscribe(S, subscriber("band"));
    const leavePane = feeds.subscribe(S, subscriber("pane"));
    expect(told).toHaveLength(2);
    expect(laneOf(told[1]![S], "band")).toEqual({
      subscribers: 1,
      drawing: true,
    });
    expect(laneOf(told[1]![S], "pane")).toEqual({
      subscribers: 1,
      drawing: true,
    });
    expect(told[1]![S]!.shown).toBe(true);
    // Nothing moved: nothing told.
    feeds.check();
    expect(told).toHaveLength(2);
    leavePane();
    leaveBand();
    expect(told.at(-1)).toEqual({});
    expect(told).toHaveLength(4);
  });

  test("a lane follows a session only while one of its subscribers draws it, and the renderer is told as that moves", () => {
    const { feeds, told, note } = harness();
    note(S, "bar");
    let drawing = false;
    feeds.subscribe(
      S,
      subscriber("tmuxStatus", () => drawing),
    );
    expect(feeds.following(S).has("tmuxStatus")).toBe(false);
    drawing = true;
    expect(feeds.following(S).has("tmuxStatus")).toBe(true);
    feeds.check();
    expect(laneOf(told.at(-1)![S], "tmuxStatus")).toEqual({
      subscribers: 1,
      drawing: true,
    });
  });

  test("a request that moves the session's pane off a screen tells the renderer the bar is unseen", () => {
    const { feeds, told, note } = harness();
    note(S, "bar");
    feeds.subscribe(S, subscriber());
    note(S, "hidden bar");
    expect(told.map((viewers) => viewers[S]!.shown)).toEqual([true, false]);
  });

  test("the feeds watch from the first feed opening to the last closing", () => {
    const { feeds, state } = harness();
    const leaveA = feeds.subscribe(S, subscriber());
    const leaveA2 = feeds.subscribe(S, subscriber());
    const leaveB = feeds.subscribe(B, subscriber());
    expect([state.opened, state.stopped]).toEqual([1, 0]);
    leaveA();
    leaveA2();
    expect([state.opened, state.stopped]).toEqual([1, 0]);
    leaveB();
    expect([state.opened, state.stopped]).toEqual([1, 1]);
    feeds.subscribe(S, subscriber())();
    expect([state.opened, state.stopped]).toEqual([2, 2]);
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  });

  test("the last subscriber leaving says what the host saw of the feed", () => {
    const { feeds, state, log, note } = harness();
    note(S, "bar");
    const leave = feeds.subscribe(S, subscriber());
    note(S, "bar again");
    feeds.framed([pushed(S, "one"), pushed(S, "two")]);
    state.refreshes.change += 2;
    leave();
    expect(log.at(-1)).toMatch(
      /^feed sid="s" left noted=1 pushed=2 daemonRefreshed=.*change:2/,
    );
  });
});

describe("a pushed frame", () => {
  test("goes to each subscriber with its lane's answer, and an answer it left as it was is not sent again", () => {
    const { feeds } = harness();
    const band = subscriber("band");
    const statusline = subscriber("statusline");
    feeds.subscribe(S, band);
    feeds.subscribe(S, statusline);
    const handoff = "the bar is drawn in the band";
    feeds.framed([
      pushed(S, "bar#1", { handoff }),
      pushed(S, "bar#2", { handoff }),
    ]);
    feeds.framed([pushed(S, "bar#3")]);
    expect(band.got).toEqual(["bar#1", "bar#2", "bar#3"]);
    expect(statusline.got).toEqual([handoff, "bar#3"]);
    // A lane drawing the statusline is still handed the bar.
    expect(statusline.bars).toEqual(["bar#1", "bar#3"]);
  });

  test("is handed to a subscriber joining later as it stands, before any new frame", () => {
    const { feeds } = harness();
    feeds.subscribe(S, subscriber());
    feeds.framed([pushed(S, "bar#1")]);
    const late = subscriber("pane");
    feeds.subscribe(S, late);
    expect(late.got).toEqual(["bar#1"]);
  });

  test("of a session nobody follows reaches no one, and is not counted", () => {
    const { feeds } = harness();
    const sub = subscriber();
    feeds.subscribe(S, sub);
    feeds.framed([pushed(B, "theirs")]);
    expect(sub.got).toEqual([]);
    expect(feeds.getStats().pushed).toBe(0);
  });

  // [LAW:no-silent-failure] The renderer pushes a failing frame once while it
  // keeps failing the same way, so its line is said once.
  test("that failed says its line at its level as it goes out, and reaches its lane as the failure's Frame", () => {
    const { feeds, log } = harness();
    const sub = subscriber();
    feeds.subscribe(S, sub);
    const failed = pushed(S, "x", {
      failure: { level: "error", line: "frame s threw" },
    });
    feeds.framed([
      {
        ...failed,
        frame: { ...failed.frame, bar: renderFailedFrame("the view broke") },
      },
    ]);
    expect(log).toContain("frame s threw");
    expect(sub.bars).toEqual([
      plainOf(renderFailedFrame("the view broke").rows[0]!.runs),
    ]);
  });
});

// [LAW:single-enforcer] The one gate on the lanes.
describe("a subscription's lane", () => {
  test("switched off in the session's settings is refused before any feed opens", () => {
    const { feeds, state, told, log, note } = harness();
    state.lanes = { ...ALL_ON, band: false };
    note(S, "bar");
    const sub = subscriber("band");
    feeds.subscribe(S, sub);
    expect(sub.refusals).toEqual([
      expect.objectContaining({
        ok: false,
        code: "SWITCHED_OFF",
        error:
          "🧪 band (A) is off — turn it on in the settings menu's ⚙ config › 🧪 toggles, or set globals.experimentalBand: true",
      }),
    ]);
    expect(state.opened).toBe(0);
    expect(told).toEqual([]);
    expect(feeds.getStats()).toMatchObject({
      feeds: 0,
      subscribers: 0,
      refused: 1,
    });
    expect(log).toContain('feed sid="s" refused lane=band switched-off');
  });

  test("of a session with no view yet is admitted, and its first frame decides", () => {
    const { feeds, state, log } = harness();
    state.lanes = null;
    const sub = subscriber("band");
    feeds.subscribe(S, sub);
    expect(log).toContain(
      'feed sid="s" subscribed lane=band subscribers=1 view=N',
    );
    feeds.framed([pushed(S, "bar", { lanes: { ...ALL_ON, band: false } })]);
    expect(sub.refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    expect(sub.got).toEqual([]);
    expect(feeds.feedOpen(S)).toBe(false);
  });

  test("switched off while it streams ends that subscriber and leaves the other lanes' running", () => {
    const { feeds, told } = harness();
    const band = subscriber("band");
    const pane = subscriber("pane");
    feeds.subscribe(S, band);
    feeds.subscribe(S, pane);
    feeds.framed([pushed(S, "bar#1")]);
    feeds.framed([pushed(S, "bar#2", { lanes: { ...ALL_ON, band: false } })]);
    feeds.framed([pushed(S, "bar#3", { lanes: { ...ALL_ON, band: false } })]);
    expect(band.got).toEqual(["bar#1"]);
    expect(band.refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    expect(pane.got).toEqual(["bar#1", "bar#2", "bar#3"]);
    expect(laneOf(told.at(-1)![S], "band")?.subscribers).toBe(0);
    expect(feeds.getStats()).toMatchObject({
      feeds: 1,
      subscribers: 1,
      refused: 1,
    });
  });

  test("turned on in the session's settings is honoured at once", () => {
    const { feeds, state } = harness();
    state.lanes = { ...ALL_ON, band: false };
    const refused = subscriber("band");
    feeds.subscribe(S, refused);
    state.lanes = ALL_ON;
    const admitted = subscriber("band");
    feeds.subscribe(S, admitted);
    expect([refused.refusals.length, admitted.refusals.length]).toEqual([1, 0]);
    expect(feeds.feedOpen(S)).toBe(true);
  });
});

describe("the sessions' latest requests", () => {
  test("a request that arrived before the one held is not the session's latest", () => {
    const { feeds, note } = harness();
    note(S, "newer", 2);
    note(S, "older", 1);
    expect(feeds.latest(S)).toBe("newer");
  });

  test("a watched session's request outlives the eviction of the least recently noted", () => {
    const { feeds, note } = harness();
    note(S, "bar");
    note(B, "theirs");
    feeds.subscribe(S, subscriber());
    for (let i = 0; i < 300; i++) note(sessionIdOf(`other-${i}`), "x");
    expect(feeds.latest(S)).toBe("bar");
    expect(feeds.latest(B)).toBeNull();
    expect(feeds.watched()).toEqual([{ sessionId: S, req: "bar" }]);
  });

  // A tmux bar pane knows its pane, not the session in it, which a /clear
  // replaces: the session is that of the newest request from the pane, by the
  // order the daemon received them.
  test("newestWhere finds the session of the newest request it matches, and counts its lookups", () => {
    const { feeds, note } = harness();
    const fromPane = (req: string): boolean => req.startsWith("%3:");
    expect(feeds.newestWhere(fromPane)).toBeNull();
    note(BEFORE_CLEAR, "%3:a");
    note(ELSEWHERE, "%4:a");
    note(AFTER_CLEAR, "%3:b");
    expect(feeds.newestWhere(fromPane)).toBe("after-clear");
    // A slow render of the old session arriving late is not newer.
    note(BEFORE_CLEAR, "%3:late", 1);
    expect(feeds.newestWhere(fromPane)).toBe("after-clear");
    note(BEFORE_CLEAR, "%3:c");
    expect(feeds.newestWhere(fromPane)).toBe("before-clear");
    expect(feeds.getStats()).toMatchObject({ lookups: 4, found: 3 });
  });
});

describe("the daemon's close", () => {
  test("ends every feed, and a subscribe after it opens nothing and says so", () => {
    const { feeds, state, told, log } = harness();
    feeds.subscribe(S, subscriber());
    feeds.close();
    expect(state.stopped).toBe(1);
    expect(told.at(-1)).toEqual({});
    feeds.subscribe(S, subscriber("pane"));
    expect(feeds.feedOpen(S)).toBe(false);
    expect(log.at(-1)).toBe('feed sid="s" dropped lane=pane daemon-closed');
  });
});
