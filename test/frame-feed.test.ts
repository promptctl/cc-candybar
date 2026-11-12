// The frame clock of src/daemon/frame-feed.ts, over a render that answers at
// once: frames fall due a period apart (the moving period while the bar moves
// where someone can see it, the still one otherwise), a change brings the next
// frame forward to the earliest the feed's spacing allows, two subscribers
// share each render, and a feed with no subscriber draws nothing.

import type { Monotonic } from "../src/time";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { ok } from "../src/utils/outcome";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { renderFrame } from "../src/daemon/draw-bar";
import {
  feedsFact,
  FrameFeeds,
  noteSent,
  type FeedFrame,
  type Refusal,
  type Subscriber,
} from "../src/daemon/frame-feed";
import type { Response } from "../src/daemon/protocol";
import { plainOf, renderFailedFrame, type Frame } from "../src/render/frame";
import { barOf } from "./helpers/drawn-frame";
import {
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneSwitches,
} from "../src/config/lanes";
import { instantOf, type Instant } from "../src/utils/instant";
import { heldClock } from "./helpers/held-clock";

import { sessionIdOf, type SessionId } from "../src/daemon/session-id";

const C = sessionIdOf("c");
const BEFORE_CLEAR = sessionIdOf("before-clear");
const ELSEWHERE = sessionIdOf("elsewhere");
const AFTER_CLEAR = sessionIdOf("after-clear");

const S = sessionIdOf("s");
const SID_A = sessionIdOf("a");
const B = sessionIdOf("b");

// Where every harness's held clock stands at the start, in wall ms: a boundary
// of every beat and period the cases use, so a case counts turns from a known
// place, and as late in the epoch as the real wall stands, so the float noise
// in the feed's arithmetic on instants (seconds, divided and multiplied back)
// is rounded away from the monotonic reading, as it is for a daemon reading
// the wall clock.
const START_MS = 1_700_000_000_000;

// A timer waits whole milliseconds, as Node's do: the feed hands `after` the
// fractional wait to a frame's moment, which the held clock would otherwise
// keep to the last digit, so a draw due at 70 ms could fall at 70.0000001 and
// miss a window that ends there. Node truncates; this rounds to the nearest,
// so float noise in the arithmetic (69.9999999) cannot cost a millisecond the
// feed meant to wait. A wait that is more than nothing is at least one
// millisecond, so a timer that fires a hair early and waits out the rest still
// moves time forward. Nothing stays nothing, where Node would take a
// millisecond: the cases draw a frame set for now at the instant it is set.
const wholeMs = (ms: number): number =>
  ms > 0 ? Math.max(1, Math.round(ms)) : 0;

const PERIODS = { moving: 20, still: 400 };

// How the harness's bar moves: on a screen, where nobody can see it, or not at
// all. A moving frame says it changes at once (a continuous effect), a still
// one never; the feed asks whether it is shown.
type Motion = "moving" | "unseen" | "still";

// A feed over a render whose bar moves as `motion` says, every frame a new
// one while it does. `renders` counts the renders, `changes` the watches'
// change callbacks, by session. `note` notes a request and wakes its feed, as
// the daemon's view of the session does when the request is declared. The
// session's view is its latest noted request: a session with none has no view
// to draw, and its frames wait. `pins` counts each session's pins.
// `duringRender` runs inside a render, as a write that wakes the feed while
// it draws would.
// `beatMs`, when given, makes the bar turn on every multiple of it on the
// wall clock and say so, as a template's `frames` does: each frame shows the
// beat it was drawn in and next changes at the next one. The wall clock the
// feed reads is the harness's held `clock` (a case moves time with
// `clock.advance`), moved by `wallOffsetS` and read short by the next of
// `shortsMs` in turn, read by read (a reading truncated to the millisecond, a
// timer fired early). A render that takes `renderMs` burns that much of the
// clock: the loop is held, and what fell due waits for it.
function harness(opts: {
  motion: Motion;
  renderMs?: number;
  fails?: boolean;
  beatMs?: number;
}) {
  const clock = heldClock(new Date(START_MS));
  const state = {
    motion: opts.motion,
    renders: 0,
    // The rate each render was handed, in order.
    rates: [] as number[],
    n: 0,
    order: 0,
    // The lanes the session's settings switch on, read by the feed when it
    // asks; `opened` counts the times the feeds began to watch, `stopped` the
    // times they stopped.
    lanes: {
      band: true,
      statusline: true,
      pane: true,
      tmuxStatus: true,
    } as LaneSwitches,
    opened: 0,
    stopped: 0,
    // A lane gate that throws, as a daemon bug in reading the settings would.
    gateThrows: false,
    // Added to the feed's clock, to reach the once-a-minute summary.
    skewMs: 0,
    // What Claude Code's statusline shows in the bar's place while a lane
    // draws it elsewhere; null while it shows the bar.
    handoff: null as string | null,
    // Runs inside the next render, once.
    duringRender: null as (() => void) | null,
    pins: new Map<string, number>(),
    // The frames whose copy clicks were recorded as delivered.
    delivered: [] as string[],
    // The instant each render was drawn for, in order.
    ats: [] as Instant[],
    // The wall each render was drawn at, in ms, in order.
    walls: [] as number[],
    wallOffsetS: 0,
    shortsMs: [0],
    reads: 0,
  };
  const frameOf = (req: string, at: Instant): FeedFrame => {
    if (opts.fails === true) return failedFrame(req);
    if (opts.beatMs !== undefined) {
      const beat = Math.floor((at * 1000) / opts.beatMs);
      return barFrame(`${req}@${beat}`, ((beat + 1) * opts.beatMs) / 1000);
    }
    const output = `${req}#${state.motion === "still" ? state.n : ++state.n}`;
    return {
      ...barFrame(
        output,
        state.motion === "still" ? Infinity : at,
        state.handoff,
      ),
      delivered: () => state.delivered.push(output),
    };
  };
  const changes = new Map<string, () => void>();
  const log: string[] = [];
  const ledger = new RefreshLedger();
  const feeds: FrameFeeds<string> = new FrameFeeds<string>({
    render: (sessionId, fps, at): FeedFrame | null => {
      const req = feeds.latest(sessionId);
      if (req === null) return null;
      state.renders++;
      state.rates.push(fps);
      state.ats.push(at);
      state.walls.push(clock.now());
      if (opts.renderMs !== undefined) clock.burn(opts.renderMs);
      const during = state.duringRender;
      state.duringRender = null;
      during?.();
      return frameOf(req, at);
    },
    lanes: (sessionId) => {
      if (state.gateThrows) throw new Error("the gate broke");
      return feeds.latest(sessionId) === null ? null : state.lanes;
    },
    pin: (sessionId) => {
      state.pins.set(sessionId, (state.pins.get(sessionId) ?? 0) + 1);
      return () => {
        const left = (state.pins.get(sessionId) ?? 0) - 1;
        if (left > 0) state.pins.set(sessionId, left);
        else state.pins.delete(sessionId);
      };
    },
    shown: () => state.motion !== "unseen",
    watching: () => {
      state.opened++;
      return () => state.stopped++;
    },
    watch: (sessionId, onChange) => {
      changes.set(sessionId, onChange);
      return () => changes.delete(sessionId);
    },
    refreshes: () => ledger.totals(),
    periods: PERIODS,
    clock: {
      monotonic: () =>
        (START_MS + clock.monotonic() + state.skewMs) as Monotonic,
      after: (ms, fire) => clock.after(wholeMs(ms), fire),
    },
    instant: () =>
      ((clock.now() - state.shortsMs[state.reads++ % state.shortsMs.length]!) /
        1000 +
        state.wallOffsetS) as Instant,
    log: (_level, line) => log.push(line),
  });
  const note = (
    sessionId: SessionId,
    req: string,
    order = ++state.order,
  ): void => {
    feeds.note(sessionId, req, order);
    feeds.wake(sessionId, "data");
  };
  // The instant a frame drawn now is drawn at.
  const nowAt = (): Instant => instantOf(new Date(clock.now()));
  return { feeds, note, state, changes, log, ledger, clock, nowAt };
}

