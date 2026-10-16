// The frame clock of src/daemon/frame-feed.ts, over a render that answers at
// once: frames fall due a period apart (the moving period while the bar
// moves, the still one otherwise), a change draws the next frame at once, two
// subscribers share each render, and a feed with no subscriber draws nothing.

import { FrameFeeds, type FeedFrame } from "../src/daemon/frame-feed";
import type { Response } from "../src/daemon/protocol";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PERIODS = { moving: 20, still: 400 };

// A feed over a render whose bar moves while `moving` says so, every frame a
// new one while it does. `renders` counts the renders, `changes` the watches'
// change callbacks, by session.
function harness(opts: { moving: boolean; renderMs?: number }) {
  const state = { moving: opts.moving, renders: 0, n: 0 };
  const changes = new Map<string, () => void>();
  const log: string[] = [];
  const feeds = new FrameFeeds<string>({
    render: async (req): Promise<FeedFrame> => {
      state.renders++;
      if (opts.renderMs !== undefined) await sleep(opts.renderMs);
      const n = state.moving ? ++state.n : state.n;
      return {
        resp: { ok: true, output: `${req}#${n}` },
        moving: state.moving,
      };
    },
    watch: (sessionId, onChange) => {
      changes.set(sessionId, onChange);
      return () => changes.delete(sessionId);
    },
    periods: PERIODS,
    now: () => Date.now(),
    log: (_level, line) => log.push(line),
  });
  return { feeds, state, changes, log };
}

const outputOf = (resp: Response): string =>
  resp.ok && "output" in resp ? resp.output : JSON.stringify(resp);

test("a moving bar is drawn a moving period apart, every new frame pushed", async () => {
  const { feeds } = harness({ moving: true });
  feeds.note("s", "bar");
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
  const { feeds, state, changes } = harness({ moving: false });
  feeds.note("s", "bar");
  const got: string[] = [];
  const close = feeds.subscribe("s", (r) => got.push(outputOf(r)));
  await sleep(100);
  expect(state.renders).toBe(1);
  expect(got).toEqual(["bar#0"]);
  // A change to the session draws at once, inside the still period.
  state.moving = true;
  changes.get("s")!();
  state.moving = false;
  await sleep(50);
  expect(got).toEqual(["bar#0", "bar#1"]);
  close();
});

test("a new request draws at once, and two subscribers share every render", async () => {
  const { feeds, state } = harness({ moving: false });
  const a: string[] = [];
  const b: string[] = [];
  const closeA = feeds.subscribe("s", (r) => a.push(outputOf(r)));
  await sleep(50);
  expect(state.renders).toBe(0);
  feeds.note("s", "first");
  await sleep(20);
  const closeB = feeds.subscribe("s", (r) => b.push(outputOf(r)));
  // The newcomer gets the bar as it stands, before any new render.
  expect(b).toEqual(["first#0"]);
  await sleep(20);
  feeds.note("s", "second");
  await sleep(20);
  expect(a).toEqual(["first#0", "second#0"]);
  expect(b).toEqual(["first#0", "second#0"]);
  closeA();
  closeB();
});

test("a render slower than the period is followed by the next at once, and a change during it by one more", async () => {
  const { feeds, state, changes } = harness({ moving: true, renderMs: 60 });
  feeds.note("s", "bar");
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
  const { feeds, state, changes, log } = harness({ moving: true });
  feeds.note("s", "bar");
  const close = feeds.subscribe("s", () => {});
  await sleep(100);
  close();
  const drawn = state.renders;
  await sleep(100);
  expect(state.renders).toBe(drawn);
  expect(changes.has("s")).toBe(false);
  expect(feeds.getStats()).toMatchObject({ feeds: 0, subscribers: 0 });
  expect(log.at(-1)).toMatch(
    /^feed sid="s" closed subscribers=0 .* drawn=\d+ pushed=\d+/,
  );
  // A request noted for a session nobody watches draws nothing.
  feeds.note("s", "again");
  await sleep(50);
  expect(state.renders).toBe(drawn);
});
