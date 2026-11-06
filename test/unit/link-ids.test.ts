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

  test("past its cap the least recently drawn link goes, and drawn again it is a new, later id", () => {
    const ids = countedIds();
    const table = new LinkIds(ids, 2);
    const a = table.rangeOf("a");
    const b = table.rangeOf("b");
    // Drawing `a` again makes `b` the least recently drawn.
    expect(table.rangeOf("a")).toBe(a);
    const c = table.rangeOf("c");
    expect(ids.counts.evicted).toBe(1);
    expect(table.rangeOf("a")).toBe(a);
    const again = table.rangeOf("b");
    expect(again).not.toBe(b);
    expect(new Set([a, b, c, again]).size).toBe(4);
    expect(parseInt(again!.slice(3), 36)).toBeGreaterThan(parseInt(c!.slice(3), 36));
  });

  test("a link the counter could not mint is not held, so it is minted once the counter can", () => {
    const ids = countedIds();
    const table = new LinkIds(ids);
    ids.faulted = true;
    expect(table.rangeOf("a")).toBeNull();
    ids.faulted = false;
    expect(table.rangeOf("a")).toBe("ccb0");
  });
});
