// A status line's link-id table (src/tmux-status/link-ids.ts): one id per
// link for as long as the table holds it, the least recently drawn dropped
// past the cap.

import { tmuxStatusFrame } from "../../src/tmux-status/frames";
import { LinkIds } from "../../src/tmux-status/link-ids";
import { barOf } from "../helpers/drawn-frame";
import { countedIds } from "../helpers/link-ids";

describe("LinkIds", () => {
  test("an animating row keeps its link's id and mints nothing after its first frame", () => {
    const ids = countedIds();
    const table = new LinkIds(ids);
    const link = "cc-candybar://to/main/dispatch/abc";
    const ranges = Array.from({ length: 30 }, (_, i) =>
      Object.keys(
        tmuxStatusFrame(barOf([{ text: `frame ${i}`, fg: `color(${i % 16})`, link }]), table)
          .links,
      ),
    );
    expect(new Set(ranges.flat()).size).toBe(1);
    expect(ids.counts).toEqual({ minted: 1, reused: 29, evicted: 0 });
  });

  // One frame drawing `urls`, each its range.
  const drawn = (table: LinkIds, ...urls: string[]) =>
    table.frame((rangeOf) => urls.map(rangeOf));

  test("past its cap the least recently drawn link goes, and drawn again it is a new, later id", () => {
    const ids = countedIds();
    const table = new LinkIds(ids, 2);
    const [a] = drawn(table, "a");
    const [b] = drawn(table, "b");
    // Drawing `a` again makes `b` the least recently drawn.
    expect(drawn(table, "a")).toEqual([a]);
    const [c] = drawn(table, "c");
    expect(ids.counts.evicted).toBe(1);
    expect(drawn(table, "a")).toEqual([a]);
    const [again] = drawn(table, "b");
    expect(again).not.toBe(b);
    expect(new Set([a, b, c, again]).size).toBe(4);
    expect(parseInt(again!.slice(3), 36)).toBeGreaterThan(parseInt(c!.slice(3), 36));
  });

  test("a row of more links than the cap keeps every id it draws, frame after frame", () => {
    const ids = countedIds();
    const table = new LinkIds(ids, 2);
    const first = drawn(table, "a", "b", "c");
    expect(drawn(table, "a", "b", "c")).toEqual(first);
    expect(ids.counts).toMatchObject({ minted: 3, evicted: 0 });
    // A frame that drops one lets the table fall back to its cap.
    drawn(table, "b", "c");
    expect(ids.counts.evicted).toBe(1);
  });

  test("a link the counter could not mint is not held, so it is minted once the counter can", () => {
    const ids = countedIds();
    const table = new LinkIds(ids);
    ids.faulted = true;
    expect(drawn(table, "a")).toEqual([null]);
    ids.faulted = false;
    expect(drawn(table, "a")).toEqual(["ccb0"]);
  });
});
