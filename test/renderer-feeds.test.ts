// The renderer's frame clock (src/renderer/feeds.ts), over a draw that answers
// at once: a followed session's frames fall due a period apart (the moving
// period while its bar moves on a screen, the still one otherwise), at its
// bar's next change between the two, and whatever owes a frame brings the next
// forward to a spacing after the last. Nothing here reads a clock: each case
// plays the host's wake, handing in a `due` turn at every instant the feeds
// declare.
//
// [LAW:no-ambient-temporal-coupling] [LAW:behavior-not-structure] A case
// reads what was drawn and pushed, at which instants, and what was said.

import { FEED_PERIODS, Feeds, noteSent } from "../src/renderer/feeds";
import { renderFrame, type RendererParts } from "../src/renderer/draw-bar";
import type { FeedFrame } from "../src/renderer-interface/adapter";
import type { Response } from "../src/daemon/foundations/protocol";
import type { PushedFrame } from "../src/renderer-interface/interface";
import {
  MOVING_FPS,
  perLane,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneFeeds,
  type LaneSwitches,
  type Viewers,
} from "../src/config/lanes";
import { renderFailedFrame } from "../src/render/frame";
import { barOf } from "./helpers/drawn-frame";
import { instantOf, type Instant } from "../src/utils/instant";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";

const S = sessionIdOf("s");
const T0 = 1_700_000_000 as Instant;
// Float noise in a sum of moving periods, below any spacing a case reads.
const EPSILON = 1e-6;

const ALL_ON: LaneSwitches = perLane(() => true);

// Who follows a session: each lane's subscribers, all drawing, and whether
// its pane is on a screen.
const viewers = (
  lanes: Partial<Record<Lane, number>> = { band: 1 },
  shown = true,
): Viewers => ({
  shown,
  lanes: perLane((lane) => ({
    subscribers: lanes[lane] ?? 0,
    drawing: (lanes[lane] ?? 0) > 0,
  })),
});

// How the harness's bar moves: every frame a new one that changes at once,
// never, or on each multiple of `beatS` seconds, saying when it next turns.
type Motion =
  | { readonly kind: "moving" }
  | { readonly kind: "still" }
  | { readonly kind: "beat"; readonly beatS: number };

// What each draw was handed.
interface Draw {
  readonly at: Instant;
  readonly fps: number;
  readonly following: readonly Lane[];
  readonly feeds: LaneFeeds;
}

// Feeds over a draw whose bar moves as `motion` says. `state.view` is whether
// the session has a view (a draw finds none while it is false), `throws` a
// message the next draws throw, and `handoff` what the statusline shows in
// the bar's place while a lane draws it elsewhere. `play` keeps the host's
// wake: a due turn at each instant the feeds declare, through `untilS`
// seconds after T0, and `now` is where the last turn stood.
function harness(motion: Motion) {
  const state = {
    motion,
    n: 0,
    view: true,
    throws: null as string | null,
    handoff: null as string | null,
    lanes: ALL_ON,
    pins: 0,
    released: 0,
  };
  const draws: Draw[] = [];
  const log: string[] = [];
  const pushed: PushedFrame[] = [];
  const frameOf = (at: Instant): FeedFrame => {
    const m = state.motion;
    if (m.kind === "beat") {
      const beat = Math.floor((at - T0 + EPSILON) / m.beatS);
      return barFrame(`bar@${beat}`, T0 + (beat + 1) * m.beatS, state);
    }
    const output = `bar#${m.kind === "still" ? state.n : ++state.n}`;
    return barFrame(output, m.kind === "still" ? Infinity : at, state);
  };
  const feeds = new Feeds({
    pin: () => {
      state.pins++;
      return () => void state.released++;
    },
    draw: (_sessionId, fps, at, following, laneFeeds) => {
      if (!state.view) return null;
      draws.push({ at, fps, following: [...following], feeds: laneFeeds });
      if (state.throws !== null) throw new Error(state.throws);
      return frameOf(at);
    },
    log: (_level, line) => log.push(line),
  });
  let now = T0;
  const play = (untilS: number): void => {
    const until = T0 + untilS + EPSILON;
    for (;;) {
      const next = feeds.next(now);
      if (next === null || next > until) break;
      // A frame overdue is drawn in the turn at hand.
      now = Math.max(now, next) as Instant;
      feeds.due(now, pushed);
    }
    now = Math.max(now, T0 + untilS) as Instant;
  };
  const follow = (each: Viewers | null): void =>
    feeds.viewersAre(each === null ? {} : { [S]: each }, now);
  return {
    feeds,
    state,
    draws,
    log,
    pushed,
    play,
    follow,
    now: () => now,
    // The seconds after T0 each frame was drawn at, to the millisecond.
    drawnAt: () => draws.map((d) => Math.round((d.at - T0) * 1000) / 1000),
    outputs: () =>
      pushed.map(({ frame }) => {
        const resp = JSON.parse(frame.answers.resp) as Response;
        return resp.ok && "output" in resp ? resp.output : "-";
      }),
  };
}

