// The frame clock of src/daemon/frame-feed.ts, over a render that answers at
// once: frames fall due a period apart (the moving period while the bar moves
// where someone can see it, the still one otherwise), a change draws the next
// frame at once, a request's own answer is pushed as its frame, two
// subscribers share each render, and a feed with no subscriber draws nothing.

import {
  feedsFact,
  FrameFeeds,
  type FeedFrame,
  type Refusal,
  type Subscriber,
} from "../src/daemon/frame-feed";
import type { Response } from "../src/daemon/protocol";
import {
  UNFOLLOWED,
  UNFOLLOWED_FEEDS,
  type Lane,
  type LaneSwitches,
} from "../src/config/lanes";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PERIODS = { moving: 20, still: 400 };

// How the harness's bar moves: on a screen, where nobody can see it, or not at
// all. A frame says only whether it moves; the feed asks whether it is shown.
type Motion = "moving" | "unseen" | "still";

// A feed over a render whose bar moves as `motion` says, every frame a new
// one while it does. `renders` counts the renders, `changes` the watches'
// change callbacks, by session. `note` notes a request with the answer a
// request's own render would give, as the daemon does.
function harness(opts: { motion: Motion; renderMs?: number; fails?: boolean }) {
  const state = {
    motion: opts.motion,
    renders: 0,
    n: 0,
    order: 0,
    // The lanes the session's settings switch on, read by the feed when it
    // asks; `opened` counts the times the feeds began to watch, `stopped` the
    // times they stopped.
    lanes: { band: true, statusline: true, pane: true } as LaneSwitches,
    opened: 0,
    stopped: 0,
    // A lane gate that throws, as a daemon bug in reading the settings would.
    gateThrows: false,
    // Added to the feed's clock, to reach the once-a-minute summary.
    skewMs: 0,
    // What Claude Code's statusline shows in the bar's place while a lane
    // draws it elsewhere; null while it shows the bar.
    handoff: null as string | null,
  };
  const frameOf = (req: string): FeedFrame =>
    opts.fails === true
      ? failedFrame(req)
      : barFrame(
          `${req}#${state.motion === "still" ? state.n : ++state.n}`,
          state.motion !== "still",
          state.handoff,
        );
  const changes = new Map<string, () => void>();
  const log: string[] = [];
  const feeds = new FrameFeeds<string>({
    render: async (req): Promise<FeedFrame> => {
      state.renders++;
      if (opts.renderMs !== undefined) await sleep(opts.renderMs);
      return frameOf(req);
    },
    lanes: () => {
      if (state.gateThrows) throw new Error("the gate broke");
      return state.lanes;
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
    periods: PERIODS,
    now: () => Date.now() + state.skewMs,
    log: (_level, line) => log.push(line),
  });
  const note = (sessionId: string, req: string, order = ++state.order): void =>
    feeds.note(sessionId, req, order, frameOf(req));
  return { feeds, note, state, changes, log };
}

// A frame drawing `output`, whose statusline shows `handoff` in its place, if
// any.
function barFrame(
  output: string,
  moves: boolean,
  handoff: string | null = null,
): FeedFrame {
  return {
    resp: { ok: true, output },
    statusline: { ok: true, output: handoff ?? output },
    drawnAt: Date.now(),
    moves,
    failure: null,
  };
}

function failedFrame(req: string): FeedFrame {
  const resp: Response = { ok: false, error: `${req} threw`, code: "RENDER_FAILED" };
  return {
    resp,
    statusline: resp,
    drawnAt: Date.now(),
    moves: false,
    failure: { level: "error", line: `frame ${req} threw` },
  };
}

// A subscriber of `lane` whose frames go to `frame` and whose refusal, if
// any, to `refused`.
const sub = (
  frame: (resp: Response) => unknown,
  lane: Lane = "band",
  refused: (resp: Refusal) => unknown = () => {},
): Subscriber => ({ lane, frame, refused });

const outputOf = (resp: Response): string =>
  resp.ok && "output" in resp ? resp.output : JSON.stringify(resp);

// brandon-menus-sjhy.amf — Brandon: "When we're showing the bar in either the
// mod or the tmux pane, we should NOT show the original bar except a single
// line". The statusline lane draws in Claude Code's statusline, so while
// another lane draws the bar it is sent the handoff line, once, however the
// bar moves.
test("while a lane draws the bar elsewhere, the statusline lane is sent the handoff line once, and the band the moving bar", async () => {
  const { feeds, note, state } = harness({ motion: "moving" });
  state.handoff = "the bar is drawn in the band";
  note("s", "bar");
  const band: string[] = [];
  const statusline: string[] = [];
  const closeBand = feeds.subscribe("s", sub((r) => band.push(outputOf(r))));
  const closeLine = feeds.subscribe(
    "s",
    sub((r) => statusline.push(outputOf(r)), "statusline"),
  );
  await sleep(200);
  state.handoff = null;
  await sleep(100);
  closeBand();
  closeLine();
  expect(band.length).toBeGreaterThan(3);
  expect(band.every((b) => b.startsWith("bar#"))).toBe(true);
  // The handoff line, then the moving bar once nothing draws it elsewhere.
  expect(statusline[0]).toBe("the bar is drawn in the band");
  expect(statusline.filter((l) => l === "the bar is drawn in the band")).toHaveLength(1);
  expect(statusline.length).toBeGreaterThan(2);
  expect(statusline.slice(1).every((l) => l.startsWith("bar#"))).toBe(true);
});

test("a moving bar is drawn a moving period apart, every new frame pushed", async () => {
  const { feeds, note } = harness({ motion: "moving" });
  note("s", "bar");
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  await sleep(500);
  close();
  // 25 frames in 500 ms at 20 ms; a loaded box draws fewer, never more.
  expect(got.length).toBeGreaterThanOrEqual(10);
  expect(got.length).toBeLessThanOrEqual(26);
  expect(new Set(got).size).toBe(got.length);
});

test("a still bar is drawn a still period apart and pushed only when it changes", async () => {
  const { feeds, note, state, changes } = harness({ motion: "still" });
  note("s", "bar");
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  await sleep(100);
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  // A change to the session draws at once, inside the still period.
  state.motion = "moving";
  changes.get("s")!();
  state.motion = "still";
  await sleep(50);
  expect(got).toEqual(["bar#0", "bar#1"]);
  close();
});

test("a new request is pushed at once as its own answer, and two subscribers share every frame", async () => {
  const { feeds, note, state } = harness({ motion: "still" });
  const a: string[] = [];
  const b: string[] = [];
  const closeA = feeds.subscribe("s", sub((r) => a.push(outputOf(r))));
  await sleep(50);
  expect(state.renders).toBe(0);
  note("s", "first");
  // Its answer is its frame: nothing is drawn again for it.
  expect(state.renders).toBe(0);
  await sleep(20);
  const closeB = feeds.subscribe("s", sub((r) => b.push(outputOf(r))));
  // The newcomer gets the bar as it stands, before any new render.
  expect(b).toEqual(["first#0"]);
  await sleep(20);
  note("s", "second");
  await sleep(20);
  expect(state.renders).toBe(0);
  expect(a).toEqual(["first#0", "second#0"]);
  expect(b).toEqual(["first#0", "second#0"]);
  closeA();
  closeB();
});

test("a render slower than the period is followed by the next at once, and a change during it by one more", async () => {
  const { feeds, note, state, changes } = harness({ motion: "moving", renderMs: 60 });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(10);
  changes.get("s")!();
  changes.get("s")!();
  await sleep(300);
  close();
  // Back to back: about five 60 ms renders in 310 ms, the changes folded
  // into the one being drawn rather than piling up.
  expect(state.renders).toBeGreaterThanOrEqual(3);
  expect(state.renders).toBeLessThanOrEqual(6);
});

test("the last subscriber leaving stops the feed and logs what it drew", async () => {
  const { feeds, note, state, changes, log } = harness({ motion: "moving" });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(100);
  close();
  const drawn = state.renders;
  await sleep(100);
  expect(state.renders).toBe(drawn);
  expect(changes.has("s")).toBe(false);
  expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  expect(log.at(-1)).toMatch(
    /^feed sid="s" closed subscribers=0 .* drawn=(\d+) noted=0 moving=\1 unseen=0 failed=0 pushed=\d+/,
  );
  // A request noted for a session nobody watches draws nothing.
  note("s", "again");
  await sleep(50);
  expect(state.renders).toBe(drawn);
});

test("a request noted while a frame is drawn is pushed, and that frame, of the data before it, is not", async () => {
  const { feeds, note, state } = harness({ motion: "still", renderMs: 60 });
  note("s", "old");
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  await sleep(10);
  expect(state.renders).toBe(1);
  note("s", "new");
  await sleep(100);
  close();
  expect(got).toEqual(["new#0"]);
});

test("a bar that moves where nobody can see it is drawn at the still rate, and its feed counts it", async () => {
  const { feeds, note, state, log } = harness({ motion: "unseen" });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(500);
  close();
  // Drawn at 0 and 400 ms: the still period, not the 20 ms a moving bar gets.
  expect(state.renders).toBe(2);
  expect(log.at(-1)).toMatch(/ drawn=2 noted=0 moving=0 unseen=2 failed=0 /);
});

test("a noted answer counts as the feed's frame, and the next falls due a period after it", async () => {
  const { feeds, note, state, log } = harness({ motion: "still" });
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  note("s", "bar");
  await sleep(200);
  expect(state.renders).toBe(0);
  await sleep(300);
  close();
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  expect(log.at(-1)).toMatch(/ drawn=1 noted=1 moving=0 unseen=0 failed=0 pushed=1 /);
});

test("a request that arrived before the one held is not the session's data, however late its render finishes", async () => {
  const { feeds, note } = harness({ motion: "still" });
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  note("s", "newer", 2);
  note("s", "older", 1);
  await sleep(20);
  close();
  expect(got).toEqual(["newer#0"]);
});

test("a watched session's request outlives the eviction of the least recently noted", async () => {
  const { feeds, note, state, changes } = harness({ motion: "still" });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(20);
  for (let i = 0; i < 300; i++) note(`other-${i}`, "x");
  const drawn = state.renders;
  changes.get("s")!();
  await sleep(20);
  close();
  expect(state.renders).toBe(drawn + 1);
});

test("a frame that keeps failing the same way is logged once, and counted every time", async () => {
  const { feeds, note, changes, log } = harness({ motion: "still", fails: true });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(20);
  changes.get("s")!();
  await sleep(20);
  close();
  expect(log.filter((l) => l === "frame bar threw")).toHaveLength(1);
  expect(log.at(-1)).toMatch(/ drawn=2 .* failed=2 pushed=1 /);
});

test("an answer drawn at an earlier instant than the frame already out is drawn afresh, not pushed", async () => {
  const { feeds, note, state } = harness({ motion: "still" });
  note("s", "bar");
  const got: string[] = [];
  const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
  await sleep(20);
  expect(got).toEqual(["bar#0"]);
  const renders = state.renders;
  feeds.note("s", "newer", ++state.order, {
    ...barFrame("drawn before the frame out", false),
    drawnAt: Date.now() - 60_000,
  });
  await sleep(20);
  close();
  expect(state.renders).toBe(renders + 1);
  expect(got).toEqual(["bar#0", "newer#0"]);
});

test("a moving answer noted while a still frame is drawn sets the pace of the next", async () => {
  const { feeds, note, state } = harness({ motion: "still", renderMs: 30 });
  note("s", "bar");
  const close = feeds.subscribe("s", sub(() => {}));
  await sleep(5);
  feeds.note("s", "moving", ++state.order, barFrame("moving#1", true));
  // The still frame finishes at 30 ms; the next is due a moving period (20 ms)
  // after the noted one, not a still period (400 ms) after the still one.
  await sleep(150);
  close();
  expect(state.renders).toBeGreaterThanOrEqual(2);
});

// On a faked clock, so a count of frames is exact.
describe("on a faked clock", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const pass = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms);

  // Whether anyone can see a bar is the feed's question, asked as it sets the
  // next frame: one that comes into view is drawn at the moving rate from then.
  test("a moving bar that comes into view is drawn at the moving rate from then", async () => {
    const { feeds, note, state, log } = harness({ motion: "unseen" });
    note("s", "bar");
    const close = feeds.subscribe("s", sub(() => {}));
    await pass(50);
    expect(state.renders).toBe(1);
    state.motion = "moving";
    feeds.wakeWhere(() => true);
    // Drawn at once at 50 ms, then a moving period apart through 150.
    await pass(100);
    close();
    expect(state.renders).toBe(7);
    expect(log.at(-1)).toMatch(/ moving=6 unseen=1 /);
  });

  test("wakeWhere draws at once only the watched sessions it matches", async () => {
    const { feeds, note, state } = harness({ motion: "still" });
    note("a", "%1:a");
    note("b", "%2:b");
    note("c", "%1:c");
    const closeA = feeds.subscribe("a", sub(() => {}));
    const closeB = feeds.subscribe("b", sub(() => {}));
    await pass(20);
    expect(state.renders).toBe(2);
    // c matches but nobody watches it, so nothing is drawn for it.
    feeds.wakeWhere((req) => req.startsWith("%1:"));
    await pass(20);
    closeA();
    closeB();
    expect(state.renders).toBe(3);
  });
});

