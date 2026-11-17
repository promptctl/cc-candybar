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

const ids = (effects: readonly Effect[]): EffectId[] =>
  effects.map((e) => e.id);

describe("a click's config writes", () => {
  test("a click that changed no file has its consequence at once", () => {
    const w = writes();
    const effects: Effect[] = [];
    let applied = false;
    w.land("/a.json5", DISK["/a.json5"]!, DISK["/a.json5"]!);
    w.seal(effects, SID, () => (applied = true));
    expect(effects).toEqual([]);
    expect(applied).toBe(true);
  });

  test("a click reads its own writes, and the disk for the rest", () => {
    const w = writes();
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    expect(w.read("/a.json5")).toBe("{ a: 2 }\n");
    expect(w.read("/b.json5")).toBe(DISK["/b.json5"]);
  });

  test("two writes to one file are one change, from the first read to the last write", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    w.land("/a.json5", "{ a: 2 }\n", "{ a: 3 }\n");
    w.seal(effects, SID, () => {});
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

  test("the consequence waits for every change, and no click begins while one is owed", () => {
    const w = writes();
    const effects: Effect[] = [];
    let applied = false;
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    w.land("/b.json5", DISK["/b.json5"]!, "{ b: 2 }\n");
    w.seal(effects, SID, () => (applied = true));
    const [a, b] = ids(effects);
    expect(w.settled(a!, { kind: "ok" })).toBe("owed");
    expect(() => w.begin("next")).toThrow(
      "next began while a click's changes to /a.json5, /b.json5 were still landing",
    );
    const landed = w.settled(b!, { kind: "ok" });
    expect(landed).toMatchObject({
      session: SID,
      files: ["/a.json5", "/b.json5"],
      outcome: { kind: "ok" },
    });
    expect(applied).toBe(false);
    if (landed === undefined || landed === "owed") throw new Error("unlanded");
    landed.consequence([]);
    expect(applied).toBe(true);
    expect(() => w.begin("next")).not.toThrow();
  });

  test("a landing that missed reports why, though a later change landed", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    w.land("/b.json5", DISK["/b.json5"]!, "{ b: 2 }\n");
    w.seal(effects, SID, () => {});
    const [a, b] = ids(effects);
    w.settled(a!, { kind: "refused", reason: "a moved" });
    expect(w.settled(b!, { kind: "ok" })).toMatchObject({
      outcome: { kind: "refused", reason: "a moved" },
    });
  });

  test("a landing names only the files its changes change", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land("/a.json5", DISK["/a.json5"]!, DISK["/a.json5"]!);
    w.land("/b.json5", DISK["/b.json5"]!, "{ b: 2 }\n");
    w.seal(effects, SID, () => {});
    expect(w.settled(ids(effects)[0]!, { kind: "ok" })).toMatchObject({
      files: ["/b.json5"],
    });
  });

  test("an id no change of its holds is not its to settle", () => {
    expect(writes().settled(7 as EffectId, { kind: "ok" })).toBeUndefined();
  });

  test("a write with no session to land for is the click's bug, said", () => {
    const w = writes();
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    expect(() => w.seal([], null, () => {})).toThrow(
      "a click with no session wrote /a.json5",
    );
  });
});