// The parts and strip items each frame says it evaluated and added.
const EVALUATED = 3;
const CELL_BREAKS = 2;

// A frame drawing `output`, next changing at `nextChange`, carrying the lanes
// the session switches on and, in the statusline, the handoff line if any.
function barFrame(
  output: string,
  nextChange: number,
  state: { readonly handoff: string | null; readonly lanes: LaneSwitches },
): FeedFrame {
  return {
    bar: { ...barOf([{ text: output }]), nextChange },
    resp: { ok: true, output },
    statusline: { ok: true, output: state.handoff ?? output },
    evaluated: EVALUATED,
    cellBreaks: CELL_BREAKS,
    lanes: state.lanes,
    failure: null,
  };
}

describe("a followed session's frames", () => {
  test("a moving bar on a screen is drawn a moving period apart, at the moving ceiling, and every frame is pushed", () => {
    const h = harness({ kind: "moving" });
    h.follow(viewers());
    h.play(0.5);
    // At once, then every 1/30 s through 0.5 s.
    expect(h.draws).toHaveLength(16);
    expect(h.draws.every((d) => d.fps === MOVING_FPS)).toBe(true);
    expect(h.pushed).toHaveLength(16);
    expect(new Set(h.outputs()).size).toBe(16);
  });

  test("a still bar is drawn a still period apart, and pushed only when it changes", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(2.5);
    expect(h.drawnAt()).toEqual([0, 1, 2]);
    expect(h.outputs()).toEqual(["bar#0"]);
  });

  test("a bar moving where nobody can see it is drawn a still period apart, at the still ceiling", () => {
    const h = harness({ kind: "moving" });
    h.follow(viewers({ band: 1 }, false));
    h.play(2.5);
    expect(h.drawnAt()).toEqual([0, 1, 2]);
    expect(h.draws.every((d) => d.fps === 1)).toBe(true);
  });

  test("a bar that says when it next turns is drawn then: once a turn, not at the moving rate", () => {
    const h = harness({ kind: "beat", beatS: 0.1 });
    h.follow(viewers());
    h.play(0.55);
    expect(h.drawnAt()).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(h.outputs()).toEqual([0, 1, 2, 3, 4, 5].map((b) => `bar@${b}`));
  });

  test("a turn sooner than the moving period is drawn a moving period on, and one later than the still period a still period on", () => {
    const fast = harness({ kind: "beat", beatS: 0.01 });
    fast.follow(viewers());
    fast.play(0.1);
    expect(fast.draws).toHaveLength(4);
    const slow = harness({ kind: "beat", beatS: 5 });
    slow.follow(viewers());
    slow.play(2.5);
    expect(slow.drawnAt()).toEqual([0, 1, 2]);
  });

  test("an unseen bar that turns every 100 ms is drawn a still period apart", () => {
    const h = harness({ kind: "beat", beatS: 0.1 });
    h.follow(viewers({ band: 1 }, false));
    h.play(2.5);
    expect(h.drawnAt()).toEqual([0, 1, 2]);
  });
});

