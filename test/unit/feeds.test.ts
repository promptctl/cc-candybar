// The renderer's feeds (src/renderer/feeds.ts): a feed is open while the
// host's viewers name its session, and decides on the renderer's ticks when
// each frame is drawn — at once on opening, then when the bar next changes,
// no closer than its spacing (the moving period on a screen, the still period
// off one) and no further than the still period — and a wake brings the next
// frame forward to the spacing. What a lane is sent of late is counted where
// its answer changed.
//
// [LAW:behavior-not-structure] Each case drives the feeds as the renderer's
// turns do: viewers, wakes and the frames due at a turn's readings, over a
// draw the case scripts.

import {
  Feeds,
  noteSent,
  WAKE_CAUSES,
  type FeedDraw,
  type FeedPeriods,
} from "../../src/renderer/feeds";
import { HostFeedHistory } from "../../src/daemon/host-feed-history";
import { recordingInputProblem } from "../../src/daemon/recording-privacy";
import { UNFOLLOWED, type Lane, type LaneFeeds } from "../../src/config/lanes";
import type { Frame } from "../../src/render/frame";
import type { Pointer } from "../../src/click/gesture";
import type {
  EffectId,
  EventInput,
  PushedFrame,
  SessionViewers,
  Viewers,
} from "../../src/renderer-interface/interface";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Instant, Tick } from "../../src/utils/instant";

const S = "s" as SessionId;
const T = "t" as SessionId;
const PERIODS: FeedPeriods = { moving: 100, still: 1000 };
const tick = (s: number) => s as Tick;

const draw = (text: string, nextChange = Infinity): Frame => ({
  depth: "none",
  rows: [{ kind: "diagnostic", runs: [{ text }] }],
  nextChange,
  motion: "still",
  pending: [],
});

// A session watched on `lanes`, each with one subscriber drawing it, in the
// lane's first turn unless `turns` says otherwise.
const watched = (
  shown = true,
  lanes: readonly Lane[] = ["pane"],
  pointers: Partial<Record<Lane, Pointer>> = {},
  turns: Partial<Record<Lane, number>> = {},
): SessionViewers => ({
  lanes: Object.fromEntries(
    lanes.map((lane) => [
      lane,
      {
        subscribers: 1,
        drawing: true,
        pointer: pointers[lane] ?? null,
        turn: turns[lane] ?? 1,
      },
    ]),
  ),
  shown,
  joined: 1,
});

// Feeds over a draw the case scripts: the bar's next change, on the wall,
// from the instant it is drawn for (Infinity: a still bar), its text, and
// whether the session has a view at all. The wall runs `skew` seconds ahead
// of the ticks.
function rig() {
  let receipts = 0;
  const prepare = (): never => {
    throw new Error("this scheduling fixture has no delivery to prepare");
  };
  const script = {
    changeIn: Infinity,
    bar: "r",
    // A surface whose bar reads otherwise than `bar`.
    bars: {} as Partial<Record<Lane, string>>,
    view: true,
    failure: null as FeedDraw["failure"],
    skew: 1000,
    // A session whose draw throws past the draw's own catch.
    throwsFor: null as { session: SessionId; cause: Error } | null,
  };
  const draws: Array<{
    session: SessionId;
    surface: Lane;
    fps: number;
    at: number;
    tick: number;
    feeds: LaneFeeds;
    pointer: Pointer | null;
  }> = [];
  const pins: string[] = [];
  const logged: string[] = [];
  const feeds = new Feeds({
    draw: (session, lanes, fps, { at, tick }, laneFeeds) => {
      for (const [surface, { pointer }] of lanes)
        draws.push({
          session,
          surface,
          fps,
          at,
          tick,
          feeds: laneFeeds,
          pointer,
        });
      if (session === script.throwsFor?.session) throw script.throwsFor.cause;
      if (!script.view) return null;
      return lanes.map(
        ([surface, { turn }]) =>
          [
            surface,
            {
              turn,
              frame:
                script.failure === null
                  ? {
                      kind: "drawn",
                      receipt: ++receipts as EffectId,
                      bar: draw(
                        script.bars[surface] ?? script.bar,
                        at + script.changeIn,
                      ),
                    }
                  : { kind: "failed", message: script.failure.line },
              evaluated: 3,
              cellBreaks: 1,
              failure: script.failure,
            },
          ] as const,
      );
    },
    pin: (session) => {
      if (session === script.throwsFor?.session) throw script.throwsFor.cause;
      pins.push(`pin ${session}`);
      return () => void pins.push(`unpin ${session}`);
    },
    log: (level, line) => void logged.push(`${level} ${line}`),
    periods: PERIODS,
  });
  const readings = (t: number) => ({
    at: (t + script.skew) as Instant,
    tick: tick(t),
  });
  // A turn at tick `t`: the frames due drawn.
  const turn = (t: number, frames: PushedFrame[] = []) => {
    feeds.drawDue(readings(t), frames, prepare);
    return frames;
  };
  // Each turn the renderer is woken for, from `from` until `until`: the
  // ticks a frame was drawn at.
  const run = (from: number, until: number): number[] => {
    const at: number[] = [];
    let next = feeds.next();
    while (next !== null && next <= until) {
      const t = Math.max(next, from);
      for (const _ of turn(t)) at.push(t);
      next = feeds.next();
      if (next !== null && next <= t) throw new Error("a feed due in the past");
    }
    return at;
  };
  return { feeds, script, draws, pins, logged, turn, run, readings, prepare };
}

