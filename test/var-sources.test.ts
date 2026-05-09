import { VariableStore, SourceRegistry } from "../src/var-system";

// Helper: fresh pair so tests are fully isolated.
function make(defaultEmptyValue?: string) {
  const store = new VariableStore();
  const registry = new SourceRegistry(store, defaultEmptyValue);
  return { store, registry };
}

// ─── literal ─────────────────────────────────────────────────────────────────

describe("SourceRegistry — literal", () => {
  it("round-trips a string literal", () => {
    const { store, registry } = make();
    registry.declareLiteral("greeting", "hello");
    expect(store.read("greeting")).toBe("hello");
  });

  it("round-trips a number literal", () => {
    const { store, registry } = make();
    registry.declareLiteral("pi", 3.14);
    expect(store.read("pi")).toBe(3.14);
  });

  it("round-trips a boolean literal", () => {
    const { store, registry } = make();
    registry.declareLiteral("flag", true);
    expect(store.read("flag")).toBe(true);
  });

  it("defines the box with the inferred type", () => {
    const { store, registry } = make();
    registry.declareLiteral("count", 42);
    expect(store.getType("count")).toBe("number");
  });

  it("records no last_error", () => {
    const { registry } = make();
    registry.declareLiteral("x", "static");
    expect(registry.getLastError("x")).toBeUndefined();
  });

  it("value is stable across multiple reads (no drift)", () => {
    const { store, registry } = make();
    registry.declareLiteral("stable", "fixed");
    expect(store.read("stable")).toBe("fixed");
    expect(store.read("stable")).toBe("fixed");
  });
});

// ─── env ─────────────────────────────────────────────────────────────────────

describe("SourceRegistry — env", () => {
  const VAR = "CC_TEST_VAR_SOURCES";

  afterEach(() => {
    delete process.env[VAR];
  });

  it("returns the env var value when set", () => {
    process.env[VAR] = "from-env";
    const { store, registry } = make();
    registry.declareEnv("myvar", VAR);
    expect(store.read("myvar")).toBe("from-env");
    expect(registry.getLastError("myvar")).toBeUndefined();
  });

  it("type is always 'string'", () => {
    process.env[VAR] = "42";
    const { store, registry } = make();
    registry.declareEnv("myvar", VAR);
    expect(store.getType("myvar")).toBe("string");
    expect(store.read("myvar")).toBe("42"); // raw string, not coerced to number
  });

  it("falls back to varDefault when env var is absent", () => {
    const { store, registry } = make();
    registry.declareEnv("myvar", VAR, "fallback-default");
    expect(store.read("myvar")).toBe("fallback-default");
  });

  it("records last_error when env var is absent", () => {
    const { registry } = make();
    const before = Date.now();
    registry.declareEnv("myvar", VAR);
    const err = registry.getLastError("myvar");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not set/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("falls back to defaultEmptyValue when absent and no varDefault", () => {
    const { store, registry } = make("(empty)");
    registry.declareEnv("myvar", VAR);
    expect(store.read("myvar")).toBe("(empty)");
  });

  it("falls back to empty string when absent, no varDefault, no defaultEmptyValue", () => {
    const { store, registry } = make();
    registry.declareEnv("myvar", VAR);
    expect(store.read("myvar")).toBe("");
  });

  it("does NOT record last_error when env var is present", () => {
    process.env[VAR] = "present";
    const { registry } = make();
    registry.declareEnv("myvar", VAR);
    expect(registry.getLastError("myvar")).toBeUndefined();
  });
});

// ─── input ───────────────────────────────────────────────────────────────────

describe("SourceRegistry — input: initialization", () => {
  it("initializes to varDefault before first applyInput", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", "/default");
    expect(store.read("cwd")).toBe("/default");
  });

  it("initializes to defaultEmptyValue when no varDefault", () => {
    const { store, registry } = make("(unset)");
    registry.declareInput("cwd", "cwd", "string");
    expect(store.read("cwd")).toBe("(unset)");
  });

  it("initializes number to 0 when defaultEmptyValue cannot coerce", () => {
    const { store, registry } = make("not-a-number");
    registry.declareInput("count", "count", "number");
    expect(store.read("count")).toBe(0);
  });

  it("initializes boolean to false when defaultEmptyValue cannot coerce", () => {
    const { store, registry } = make("not-a-bool");
    registry.declareInput("flag", "flag", "boolean");
    expect(store.read("flag")).toBe(false);
  });
});

describe("SourceRegistry — input: round-trip", () => {
  it("resolves a top-level path and updates the box", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string");
    registry.applyInput({ cwd: "/home/user/project" });
    expect(store.read("cwd")).toBe("/home/user/project");
  });

  it("resolves a nested dotted path", () => {
    const { store, registry } = make();
    registry.declareInput("session_id", "session_id", "string");
    registry.applyInput({ session_id: "abc123" });
    expect(store.read("session_id")).toBe("abc123");
  });

  it("resolves deeply nested paths", () => {
    const { store, registry } = make();
    registry.declareInput("model_name", "model.display_name", "string");
    registry.applyInput({ model: { display_name: "claude-opus-4" } });
    expect(store.read("model_name")).toBe("claude-opus-4");
  });

  it("resolves a number field", () => {
    const { store, registry } = make();
    registry.declareInput("tokens", "context_window.total_input_tokens", "number");
    registry.applyInput({ context_window: { total_input_tokens: 5000 } });
    expect(store.read("tokens")).toBe(5000);
  });

  it("resolves a boolean field", () => {
    const { store, registry } = make();
    registry.declareInput("expanded", "state.toolbarExpanded", "boolean");
    registry.applyInput({ state: { toolbarExpanded: true } });
    expect(store.read("expanded")).toBe(true);
  });

  it("clears last_error on successful resolution", () => {
    const { registry } = make();
    registry.declareInput("cwd", "cwd", "string");
    // First push fails
    registry.applyInput({});
    expect(registry.getLastError("cwd")).toBeDefined();
    // Second push succeeds — error cleared
    registry.applyInput({ cwd: "/now/present" });
    expect(registry.getLastError("cwd")).toBeUndefined();
  });
});