describe("what owes a frame", () => {
  test("a change after the spacing since the last frame is drawn at once; one inside it, a spacing after the last", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(0.5);
    h.state.n++;
    h.feeds.owe(S, "state");
    h.play(0.5);
    expect(h.drawnAt()).toEqual([0, 0.5]);
    h.state.n++;
    h.feeds.owe(S, "data");
    // Owed at 0.5, the frame drawn there: the next a moving period on.
    h.play(0.6);
    expect(h.drawnAt()).toEqual([0, 0.5, 0.533]);
    expect(h.outputs()).toEqual(["bar#0", "bar#1", "bar#2"]);
  });

  test("owing twice before the frame is one frame, and the summary counts the coalesced", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(0);
    h.feeds.owe(S, "data");
    h.feeds.owe(S, "state");
    h.play(0.5);
    expect(h.draws).toHaveLength(2);
    h.follow(null);
    expect(h.log.at(-1)).toMatch(
      / owed=data:1,state:1,reload:0,viewers:0 coalesced=1$/,
    );
  });

  test("viewers that move owe a frame, and the same viewers owe none", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(0.1);
    h.follow(viewers());
    expect(h.feeds.next(h.now())).toBeCloseTo(T0 + 1);
    h.follow(viewers({ band: 2 }));
    h.play(0.2);
    expect(h.drawnAt()).toEqual([0, 0.1]);
  });

  test("nothing is owed a session nobody follows, and a feed draws only for the lanes that draw it", () => {
    const h = harness({ kind: "still" });
    h.feeds.owe(S, "data");
    expect(h.feeds.next(h.now())).toBeNull();
    h.follow({
      shown: true,
      lanes: perLane((lane) => ({
        subscribers: lane === "band" || lane === "tmuxStatus" ? 1 : 0,
        drawing: lane === "band",
      })),
    });
    h.play(0);
    expect(h.draws.map((d) => d.following)).toEqual([["band"]]);
    expect(h.feeds.following(S)).toEqual(new Set(["band"]));
  });

  test("a feed whose session has no view waits, with no frame due, until something owes it one", () => {
    const h = harness({ kind: "still" });
    h.state.view = false;
    h.follow(viewers());
    h.play(5);
    expect(h.feeds.next(h.now())).toBeNull();
    h.state.view = true;
    h.feeds.owe(S, "data");
    h.play(5);
    expect(h.drawnAt()).toEqual([5]);
    h.follow(null);
    expect(h.log.at(-1)).toMatch(/ drawn=1 noView=1 /);
  });
});

describe("a feed's frames", () => {
  test("each lane is sent its own answer: while a lane draws the bar elsewhere, the statusline's handoff line goes out once", () => {
    const h = harness({ kind: "moving" });
    h.state.handoff = "the bar is drawn in the band";
    h.follow(viewers({ band: 1, statusline: 1 }));
    h.play(1);
    const statusline = new Set(
      h.pushed.map(({ frame }) => frame.answers.statusline),
    );
    expect(statusline.size).toBe(1);
    // Counted against the lanes that frame changed: the band every frame,
    // the statusline its one handoff line.
    const feeds = h.feeds.feedsOf(S, h.now());
    expect(feeds.band).toEqual({ subscribers: 1, fps: 30, shown: true });
    expect(feeds.statusline).toEqual({ subscribers: 1, fps: 0, shown: true });
  });

  test("each draw is handed the lane feeds as of its own instant, which no frame before it counts", () => {
    const h = harness({ kind: "moving" });
    h.follow(viewers({ band: 2 }));
    h.play(2);
    expect(h.draws[0]!.feeds.band).toEqual({
      subscribers: 2,
      fps: 0,
      shown: true,
    });
    // The second is handed the first, and not itself.
    expect(h.draws[1]!.feeds.band.fps).toBe(1);
    expect(h.feeds.feedsOf(sessionIdOf("nobody"), h.now())).toEqual(
      UNFOLLOWED_FEEDS,
    );
  });

  test("a frame whose lanes moved goes out though its answers did not", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(0);
    h.state.lanes = { ...ALL_ON, pane: false };
    h.feeds.owe(S, "state");
    h.play(0.1);
    expect(h.pushed.map(({ frame }) => frame.lanes)).toEqual([
      ALL_ON,
      h.state.lanes,
    ]);
  });

  test("a draw that throws is said once while it keeps throwing, its next spaced a still period on, and its recovery said", () => {
    const h = harness({ kind: "moving" });
    h.state.throws = "the view broke";
    h.follow(viewers());
    h.play(3);
    expect(h.drawnAt()).toEqual([0, 1, 2, 3]);
    expect(h.log.filter((l) => l.includes("threw"))).toEqual([
      expect.stringMatching(/^feed sid="s" threw: .*the view broke/),
    ]);
    h.state.throws = null;
    h.play(4);
    expect(h.log).toContain('feed sid="s" recovered after the view broke');
    h.follow(null);
    expect(h.log.at(-1)).toMatch(/ faulted=4 pushed=1 /);
  });

  test("a turn whose instant stands before the last frame's is followed at once, not drawn ahead of", () => {
    const h = harness({ kind: "moving" });
    h.follow(viewers());
    h.play(0);
    const back = (T0 - 3600) as Instant;
    expect(h.feeds.next(back)).toBeCloseTo(back + FEED_PERIODS.moving);
  });
});