// What runs while any feed exists (the tmux visibility loop) starts with the
// first feed and stops with the last, not a moment later.
test("the feeds watch from the first feed opening to the last closing", async () => {
  const { feeds, note, state } = harness({ motion: "still" });
  note("a", "x");
  note("b", "y");
  expect(state.opened).toBe(0);
  const closeA = feeds.subscribe("a", sub(() => {}));
  const closeA2 = feeds.subscribe("a", sub(() => {}));
  const closeB = feeds.subscribe("b", sub(() => {}));
  expect([state.opened, state.stopped]).toEqual([1, 0]);
  closeA();
  closeA2();
  expect([state.opened, state.stopped]).toEqual([1, 0]);
  closeB();
  expect([state.opened, state.stopped]).toEqual([1, 1]);
  feeds.subscribe("a", sub(() => {}))();
  expect([state.opened, state.stopped]).toEqual([2, 2]);
});

// The lane toggles (candybar-animation-wbxz.81o.azo): FrameFeeds is the one
// gate, reading the lanes the session's settings switch on as it asks.
describe("a subscription's lane", () => {
  test("switched off in the session's settings is refused before any feed opens", async () => {
    const { feeds, note, state, log } = harness({ motion: "moving" });
    state.lanes = { band: false, statusline: true, pane: true };
    note("s", "bar");
    const refusals: Refusal[] = [];
    const frames: string[] = [];
    feeds.subscribe("s", sub((r) => frames.push(outputOf(r)), "band", (r) => refusals.push(r)));
    await sleep(50);
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
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0, refused: 1 });
    expect(log).toContain('feed sid="s" refused lane=band switched-off');
  });

  test("switched off while it streams ends that subscriber and leaves the other lanes' running", async () => {
    const { feeds, note, state, changes, log } = harness({ motion: "still" });
    note("s", "bar");
    const band: string[] = [];
    const pane: string[] = [];
    const refusals: Refusal[] = [];
    feeds.subscribe("s", sub((r) => band.push(outputOf(r)), "band", (r) => refusals.push(r)));
    const closePane = feeds.subscribe("s", sub((r) => pane.push(outputOf(r)), "pane"));
    await sleep(30);
    state.lanes = { band: false, statusline: true, pane: true };
    state.motion = "moving"; // the next frame differs, so it is pushed
    changes.get("s")!();
    await sleep(60);
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    const bandSeen = band.length;
    await sleep(60);
    expect(band.length).toBe(bandSeen);
    expect(pane.length).toBeGreaterThan(bandSeen);
    expect(feeds.getStats()).toMatchObject({ feeds: 1, subscribers: 1, refused: 1 });
    // Each subscribe names its lane; the running summary names the lanes still
    // subscribed when it is written.
    expect(log).toContain('feed sid="s" subscribed lane=band subscribers=1 data=Y');
    expect(log).toContain('feed sid="s" subscribed lane=pane subscribers=2 data=Y');
    state.skewMs = 60_000;
    changes.get("s")!();
    await sleep(30);
    expect(log.some((l) => /feed sid="s" running subscribers=1 lanes=pane /.test(l))).toBe(true);
    closePane();
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  });

  // [LAW:no-silent-failure] A frame step runs off a timer: a throw it let go
  // would be an unhandled rejection, which exits the daemon. It is the feed's
  // logged fault, and the feed draws on.
  test("a lane gate that throws while a frame goes out is the feed's logged fault, and the feed draws on", async () => {
    const { feeds, note, state, changes, log } = harness({ motion: "still" });
    note("s", "bar");
    const got: string[] = [];
    const close = feeds.subscribe("s", sub((r) => got.push(outputOf(r))));
    await sleep(20);
    state.gateThrows = true;
    changes.get("s")!();
    await sleep(20);
    expect(log.some((l) => l.startsWith('feed sid="s" threw: Error: the gate broke'))).toBe(true);
    expect(feeds.getStats()).toMatchObject({ feeds: 1, subscribers: 1 });
    state.gateThrows = false;
    state.motion = "moving";
    changes.get("s")!();
    await sleep(40);
    close();
    expect(got.length).toBeGreaterThan(1);
  });

  test("of a session with no frame yet waits, and the first frame decides", async () => {
    const { feeds, note, state } = harness({ motion: "still" });
    const refusals: Refusal[] = [];
    feeds.subscribe("s", sub(() => {}, "pane", (r) => refusals.push(r)));
    await sleep(20);
    expect(refusals).toEqual([]);
    state.lanes = { band: true, statusline: true, pane: false };
    note("s", "bar");
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  });

  // The switches are read when the gate asks, not copied from a frame: a
  // toggle turned on is honoured by the next subscribe, with no new request.
  test("turned on in the session's settings is honoured at once, with no frame between", async () => {
    const { feeds, note, state } = harness({ motion: "still" });
    state.lanes = { band: false, statusline: true, pane: true };
    note("s", "bar");
    const refusals: Refusal[] = [];
    feeds.subscribe("s", sub(() => {}, "band", (r) => refusals.push(r)));
    expect(refusals.map((r) => r.code)).toEqual(["SWITCHED_OFF"]);
    state.lanes = { band: true, statusline: true, pane: true };
    const frames: string[] = [];
    const close = feeds.subscribe("s", sub((r) => frames.push(outputOf(r))));
    await sleep(20);
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
  note("before-clear", "%3:a");
  note("elsewhere", "%4:a");
  note("after-clear", "%3:b");
  expect(feeds.newestWhere(fromPane)).toBe("after-clear");
  // A slow render of the old session arriving late is not newer.
  note("before-clear", "%3:late", 1);
  expect(feeds.newestWhere(fromPane)).toBe("after-clear");
  note("before-clear", "%3:c");
  expect(feeds.newestWhere(fromPane)).toBe("before-clear");
  expect(feeds.getStats()).toMatchObject({ lookups: 4, found: 3 });
});