// The parts each bar frame says it evaluated.
const EVALUATED = 3;

// The strip items each bar frame says divided cells added.
const CELL_BREAKS = 2;

// A frame drawing `output`, next changing at `nextChange`, whose statusline
// shows `handoff` in its place, if any.
function barFrame(
  output: string,
  nextChange: number,
  handoff: string | null = null,
): FeedFrame {
  return {
    bar: { ...barOf([{ text: output }]), nextChange },
    resp: { ok: true, output },
    statusline: { ok: true, output: handoff ?? output },
    evaluated: EVALUATED,
    cellBreaks: CELL_BREAKS,
    delivered: () => {},
    failure: null,
  };
}

function failedFrame(req: string): FeedFrame {
  const resp: Response = {
    ok: false,
    error: `${req} threw`,
    code: "RENDER_FAILED",
  };
  return {
    bar: renderFailedFrame(`${req} threw`),
    resp,
    statusline: resp,
    evaluated: 0,
    cellBreaks: 0,
    delivered: () => {},
    failure: { level: "error", line: `frame ${req} threw` },
  };
}

// A subscriber of `lane` whose frames go to `frame` and whose refusal, if
// any, to `refused`.
const sub = (
  frame: (resp: Response) => unknown,
  lane: Lane = "band",
  refused: (resp: Refusal) => unknown = () => {},
): Subscriber => ({
  lane,
  frame: (_bar, json) => frame(JSON.parse(json) as Response),
  refused,
  drawing: () => true,
});

const outputOf = (resp: Response): string =>
  resp.ok && "output" in resp ? resp.output : JSON.stringify(resp);

// brandon-menus-sjhy.amf — Brandon: "When we're showing the bar in either the
// mod or the tmux pane, we should NOT show the original bar except a single
// line". The statusline lane draws in Claude Code's statusline, so while
// another lane draws the bar it is sent the handoff line, once, however the
// bar moves.
test("while a lane draws the bar elsewhere, the statusline lane is sent the handoff line once, and the band the moving bar", () => {
  const { feeds, note, state, clock } = harness({ motion: "moving" });
  state.handoff = "the bar is drawn in the band";
  note(S, "bar");
  const band: string[] = [];
  const statusline: string[] = [];
  const closeBand = feeds.subscribe(
    S,
    sub((r) => band.push(outputOf(r))),
  );
  const closeLine = feeds.subscribe(
    S,
    sub((r) => statusline.push(outputOf(r)), "statusline"),
  );
  clock.advance(200);
  state.handoff = null;
  clock.advance(100);
  closeBand();
  closeLine();
  // A frame at subscribing and one every moving period through 300 ms.
  expect(band).toHaveLength(16);
  expect(band.every((b) => b.startsWith("bar#"))).toBe(true);
  // The handoff line, then the moving bar once nothing draws it elsewhere.
  expect(statusline[0]).toBe("the bar is drawn in the band");
  expect(
    statusline.filter((l) => l === "the bar is drawn in the band"),
  ).toHaveLength(1);
  // The handoff line, then the five frames drawn after 200 ms (220 to 300).
  expect(statusline).toHaveLength(6);
  expect(statusline.slice(1).every((l) => l.startsWith("bar#"))).toBe(true);
});

// Review of PR #405: the daemon's own tmux status line subscriber follows
// every session it holds, but draws only the one its status line shows.
test("a lane follows a session only while one of its subscribers draws it", () => {
  const { feeds, note } = harness({ motion: "still" });
  note(S, "bar");
  let drawing = false;
  const close = feeds.subscribe(S, {
    ...sub(() => {}, "tmuxStatus"),
    drawing: () => drawing,
  });
  expect(feeds.following(S).has("tmuxStatus")).toBe(false);
  drawing = true;
  expect(feeds.following(S).has("tmuxStatus")).toBe(true);
  close();
});