describe("a feed's summary", () => {
  test("its close says who followed it and what it drew, at what ceiling and rate", () => {
    const h = harness({ kind: "moving" });
    h.follow(viewers({ band: 1, pane: 1 }));
    h.play(1);
    h.follow(null);
    expect(h.state).toMatchObject({ pins: 1, released: 1 });
    expect(h.log.at(-1)).toMatch(
      new RegExp(
        '^feed sid="s" closed subscribers=2 lanes=band,pane for=1s drawn=31 noView=0 moving=31 unseen=0 failed=0 faulted=0 pushed=31 ceiling=30fps achieved=31.0fps ' +
          `evaluated=${31 * EVALUATED} cellBreaks=${31 * CELL_BREAKS} owed=data:0,state:0,reload:0,viewers:0 coalesced=0$`,
      ),
    );
  });

  test("a long-lived feed says it once a minute while it runs", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(130);
    expect(h.log.filter((l) => / running /.test(l))).toHaveLength(2);
  });

  test("the renderer's close ends every feed, releasing its pin", () => {
    const h = harness({ kind: "still" });
    h.follow(viewers());
    h.play(0);
    h.feeds.close(h.now());
    expect(h.state.released).toBe(1);
    expect(h.feeds.next(h.now())).toBeNull();
    expect(h.feeds.drawn).toBe(1);
  });
});

describe("noteSent", () => {
  test("a lane's log holds the sends of the window ending at this one, a wall clock stepped back included", () => {
    const at = (ms: number): Instant => instantOf(new Date(ms));
    const rate: Instant[] = [];
    for (const ms of [100_000, 100_500, 100_900, 101_200])
      noteSent(rate, at(ms));
    expect(rate).toEqual([at(100_500), at(100_900), at(101_200)]);
    // An hour back: every earlier send is stamped after this one.
    noteSent(rate, at(101_200 - 3_600_000));
    expect(rate).toEqual([at(101_200 - 3_600_000)]);
  });
});

// [LAW:no-silent-failure] A feed's draw that threw reaches a lane as a Frame
// saying so, with no failure branch in the lane.
test("a frame whose render threw is the failure's Frame, a still bar in the error glyph's words", () => {
  const parts = {
    renderCache: {
      holdView: () => null,
      openFailure: () => ({ error: new Error("the view would not open") }),
    },
  } as unknown as RendererParts;
  const drawn = renderFrame(parts, S as SessionId, 30, T0, {
    following: new Set(["band"]),
    feeds: UNFOLLOWED_FEEDS,
    idleSince: null,
  })!;
  expect(drawn.menus).toBeNull();
  expect(drawn.frame.bar).toEqual(renderFailedFrame("the view would not open"));
  expect(drawn.frame.bar.nextChange).toBe(Infinity);
  expect(drawn.frame.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: "the view would not open",
  });
});