const view =
  (viewers: Viewers, at = 0) =>
  (f: Feeds) =>
    f.view(viewers, tick(at));

describe("a feed's life", () => {
  test("opens for a session the viewers name, pinning its view, and closes for one they no longer name, summing up what it drew", () => {
    const r = rig();
    view({ [S]: watched() })(r.feeds);
    expect(r.pins).toEqual([`pin ${S}`]);
    expect(r.feeds.next()).toBe(0);
    r.turn(0);
    r.feeds.view({}, tick(2));
    expect(r.pins).toEqual([`pin ${S}`, `unpin ${S}`]);
    expect(r.feeds.next()).toBeNull();
    expect(r.logged.at(-1)).toMatch(
      /^info feed sid="s" closed lanes=pane:1 for=2s drawn=1 .*latenessHistogram=/,
    );
  });

  test("a feed whose pin throws keeps no other feed from opening, and its throw is the view's", () => {
    const r = rig();
    r.script.throwsFor = { session: S, cause: new Error("s broke") };
    expect(() => view({ [S]: watched(), [T]: watched() })(r.feeds)).toThrow(
      "s broke",
    );
    expect(r.pins).toEqual([`pin ${T}`]);
  });

  test("a feed whose draw throws keeps no other feed's frame from going out, and its throw is the turn's", () => {
    const r = rig();
    view({ [S]: watched(), [T]: watched() })(r.feeds);
    r.script.throwsFor = { session: S, cause: new Error("s broke") };
    const frames: PushedFrame[] = [];
    expect(() => r.feeds.drawDue(r.readings(0), frames, r.prepare)).toThrow(
      "s broke",
    );
    expect(frames.map((f) => f.session)).toEqual([T]);
    // The feed that threw is due again a still period on, never at once.
    expect(r.feeds.next()).toBe(PERIODS.still / 1000);
  });

  test("frequent wakes respect a thrown draw's retry while the healthy feed keeps drawing", () => {
    const r = rig();
    view({ [S]: watched(), [T]: watched() })(r.feeds);
    expect(r.turn(0).map(({ session }) => session)).toEqual([S, T]);
    const failure = new Error("draw escaped its presentation");
    r.script.throwsFor = { session: S, cause: failure };

    const thrown: unknown[] = [];
    const wakeAndDraw = (at: number) => {
      for (const cause of WAKE_CAUSES) r.feeds.wake(S, cause, tick(at));
      r.feeds.wake(T, "data", tick(at));
      const frames: PushedFrame[] = [];
      try {
        r.turn(at, frames);
      } catch (cause) {
        thrown.push(cause);
      }
      return frames;
    };

    const { moving, still } = PERIODS;
    const retry = (moving + still) / 1000;
    const recovery = (moving + 2 * still) / 1000;
    expect(wakeAndDraw(moving / 1000).map(({ session }) => session)).toEqual([
      T,
    ]);

    const interval = moving / 2;
    const viewersChangedAt = (moving + interval) / 1000;
    view({ [S]: watched(false), [T]: watched() }, viewersChangedAt)(r.feeds);
    view({ [S]: watched(), [T]: watched() }, viewersChangedAt)(r.feeds);
    view(
      { [S]: watched(true, ["pane", "statusline"]), [T]: watched() },
      viewersChangedAt,
    )(r.feeds);
    const frames: PushedFrame[] = [];
    for (let ms = moving + interval; ms < recovery * 1000; ms += interval)
      frames.push(...wakeAndDraw(ms / 1000));
    expect(
      r.draws
        .filter(({ session, surface }) => session === S && surface === "pane")
        .map(({ tick }) => tick),
    ).toEqual([0, moving / 1000, retry]);
    expect(thrown).toHaveLength(2);
    for (const cause of thrown) expect(cause).toBe(failure);
    expect(frames.length).toBeGreaterThan(still / moving);
    expect(
      frames.every(
        ({ session, frame }) => session === T && frame.kind === "drawn",
      ),
    ).toBe(true);

    r.script.throwsFor = null;
    r.script.bar = "recovered";
    expect(wakeAndDraw(recovery)).toContainEqual(
      expect.objectContaining({
        session: S,
        frame: expect.objectContaining({
          kind: "drawn",
          bar: draw("recovered"),
        }),
      }),
    );
    r.script.bar = "still responsive";
    expect(wakeAndDraw(recovery + moving / 1000)).toContainEqual(
      expect.objectContaining({
        session: S,
        frame: expect.objectContaining({
          kind: "drawn",
          bar: draw("still responsive"),
        }),
      }),
    );
  });

  test("each lane that follows the session is drawn its own frame, with its own pointer", () => {
    const r = rig();
    const over: Pointer = { gestures: ["left"], hover: "menu" };
    view({ [S]: watched(true, ["pane", "statusline"], { pane: over }) })(
      r.feeds,
    );
    r.script.bars = { statusline: "s" };
    const frames = r.turn(0);
    expect(frames).toEqual([
      {
        session: S,
        lane: "statusline",
        turn: 1,
        frame: { kind: "drawn", receipt: 1, bar: draw("s") },
      },
      {
        session: S,
        lane: "pane",
        turn: 1,
        frame: { kind: "drawn", receipt: 2, bar: draw("r") },
      },
    ]);
    expect(r.draws.map(({ surface, pointer }) => [surface, pointer])).toEqual([
      ["statusline", null],
      ["pane", over],
    ]);
    expect(r.feeds.drawn()).toBe(1);
  });

  test("each lane's frame carries the turn of the lane it was drawn under", () => {
    const r = rig();
    view({ [S]: watched(true, ["pane", "window"], {}, { window: 4 }) })(
      r.feeds,
    );
    expect(r.turn(0).map(({ lane, turn }) => [lane, turn])).toEqual([
      ["pane", 1],
      ["window", 4],
    ]);
    r.feeds.view(
      { [S]: watched(true, ["pane", "window"], {}, { pane: 3, window: 4 }) },
      tick(0.5),
    );
    expect(r.turn(1).map(({ lane, turn }) => [lane, turn])).toEqual([
      ["pane", 3],
      ["window", 4],
    ]);
  });

  test("only the closing summary writes the lateness histogram; a running summary comes once a minute", () => {
    const r = rig();
    view({ [S]: watched() })(r.feeds);
    r.run(0, 61);
    const running = r.logged.filter((l) => l.includes(" running "));
    expect(running).toHaveLength(1);
    expect(running[0]).not.toContain("latenessHistogram=");
    r.feeds.closeAll(tick(62));
    expect(r.logged.at(-1)).toContain("latenessHistogram=");
  });
});