// On a faked clock, so each lane's frame count is exact.
describe("feedsOf", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const pass = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms);
  // Frames a second a bar is pushed at, moving on a screen and otherwise.
  const MOVING = 1000 / PERIODS.moving;

  test("a session nobody follows is unfollowed on every lane", () => {
    const { feeds, note } = harness({ motion: "moving" });
    note("s", "bar");
    expect(feeds.feedsOf("s")).toEqual(UNFOLLOWED_FEEDS);
    expect(feedsFact(feeds.feedsOf("s"))).toBe("-");
  });

  test("counts each lane's subscribers and the frames pushed in the last second", async () => {
    const { feeds, note } = harness({ motion: "moving" });
    note("s", "bar");
    const closeA = feeds.subscribe("s", sub(() => {}, "statusline"));
    const closeB = feeds.subscribe("s", sub(() => {}, "statusline"));
    const closeC = feeds.subscribe("s", sub(() => {}, "pane"));
    await pass(1100);
    const now = feeds.feedsOf("s");
    expect(now.band).toEqual(UNFOLLOWED);
    // The window holds only the last second's frames, never the 1.1 s since
    // subscribing.
    expect(now.statusline).toEqual({ subscribers: 2, fps: MOVING, shown: true });
    expect(now.pane).toEqual({ subscribers: 1, fps: MOVING, shown: true });
    expect(feedsFact(now)).toBe(
      `statusline:2sub/${MOVING}fps/shown,pane:1sub/${MOVING}fps/shown`,
    );
    closeA();
    closeB();
    closeC();
    expect(feeds.feedsOf("s")).toEqual(UNFOLLOWED_FEEDS);
  });

  test("a lane is credited only with the frames sent since its first subscriber joined", async () => {
    const { feeds, note } = harness({ motion: "moving" });
    note("s", "bar");
    const closeA = feeds.subscribe("s", sub(() => {}, "statusline"));
    await pass(1000);
    const closeB = feeds.subscribe("s", sub(() => {}, "pane"));
    await pass(100);
    const now = feeds.feedsOf("s");
    closeA();
    closeB();
    expect(now.statusline.fps).toBe(MOVING);
    // The bar as it stood, handed over on joining, then each one pushed since.
    expect(now.pane.fps).toBe(1 + 100 / PERIODS.moving);
  });

  test("a lane whose answer stands still is credited with no frames while the bar moves", async () => {
    const { feeds, note, state } = harness({ motion: "moving" });
    state.handoff = "the bar is drawn in the band";
    note("s", "bar");
    const closeBand = feeds.subscribe("s", sub(() => {}, "band"));
    const closeLine = feeds.subscribe("s", sub(() => {}, "statusline"));
    await pass(1100);
    const now = feeds.feedsOf("s");
    closeBand();
    closeLine();
    expect(now.band.fps).toBe(MOVING);
    // The handoff line, sent once on joining and never again.
    expect(now.statusline.fps).toBe(0);
  });

  test("a pane off screen is drawn at the still rate, and says so", async () => {
    const { feeds, note } = harness({ motion: "unseen" });
    note("s", "bar");
    const close = feeds.subscribe("s", sub(() => {}, "statusline"));
    await pass(1100);
    const { statusline } = feeds.feedsOf("s");
    close();
    // Pushed at 400 and 800 ms, a still period apart, inside the window.
    expect(statusline).toEqual({ subscribers: 1, fps: 2, shown: false });
    expect(feedsFact({ ...UNFOLLOWED_FEEDS, statusline })).toBe(
      "statusline:1sub/2fps/offscreen",
    );
  });
});
