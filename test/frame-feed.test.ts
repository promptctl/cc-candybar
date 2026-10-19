// The frame clock of src/daemon/frame-feed.ts, over a render that answers at
// once: frames fall due a period apart (the moving period while the bar moves
// where someone can see it, the still one otherwise), a change draws the next
// frame at once, a request's own answer is pushed as its frame, two
// subscribers share each render, and a feed with no subscriber draws nothing.

import {
  FrameFeeds,
  type FeedFrame,
  type Motion,
  type Refusal,
  type Subscriber,
} from "../src/daemon/frame-feed";
import type { Response } from "../src/daemon/protocol";
import type { Lane, LaneSwitches } from "../src/config/lanes";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PERIODS = { moving: 20, still: 400 };

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
    lanes: { band: true, statusline: true, pane: true } as LaneSwitches,
    // A drawn frame that resolved no switches, as a render that threw.
    unresolved: false,
  };
  const frameOf = (req: string): FeedFrame & { lanes: LaneSwitches } =>
    opts.fails === true
      ? {
          resp: { ok: false, error: `${req} threw`, code: "RENDER_FAILED" },
          drawnAt: Date.now(),
          motion: "still",
          lanes: state.lanes,
          failure: { level: "error", line: `frame ${req} threw` },
        }
      : {
          resp: { ok: true, output: `${req}#${state.motion === "still" ? state.n : ++state.n}` },
          drawnAt: Date.now(),
          motion: state.motion,
          lanes: state.lanes,
          failure: null,
        };
  const changes = new Map<string, () => void>();
  const log: string[] = [];
  const feeds = new FrameFeeds<string>({
    render: async (req): Promise<FeedFrame> => {
      state.renders++;
      if (opts.renderMs !== undefined) await sleep(opts.renderMs);
      const frame = frameOf(req);
      return state.unresolved ? { ...frame, lanes: null } : frame;
    },
    watch: (sessionId, onChange) => {
      changes.set(sessionId, onChange);
      return () => changes.delete(sessionId);
    },
    periods: PERIODS,
    now: () => Date.now(),
    log: (_level, line) => log.push(line),
  });
  const note = (sessionId: string, req: string, order = ++state.order): void =>
    feeds.note(sessionId, req, order, frameOf(req));
  return { feeds, note, state, changes, log };
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
    resp: { ok: true, output: "drawn before the frame out" },
    drawnAt: Date.now() - 60_000,
    motion: "still",
    lanes: state.lanes,
    failure: null,
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
  feeds.note("s", "moving", ++state.order, {
    resp: { ok: true, output: "moving#1" },
    drawnAt: Date.now(),
    motion: "moving",
    lanes: state.lanes,
    failure: null,
  });
  // The still frame finishes at 30 ms; the next is due a moving period (20 ms)
  // after the noted one, not a still period (400 ms) after the still one.
  await sleep(150);
  close();
  expect(state.renders).toBeGreaterThanOrEqual(2);
});

// The lane toggles (candybar-animation-wbxz.81o.azo): FrameFeeds is the one
// gate, reading the lanes the session's newest frame resolved.
describe("a subscription's lane", () => {
  test("switched off in the session's newest frame is refused before any feed opens", async () => {
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
        error: expect.stringContaining("globals.experimentalBand"),
      }),
    ]);
    expect(frames).toEqual([]);
    expect(state.renders).toBe(0);
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0, refused: 1 });
    expect(log).toContain('feed sid="s" refused lane=band switched-off');
  });

  test("switched off by a later frame ends that subscriber and leaves the other lanes' running", async () => {
    const { feeds, note, state, changes } = harness({ motion: "still" });
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
    closePane();
    expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
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

  test("a drawn frame that resolved no switches keeps the ones the last frame did", async () => {
    const { feeds, note, state, changes } = harness({ motion: "still" });
    note("s", "bar");
    const refusals: Refusal[] = [];
    const frames: string[] = [];
    feeds.subscribe("s", sub((r) => frames.push(outputOf(r)), "band", (r) => refusals.push(r)));
    await sleep(20);
    state.lanes = { band: false, statusline: true, pane: true };
    state.unresolved = true;
    state.motion = "moving";
    changes.get("s")!();
    await sleep(40);
    expect(refusals).toEqual([]);
    expect(frames.length).toBeGreaterThan(1);
  });
});