test("a moving bar is drawn a moving period apart, every new frame pushed", () => {
  const { feeds, note, clock } = harness({ motion: "moving" });
  note(S, "bar");
  const got: string[] = [];
  const close = feeds.subscribe(
    S,
    sub((r) => got.push(outputOf(r))),
  );
  clock.advance(500);
  close();
  // One at subscribing and one every 20 ms through 500: 26.
  expect(got).toHaveLength(26);
  expect(new Set(got).size).toBe(got.length);
});

test("a still bar is drawn a still period apart and pushed only when it changes", () => {
  const { feeds, note, state, changes, clock } = harness({ motion: "still" });
  note(S, "bar");
  const got: string[] = [];
  const close = feeds.subscribe(
    S,
    sub((r) => got.push(outputOf(r))),
  );
  clock.advance(100);
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  // A change to the session is drawn inside the still period, a moving period
  // after the last frame at most.
  state.n++;
  changes.get("s")!();
  clock.advance(50);
  expect(got).toEqual(["bar#0", "bar#1"]);
  close();
});

test("a frame's copies are recorded once it goes out to a follower, never while none follows", () => {
  const { feeds, note, state, clock } = harness({ motion: "still" });
  note(S, "bar");
  clock.advance(50);
  expect(state.delivered).toEqual([]);
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(100);
  expect(state.delivered).toEqual(["bar#0"]);
  close();
});

test("a new request is drawn at once, and two subscribers share every frame", () => {
  const { feeds, note, state, clock } = harness({ motion: "still" });
  const a: string[] = [];
  const b: string[] = [];
  const closeA = feeds.subscribe(
    S,
    sub((r) => a.push(outputOf(r))),
  );
  clock.advance(50);
  expect(state.renders).toBe(0);
  note(S, "first");
  clock.advance(20);
  // The request's own answer is its client's: the feed draws its frame.
  expect(state.renders).toBe(1);
  const closeB = feeds.subscribe(
    S,
    sub((r) => b.push(outputOf(r))),
  );
  // The newcomer gets the bar as it stands, before any new render, and the
  // next frame is brought forward, since who follows is drawn into it. Its
  // bytes are the same, so it is pushed to no one.
  expect(b).toEqual(["first#0"]);
  clock.advance(30);
  expect(state.renders).toBe(2);
  note(S, "second");
  clock.advance(30);
  expect(state.renders).toBe(3);
  expect(a).toEqual(["first#0", "second#0"]);
  expect(b).toEqual(["first#0", "second#0"]);
  // A follower leaving brings it forward too.
  closeA();
  clock.advance(30);
  expect(state.renders).toBe(4);
  closeB();
});

test("a render slower than the period is followed by the next at once, and a wake during it is coalesced into it", () => {
  const { feeds, note, state, changes, clock } = harness({
    motion: "moving",
    renderMs: 60,
  });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(10);
  state.duringRender = () => {
    changes.get("s")!();
    changes.get("s")!();
  };
  clock.advance(300);
  close();
  // Back to back, 60 ms apart: the first render at 0 holds the loop to 60,
  // which the 10 ms advance ends inside, so the 300 ms window runs from 60
  // to 360 and holds renders at 60, 120, 180, 240, 300 and 360 beside the
  // first. The wakes were folded into the one being drawn rather than piling
  // up: each would have added a render.
  expect(state.renders).toBe(7);
});

test("the last subscriber leaving stops the feed and logs what it drew", () => {
  const { feeds, note, state, changes, log, clock } = harness({
    motion: "moving",
  });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(100);
  close();
  const drawn = state.renders;
  clock.advance(100);
  expect(state.renders).toBe(drawn);
  expect(changes.has("s")).toBe(false);
  expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  expect(log.at(-1)).toMatch(
    /^feed sid="s" closed subscribers=0 .* drawn=(\d+) noted=0 noView=0 moving=\1 unseen=0 failed=0 pushed=\d+/,
  );
  // A request noted for a session nobody watches draws nothing.
  note(S, "again");
  clock.advance(50);
  expect(state.renders).toBe(drawn);
});

test("a bar that moves where nobody can see it is drawn at the still rate, and its feed counts it", () => {
  const { feeds, note, state, log, clock } = harness({ motion: "unseen" });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(500);
  close();
  // Drawn at 0 and 400 ms: the still period, not the 20 ms a moving bar gets.
  expect(state.renders).toBe(2);
  expect(log.at(-1)).toMatch(
    / drawn=2 noted=0 noView=0 moving=0 unseen=2 failed=0 /,
  );
});

test("a noted request is drawn at once, and the next frame falls due a period after that one", () => {
  const { feeds, note, state, log, clock } = harness({ motion: "still" });
  const got: string[] = [];
  const close = feeds.subscribe(
    S,
    sub((r) => got.push(outputOf(r))),
  );
  note(S, "bar");
  clock.advance(200);
  expect(state.renders).toBe(1);
  clock.advance(150);
  close();
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  expect(log.at(-1)).toMatch(
    / drawn=1 noted=1 noView=0 moving=0 unseen=0 failed=0 pushed=1 /,
  );
});

test("a request that arrived before the one held is not the session's data, however late its render finishes", () => {
  const { feeds, note, clock } = harness({ motion: "still" });
  const got: string[] = [];
  const close = feeds.subscribe(
    S,
    sub((r) => got.push(outputOf(r))),
  );
  note(S, "newer", 2);
  note(S, "older", 1);
  clock.advance(20);
  close();
  expect(got).toEqual(["newer#0"]);
});

