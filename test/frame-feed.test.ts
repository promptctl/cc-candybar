// The frame clock of src/daemon/frame-feed.ts, over a render that answers at
// once: frames fall due a period apart (the moving period while the bar moves
// where someone can see it, the still one otherwise), a change draws the next
// frame at once, a request's own answer is pushed as its frame, two
// subscribers share each render, and a feed with no subscriber draws nothing.

import { FrameFeeds, type FeedFrame, type Motion } from "../src/daemon/frame-feed";
import type { Response } from "../src/daemon/protocol";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PERIODS = { moving: 20, still: 400 };

// A feed over a render whose bar moves as `motion` says, every frame a new
// one while it does. `renders` counts the renders, `changes` the watches'
// change callbacks, by session. `note` notes a request with the answer a
// request's own render would give, as the daemon does.
function harness(opts: { motion: Motion; renderMs?: number }) {
  const state = { motion: opts.motion, renders: 0, n: 0 };
  const frameOf = (req: string): FeedFrame => ({
    resp: { ok: true, output: `${req}#${state.motion === "still" ? state.n : ++state.n}` },
    motion: state.motion,
  });
  const changes = new Map<string, () => void>();
  const log: string[] = [];
  const feeds = new FrameFeeds<string>({
    render: async (req): Promise<FeedFrame> => {
      state.renders++;
      if (opts.renderMs !== undefined) await sleep(opts.renderMs);
      return frameOf(req);
    },
    watch: (sessionId, onChange) => {
      changes.set(sessionId, onChange);
      return () => changes.delete(sessionId);
    },
    periods: PERIODS,
    now: () => Date.now(),
    log: (_level, line) => log.push(line),
  });
  const note = (sessionId: string, req: string): void =>
    feeds.note(sessionId, req, frameOf(req));
  return { feeds, note, state, changes, log };
}

const outputOf = (resp: Response): string =>
  resp.ok && "output" in resp ? resp.output : JSON.stringify(resp);

test("a moving bar is drawn a moving period apart, every new frame pushed", async () => {
  const { feeds, note } = harness({ motion: "moving" });
  note("s", "bar");
  const got: string[] = [];
  const close = feeds.subscribe("s", (r) => got.push(outputOf(r)));
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
  const close = feeds.subscribe("s", (r) => got.push(outputOf(r)));
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
  const closeA = feeds.subscribe("s", (r) => a.push(outputOf(r)));
  await sleep(50);
  expect(state.renders).toBe(0);
  note("s", "first");
  // Its answer is its frame: nothing is drawn again for it.
  expect(state.renders).toBe(0);
  await sleep(20);
  const closeB = feeds.subscribe("s", (r) => b.push(outputOf(r)));
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
  const close = feeds.subscribe("s", () => {});
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
  const close = feeds.subscribe("s", () => {});
  await sleep(100);
  close();
  const drawn = state.renders;
  await sleep(100);
  expect(state.renders).toBe(drawn);
  expect(changes.has("s")).toBe(false);
  expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  expect(log.at(-1)).toMatch(
    /^feed sid="s" closed subscribers=0 .* drawn=(\d+) noted=0 moving=\1 unseen=0 pushed=\d+/,
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
  const close = feeds.subscribe("s", (r) => got.push(outputOf(r)));
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
  const close = feeds.subscribe("s", () => {});
  await sleep(500);
  close();
  // Drawn at 0 and 400 ms: the still period, not the 20 ms a moving bar gets.
  expect(state.renders).toBe(2);
  expect(log.at(-1)).toMatch(/ drawn=2 noted=0 moving=0 unseen=2 /);
});

test("a noted answer counts as the feed's frame, and the next falls due a period after it", async () => {
  const { feeds, note, state, log } = harness({ motion: "still" });
  const got: string[] = [];
  const close = feeds.subscribe("s", (r) => got.push(outputOf(r)));
  note("s", "bar");
  await sleep(200);
  expect(state.renders).toBe(0);
  await sleep(300);
  close();
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  expect(log.at(-1)).toMatch(/ drawn=1 noted=1 moving=0 unseen=0 pushed=1 /);
});