describe("when a frame falls due", () => {
  test("a still bar is drawn a still period apart", () => {
    const r = rig();
    view({ [S]: watched() })(r.feeds);
    expect(r.run(0, 3)).toEqual([0, 1, 2, 3]);
  });

  test("a bar that turns every 300 ms is drawn once a turn, not at the moving rate", () => {
    const r = rig();
    r.script.changeIn = 0.3;
    view({ [S]: watched() })(r.feeds);
    expect(r.run(0, 0.95).map((t) => +t.toFixed(3))).toEqual([
      0, 0.3, 0.6, 0.9,
    ]);
  });

  test("a continuously moving bar is drawn a moving period apart, with the moving rate as its ceiling", () => {
    const r = rig();
    r.script.changeIn = 0.001;
    view({ [S]: watched() })(r.feeds);
    expect(r.run(0, 0.35).map((t) => +t.toFixed(3))).toEqual([
      0, 0.1, 0.2, 0.3,
    ]);
    expect(r.draws[0]!.fps).toBe(10);
  });

  test("a moving bar on no screen is drawn a still period apart, with the still rate as its ceiling, and counted so", () => {
    const r = rig();
    r.script.changeIn = 0.001;
    view({ [S]: watched(false) })(r.feeds);
    expect(r.run(0, 2.5)).toEqual([0, 1, 2]);
    expect(r.draws[0]!.fps).toBe(1);
    r.feeds.closeAll(tick(3));
    expect(r.logged.at(-1)).toMatch(/ moving=0 unseen=3 /);
  });

  test("a frame due for a change is drawn for that change's instant when the turn's wall reading falls just short of it", () => {
    const r = rig();
    r.script.changeIn = 0.3;
    view({ [S]: watched() })(r.feeds);
    r.turn(0);
    // The turn comes on time, but the wall reads a millisecond short.
    r.script.skew -= 0.001;
    r.turn(0.3);
    expect(r.draws[1]!.at).toBe(1000.3);
    // More than the timer's resolution short: drawn at the wall's reading.
    r.script.skew -= 0.01;
    r.turn(0.6);
    expect(r.draws[2]!.at).toBeCloseTo(1000.589, 6);
  });

  test("a wall clock stepped between two frames moves no schedule", () => {
    const r = rig();
    r.script.changeIn = 0.3;
    view({ [S]: watched() })(r.feeds);
    r.turn(0);
    r.script.skew -= 3600;
    expect(r.feeds.next()).toBeCloseTo(0.3, 9);
    r.turn(0.3);
    expect(r.feeds.next()).toBeCloseTo(0.6, 9);
  });

  test("a turn after a frame fell due draws it then, and counts it late from when it fell due", () => {
    const r = rig();
    view({ [S]: watched() })(r.feeds);
    r.turn(0);
    expect(r.turn(0.5)).toEqual([]);
    expect(r.turn(1.25)).toHaveLength(1);
    expect(r.feeds.next()).toBe(2.25);
    r.feeds.closeAll(tick(3));
    expect(r.logged.at(-1)).toMatch(/ lateness=n:2,p50:0\.00,.*max:250\.00/);
  });
});

