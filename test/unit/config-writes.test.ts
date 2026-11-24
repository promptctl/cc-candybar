// [LAW:verifiable-goals] A click lands whole or not at all: its writes leave
// as changes, one per file, each naming its layer by the click's origin and
// the layer's role, and what else it did waits for every one of them to land,
// or is told why one did not. A click reads only its origin's layers, as the
// snapshot holds them.

import {
  ConfigWrites,
  requireLayerText,
  type ClickLayers,
} from "../../src/renderer/config-writes";
import type { RenderOrigin } from "../../src/config-hint";
import type { Layer } from "../../src/config/config-snapshot";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import type { Effect, EffectId } from "../../src/renderer-interface/interface";

const SID = sessionIdOf("s1");
const DISK: Record<string, string> = {
  "/a.json5": "{ a: 1 }\n",
  "/b.json5": "{ b: 1 }\n",
};

const ORIGIN: RenderOrigin = {
  projectDir: "/p",
  cwd: "/p",
  target: { source: "search" },
};
const layer = (role: Layer["role"], path: string): Layer => ({
  role,
  path,
  content:
    DISK[path] === undefined
      ? { kind: "absent" }
      : { kind: "text", text: DISK[path] },
  listed: {},
});
// The origin's chain: `/a.json5` the user's, `/b.json5` the project's, and
// a local layer not written yet.
const LAYERS: ClickLayers = {
  origin: ORIGIN,
  chain: [
    layer("user", "/a.json5"),
    layer("project", "/b.json5"),
    layer("local", "/c.json5"),
  ],
};

// A click open over the origin's layers.
function writes(layers = LAYERS) {
  let minted = 0;
  const w = new ConfigWrites(() => ++minted as EffectId);
  w.begin("click", () => layers);
  return w;
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

  test("a click reads its own writes, and its origin's snapshot for the rest", () => {
    const w = writes();
    w.land("/a.json5", DISK["/a.json5"]!, "{ a: 2 }\n");
    expect(w.read("/a.json5")).toEqual({ kind: "text", text: "{ a: 2 }\n" });
    expect(w.read("/b.json5")).toEqual({ kind: "text", text: DISK["/b.json5"] });
    expect(w.read("/c.json5")).toEqual({ kind: "absent" });
  });

  test("an unreadable layer remains a read error rather than an absent file", () => {
    const path = "/c.json5";
    const failure = { kind: "unreadable", error: "EACCES" } as const;
    const w = writes({
      origin: ORIGIN,
      chain: [
        layer("user", "/a.json5"),
        layer("project", "/b.json5"),
        { ...layer("local", path), content: failure },
      ],
    });
    const read = w.read(path);
    expect(read).toEqual(failure);
    expect(() => requireLayerText(path, read)).toThrow(
      "/c.json5 could not be read (EACCES)",
    );
  });

  test("a file its origin's chain does not hold is no file the click reads", () => {
    expect(() => writes().read("/elsewhere.json5")).toThrow(
      "/elsewhere.json5 is not a config file this session renders from — the click is not taken",
    );
  });

  test("a click that reads no layer asks for no snapshot", () => {
    const w = new ConfigWrites(() => 1 as EffectId);
    w.begin("click", () => {
      throw new Error("no snapshot is held");
    });
    const effects: Effect[] = [];
    let applied = false;
    w.seal(effects, SID, () => (applied = true));
    expect(applied).toBe(true);
  });

  test("each change names its layer by the click's origin and the layer's role", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.land("/b.json5", DISK["/b.json5"]!, "{ b: 2 }\n");
    w.land("/c.json5", null, "{ c: 1 }\n");
    w.seal(effects, SID, () => {});
    expect(effects.map((e) => (e.kind === "change" ? e.target : null))).toEqual(
      [
        { kind: "layer", origin: ORIGIN, role: "project" },
        { kind: "layer", origin: ORIGIN, role: "local" },
      ],
    );
  });

  test("an answer to the trust book names the click's origin", () => {
    const w = writes();
    const effects: Effect[] = [];
    w.answer("/p", "approved");
    w.seal(effects, SID, () => {});
    expect(effects).toEqual([
      expect.objectContaining({
        kind: "approve-repo",
        origin: ORIGIN,
        dir: "/p",
      }),
    ]);
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
        target: { kind: "layer", origin: ORIGIN, role: "user" },
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
    expect(() => w.begin("next", () => LAYERS)).toThrow(
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
    expect(() => w.begin("next", () => LAYERS)).not.toThrow();
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
