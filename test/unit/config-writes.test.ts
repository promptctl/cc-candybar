// [LAW:verifiable-goals] A click lands whole or not at all: its writes leave
// as changes, one per file, and what else it did waits for every one of them
// to land, or is told why one did not.

import { ConfigWrites } from "../../src/renderer/config-writes";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import type {
  Effect,
  EffectId,
} from "../../src/renderer-interface/interface";

const SID = sessionIdOf("s1");
const DISK: Record<string, string> = {
  "/a.json5": "{ a: 1 }\n",
  "/b.json5": "{ b: 1 }\n",
};

function writes() {
  let minted = 0;
  return new ConfigWrites(
    () => ++minted as EffectId,
    (file) => DISK[file] ?? null,
  );
}

// A click's landing that answers no refusal.
const landing = (consequence: () => unknown) => ({
  consequence: () => void consequence(),
  refused: () => {},
});

const ids = (effects: readonly Effect[]): EffectId[] =>
  effects.map((e) => e.id);

describe("a click's config writes", () => {
  test("a click that changed no file has its consequence at once", () => {
    const w = writes();
    const effects: Effect[] = [];
    let applied = false;
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: DISK["/a.json5"]! }]);
    w.seal(effects, SID, landing(() => (applied = true)));
    expect(effects).toEqual([]);
    expect(applied).toBe(true);
  });

  test("a click reads its own writes, and the disk for the rest", () => {
    const w = writes();
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    expect(w.read("/a.json5")).toBe("{ a: 2 }\n");
    expect(w.read("/b.json5")).toBe(DISK["/b.json5"]);
  });

  test("two writes to one file are one change, from the first read to the last write", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    w.land([{ file: "/a.json5", before: "{ a: 2 }\n", after: "{ a: 3 }\n" }]);
    w.seal(effects, SID, landing(() => {}));
    expect(effects).toEqual([
      {
        kind: "change",
        id: 1,
        session: SID,
        target: { kind: "layer", path: "/a.json5" },
        changes: [
          {
            op: "replace",
            at: ["a"],
            text: "3",
            read: { kind: "value", text: "1" },
          },
        ],
      },
    ]);
  });

  test("the consequence waits for every change, and the next turn waits with it", async () => {
    const w = writes();
    const effects: Effect[] = [];
    let applied = false;
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    w.land([{ file: "/b.json5", before: DISK["/b.json5"]!, after: "{ b: 2 }\n" }]);
    w.seal(effects, SID, landing(() => (applied = true)));
    const [a, b] = ids(effects);
    let opened = false;
    const next = w.landed().then(() => (opened = true));
    expect(w.settled(a!, { kind: "ok" })).toBe("owed");
    await Promise.resolve();
    expect(opened).toBe(false);
    const landed = w.settled(b!, { kind: "ok" });
    expect(landed).toMatchObject({
      session: SID,
      files: ["/a.json5", "/b.json5"],
      outcome: { kind: "ok" },
    });
    expect(applied).toBe(false);
    if (landed === undefined || landed === "owed") throw new Error("unlanded");
    landed.consequence();
    expect(applied).toBe(true);
    await next;
    expect(opened).toBe(true);
  });

  test("a landing that missed reports why, though a later change landed", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    w.land([{ file: "/b.json5", before: DISK["/b.json5"]!, after: "{ b: 2 }\n" }]);
    w.seal(effects, SID, landing(() => {}));
    const [a, b] = ids(effects);
    w.settled(a!, { kind: "refused", reason: "a moved" });
    expect(w.settled(b!, { kind: "ok" })).toMatchObject({
      outcome: { kind: "refused", reason: "a moved" },
    });
  });

  test("a write from text other than the click's lands its changes over what the click wrote", () => {
    const w = writes();
    w.land([
      { file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 1, x: 1 }\n" },
    ]);
    // A history step, recorded before the click added `x`.
    w.land([{ file: "/a.json5", before: "{ a: 1 }\n", after: "{ a: 6 }\n" }]);
    expect(w.read("/a.json5")).toBe("{ a: 6, x: 1 }\n");
  });

  test("a write whose setting the click itself moved is refused", () => {
    const w = writes();
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    expect(() => w.land([{ file: "/a.json5", before: "{ a: 5 }\n", after: "{ a: 6 }\n" }])).toThrow(
      "a in /a.json5 was changed earlier in this click",
    );
  });

  test("writes that land together land nothing when one contradicts the click", () => {
    const w = writes();
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    expect(() =>
      w.land([
        { file: "/b.json5", before: DISK["/b.json5"]!, after: "{ b: 2 }\n" },
        { file: "/a.json5", before: "{ a: 5 }\n", after: "{ a: 6 }\n" },
      ]),
    ).toThrow("a in /a.json5 was changed earlier in this click");
    expect(w.read("/b.json5")).toBe(DISK["/b.json5"]);
  });

  test("a landing names only the files its changes change", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: DISK["/a.json5"]! }]);
    w.land([{ file: "/b.json5", before: DISK["/b.json5"]!, after: "{ b: 2 }\n" }]);
    w.seal(effects, SID, landing(() => {}));
    expect(w.settled(ids(effects)[0]!, { kind: "ok" })).toMatchObject({
      files: ["/b.json5"],
    });
  });

  test("an id no change of its holds is not its to settle", () => {
    expect(writes().settled(7 as EffectId, { kind: "ok" })).toBeUndefined();
  });

  test("a write with no session to land for is the click's bug, said", () => {
    const w = writes();
    w.land([{ file: "/a.json5", before: DISK["/a.json5"]!, after: "{ a: 2 }\n" }]);
    expect(() => w.seal([], null, landing(() => {}))).toThrow(
      "a click with no session wrote /a.json5",
    );
  });
});