describe("SourceRegistry — input: missing path fallback chain", () => {
  it("uses varDefault when path is missing", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", "/fallback");
    registry.applyInput({});
    expect(store.read("cwd")).toBe("/fallback");
  });

  it("records last_error when path is missing", () => {
    const { registry } = make();
    const before = Date.now();
    registry.declareInput("cwd", "cwd", "string");
    registry.applyInput({});
    const err = registry.getLastError("cwd");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not found in payload/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("uses defaultEmptyValue when path missing and no varDefault (string)", () => {
    const { store, registry } = make("(none)");
    registry.declareInput("cwd", "cwd", "string");
    registry.applyInput({});
    expect(store.read("cwd")).toBe("(none)");
  });

  it("uses zero value when path missing, no varDefault, defaultEmptyValue incompatible (number)", () => {
    const { store, registry } = make("not-a-number");
    registry.declareInput("count", "count", "number");
    registry.applyInput({});
    expect(store.read("count")).toBe(0);
  });

  it("uses zero value for boolean type when all fallbacks fail", () => {
    const { store, registry } = make("not-a-bool");
    registry.declareInput("flag", "flag", "boolean");
    registry.applyInput({});
    expect(store.read("flag")).toBe(false);
  });

  it("returns undefined for missing intermediate path segment", () => {
    const { store, registry } = make();
    registry.declareInput("name", "model.display_name", "string", "default-name");
    registry.applyInput({ model: null });
    expect(store.read("name")).toBe("default-name");
  });
});

describe("SourceRegistry — input: runInAction batching", () => {
  it("updates multiple input boxes in one action so dependents invalidate once", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    let evalCount = 0;

    registry.declareInput("a", "a", "string");
    registry.declareInput("b", "b", "string");

    // computed that reads both input boxes
    store.defineComputed("combined", "string", (read) => {
      evalCount++;
      return `${read("a")}:${read("b")}`;
    });

    // warm the computed
    expect(store.read("combined")).toBe(":");
    evalCount = 0; // reset after warmup

    // Apply both inputs together — computed should re-evaluate at most once
    registry.applyInput({ a: "hello", b: "world" });
    expect(store.read("combined")).toBe("hello:world");

    // MobX batching: keepAlive computed re-runs on first access after invalidation,
    // not during the action. Eval count should be exactly 1.
    expect(evalCount).toBe(1);
  });

  it("updates independently across multiple applyInput calls", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string");

    registry.applyInput({ cwd: "/first" });
    expect(store.read("cwd")).toBe("/first");

    registry.applyInput({ cwd: "/second" });
    expect(store.read("cwd")).toBe("/second");
  });
});

// ─── interaction with VariableStore computeds ─────────────────────────────────

describe("SourceRegistry — input boxes as computed dependencies", () => {
  it("invalidates computeds when input boxes update", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);

    registry.declareInput("cwd", "cwd", "string", "/initial");
    store.defineComputed("basename", "string", (read) => {
      const p = String(read("cwd"));
      return p.split("/").at(-1) ?? "";
    });

    expect(store.read("basename")).toBe("initial");
    registry.applyInput({ cwd: "/home/user/project" });
    expect(store.read("basename")).toBe("project");
  });

  it("literal box is stable as a computed dependency", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);

    registry.declareLiteral("prefix", "cc-");
    store.defineComputed("label", "string", (read) => `${read("prefix")}candybar`);
    expect(store.read("label")).toBe("cc-candybar");
  });
});