describe("a wake", () => {
  test("brings the next frame forward to now, once the spacing from the last allows", () => {
    const r = rig();
    view({ [S]: watched() })(r.feeds);
    r.turn(0);
    r.feeds.wake(S, "data", tick(0.05));
    expect(r.feeds.next()).toBe(0.1);
    r.turn(0.1);
    r.feeds.wake(S, "data", tick(0.5));
    expect(r.feeds.next()).toBe(0.5);
  });

  test("a click that changed a visible control is due immediately; an unseen surface keeps its budget", () => {
    for (const shown of [true, false]) {
      const r = rig();
      view({ [S]: watched(shown) })(r.feeds);
      r.turn(0);
      r.feeds.wake(S, "interaction", tick(0.001));
      expect(r.feeds.next()).toBe(shown ? 0.001 : 1);
    }
  });

  test("an observed session change advances a visible feed once at the commit tick", () => {
    const r = rig();
    view({ [S]: watched(true) })(r.feeds);
    r.turn(0);
    expect(r.feeds.observe(() => {})).toEqual({});
    const change = () => r.feeds.wake(S, "state", tick(0.001));
    expect(r.feeds.observe(change)).toEqual({ wake: 0.001 });
    expect(r.feeds.observe(change)).toEqual({});
    expect(r.feeds.next()).toBe(0.001);
  });

  test("background wakes at 1 ms intervals draw a shown feed at most once a moving period, and an unseen one once a still period", () => {
    for (const [shown, spacing] of [
      [true, 0.1],
      [false, 1],
    ] as const) {
      const r = rig();
      view({ [S]: watched(shown) })(r.feeds);
      const drawn: number[] = [];
      for (let ms = 0; ms <= 2000; ms++) {
        const t = ms / 1000;
        r.feeds.wake(
          S,
          (["data", "state", "reload"] as const)[ms % 3]!,
          tick(t),
        );
        if ((r.feeds.next() ?? Infinity) <= t)
          for (const _ of r.turn(t)) drawn.push(t);
      }
      for (let i = 1; i < drawn.length; i++)
        expect(drawn[i]! - drawn[i - 1]!).toBeGreaterThanOrEqual(
          spacing - 1e-9,
        );
      r.feeds.closeAll(tick(2));
      expect(r.logged.at(-1)).toMatch(
        / woke=data:\d+,state:\d+,reload:\d+,visibility:0,viewers:0,interaction:0 coalesced=[1-9]/,
      );
    }
  });

  test("of a session no feed is open for does nothing", () => {
    const r = rig();
    r.feeds.wake(S, "data", tick(0));
    expect(r.feeds.next()).toBeNull();
  });

  test("a pane that comes into view wakes its feed, which draws at the moving rate from then", () => {
    const r = rig();
    r.script.changeIn = 0.001;
    view({ [S]: watched(false) })(r.feeds);
    r.turn(0);
    expect(r.feeds.next()).toBe(1);
    r.feeds.view({ [S]: watched(true) }, tick(0.4));
    expect(r.feeds.next()).toBe(0.4);
    r.turn(0.4);
    expect(r.feeds.next()).toBeCloseTo(0.5, 9);
  });

  test("viewers that changed only in who follows wake the feed for its viewers; the same viewers again wake nothing", () => {
    const r = rig();
    view({ [S]: watched(true, ["pane"]) })(r.feeds);
    r.turn(0);
    r.feeds.view({ [S]: watched(true, ["pane"]) }, tick(0.5));
    expect(r.feeds.next()).toBe(1);
    r.feeds.view({ [S]: watched(true, ["pane", "statusline"]) }, tick(0.5));
    expect(r.feeds.next()).toBe(0.5);
  });
});