test("a watched session's request outlives the eviction of the least recently noted", () => {
  const { feeds, note, state, changes, clock } = harness({ motion: "still" });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(20);
  for (let i = 0; i < 300; i++) note(sessionIdOf(`other-${i}`), "x");
  const drawn = state.renders;
  changes.get("s")!();
  clock.advance(20);
  close();
  expect(state.renders).toBe(drawn + 1);
});

test("every subscriber is handed the bar with its lane's answer, and one joining later the bar as it stands", () => {
  const { feeds, note, state, clock } = harness({ motion: "still" });
  state.handoff = "the bar is drawn in the band";
  note(S, "bar");
  const barText = (bar: Frame): string => plainOf(bar.rows[0]!.runs);
  const seen: Array<[string, string]> = [];
  const follow = (lane: Lane): (() => void) =>
    feeds.subscribe(S, {
      lane,
      frame: (bar, json) => seen.push([barText(bar), json]),
      refused: () => {},
      drawing: () => true,
    });
  const closeBand = follow("band");
  clock.advance(PERIODS.moving * 3);
  expect(seen).toEqual([
    ["bar#0", JSON.stringify({ ok: true, output: "bar#0" })],
  ]);
  const closeLate = follow("statusline");
  expect(seen[1]).toEqual([
    "bar#0",
    JSON.stringify({ ok: true, output: state.handoff }),
  ]);
  closeBand();
  closeLate();
});

test("a frame that keeps failing the same way is logged once, and counted every time", () => {
  const { feeds, note, changes, log, clock } = harness({
    motion: "still",
    fails: true,
  });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(20);
  changes.get("s")!();
  clock.advance(20);
  close();
  expect(log.filter((l) => l === "frame bar threw")).toHaveLength(1);
  expect(log.at(-1)).toMatch(/ drawn=2 .* failed=2 pushed=1 /);
});

