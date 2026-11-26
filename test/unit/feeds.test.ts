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
import { UNFOLLOWED, type Lane, type LaneFeeds } from "../../src/config/lanes";
import type { Frame } from "../../src/render/frame";
import type {
  EffectId,
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

// A session watched on `lanes`, each with one subscriber drawing it.
const watched = (
  shown = true,
  lanes: readonly Lane[] = ["pane"],
): SessionViewers => ({
  lanes: Object.fromEntries(
    lanes.map((lane) => [lane, { subscribers: 1, drawing: true }]),
  ),
  pointer: null,
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
    handoff: "s",
    view: true,
    failure: null as FeedDraw["failure"],
    skew: 1000,
    // A session whose draw throws past the draw's own catch.
    throwsFor: null as { session: SessionId; cause: Error } | null,
  };
  const draws: Array<{
    session: SessionId;
    fps: number;
    at: number;
    tick: number;
    following: Lane[];
    feeds: LaneFeeds;
  }> = [];
  const pins: string[] = [];
  const logged: string[] = [];
  const feeds = new Feeds({
    draw: (session, fps, { at, tick }, following, laneFeeds) => {
      draws.push({
        session,
        fps,
        at,
        tick,
        following: [...following],
        feeds: laneFeeds,
      });
      if (session === script.throwsFor?.session) throw script.throwsFor.cause;
      if (!script.view) return null;
      return {
        frame:
          script.failure === null
            ? {
                kind: "drawn",
                receipt: ++receipts as EffectId,
                bar: draw(script.bar, at + script.changeIn),
                handoff: draw(script.handoff),
              }
            : { kind: "failed", message: script.failure.line },
        evaluated: 3,
        cellBreaks: 1,
        failure: script.failure,
      };
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
    view({ [S]: watched(true, ["pane", "statusline"]), [T]: watched() }, viewersChangedAt)(r.feeds);
    const frames: PushedFrame[] = [];
    for (let ms = moving + interval; ms < recovery * 1000; ms += interval)
      frames.push(...wakeAndDraw(ms / 1000));
    expect(
      r.draws.filter(({ session }) => session === S).map(({ tick }) => tick),
    ).toEqual([0, moving / 1000, retry]);
    expect(thrown).toHaveLength(2);
    for (const cause of thrown) expect(cause).toBe(failure);
    expect(frames.length).toBeGreaterThan(still / moving);
    expect(
      frames.every(({ session, frame }) => session === T && frame.kind === "drawn"),
    ).toBe(true);

    r.script.throwsFor = null;
    r.script.bar = "recovered";
    expect(wakeAndDraw(recovery)).toContainEqual(
      expect.objectContaining({
        session: S,
        frame: expect.objectContaining({ kind: "drawn", bar: draw("recovered") }),
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

  test("a frame is drawn with the lanes that follow the session and handed on with its structured presentations", () => {
    const r = rig();
    view({ [S]: watched(true, ["pane", "statusline"]) })(r.feeds);
    const frames = r.turn(0);
    expect(frames).toEqual([
      {
        session: S,
        frame: {
          kind: "drawn",
          receipt: 1,
          bar: draw("r"),
          handoff: draw("s"),
        },
      },
    ]);
    expect(r.draws[0]!.following.sort()).toEqual(["pane", "statusline"]);
    expect(r.feeds.drawn()).toBe(1);
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

  test("wakes of every cause at 1 ms intervals draw a shown feed at most once a moving period, and an unseen one once a still period", () => {
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
        / woke=data:\d+,state:\d+,reload:\d+,visibility:0,viewers:0 coalesced=[1-9]/,
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
      { session: S, frame: { kind: "failed", message: "render broke" } },
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
        frame: {
          kind: "drawn",
          receipt: 1,
          bar: draw("corrected"),
          handoff: draw("s"),
        },
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