describe("a feed whose session has no view", () => {
  test("waits, drawing nothing, until a wake brings it forward, then draws at once", () => {
    const r = rig();
    r.script.view = false;
    view({ [S]: watched() })(r.feeds);
    expect(r.turn(0)).toEqual([]);
    expect(r.feeds.next()).toBeNull();
    r.script.view = true;
    r.feeds.wake(S, "data", tick(0.01));
    // A frame not drawn spaces nothing.
    expect(r.feeds.next()).toBe(0.01);
    expect(r.turn(0.01)).toHaveLength(1);
  });
});

describe("a frame that failed", () => {
  test("publishes a typed failure and can be replaced by a corrected view at the ordinary spacing", () => {
    const r = rig();
    r.script.failure = { level: "error", line: "render broke" };
    view({ [S]: watched() })(r.feeds);
    expect(r.turn(0)).toEqual([
      {
        session: S,
        lane: "pane",
        turn: 1,
        frame: { kind: "failed", message: "render broke" },
      },
    ]);
    expect(r.logged).toContain("error render broke");

    r.script.failure = null;
    r.script.bar = "corrected";
    const moving = PERIODS.moving / 1000;
    r.feeds.wake(S, "reload", tick(moving / 2));
    expect(r.turn(moving / 2)).toEqual([]);
    expect(r.turn(moving)).toEqual([
      {
        session: S,
        lane: "pane",
        turn: 1,
        frame: { kind: "drawn", receipt: 1, bar: draw("corrected") },
      },
    ]);
  });

  test("is logged when its failure first shows, and counted every time", () => {
    const r = rig();
    r.script.failure = { level: "error", line: "render broke" };
    view({ [S]: watched() })(r.feeds);
    r.run(0, 3);
    expect(r.logged.filter((l) => l === "error render broke")).toHaveLength(1);
    r.feeds.closeAll(tick(4));
    expect(r.logged.at(-1)).toMatch(/ failed=4 /);
  });
});

