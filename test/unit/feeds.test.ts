// [LAW:no-ambient-temporal-coupling] The renderer's feeds (src/renderer/feeds.ts)
// decide when each watched session's next frame is drawn, as state: the host
// hands in its viewers, each `due` hands in an instant, and the feeds say the
// next instant they want. No clock and no timer: every case below chooses its
// instants.

import { Feeds, FEED_PERIODS, noteSent, type FeedFrame } from "../../src/renderer/feeds";
import { perLane, type Lane, type LaneFeeds } from "../../src/config/lanes";
import type { Instant } from "../../src/utils/instant";
import type {
  SessionViewers,
  Viewers,
} from "../../src/renderer-interface/interface";
import { sessionIdOf, type SessionId } from "../../src/daemon/foundations/session-id";
import { barOf } from "../helpers/drawn-frame";

const S = sessionIdOf("s");
const T = sessionIdOf("t");
const PERIODS = { moving: 20, still: 400 };
const T0 = 1_700_000_000;
const at = (ms: number): Instant => (T0 + ms / 1000) as Instant;
// An instant as ms after T0, rounded off the float noise of the seconds.
const msOf = (instant: Instant | null): number | null =>
  instant === null ? null : Math.round((instant - T0) * 1000);

// Who watches a session: `lanes`' subscribers, each drawing it, and whether
// its pane is on a screen.
const watching = (
  lanes: Partial<Record<Lane, number>> = { band: 1 },
  shown = true,
): SessionViewers => ({
  lanes: perLane((lane) => ({
    subscribers: lanes[lane] ?? 0,
    drawing: (lanes[lane] ?? 0) > 0,
  })),
  shown,
});

// A bar showing `text`, next changing at `nextChange`.
const frameOf = (
  text: string,
  nextChange: number,
  failure: FeedFrame["failure"] = null,
  statusline = text,
): FeedFrame => ({
  bar: { ...barOf([{ text }]), nextChange },
  answers: { resp: JSON.stringify(text), statusline: JSON.stringify(statusline) },
  evaluated: 3,
  cellBreaks: 2,
  failure,
});

type Motion = "moving" | "still";

// Feeds over a draw whose bar moves as `motion` says, each moving frame new;
// `noView` is the sessions with no view to draw; `beatMs` makes the bar turn on
// each multiple of it and say so.
function rig(
  opts: { motion?: Motion; beatMs?: number; failing?: boolean } = {},
) {
  const state = {
    motion: opts.motion ?? "moving",
    n: 0,
    noView: new Set<SessionId>(),
    // What each draw was handed, in order.
    draws: [] as Array<{
      session: SessionId;
      ms: number;
      fps: number;
      following: readonly Lane[];
      feeds: LaneFeeds;
    }>,
    pins: new Map<SessionId, number>(),
    statusline: null as string | null,
  };
  const logged: string[] = [];
  const feeds = new Feeds({
    draw: (session, when, fps, following, laneFeeds) => {
      if (state.noView.has(session)) return null;
      state.draws.push({
        session,
        ms: msOf(when)!,
        fps,
        following: [...following],
        feeds: laneFeeds,
      });
      if (opts.failing === true)
        return frameOf("broke", Infinity, {
          level: "error",
          line: "frame threw: broke",
        });
      if (opts.beatMs !== undefined) {
        const beat = Math.floor(msOf(when)! / opts.beatMs);
        return frameOf(
          `beat${beat}`,
          at((beat + 1) * opts.beatMs),
        );
      }
      const text = `${session}#${state.motion === "still" ? 0 : ++state.n}`;
      return frameOf(
        text,
        state.motion === "still" ? Infinity : when,
        null,
        state.statusline ?? text,
      );
    },
    pin: (session) => {
      state.pins.set(session, (state.pins.get(session) ?? 0) + 1);
      return () => state.pins.set(session, state.pins.get(session)! - 1);
    },
    periods: PERIODS,
    log: (_level, line) => logged.push(line),
  });
  // Every due a host's wake would hand in from `fromMs` through `toMs`: one
  // at each instant the feeds declare, handed in as declared.
  const run = (fromMs: number, toMs: number): void => {
    const end = at(toMs);
    for (let next: Instant | null = at(fromMs); next !== null && next <= end; ) {
      const drawn = feeds.due(next);
      // [LAW:no-silent-failure] A due that draws nothing at the instant
      // declared would spin a host's wake.
      if (drawn.length === 0) throw new Error(`a due at ${msOf(next)}ms drew nothing`);
      next = feeds.next();
    }
  };
  const view = (viewers: Viewers, ms: number) => feeds.view(viewers, at(ms));
  return { feeds, state, logged, run, view };
}

const drawnAt = (r: ReturnType<typeof rig>) => r.state.draws.map((d) => d.ms);

test("a session newly watched opens a feed whose first frame is due at once, and its view is pinned while it is open", () => {
  const r = rig();
  r.view({ [S]: watching() }, 0);
  expect(msOf(r.feeds.next())).toBe(0);
  expect(r.state.pins.get(S)).toBe(1);
  r.view({}, 5);
  expect(r.state.pins.get(S)).toBe(0);
  expect(r.feeds.next()).toBeNull();
});

