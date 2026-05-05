import {
  VariableStore,
  toString,
  toNumber,
  toBool,
  typeOf,
} from "../src/var-system";

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
