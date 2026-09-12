import { autorun } from "mobx";

import {
  VariableStore,
  toString,
  toNumber,
  toBool,
  typeOf,
} from "../src/var-system";
import { ABSENT, failed, ok } from "../src/utils/outcome";

describe("VariableStore — boxes", () => {
  it("returns the initial value", () => {
    const store = new VariableStore();
    store.defineBox("count", "number", 7);
    expect(store.read("count")).toBe(7);
  });

  it("reflects updates via setBox", () => {
    const store = new VariableStore();
    store.defineBox("name", "string", "alice");
    store.setBox("name", "bob");
    expect(store.read("name")).toBe("bob");
  });

  it("rejects an initial value of the wrong type", () => {
    const store = new VariableStore();
    expect(() => store.defineBox("count", "number", "seven" as unknown as number))
      .toThrow(/initial value type string does not match declared type number/);
  });

  it("rejects setBox with the wrong type", () => {
    const store = new VariableStore();
    store.defineBox("count", "number", 0);
    expect(() => store.setBox("count", "lots" as unknown as number))
      .toThrow(/set value type string does not match declared type number/);
  });

  it("rejects setBox on a computed", () => {
    const store = new VariableStore();
    store.defineComputed("answer", "number", () => 42);
    expect(() => store.setBox("answer", 99))
      .toThrow(/is a computed, not a box/);
  });

  it("rejects setBox on an unknown name", () => {
    const store = new VariableStore();
    expect(() => store.setBox("ghost", 1)).toThrow(/Unknown variable "ghost"/);
  });

  it("rejects duplicate declarations", () => {
    const store = new VariableStore();
    store.defineBox("x", "number", 1);
    expect(() => store.defineBox("x", "number", 2))
      .toThrow(/already declared/);
    expect(() => store.defineComputed("x", "number", () => 3))
      .toThrow(/already declared/);
  });
});

describe("VariableStore — computed nodes track dependencies", () => {
  it("re-evaluates when an upstream box changes", () => {
    const store = new VariableStore();
    store.defineBox("a", "number", 1);
    store.defineComputed("doubled", "number", (read) => toNumber(read("a")) * 2);
    expect(store.read("doubled")).toBe(2);
    store.setBox("a", 5);
    expect(store.read("doubled")).toBe(10);
  });

  it("propagates invalidation transitively (computed → computed)", () => {
    const store = new VariableStore();
    store.defineBox("a", "number", 1);
    store.defineComputed("b", "number", (read) => toNumber(read("a")) + 10);
    store.defineComputed("c", "number", (read) => toNumber(read("b")) * 2);
    expect(store.read("c")).toBe(22);
    store.setBox("a", 5);
    expect(store.read("c")).toBe(30);
  });

  it("only tracks deps actually read by the deriver", () => {
    const store = new VariableStore();
    store.defineBox("flag", "boolean", false);
    store.defineBox("x", "number", 1);
    store.defineBox("y", "number", 2);
    let evals = 0;
    store.defineComputed("picked", "number", (read) => {
      evals++;
      return toBool(read("flag")) ? toNumber(read("x")) : toNumber(read("y"));
    });
    expect(store.read("picked")).toBe(2); // reads flag + y
    const evalsAfterFirst = evals;

    // x changes; flag is false so x was never read — no invalidation expected.
    store.setBox("x", 999);
    store.read("picked");
    expect(evals).toBe(evalsAfterFirst);

    // y changes; was read on the previous pass — invalidation expected.
    store.setBox("y", 100);
    expect(store.read("picked")).toBe(100);
    expect(evals).toBe(evalsAfterFirst + 1);
  });

  it("batches multiple setBox calls inside runInAction", () => {
    const store = new VariableStore();
    store.defineBox("a", "number", 1);
    store.defineBox("b", "number", 2);
    let evals = 0;
    store.defineComputed("sum", "number", (read) => {
      evals++;
      return toNumber(read("a")) + toNumber(read("b"));
    });
    expect(store.read("sum")).toBe(3);
    const before = evals;

    store.runInAction(() => {
      store.setBox("a", 10);
      store.setBox("b", 20);
    });
    expect(store.read("sum")).toBe(30);
    expect(evals - before).toBe(1);
  });

  it("throws at read time when the computed produces the wrong type", () => {
    const store = new VariableStore();
    store.defineBox("seed", "number", 1);
    store.defineComputed("bogus", "string", (read) => toNumber(read("seed")));
    expect(() => store.read("bogus"))
      .toThrow(/computed result type number does not match declared type string/);
  });

  it("throws when the deriver reads an unknown variable", () => {
    const store = new VariableStore();
    store.defineComputed("oops", "string", (read) => toString(read("missing")));
    expect(() => store.read("oops")).toThrow(/Unknown variable "missing"/);
  });
});