test("a moving bar on a screen is drawn a moving period apart, and declares each next frame as it draws", () => {
  const r = rig({ motion: "moving" });
  r.view({ [S]: watching() }, 0);
  r.run(0, 100);
  expect(drawnAt(r)).toEqual([0, 20, 40, 60, 80, 100]);
  expect(msOf(r.feeds.next())).toBe(120);
});

test("a still bar is drawn a still period apart", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching() }, 0);
  r.run(0, 1000);
  expect(drawnAt(r)).toEqual([0, 400, 800]);
});

test("a moving bar nobody can see is drawn at the still rate", () => {
  const r = rig({ motion: "moving" });
  r.view({ [S]: watching({ band: 1 }, false) }, 0);
  r.run(0, 1000);
  expect(drawnAt(r)).toEqual([0, 400, 800]);
});

test("each frame is handed its feed's ceiling: the moving rate while shown, the still rate while not", () => {
  const r = rig();
  r.view({ [S]: watching() }, 0);
  r.feeds.due(at(0));
  r.view({ [S]: watching({ band: 1 }, false) }, 10);
  r.feeds.due(at(400));
  expect(r.state.draws.map((d) => d.fps)).toEqual([
    Math.round(1000 / PERIODS.moving),
    Math.round(1000 / PERIODS.still),
  ]);
});

test("a bar that turns every 100 ms is drawn once a turn, for the moment it turns", () => {
  const r = rig({ beatMs: 100 });
  r.view({ [S]: watching() }, 0);
  r.run(0, 400);
  expect(drawnAt(r)).toEqual([0, 100, 200, 300, 400]);
});

test("a due before a feed's next frame draws nothing, and one after it draws once, at the due's instant", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching() }, 0);
  r.feeds.due(at(0));
  expect(r.feeds.due(at(399))).toEqual([]);
  expect(r.feeds.due(at(450)).map((d) => d.sessionId)).toEqual([S]);
  expect(drawnAt(r)).toEqual([0, 450]);
  expect(msOf(r.feeds.next())).toBe(850);
});

test("a change brings the next frame forward to the earliest the spacing allows, and a second is coalesced into it", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching() }, 0);
  r.feeds.due(at(0));
  r.feeds.owe(S, "data", at(5));
  expect(msOf(r.feeds.next())).toBe(PERIODS.moving);
  r.feeds.owe(S, "state", at(6));
  r.feeds.due(at(20));
  r.view({}, 30);
  expect(r.logged.at(-1)).toMatch(/woke=data:1,state:1,reload:0,visibility:0 coalesced=1$/);
});

test("an unseen feed brought forward is spaced a still period from its last frame", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching({ band: 1 }, false) }, 0);
  r.feeds.due(at(0));
  r.feeds.owe(S, "data", at(5));
  expect(msOf(r.feeds.next())).toBe(PERIODS.still);
});

test("a change to a session nobody watches moves nothing", () => {
  const r = rig();
  r.feeds.owe(S, "data", at(0));
  expect(r.feeds.next()).toBeNull();
});

test("viewers equal to a feed's own move nothing; a pane coming into view is drawn at the moving rate from then", () => {
  const r = rig({ motion: "moving" });
  r.view({ [S]: watching({ band: 1 }, false) }, 0);
  r.feeds.due(at(0));
  r.view({ [S]: watching({ band: 1 }, false) }, 10);
  expect(msOf(r.feeds.next())).toBe(400);
  r.view({ [S]: watching({ band: 1 }, true) }, 10);
  expect(msOf(r.feeds.next())).toBe(20);
  r.run(20, 60);
  expect(drawnAt(r)).toEqual([0, 20, 40, 60]);
});

test("each frame is asked for with the lanes whose subscribers draw it", () => {
  const r = rig();
  r.view(
    {
      [S]: {
        ...watching({ band: 1, tmuxStatus: 1 }),
        lanes: perLane((lane) => ({
          subscribers: lane === "band" || lane === "tmuxStatus" ? 1 : 0,
          drawing: lane === "band",
        })),
      },
    },
    0,
  );
  r.feeds.due(at(0));
  expect(r.state.draws[0]!.following).toEqual(["band"]);
  expect([...r.feeds.following(S)]).toEqual(["band"]);
});

test("a feed with no view to draw waits, and the frame the view's opening wakes is drawn at once", () => {
  const r = rig({ motion: "still" });
  r.state.noView.add(S);
  r.view({ [S]: watching() }, 0);
  expect(r.feeds.due(at(0))).toEqual([]);
  expect(r.feeds.next()).toBeNull();
  r.state.noView.delete(S);
  r.feeds.owe(S, "reload", at(3));
  expect(msOf(r.feeds.next())).toBe(3);
  r.feeds.due(at(3));
  expect(drawnAt(r)).toEqual([3]);
});