describe("feedsOf: what each lane was sent of late", () => {
  test("a session nobody follows is unfollowed on every lane", () => {
    const r = rig();
    expect(r.feeds.feedsOf(S, tick(0)).pane).toEqual(UNFOLLOWED);
  });

  test("a change to timing alone does not count as a changed presentation", () => {
    const r = rig();
    r.script.changeIn = 0.001;
    view({ [S]: watched() })(r.feeds);
    expect(r.run(0, 2).length).toBeGreaterThan(18);
    expect(r.feeds.feedsOf(S, tick(2)).pane.fps).toBe(0);
  });

  test("counts a lane's subscribers and the frames whose answer changed for it in the last second", () => {
    const r = rig();
    r.script.changeIn = 0.001;
    view({ [S]: watched(true, ["pane", "statusline"]) })(r.feeds);
    r.script.bars = { statusline: "s" };
    let n = 0;
    let next = r.feeds.next();
    while (next !== null && next <= 2) {
      // The pane's answer moves every frame; the statusline's never.
      r.script.bar = `r${n++}`;
      r.turn(next);
      next = r.feeds.next();
    }
    const feeds = r.feeds.feedsOf(S, tick(2));
    // Ten frames a second, give or take the one on the window's edge.
    expect(feeds.pane.fps + feeds.statusline.fps).toBeGreaterThanOrEqual(9);
    expect(Math.min(feeds.pane.fps, feeds.statusline.fps)).toBe(0);
    expect(feeds.pane.subscribers).toBe(1);
    expect(feeds.pane.shown).toBe(true);
  });

  test("a lane's count starts again when its last subscriber leaves", () => {
    const r = rig();
    view({ [S]: watched(true, ["pane"]) })(r.feeds);
    r.turn(0);
    expect(r.feeds.feedsOf(S, tick(0.5)).pane.fps).toBe(1);
    r.feeds.view({ [S]: watched(true, ["statusline"]) }, tick(0.5));
    r.feeds.view({ [S]: watched(true, ["pane"]) }, tick(0.5));
    expect(r.feeds.feedsOf(S, tick(0.5)).pane.fps).toBe(0);
  });

  test("a lane's count starts again with its next turn, though the viewers between read alike", () => {
    const r = rig();
    view({ [S]: watched(true, ["pane"]) })(r.feeds);
    r.turn(0);
    expect(r.feeds.feedsOf(S, tick(0.5)).pane.fps).toBe(1);
    r.feeds.view({ [S]: watched(true, ["pane"], {}, { pane: 3 }) }, tick(0.5));
    expect(r.feeds.feedsOf(S, tick(0.5)).pane.fps).toBe(0);
  });

  test("a frame is drawn with what its own session's lanes were sent before it, never another session's", () => {
    const r = rig();
    view({ [S]: watched(), [T]: watched(false) })(r.feeds);
    r.turn(0);
    expect(r.draws.map((d) => [d.session, d.feeds.pane.shown])).toEqual([
      [S, true],
      [T, false],
    ]);
  });
});

describe("noteSent", () => {
  test("a lane's log holds the sends of the window ending at this one", () => {
    const rate: Tick[] = [];
    for (const t of [0, 0.5, 0.9, 1.2, 1.4]) noteSent(rate, tick(t));
    expect(rate).toEqual([0.5, 0.9, 1.2, 1.4]);
  });
});