// What a feed draws and what its summary says of it, in frames counted on
// the held clock.
describe("a feed's draws and its summary", () => {
  // Whether anyone can see a bar is the feed's question, asked as it sets the
  // next frame: one that comes into view is drawn at the moving rate from then.
  test("a moving bar that comes into view is drawn at the moving rate from then", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "unseen" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(50);
    expect(state.renders).toBe(1);
    state.motion = "moving";
    feeds.wakeWhere("visibility", () => true);
    // Drawn at once at 50 ms, then a moving period apart through 150.
    clock.advance(100);
    close();
    expect(state.renders).toBe(7);
    expect(log.at(-1)).toMatch(/ moving=6 unseen=1 /);
  });

  // candybar-animation-wbxz.829, .014: the rate a fed bar shows is its feed's
  // ceiling — the most frames a second it draws the bar at, set by whether
  // the pane is on a screen — which neither the bar's own beat, an extra draw,
  // nor the frame's own push can move, so a still bar showing it stays still.
  test("each frame is handed its feed's ceiling: the moving rate while shown, the still rate while not", () => {
    const pace = (ms: number) => Math.round(1000 / ms);
    const { feeds, note, state, changes, log, clock } = harness({
      motion: "moving",
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(200);
    expect(state.rates).toEqual(state.rates.map(() => pace(PERIODS.moving)));
    // A change draws an extra frame, which moves nothing.
    changes.get("s")!();
    clock.advance(1);
    expect(state.rates.at(-1)).toBe(pace(PERIODS.moving));
    // A still bar on a screen is drawn a still period apart, and still shows
    // the ceiling: it would be drawn that fast if it moved.
    state.motion = "still";
    clock.advance(1000);
    expect(state.rates.at(-1)).toBe(pace(PERIODS.moving));
    // Unseen, its next frame is spaced a still period from the last.
    state.motion = "unseen";
    feeds.wakeWhere("visibility", () => true);
    clock.advance(PERIODS.still);
    close();
    expect(state.rates.at(-1)).toBe(pace(PERIODS.still));
    expect(log.at(-1)).toMatch(
      new RegExp(` ceiling=${pace(PERIODS.still)}fps `),
    );
  });

  // The rate a feed drew at, beside the pace it set: the gap is what the
  // daemon's other work cost it.
  test("the summary states the rate the feed drew at over its life", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "moving" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(2000);
    close();
    // One at subscribing and one every 20 ms through 2000.
    expect(state.renders).toBe(1 + 2000 / PERIODS.moving);
    expect(log.at(-1)).toMatch(
      new RegExp(
        ` for=2s drawn=${state.renders} .* achieved=${(state.renders / 2).toFixed(1)}fps `,
      ),
    );
  });

  // brandon-unfiled-3248.8ro6 step 7: what the feed's frames evaluated rides
  // beside what it drew.
  test("the summary counts the parts its frames evaluated", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "moving" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(100);
    close();
    expect(state.renders).toBe(1 + 100 / PERIODS.moving);
    expect(log.at(-1)).toMatch(
      new RegExp(
        ` drawn=${state.renders} .* evaluated=${EVALUATED * state.renders} `,
      ),
    );
  });

  // A lane's requests draw a handoff row, so the feed is what shows how the
  // lane's width treats its bar.
  test("the summary counts the strip items its frames' divided cells added", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "moving" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(100);
    close();
    expect(log.at(-1)).toContain(` cellBreaks=${CELL_BREAKS * state.renders} `);
  });

  // brandon-unfiled-3248.8ro6 §4e: no cause of a wake sets the draw rate. A
  // still bar on a screen, woken every millisecond by each cause in turn, is
  // drawn at most once a moving period, and its summary says what woke it and
  // how many of those wakes found a frame already due.
  test("wakes of every cause at 1 ms intervals draw a shown feed at most once a moving period", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "still" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(1);
    expect(state.renders).toBe(1);
    const causes = ["data", "state", "reload", "visibility"] as const;
    for (let ms = 0; ms < 200; ms++) {
      feeds.wake(S, causes[ms % causes.length]!);
      clock.advance(1);
    }
    close();
    // One frame per 20 ms moving period over the 200 ms, on top of the first.
    expect(state.renders).toBe(1 + 200 / PERIODS.moving);
    // Each frame after the first was set by a wake that moved the timer, and
    // so was the one the close cancelled, at 200 ms: every other wake was
    // coalesced.
    const summary = log.at(-1)!;
    expect(summary).toContain(
      " woke=data:50,state:50,reload:50,visibility:50 ",
    );
    const coalesced = Number(/ coalesced=(\d+) /.exec(summary)![1]);
    expect(coalesced).toBe(200 - state.renders);
  });

  test("a feed whose pane nobody can see, woken at 1 ms intervals, draws at most once a still period", () => {
    const { feeds, note, state, clock } = harness({ motion: "unseen" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(1);
    for (let ms = 0; ms < 1000; ms++) {
      feeds.wake(S, "data");
      clock.advance(1);
    }
    close();
    // The first frame, and one a still period after it, at 400 and 800 ms.
    expect(state.renders).toBe(3);
  });

  // [LAW:nothing-unseen] Beside the frames a feed drew, its summary counts the
  // refreshes every source ran while it was open, by trigger: a feed that drew
  // a moving bar and refreshed nothing is seen to.
  test("its summary counts the refreshes run while it was open, by trigger", () => {
    const { feeds, note, ledger, log, clock } = harness({ motion: "still" });
    const tmux = ledger.declare({
      name: "tmux",
      scope: "pane",
      refresh: ["first", "period"],
    });
    tmux.recorded("pane=%1", "first", ok(null), 1);
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(1);
    tmux.recorded("pane=%1", "period", ok(null), 1);
    tmux.recorded("pane=%1", "period", ok(null), 1);
    close();
    expect(log.at(-1)).toContain(
      " daemonRefreshed=first:0,period:2,change:0,request:0,supersede:0 ",
    );
  });

  // A frame is drawn in one synchronous turn, so a wake while it draws is the
  // draw's own (a view it reopened), and the frame reads what that moved: it
  // is coalesced into that frame, and the next falls due as the frame set it.
  test("a wake while a frame is drawn is coalesced into it", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "still" });
    note(S, "bar");
    state.duringRender = () => feeds.wake(S, "data");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(PERIODS.still - 1);
    expect(state.renders).toBe(1);
    clock.advance(1);
    close();
    expect(state.renders).toBe(2);
    expect(log.at(-1)).toContain(
      " woke=data:1,state:0,reload:0,visibility:0 coalesced=1 ",
    );
  });

  // A feed whose session has no view has no timer: a frame opens no view,
  // so it waits for the event that does. Noting a request wakes nothing; the
  // view the request opens says so (the harness's `note`), and that draws.
  test("a feed waiting for a view draws once the view that opens wakes it", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "still" });
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(PERIODS.still * 2);
    expect(state.renders).toBe(0);
    feeds.note(S, "bar", 1);
    clock.advance(PERIODS.still * 2);
    expect(state.renders).toBe(0);
    note(S, "bar", 2);
    clock.advance(1);
    close();
    expect(state.renders).toBe(1);
    // The one frame due before any view found none, and waited.
    expect(log.at(-1)).toContain(" noView=1 ");
  });

  // A draw that found no view drew nothing, so it spaces nothing: an unseen
  // feed's first frame is not held a still period behind it.
  test("the frame a view's opening wakes is drawn at once, not spaced from a draw that found no view", () => {
    const { feeds, note, state, clock } = harness({ motion: "unseen" });
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(PERIODS.still / 8);
    expect(state.renders).toBe(0);
    note(S, "bar");
    clock.advance(1);
    close();
    expect(state.renders).toBe(1);
  });

  test("wakeWhere draws at once only the watched sessions it matches", () => {
    const { feeds, note, state, clock } = harness({ motion: "still" });
    note(SID_A, "%1:a");
    note(B, "%2:b");
    note(C, "%1:c");
    const closeA = feeds.subscribe(
      SID_A,
      sub(() => {}),
    );
    const closeB = feeds.subscribe(
      B,
      sub(() => {}),
    );
    clock.advance(20);
    expect(state.renders).toBe(2);
    // c matches but nobody watches it, so nothing is drawn for it.
    feeds.wakeWhere("reload", (req) => req.startsWith("%1:"));
    clock.advance(20);
    closeA();
    closeB();
    expect(state.renders).toBe(3);
  });
});

// What runs while any feed exists (the tmux visibility loop) starts with the
// first feed and stops with the last, not a moment later.
// The ceiling is drawn into the frame, so a rate that moved with a render's
// duration would make every frame of an unchanged bar differ, and be pushed.
test("a render slower than the moving period leaves the pace at the moving rate", () => {
  const { feeds, note, state, clock } = harness({
    motion: "moving",
    renderMs: 60,
  });
  note(S, "bar");
  const close = feeds.subscribe(
    S,
    sub(() => {}),
  );
  clock.advance(400);
  close();
  // Back to back, 60 ms apart, from 0 through the 400 ms window: 7 renders.
  expect(state.renders).toBe(7);
  expect(state.rates.slice(1)).toEqual(
    state.rates.slice(1).map(() => Math.round(1000 / PERIODS.moving)),
  );
});

test("the feeds watch from the first feed opening to the last closing", () => {
  const { feeds, note, state } = harness({ motion: "still" });
  note(SID_A, "x");
  note(B, "y");
  expect(state.opened).toBe(0);
  const closeA = feeds.subscribe(
    SID_A,
    sub(() => {}),
  );
  const closeA2 = feeds.subscribe(
    SID_A,
    sub(() => {}),
  );
  const closeB = feeds.subscribe(
    B,
    sub(() => {}),
  );
  expect([state.opened, state.stopped]).toEqual([1, 0]);
  closeA();
  closeA2();
  expect([state.opened, state.stopped]).toEqual([1, 0]);
  closeB();
  expect([state.opened, state.stopped]).toEqual([1, 1]);
  feeds.subscribe(
    SID_A,
    sub(() => {}),
  )();
  expect([state.opened, state.stopped]).toEqual([2, 2]);
});

