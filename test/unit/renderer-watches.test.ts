// [LAW:behavior-not-structure] The renderer's watches: each is held by the
// host under an id the renderer minted, and what the host pushes back is what
// the watch hears and how deaf it is.

import { Watches } from "../../src/renderer/watches";
import type { WatchId } from "../../src/renderer-interface/adapter";
import type {
  Deafness,
  Invalidation,
  WatchTargets,
} from "../../src/daemon/foundations/watch-targets";

const TARGETS: WatchTargets = { dirs: [{ path: "/w", filenames: ["a"] }] };
const DEAF: readonly Deafness[] = [
  { kind: "refused", path: "/w", reason: "EACCES" },
];

// A host that records what it was told and pushes nothing of its own.
function hostOf() {
  const told: string[] = [];
  const watches = new Watches({
    watch: (id, key) => told.push(`watch ${id} ${key}`),
    unwatch: (id) => told.push(`unwatch ${id}`),
  });
  return { told, watches };
}

test("a watch is told to the host by an id of its own, and its release is told once", () => {
  const { told, watches } = hostOf();
  const first = watches.acquire("k", TARGETS, () => {});
  const second = watches.acquire("k", TARGETS, () => {});
  first.release();
  first.release();
  expect(told).toEqual(["watch 1 k", "watch 2 k", "unwatch 1"]);
  second.release();
});

test("a push is what its watch hears, and its deafness stands until the next push", () => {
  const { watches } = hostOf();
  const heard: Invalidation[] = [];
  const handle = watches.acquire("k", TARGETS, (h) => heard.push(h));
  expect(handle.deaf).toEqual([]);
  // The acquire's own push says how deaf the watch is, and hears nothing.
  watches.pushed(1 as WatchId, null, DEAF);
  expect(handle.deaf).toEqual(DEAF);
  expect(heard).toEqual([]);
  // Listening again is told as a window that names nothing.
  watches.pushed(1 as WatchId, { kind: "unknown" }, []);
  expect(handle.deaf).toEqual([]);
  expect(heard).toEqual([{ kind: "unknown" }]);
});

test("a push for a watch released since it was sent reaches nothing", () => {
  const { watches } = hostOf();
  const heard: Invalidation[] = [];
  const handle = watches.acquire("k", TARGETS, (h) => heard.push(h));
  handle.release();
  watches.pushed(1 as WatchId, { kind: "changed", paths: ["/w/a"] }, DEAF);
  expect(heard).toEqual([]);
  expect(handle.deaf).toEqual([]);
});

test("following a spec keeps the watch under the same key, and rebinds under another", () => {
  const { told, watches } = hostOf();
  const spec = (key: string) => ({ key, targets: TARGETS, unbound: false });
  const { watch } = watches.follow(null, spec("a"), () => {});
  expect(watches.follow(watch, spec("a"), () => {}).move).toBe("kept");
  const moved = watches.follow(watch, spec("b"), () => {});
  expect(moved.move).toBe("rebound");
  // The new key's watch is told before the old one is released.
  expect(told).toEqual(["watch 1 a", "watch 2 b", "unwatch 1"]);
  moved.watch.handle.release();
});