describe("VariableStore — introspection", () => {
  it("reports name, kind, and type", () => {
    const store = new VariableStore();
    store.defineBox("seed", "number", 0);
    store.defineComputed("derived", "string", () => "x");

    expect(store.has("seed")).toBe(true);
    expect(store.has("derived")).toBe(true);
    expect(store.has("ghost")).toBe(false);

    expect(store.getKind("seed")).toBe("box");
    expect(store.getKind("derived")).toBe("computed");

    expect(store.getType("seed")).toBe("number");
    expect(store.getType("derived")).toBe("string");

    expect(store.names().sort()).toEqual(["derived", "seed"]);
  });

  // [LAW:types-are-the-program] The VarNode returned by getNode is the
  // read-only view of a variable. A BoxNode's `.set` must NOT be reachable
  // through the returned wrapper at any level (no structural escape, no
  // plain-JS reach-through), so introspection consumers cannot accidentally
  // bypass setBox + runInAction.
  it("getNode returns a wrapper whose mutation surface is unreachable", () => {
    const store = new VariableStore();
    store.defineBox("seed", "number", 7);
    const node = store.getNode("seed");

    // The advertised surface works.
    expect(node.name).toBe("seed");
    expect(node.kind).toBe("box");
    expect(node.kind !== "document" && node.type).toBe("number");
    expect(node.read()).toBe(7);
    expect(node.lastUpdatedMs()).toBeGreaterThan(0);

    // .set must not exist on the wrapper — no key, no accessor, no path.
    // Cast to record-of-unknown to assert at runtime (the wrapper hides
    // .set; reaching for it as `unknown` returns undefined).
    expect((node as unknown as Record<string, unknown>).set).toBeUndefined();
  });

  it("getNode's wrapper read() reflects subsequent setBox", () => {
    // The wrapper is bound to the underlying node, so values change as
    // the store mutates — it isn't a frozen snapshot.
    const store = new VariableStore();
    store.defineBox("seed", "number", 7);
    const node = store.getNode("seed");
    expect(node.read()).toBe(7);

    store.setBox("seed", 42);
    expect(node.read()).toBe(42);
  });
});

describe("type-checked cast helpers", () => {
  describe("toString", () => {
    it("returns strings unchanged", () => {
      expect(toString("hi")).toBe("hi");
    });
    it("stringifies numbers and booleans", () => {
      expect(toString(42)).toBe("42");
      expect(toString(true)).toBe("true");
      expect(toString(false)).toBe("false");
    });
  });

  describe("toNumber", () => {
    it("returns numbers unchanged", () => {
      expect(toNumber(3.14)).toBe(3.14);
    });
    it("parses numeric strings", () => {
      expect(toNumber("42")).toBe(42);
      expect(toNumber("  -1.5 ")).toBe(-1.5);
    });
    it("maps booleans to 0/1", () => {
      expect(toNumber(true)).toBe(1);
      expect(toNumber(false)).toBe(0);
    });
    it("throws on non-numeric strings", () => {
      expect(() => toNumber("abc")).toThrow(/Cannot cast .* to number/);
      expect(() => toNumber("")).toThrow(/empty string/);
      expect(() => toNumber("NaN")).toThrow(/Cannot cast .* to number/);
    });
  });

  describe("toBool", () => {
    it("returns booleans unchanged", () => {
      expect(toBool(true)).toBe(true);
      expect(toBool(false)).toBe(false);
    });
    it("accepts the strings \"true\" and \"false\"", () => {
      expect(toBool("true")).toBe(true);
      expect(toBool("false")).toBe(false);
    });
    it("accepts 0 and 1", () => {
      expect(toBool(0)).toBe(false);
      expect(toBool(1)).toBe(true);
    });
    it("throws on ambiguous strings and other numbers", () => {
      expect(() => toBool("yes")).toThrow(/expected "true" or "false"/);
      expect(() => toBool("")).toThrow(/expected "true" or "false"/);
      expect(() => toBool(2)).toThrow(/only 0 and 1 are accepted/);
      expect(() => toBool(-1)).toThrow(/only 0 and 1 are accepted/);
    });
  });

  describe("typeOf", () => {
    it("recognizes string|number|boolean", () => {
      expect(typeOf("x")).toBe("string");
      expect(typeOf(0)).toBe("number");
      expect(typeOf(false)).toBe("boolean");
    });
  });
});