// The lane toggles (candybar-animation-wbxz.81o.azo): FrameFeeds is the one
// gate, reading the lanes the session's settings switch on as it asks.
describe("a subscription's lane", () => {
  test("switched off in the session's settings is refused before any feed opens", () => {
    const { feeds, note, state, log, clock } = harness({ motion: "moving" });
    state.lanes = {
      band: false,
      statusline: true,
      pane: true,
      tmuxStatus: false,
    };
    note(S, "bar");
    const refusals: Refusal[] = [];
    const frames: string[] = [];
    feeds.subscribe(
      S,
      sub(
        (r) => frames.push(outputOf(r)),
        "band",
        (r) => refusals.push(r),
      ),
    );
    clock.advance(50);
    expect(refusals).toEqual([
      expect.objectContaining({
        ok: false,
        code: "SWITCHED_OFF",
        error:
          "🧪 band (A) is off — turn it on in the settings menu's ⚙ config › 🧪 toggles, or set globals.experimentalBand: true",
      }),
    ]);
    expect(frames).toEqual([]);
    expect(state.renders).toBe(0);
    expect(state.opened).toBe(0);
    expect(feeds.getStats()).toMatchObject({
      feeds: 0,
      subscribers: 0,
      refused: 1,
    });
    expect(log).toContain('feed sid="s" refused lane=band switched-off');
  });

  test("switched off while it streams ends that subscriber and leaves the other lanes' running", () => {
    const { feeds, note, state, changes, log, clock } = harness({
      motion: "still",
    });
    note(S, "bar");
    const band: string[] = [];
    const pane: string[] = [];
    const refusals: Refusal[] = [];
    feeds.subscribe(
      S,
      sub(
        (r) => band.push(outputOf(r)),
        "band",
        (r) => refusals.push(r),
      ),
    );
    const closePane = feeds.subscribe(
      S,
      sub((r) => pane.push(outputOf(r)), "pane"),
    );
    clock.advance(30);
    state.lanes = {
      band: false,
      statusline: true,
      pane: true,
      tmuxStatus: false,
    };
    state.motion = "moving"; // the next frame differs, so it is pushed
    changes.get("s")!();
    clock.advance(60);
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    const bandSeen = band.length;
    clock.advance(60);
    expect(band.length).toBe(bandSeen);
    // Band's one frame, before its lane went off; pane's the same, then a
    // frame at the change (30 ms) and one every moving period through 150.
    expect(bandSeen).toBe(1);
    expect(pane).toHaveLength(8);
    expect(feeds.getStats()).toMatchObject({
      feeds: 1,
      subscribers: 1,
      refused: 1,
    });
    // Each subscribe names its lane; the running summary names the lanes still
    // subscribed when it is written.
    expect(log).toContain(
      'feed sid="s" subscribed lane=band subscribers=1 view=Y',
    );
    expect(log).toContain(
      'feed sid="s" subscribed lane=pane subscribers=2 view=Y',
    );
    state.skewMs = 60_000;
    changes.get("s")!();
    clock.advance(30);
    expect(
      log.some((l) => /feed sid="s" running subscribers=1 lanes=pane /.test(l)),
    ).toBe(true);
    closePane();
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  });

  // [LAW:no-silent-failure] A frame step runs off a timer: a throw it let go
  // would be an unhandled rejection, which exits the daemon. It is the feed's
  // logged fault, and the feed draws on.
  test("a lane gate that throws while a frame goes out is the feed's logged fault, and the feed draws on", () => {
    const { feeds, note, state, changes, log, clock } = harness({
      motion: "still",
    });
    note(S, "bar");
    const got: string[] = [];
    const close = feeds.subscribe(
      S,
      sub((r) => got.push(outputOf(r))),
    );
    clock.advance(20);
    state.gateThrows = true;
    changes.get("s")!();
    clock.advance(20);
    expect(
      log.some((l) =>
        l.startsWith('feed sid="s" threw: Error: the gate broke'),
      ),
    ).toBe(true);
    expect(feeds.getStats()).toMatchObject({ feeds: 1, subscribers: 1 });
    state.gateThrows = false;
    state.motion = "moving";
    changes.get("s")!();
    clock.advance(40);
    close();
    // The first frame, none at 20 ms (the gate threw), then one at the change
    // (40 ms) and one every moving period through 80.
    expect(got).toEqual(["bar#0", "bar#1", "bar#2", "bar#3"]);
  });

  test("of a session with no frame yet waits, and the first frame decides", () => {
    const { feeds, note, state, clock } = harness({ motion: "still" });
    const refusals: Refusal[] = [];
    feeds.subscribe(
      S,
      sub(
        () => {},
        "pane",
        (r) => refusals.push(r),
      ),
    );
    clock.advance(20);
    expect(refusals).toEqual([]);
    state.lanes = {
      band: true,
      statusline: true,
      pane: false,
      tmuxStatus: false,
    };
    note(S, "bar");
    clock.advance(20);
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  });

  // The switches are read when the gate asks, not copied from a frame: a
  // toggle turned on is honoured by the next subscribe, with no new request.
  test("turned on in the session's settings is honoured at once, with no frame between", () => {
    const { feeds, note, state, clock } = harness({ motion: "still" });
    state.lanes = {
      band: false,
      statusline: true,
      pane: true,
      tmuxStatus: false,
    };
    note(S, "bar");
    const refusals: Refusal[] = [];
    feeds.subscribe(
      S,
      sub(
        () => {},
        "band",
        (r) => refusals.push(r),
      ),
    );
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    state.lanes = {
      band: true,
      statusline: true,
      pane: true,
      tmuxStatus: false,
    };
    const frames: string[] = [];
    const close = feeds.subscribe(
      S,
      sub((r) => frames.push(outputOf(r))),
    );
    clock.advance(20);
    close();
    expect(frames).toEqual(["bar#0"]);
    expect(state.opened).toBe(1);
  });
});