test("feeds due at one instant are each drawn, in the order they opened", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching() }, 0);
  r.view({ [S]: watching(), [T]: watching() }, 0);
  expect(r.feeds.due(at(0)).map((d) => d.sessionId)).toEqual([S, T]);
});

test("a wall clock stepped back is drawn at once, and the next frame spaced from it", () => {
  const r = rig({ motion: "still" });
  r.view({ [S]: watching() }, 1000);
  r.feeds.due(at(1000));
  r.feeds.due(at(500));
  expect(drawnAt(r)).toEqual([1000, 500]);
  expect(msOf(r.feeds.next())).toBe(900);
});

test("a frame that keeps failing the same way is said once, and counted every time", () => {
  const r = rig({ failing: true });
  r.view({ [S]: watching() }, 0);
  r.run(0, 900);
  expect(r.logged.filter((l) => l === "frame threw: broke")).toHaveLength(1);
  r.view({}, 900);
  expect(r.logged.at(-1)).toMatch(/ drawn=3 .* failed=3 /);
});

describe("what each lane is doing, as a frame is asked for", () => {
  test("a session nobody follows is unfollowed on every lane", () => {
    const r = rig();
    expect(r.feeds.feedsOf(S, at(0))).toEqual(
      perLane(() => ({ subscribers: 0, fps: 0, shown: true })),
    );
  });

  test("counts each lane's subscribers and the frames that changed what it shows in the last second", () => {
    const r = rig({ motion: "moving" });
    r.view({ [S]: watching({ band: 2 }) }, 0);
    r.run(0, 1000);
    expect(r.feeds.feedsOf(S, at(1000)).band).toEqual({
      subscribers: 2,
      fps: 50,
      shown: true,
    });
  });

  test("a lane whose answer stands still is credited with no frames while the bar moves", () => {
    const r = rig({ motion: "moving" });
    r.state.statusline = "drawn in the band";
    r.view({ [S]: watching({ band: 1, statusline: 1 }) }, 0);
    r.run(0, 1000);
    const lanes = r.feeds.feedsOf(S, at(1000));
    expect(lanes.statusline.fps).toBe(0);
    expect(lanes.band.fps).toBe(50);
  });

  test("a lane is credited only with the frames since its first subscriber joined", () => {
    const r = rig({ motion: "moving" });
    r.view({ [S]: watching({ band: 1 }) }, 0);
    r.run(0, 500);
    r.view({ [S]: watching({ band: 1, pane: 1 }) }, 500);
    r.run(520, 600);
    expect(r.feeds.feedsOf(S, at(600)).pane.fps).toBe(5);
  });

  test("a frame's count reads only the frames before it, so the draw asking sees its own instant's", () => {
    const r = rig({ motion: "moving" });
    r.view({ [S]: watching({ band: 1 }) }, 0);
    r.run(0, 40);
    expect(r.state.draws.map((d) => d.feeds.band.fps)).toEqual([0, 1, 2]);
  });
});

describe("a feed's summary", () => {
  test("is written as the feed closes, with what it drew", () => {
    const r = rig({ motion: "moving" });
    r.view({ [S]: watching({ band: 1, pane: 2 }) }, 0);
    r.run(0, 1000);
    r.view({}, 1000);
    expect(r.logged.at(-1)).toBe(
      `feed sid="s" closed lanes=band:1,pane:2 for=1s drawn=51 noView=0 moving=51 unseen=0 failed=0 ceiling=50fps achieved=51.0fps evaluated=153 cellBreaks=102 woke=data:0,state:0,reload:0,visibility:0 coalesced=0`,
    );
  });

  test("is written once a minute while the feed runs, by its frames' instants", () => {
    const r = rig({ motion: "still" });
    r.view({ [S]: watching() }, 0);
    r.run(0, 61_000);
    expect(r.logged.filter((l) => l.includes(" running "))).toHaveLength(1);
  });

  test("the renderer's close ends every feed and releases every pin", () => {
    const r = rig();
    r.view({ [S]: watching(), [T]: watching() }, 0);
    r.feeds.close(at(10));
    expect([...r.state.pins.values()]).toEqual([0, 0]);
    expect(r.logged.filter((l) => l.includes(" closed "))).toHaveLength(2);
    expect(r.feeds.next()).toBeNull();
  });
});

test("a lane's log holds the sends of the window ending at this one, a wall clock stepped back included", () => {
  const rate: Instant[] = [];
  for (const s of [0, 0.5, 1.2, 1.4]) noteSent(rate, (T0 + s) as Instant);
  expect(rate.map((i) => Math.round((i - T0) * 10) / 10)).toEqual([0.5, 1.2, 1.4]);
  noteSent(rate, (T0 + 0.1) as Instant);
  expect(rate.map((i) => Math.round((i - T0) * 10) / 10)).toEqual([0.1]);
});

test("the feeds draw a continuous effect at the rate its curves were signed off at, and any bar at least once a second", () => {
  expect(FEED_PERIODS.still).toBe(1000);
  expect(Math.round(1000 / FEED_PERIODS.moving)).toBe(30);
});