describe("a live subscription moving between renderers", () => {
  const viewers = { [S]: watched(true, ["statusline", "pane"]) };
  const input = (event: EventInput["event"], time: number): EventInput => ({
    kind: "event",
    event,
    at: time as Instant,
    tick: tick(time),
  });
  function subscription() {
    const host = new HostFeedHistory();
    host.watching(S, true);
    const enter = (
      r: ReturnType<typeof rig>,
      time: number,
      seen: Viewers = viewers,
    ) => {
      const turn = host.turn(
        input({ kind: "viewers", viewers: seen }, time),
        r,
        () => true,
      );
      using report = r.feeds.reporting();
      r.feeds.view(seen, tick(time), turn.input.feedResumes);
      turn.took({ frames: [], feedUpdates: report.updates() }, () => null);
      return turn.input;
    };
    const due = (
      r: ReturnType<typeof rig>,
      time: number,
      reason: string | null = null,
    ) => {
      const turn = host.turn(input({ kind: "due" }, time), r, () => true);
      const frames: PushedFrame[] = [];
      using report = r.feeds.reporting();
      try {
        r.turn(time, frames);
      } finally {
        turn.took({ frames, feedUpdates: report.updates() }, () => reason);
      }
      return frames;
    };
    return { host, enter, due };
  }

  test("uses both attempted draws, even before delivery, and preserves each surface's rate and absolute deadline", () => {
    const { host, enter, due } = subscription();
    const a = rig(),
      b = rig();
    a.script.bars = b.script.bars = { statusline: "s" };
    enter(a, 0);
    due(a, 0);
    a.script.bar = b.script.bar = "second bar";
    a.feeds.wake(S, "interaction", tick(0.1));
    due(a, 0.1, "private source");
    host.moved(S);
    const handoff = enter(b, 0.15);
    expect(recordingInputProblem(handoff)).toBe("private source");
    expect(b.feeds.feedsOf(S, tick(0.15))).toEqual(
      a.feeds.feedsOf(S, tick(0.15)),
    );
    expect(b.feeds.feedsOf(S, tick(0.15))).toMatchObject({
      pane: { fps: 2 },
      statusline: { fps: 1 },
    });
    expect(b.feeds.next()).toBe(1.1);
    expect(enter(b, 0.16).feedResumes).toBeUndefined();
    b.feeds.wake(S, "interaction", tick(0.2));
    due(b, 0.2);
    expect(b.feeds.feedsOf(S, tick(0.2))).toMatchObject({
      pane: { fps: 2 },
      statusline: { fps: 1 },
    });
    expect(b.feeds.feedsOf(S, tick(1))).toMatchObject({
      pane: { fps: 1 },
      statusline: { fps: 0 },
    });
    enter(b, 1.01, { [S]: watched(true, ["statusline"]) });
    enter(b, 1.02);
    expect(b.feeds.feedsOf(S, tick(1.02)).pane.fps).toBe(0);
  });

  test("one-way state advances only the owning reader's feed and late answers cannot resurrect a closed subscription", () => {
    const { host, enter, due } = subscription();
    const a = rig(),
      b = rig();
    enter(a, 0);
    due(a, 0);
    const observed = a.feeds.observe(
      () => a.feeds.wake(S, "state", tick(0.12)),
      true,
    );
    host.advanced(a, observed.advances!);
    const old = host.turn(input({ kind: "due" }, 0.13), a, () => true);
    host.moved(S);
    host.advanced(a, [{ sequence: 100, session: S, next: tick(0.1) }]);
    enter(b, 0.14);
    expect(b.feeds.next()).toBe(0.12);
    due(b, 0.14);
    host.watching(S, false);
    host.watching(S, true);
    enter(b, 0.2);
    old.took(
      {
        frames: [],
        feedUpdates: [
          {
            sequence: 100,
            session: S,
            schedule: { kind: "retry", next: tick(20) },
          },
        ],
      },
      () => null,
    );
    expect(b.feeds.next()).toBe(0.2);
    expect(b.feeds.feedsOf(S, tick(0.2)).pane.fps).toBe(0);
    expect(enter(a, 0.21).feedResumes?.[0]?.history?.schedule.next).toBe(0.2);
  });

  test("the later wake survives when its observation arrives before the numbered frame answer", () => {
    const { host, enter } = subscription();
    const a = rig(),
      b = rig();
    enter(a, 0);
    const flight = host.turn(input({ kind: "due" }, 0), a, () => true);
    let result;
    {
      using report = a.feeds.reporting();
      result = { frames: a.turn(0), feedUpdates: report.updates() };
    }
    const changed = a.feeds.observe(
      () => a.feeds.wake(S, "state", tick(0.04)),
      true,
    );
    host.advanced(a, changed.advances!);
    flight.took(result, () => null);
    host.moved(S);
    enter(b, 0.05);
    expect(b.feeds.next()).toBe(0.04);
    expect(b.feeds.feedsOf(S, tick(0.05)).pane.fps).toBe(1);
  });

  test("a retry retains its original deadline and a waiting feed waits until the view becomes available", () => {
    const { host, enter, due } = subscription();
    const a = rig(),
      b = rig();
    enter(a, 0);
    a.script.throwsFor = { session: S, cause: Error("draw failed") };
    expect(() => due(a, 0.1)).toThrow("draw failed");
    host.moved(S);
    enter(b, 0.2);
    b.feeds.wake(S, "interaction", tick(0.2));
    expect(b.feeds.next()).toBe(1.1);
    b.script.view = false;
    due(b, 1.1);
    host.moved(S);
    a.script.throwsFor = null;
    enter(a, 1.2);
    expect(a.feeds.next()).toBeNull();
    a.feeds.wake(S, "data", tick(1.3));
    expect(due(a, 1.3).map(({ lane }) => lane)).toEqual(["statusline", "pane"]);
  });
});