// A tmux bar pane knows its pane, not the session in it, which a /clear
// replaces: the session is that of the newest request from the pane, by the
// order the daemon received them.
test("newestWhere finds the session of the newest request it matches, and counts its lookups", () => {
  const { feeds, note } = harness({ motion: "still" });
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

describe("feedsOf", () => {
  // Frames a second a bar is pushed at, moving on a screen and otherwise.
  const MOVING = 1000 / PERIODS.moving;

  test("a session nobody follows is unfollowed on every lane", () => {
    const { feeds, note, nowAt } = harness({ motion: "moving" });
    note(S, "bar");
    expect(feeds.feedsOf(S, nowAt())).toEqual(UNFOLLOWED_FEEDS);
    expect(feedsFact(feeds.feedsOf(S, nowAt()))).toBe("-");
  });

  test("counts each lane's subscribers and the frames pushed in the last second", () => {
    const { feeds, note, clock, nowAt } = harness({ motion: "moving" });
    note(S, "bar");
    const closeA = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    const closeB = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    const closeC = feeds.subscribe(
      S,
      sub(() => {}, "pane"),
    );
    clock.advance(1100);
    const now = feeds.feedsOf(S, nowAt());
    expect(now.band).toEqual(UNFOLLOWED);
    // The window holds only the last second's frames, never the 1.1 s since
    // subscribing.
    expect(now.statusline).toEqual({
      subscribers: 2,
      fps: MOVING,
      shown: true,
    });
    expect(now.pane).toEqual({ subscribers: 1, fps: MOVING, shown: true });
    expect(feedsFact(now)).toBe(
      `statusline:2sub/${MOVING}fps/shown,pane:1sub/${MOVING}fps/shown`,
    );
    closeA();
    closeB();
    closeC();
    expect(feeds.feedsOf(S, nowAt())).toEqual(UNFOLLOWED_FEEDS);
  });

  test("a lane is credited only with the frames sent since its first subscriber joined", () => {
    const { feeds, note, clock, nowAt } = harness({ motion: "moving" });
    note(S, "bar");
    const closeA = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    clock.advance(1000);
    const closeB = feeds.subscribe(
      S,
      sub(() => {}, "pane"),
    );
    clock.advance(100);
    const now = feeds.feedsOf(S, nowAt());
    closeA();
    closeB();
    expect(now.statusline.fps).toBe(MOVING);
    // The frames pushed since; the bar as it stood, handed over on joining,
    // is not one more frame.
    expect(now.pane.fps).toBe(100 / PERIODS.moving);
  });

  test("a lane's rate is unmoved by a subscriber joining it late or leaving it", () => {
    const { feeds, note, clock, nowAt } = harness({ motion: "moving" });
    note(S, "bar");
    const closeA = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    clock.advance(1000);
    const closeB = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    clock.advance(100);
    expect(feeds.feedsOf(S, nowAt()).statusline).toEqual({
      subscribers: 2,
      fps: MOVING,
      shown: true,
    });
    closeA();
    expect(feeds.feedsOf(S, nowAt()).statusline.fps).toBe(MOVING);
    closeB();
    expect(feeds.feedsOf(S, nowAt()).statusline).toEqual(UNFOLLOWED);
  });

  test("a subscriber rejoining a still bar is not counted as a frame", () => {
    const { feeds, note, clock, nowAt } = harness({ motion: "still" });
    note(S, "bar");
    const keep = feeds.subscribe(
      S,
      sub(() => {}, "band"),
    );
    clock.advance(1000);
    for (let i = 0; i < 3; i++)
      feeds.subscribe(
        S,
        sub(() => {}, "band"),
      )();
    expect(feeds.feedsOf(S, nowAt()).band.fps).toBe(0);
    keep();
  });

  test("a lane whose answer stands still is credited with no frames while the bar moves", () => {
    const { feeds, note, state, clock, nowAt } = harness({ motion: "moving" });
    state.handoff = "the bar is drawn in the band";
    note(S, "bar");
    const closeBand = feeds.subscribe(
      S,
      sub(() => {}, "band"),
    );
    const closeLine = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    clock.advance(1100);
    const now = feeds.feedsOf(S, nowAt());
    closeBand();
    closeLine();
    expect(now.band.fps).toBe(MOVING);
    // The handoff line, sent once on joining and never again.
    expect(now.statusline.fps).toBe(0);
  });

  test("a pane off screen is drawn at the still rate, and says so", () => {
    const { feeds, note, clock, nowAt } = harness({ motion: "unseen" });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}, "statusline"),
    );
    clock.advance(1100);
    const { statusline } = feeds.feedsOf(S, nowAt());
    close();
    // Pushed at 400 and 800 ms, a still period apart, inside the window.
    expect(statusline).toEqual({ subscribers: 1, fps: 2, shown: false });
    expect(feedsFact({ ...UNFOLLOWED_FEEDS, statusline })).toBe(
      "statusline:1sub/2fps/offscreen",
    );
  });
});