// ─── Documents ───────────────────────────────────────────────────────────────

// [LAW:behavior-not-structure] A document node holds an Outcome, is read by its
// own accessor, and is refused by the scalar reads by name — the contract the
// scope proxy and the registry's publishers build on.
// brandon-var-system-1tl. `lastUpdatedMs` is surfaced by src/daemon/debug.ts as
// the node's AGE, and both its name and the reason anyone reads it say "when did
// this last change" — which is exactly the question being asked when debugging a
// source that re-runs without effect. It used to be stamped on every write.
//
// [LAW:no-ambient-temporal-coupling] The clock is the test's, not the machine's:
// with the real `Date.now()`, two writes inside one millisecond produce the same
// stamp, so "the stamp did not move" would pass for the wrong reason — the
// defect's own failure mode.
describe("VariableStore — the age records a change, not a write", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("a scalar write that moves nothing leaves the age alone", () => {
    jest.setSystemTime(1000);
    const store = new VariableStore();
    store.defineBox("n", "number", 7);
    expect(store.getNode("n").lastUpdatedMs()).toBe(1000);

    jest.setSystemTime(5000);
    store.setBox("n", 7);
    expect(store.getNode("n").lastUpdatedMs()).toBe(1000);

    jest.setSystemTime(9000);
    store.setBox("n", 8);
    expect(store.getNode("n").lastUpdatedMs()).toBe(9000);
  });

  it("a document rescan that parsed the same content leaves the age alone", () => {
    jest.setSystemTime(1000);
    const store = new VariableStore();
    store.defineDocument("d", ok({ a: 1 }));
    expect(store.getNode("d").lastUpdatedMs()).toBe(1000);

    jest.setSystemTime(5000);
    store.setDocument("d", ok({ a: 1 }));
    expect(store.getNode("d").lastUpdatedMs()).toBe(1000);

    jest.setSystemTime(9000);
    store.setDocument("d", ok({ a: 2 }));
    expect(store.getNode("d").lastUpdatedMs()).toBe(9000);
  });
});

