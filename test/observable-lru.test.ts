// [LAW:behavior-not-structure] The bounded map behind every owner whose
// refresh finds its value standing most of the time: a use keeps a key from
// eviction and wakes nobody; only a new value wakes the key's readers.

import { autorun } from "mobx";
import { ObservableLru } from "../src/utils/observable-lru";

test("a use or an identical value wakes no reader; a new value wakes only its key's", () => {
  const lru = new ObservableLru<string, { n: number }>(4);
  const a = { n: 1 };
  lru.set("a", a);
  lru.set("b", { n: 2 });
  const woke = { a: 0, b: 0 };
  const stops = (["a", "b"] as const).map((key) =>
    autorun(() => {
      lru.get(key);
      woke[key]++;
    }),
  );
  try {
    lru.touch("a");
    lru.set("a", a);
    expect(woke).toEqual({ a: 1, b: 1 });
    lru.set("a", { n: 3 });
    expect(woke).toEqual({ a: 2, b: 1 });
  } finally {
    for (const stop of stops) stop();
  }
});

test("past its bound the least recently used key goes, a touched one stays", () => {
  const lru = new ObservableLru<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.touch("a");
  lru.set("c", 3);
  expect([lru.get("a"), lru.get("b"), lru.get("c")]).toEqual([1, undefined, 3]);
  expect(lru.size).toBe(2);
});