// candybar-animation-wbxz.014: a feed draws its next frame when the drawn
// frame next changes — within its spacing, and no later than the still period
// — and draws it for the instant of that change.
describe("a feed draws when its bar next changes", () => {
  // The start lies on a turn boundary.
  const beatAt = (ms: number): number => Math.floor(ms / 100);
  // The turn the held clock starts in.
  const BEAT_0 = beatAt(START_MS);
  const beatsOf = (ats: Instant[]): number[] =>
    ats.map((at) => beatAt(at * 1000));

  test("a bar that turns every 100 ms is drawn once a turn, not at the moving rate", () => {
    const { feeds, note, state, clock } = harness({
      motion: "moving",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(1050);
    close();
    // Once at subscribing and once a turn; the moving rate would draw
    // about fifty.
    expect(state.renders).toBe(11);
  });

  test("an unseen bar that turns every 100 ms is drawn a still period apart", () => {
    const { feeds, note, state, clock } = harness({
      motion: "unseen",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(1000);
    close();
    // At once, then 400 ms apart.
    expect(state.renders).toBe(3);
  });

  // Offset 0.3 ms long and short by 0, 1 or 2 ms, the wall reads 0.3 ms
  // long, 0.7 ms short or 1.7 ms short: each alone for a whole run, and
  // in turn so that one reading disagrees with the next. The mixed
  // sequences have prime lengths, so every reading of a draw meets every
  // shortfall however many readings a draw takes.
  test.each([[[0]], [[1]], [[2]], [[0, 2, 1]], [[2, 0, 1, 1, 0]]])(
    "a frame set for a turn is drawn for it, the wall read short within the timer's resolution (short by %j ms), and each turn costs one draw",
    (shortsMs: number[]) => {
      const RUN_MS = 1550;
      const OFFSET_MS = 0.3;
      const { feeds, note, state, clock } = harness({
        motion: "moving",
        beatMs: 100,
      });
      state.wallOffsetS = OFFSET_MS / 1000;
      state.shortsMs = shortsMs;
      note(S, "bar");
      const close = feeds.subscribe(
        S,
        sub(() => {}),
      );
      clock.advance(RUN_MS);
      close();
      const beats = beatsOf(state.ats);
      // Every frame is drawn in the turn after the last one's: never for
      // the instant before its turn, so never twice in one, and none
      // skipped, from the turn the wall reads at subscribing to the last.
      expect(beats).toEqual(beats.map((_, i) => beats[0]! + i));
      // The first is for a turn the wall read at subscribing, short or not.
      expect(
        shortsMs.map((short) => beatAt(START_MS + OFFSET_MS - short)),
      ).toContain(beats[0]);
      expect(beats.at(-1)).toBe(beatAt(START_MS + RUN_MS));
    },
  );

  // A timer armed late in a slow callback fires early by as long as the
  // callback had run, which is more than the wall's resolution on a busy
  // machine. Both clocks read the early moment here, as they do then.
  test("a timer that fires before its moment waits it out, so no turn is drawn twice", () => {
    const { feeds, note, state, clock } = harness({
      motion: "moving",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(0);
    state.skewMs = -8;
    state.wallOffsetS = -0.008;
    clock.advance(100);
    state.skewMs = 0;
    state.wallOffsetS = 0;
    clock.advance(8);
    close();
    expect(beatsOf(state.ats)).toEqual([BEAT_0, BEAT_0 + 1]);
  });

  test("a timer that fires early again waits again, and still draws the turn once", () => {
    const { feeds, note, state, clock } = harness({
      motion: "moving",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(0);
    state.skewMs = -8;
    state.wallOffsetS = -0.008;
    clock.advance(100);
    // The re-armed timer fires early too: the clocks fell further behind.
    state.skewMs = -12;
    state.wallOffsetS = -0.012;
    clock.advance(8);
    state.skewMs = 0;
    state.wallOffsetS = 0;
    clock.advance(4);
    close();
    expect(beatsOf(state.ats)).toEqual([BEAT_0, BEAT_0 + 1]);
  });

  test("closing a feed whose timer is waiting out its moment leaves no timer behind", () => {
    const { feeds, note, state, clock } = harness({
      motion: "moving",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    clock.advance(0);
    state.skewMs = -8;
    clock.advance(100);
    expect(clock.pending()).toBe(1);
    close();
    expect(clock.pending()).toBe(0);
  });

  test("a wall clock stepped back is followed at the next draw, not drawn ahead of", () => {
    const { feeds, note, state, clock } = harness({
      motion: "moving",
      beatMs: 100,
    });
    note(S, "bar");
    const close = feeds.subscribe(
      S,
      sub(() => {}),
    );
    const BEFORE_MS = 250;
    const AFTER_MS = 1200;
    const STEP_MS = -10_000;
    clock.advance(BEFORE_MS);
    state.wallOffsetS = STEP_MS / 1000;
    const before = state.renders;
    clock.advance(AFTER_MS);
    close();
    const after = beatsOf(state.ats.slice(before));
    // Once the wall steps back, a turn of the stepped wall at a time,
    // ending on the turn it reads at the last, never 10 s ahead of it.
    expect(after).toEqual(after.map((_, i) => after[0]! + i));
    expect(after.at(-1)).toBe(
      beatAt(START_MS + BEFORE_MS + AFTER_MS + STEP_MS),
    );
    // Each drawn within the timer's resolution of the stepped wall it was
    // drawn at.
    state.ats
      .slice(before)
      .forEach((at, i) =>
        expect(at * 1000 - (state.walls[before + i]! + STEP_MS)).toBeLessThan(
          10,
        ),
      );
  });
});

// [LAW:no-silent-failure] A feed's render that threw reaches a lane as a Frame
// saying so, with no failure branch in the lane.
test("a frame whose render threw is the failure's Frame, a still bar in the error glyph's words", () => {
  const parts = {
    clock: { monotonic: () => 0 },
    renderCache: {
      holdView: () => null,
      openFailure: () => ({ error: new Error("the view would not open") }),
    },
  } as unknown as DaemonParts;
  const frame = renderFrame(parts, S, 30, instantOf(new Date(START_MS)))!;
  expect(frame.bar).toEqual(renderFailedFrame("the view would not open"));
  expect(frame.bar.nextChange).toBe(Infinity);
  expect(frame.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: "the view would not open",
  });
});