describe("VariableStore — documents", () => {
  const doc = () => ({ a: 1, b: { c: "x" } });

  it("round-trips an outcome through defineDocument / readDocument / setDocument", () => {
    const store = new VariableStore();
    store.defineDocument("d", ABSENT);
    expect(store.readDocument("d")).toEqual({ kind: "absent" });
    store.setDocument("d", ok(doc()));
    expect(store.readDocument("d")).toEqual({ kind: "ok", value: doc() });
    store.setDocument("d", failed("boom"));
    expect(store.readDocument("d")).toEqual({ kind: "failed", reason: "boom" });
  });

  it("is a distinct node kind", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok(doc()));
    expect(store.getKind("d")).toBe("document");
    expect(store.names()).toEqual(["d"]);
  });

  it("the scalar reads refuse a document by name, pointing at the path form", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok(doc()));
    expect(() => store.read("d")).toThrow(
      /Variable "d" is a document; read its fields by path \(\.d\.<field>\)/,
    );
    expect(() => store.getType("d")).toThrow(/is a document/);
  });

  it("the document reads refuse a scalar by name", () => {
    const store = new VariableStore();
    store.defineBox("s", "string", "x");
    expect(() => store.readDocument("s")).toThrow(/"s" is a box, not a document/);
    expect(() => store.setDocument("s", ok(doc()))).toThrow(/is a box, not a document/);
  });

  it("a document name cannot be re-declared as anything", () => {
    const store = new VariableStore();
    store.defineDocument("d", ABSENT);
    expect(() => store.defineBox("d", "string", "")).toThrow(/already declared/);
    expect(() => store.defineDocument("d", ABSENT)).toThrow(/already declared/);
  });

  it("shapes every ok document on write: null prototypes and sorted keys at every level", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok({ b: { z: 1, y: 2 }, a: [{ q: 1, p: 2 }] }));
    const d = store.readDocument("d");
    if (d.kind !== "ok") throw new Error("expected ok");
    const root = d.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.keys(root)).toEqual(["a", "b"]);
    expect(Object.getPrototypeOf(root.b)).toBeNull();
    expect(Object.keys(root.b as object)).toEqual(["y", "z"]);
    const item = (root.a as unknown[])[0] as object;
    expect(Object.getPrototypeOf(item)).toBeNull();
    expect(Object.keys(item)).toEqual(["p", "q"]);
    store.setDocument("d", ok({ toString: "own" }));
    const again = store.readDocument("d");
    if (again.kind !== "ok") throw new Error("expected ok");
    expect(Object.getPrototypeOf(again.value)).toBeNull();
    expect(Object.keys(again.value as object)).toEqual(["toString"]);
  });

  it("every document is frozen at every level: an in-place edit throws instead of rewriting the store", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok({ b: { z: 1 }, a: [{ q: 1 }, 2] }));
    const d = store.readDocument("d");
    if (d.kind !== "ok") throw new Error("expected ok");
    const root = d.value as Record<string, unknown>;
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.b)).toBe(true);
    expect(Object.isFrozen(root.a)).toBe(true);
    expect(Object.isFrozen((root.a as unknown[])[0])).toBe(true);
    expect(() => {
      (root.b as Record<string, unknown>).z = 2;
    }).toThrow(TypeError);
    expect(store.readDocument("d")).toEqual({ kind: "ok", value: { a: [{ q: 1 }, 2], b: { z: 1 } } });
  });

  it("changeKey is canonical: the same content in another key order is the same key", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok({ a: 1, b: { c: "x", d: 2 } }));
    const before = store.changeKey("d");
    store.setDocument("d", ok({ b: { d: 2, c: "x" }, a: 1 }));
    expect(store.changeKey("d")).toBe(before);
    store.setDocument("d", ok({ b: { d: 2, c: "y" }, a: 1 }));
    expect(store.changeKey("d")).not.toBe(before);
  });

  it("changeKey is structural over documents and total over node kinds", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok(doc()));
    store.defineBox("n", "number", 7);
    const before = store.changeKey("d");
    store.setDocument("d", ok(doc())); // a rescan yielding the same content
    expect(store.changeKey("d")).toBe(before);
    store.setDocument("d", ok({ ...doc(), a: 2 }));
    expect(store.changeKey("d")).not.toBe(before);
    expect(store.changeKey("n")).toBe("7");
  });

  // brandon-var-system-1tl. The defect: the document box compared by Object.is
  // against a value `toDocument` rebuilds on every scan, so a `json` source
  // that re-read byte-identical content woke every observer — while changeKey,
  // one method away, said the same rescan was not a change. Two spellings of
  // "did this document change" that disagree; the content one wins, and now
  // there is only one.
  it("a rescan yielding identical content wakes nobody, and changeKey agrees", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok(doc()));
    let runs = 0;
    const stop = autorun(() => {
      store.readDocument("d");
      runs++;
    });
    expect(runs).toBe(1);
    const key = store.changeKey("d");

    // A rescan that parsed the same bytes into a fresh object.
    store.setDocument("d", ok(doc()));
    expect({ runs, key: store.changeKey("d") }).toEqual({ runs: 1, key });

    // And one that parsed the same content in another key order: toDocument
    // sorts, so this is the same document by the only measure that matters.
    store.setDocument("d", ok({ b: { c: "x" }, a: 1 }));
    expect({ runs, key: store.changeKey("d") }).toEqual({ runs: 1, key });

    // Real movement still wakes it.
    store.setDocument("d", ok({ ...doc(), a: 2 }));
    expect(runs).toBe(2);
    expect(store.changeKey("d")).not.toBe(key);
    stop();
  });

  // The non-ok arms are values too: a source that keeps failing for the same
  // reason has not changed, and one whose reason changes has.
  it("an unchanged outcome is unchanged whatever its kind", () => {
    const store = new VariableStore();
    store.defineDocument("d", failed("boom"));
    let runs = 0;
    const stop = autorun(() => {
      store.readDocument("d");
      runs++;
    });
    store.setDocument("d", failed("boom"));
    expect(runs).toBe(1);
    store.setDocument("d", failed("different"));
    expect(runs).toBe(2);
    store.setDocument("d", ABSENT);
    expect(runs).toBe(3);
    store.setDocument("d", ABSENT);
    expect(runs).toBe(3);
    stop();
  });

  it("getNode hands out a document wrapper with no mutation surface and no scalar type", () => {
    const store = new VariableStore();
    store.defineDocument("d", ok(doc()));
    const node = store.getNode("d");
    expect(node.kind).toBe("document");
    expect(node.read()).toEqual({ kind: "ok", value: doc() });
    expect(node.lastUpdatedMs()).toBeGreaterThan(0);
    expect("type" in node).toBe(false);
    expect((node as unknown as Record<string, unknown>).set).toBeUndefined();
  });
});
