import fs from "fs";
import os from "os";
import path from "path";
import {
  VariableStore,
  SourceRegistry,
  parseDuration,
  formatGoTime,
} from "../src/var-system";

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

// ─── parseDuration ────────────────────────────────────────────────────────────

describe("parseDuration", () => {
  it.each([
    ["100ms", 100],
    ["1s", 1_000],
    ["30s", 30_000],
    ["2m", 120_000],
    ["1h", 3_600_000],
  ])("%s → %d ms", (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });

  it("rejects unknown unit", () => {
    expect(() => parseDuration("5d")).toThrow(/Invalid duration/);
  });

  it("rejects bare number", () => {
    expect(() => parseDuration("42")).toThrow(/Invalid duration/);
  });
});

// ─── Shared temp-dir helper ───────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Wait for all microtasks + a small wall-clock window so async shell/file
// operations have time to settle before asserting.
function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── shell — basic ────────────────────────────────────────────────────────────

describe("SourceRegistry — shell: basic", () => {
  it("populates box with command stdout (never policy)", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "hello world"', { cache: { kind: "never" } });
    await settle();
    expect(store.read("val")).toBe("hello world");
    registry.dispose();
  });

  it("replaces newlines with spaces in multi-line output", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'printf "a\\nb\\nc"', { cache: { kind: "never" } });
    await settle();
    expect(store.read("val")).toBe("a b c");
    registry.dispose();
  });

  it("extracts regex group-1 from stdout", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "load: 0.52 0.48 0.45"', {
      regex: "load:\\s*([0-9.]+)",
      cache: { kind: "never" },
    });
    await settle();
    expect(store.read("val")).toBe("0.52");
    registry.dispose();
  });

  it("shell failure → varDefault", async () => {
    const { store, registry } = make();
    registry.declareShell("val", "exit 1", {
      varDefault: "fallback",
      cache: { kind: "never" },
    });
    await settle();
    expect(store.read("val")).toBe("fallback");
    registry.dispose();
  });

  it("shell failure → records last_error", async () => {
    const before = Date.now();
    const { registry } = make();
    registry.declareShell("val", "exit 2", { cache: { kind: "never" } });
    await settle();
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/exited with code/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
    registry.dispose();
  });

  it("shell failure → defaultEmptyValue when no varDefault", async () => {
    const { store, registry } = make("(none)");
    registry.declareShell("val", "exit 1", { cache: { kind: "never" } });
    await settle();
    expect(store.read("val")).toBe("(none)");
    registry.dispose();
  });

  it("regex no-match → varDefault", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "nothing here"', {
      regex: "([0-9]+)",
      varDefault: "—",
      cache: { kind: "never" },
    });
    await settle();
    expect(store.read("val")).toBe("—");
    registry.dispose();
  });

  it("regex no-match → records last_error", async () => {
    const { registry } = make();
    registry.declareShell("val", 'echo "no digits"', {
      regex: "([0-9]+)",
      cache: { kind: "never" },
    });
    await settle();
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/regex no-match/);
    registry.dispose();
  });

  it("success clears previous last_error on re-run via TTL", async () => {
    const { tmpDir, dataFile, cleanup } = (() => {
      const { dir, cleanup } = makeTmpDir();
      return { tmpDir: dir, dataFile: path.join(dir, "f"), cleanup };
    })();
    try {
      fs.writeFileSync(dataFile, "bad");
      const { store, registry } = make();
      // First: failing command
      registry.declareShell("val", `grep nonexistent ${dataFile}`, {
        cache: { kind: "never" },
      });
      await settle();
      expect(registry.getLastError("val")).toBeDefined();

      // Can't re-run on "never" — use a separate variable to test error-clearing
      const { store: store2, registry: registry2 } = make();
      // Command that succeeds
      registry2.declareShell("val", `echo "ok"`, { cache: { kind: "never" } });
      await settle();
      expect(registry2.getLastError("val")).toBeUndefined();
      expect(store2.read("val")).toBe("ok");
      registry.dispose();
      registry2.dispose();
    } finally {
      cleanup();
    }
  });
});

// ─── shell — TTL cache policy ────────────────────────────────────────────────

describe("SourceRegistry — shell: ttl cache policy", () => {
  it("TTL fires and refreshes box with new command output", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "v");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareShell("val", `cat ${f}`, { cache: { kind: "ttl", durationMs: 60 } });

      await settle(100);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(f, "v2");
      await settle(150); // ≥ 1 TTL tick

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("TTL bucket sweep: two vars at same interval both update", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f1 = path.join(dir, "f1");
      const f2 = path.join(dir, "f2");
      fs.writeFileSync(f1, "a1");
      fs.writeFileSync(f2, "b1");
      const { store, registry } = make();
      registry.declareShell("v1", `cat ${f1}`, { cache: { kind: "ttl", durationMs: 60 } });
      registry.declareShell("v2", `cat ${f2}`, { cache: { kind: "ttl", durationMs: 60 } });

      await settle(100);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      await settle(150);

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("dispose stops TTL from firing further updates", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareShell("val", `cat ${f}`, { cache: { kind: "ttl", durationMs: 60 } });

      await settle(100);
      expect(store.read("val")).toBe("v1");

      registry.dispose();

      fs.writeFileSync(f, "v2");
      await settle(150); // timer should NOT fire after dispose

      expect(store.read("val")).toBe("v1"); // unchanged
    } finally {
      cleanup();
    }
  });
});

// ─── shell — watch_file cache policy ─────────────────────────────────────────

describe("SourceRegistry — shell: watch_file cache policy", () => {
  it("file modification triggers box update", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const watchedFile = path.join(dir, "watched");
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(watchedFile, "x");
      fs.writeFileSync(dataFile, "v1");
      const { store, registry } = make();
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "watch_file", path: watchedFile },
      });

      await settle(100);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      fs.writeFileSync(watchedFile, "x"); // trigger the watcher
      await settle(250);

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("multiple subscribers on one watch_file path both update", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const watchedFile = path.join(dir, "watched");
      const f1 = path.join(dir, "f1");
      const f2 = path.join(dir, "f2");
      fs.writeFileSync(watchedFile, "x");
      fs.writeFileSync(f1, "a1");
      fs.writeFileSync(f2, "b1");
      const { store, registry } = make();
      registry.declareShell("v1", `cat ${f1}`, {
        cache: { kind: "watch_file", path: watchedFile },
      });
      registry.declareShell("v2", `cat ${f2}`, {
        cache: { kind: "watch_file", path: watchedFile },
      });

      await settle(100);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      fs.writeFileSync(watchedFile, "y");
      await settle(250);

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });
});

// ─── shell — key: cache policy ────────────────────────────────────────────────

describe("SourceRegistry — shell: key: cache policy", () => {
  it("re-runs shell when key template result changes", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      // Put a box directly in the store — the key template will read it.
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "key", template: "{{ .trigger }}" },
      });

      await settle(150);
      expect(store.read("val")).toBe("v1");

      // Mutate the data and change the key — reaction fires, shell re-runs.
      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b");
      await settle(250);

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("does NOT re-run shell when key is unchanged", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "key", template: "{{ .trigger }}" },
      });

      await settle(150);
      expect(store.read("val")).toBe("v1");

      // Change data file, but do NOT change the key.
      fs.writeFileSync(dataFile, "v2");
      // trigger stays "a" — key template still produces "a" — no re-run.
      await settle(250);

      expect(store.read("val")).toBe("v1");
      registry.dispose();
    } finally {
      cleanup();
    }
  });
});

// ─── file — basic ─────────────────────────────────────────────────────────────

describe("SourceRegistry — file: basic", () => {
  it("whole mode: reads entire file, newlines→spaces", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "line1\nline2\nline3");
      const { store, registry } = make();
      registry.declareFile("val", f, { cache: { kind: "never" } });
      await settle();
      expect(store.read("val")).toBe("line1 line2 line3");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("first-line mode: returns first line only", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "ref: refs/heads/main\nother");
      const { store, registry } = make();
      registry.declareFile("val", f, { readMode: "first-line", cache: { kind: "never" } });
      await settle();
      expect(store.read("val")).toBe("ref: refs/heads/main");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("regex: extracts group-1 from file contents", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "ref: refs/heads/feature-branch\n");
      const { store, registry } = make();
      registry.declareFile("val", f, {
        regex: "refs/heads/(.+)",
        cache: { kind: "never" },
      });
      await settle();
      expect(store.read("val")).toBe("feature-branch");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("file missing → varDefault", async () => {
    const { store, registry } = make();
    registry.declareFile("val", "/nonexistent/path/xyz.txt", {
      varDefault: "(missing)",
      cache: { kind: "never" },
    });
    await settle();
    expect(store.read("val")).toBe("(missing)");
    registry.dispose();
  });

  it("file missing → records last_error", async () => {
    const before = Date.now();
    const { registry } = make();
    registry.declareFile("val", "/nonexistent/path/xyz.txt", { cache: { kind: "never" } });
    await settle();
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/unreadable/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
    registry.dispose();
  });

  it("regex no-match → varDefault", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "nothing to match");
      const { store, registry } = make();
      registry.declareFile("val", f, {
        regex: "([0-9]+)",
        varDefault: "—",
        cache: { kind: "never" },
      });
      await settle();
      expect(store.read("val")).toBe("—");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("regex no-match → records last_error", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "no numbers");
      const { registry } = make();
      registry.declareFile("val", f, { regex: "([0-9]+)", cache: { kind: "never" } });
      await settle();
      expect(registry.getLastError("val")).toBeDefined();
      expect(registry.getLastError("val")!.message).toMatch(/regex no-match/);
      registry.dispose();
    } finally {
      cleanup();
    }
  });
});

// ─── file — watch_file cache policy (file watch trigger → invalidation) ───────

describe("SourceRegistry — file: watch_file cache policy", () => {
  it("file change triggers box update", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareFile("val", f, { cache: { kind: "watch_file", path: f } });

      await settle(100);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(f, "v2");
      await settle(350);

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("multiple subscribers on one watch_file path: both file vars update", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const watchedFile = path.join(dir, "watched");
      const f1 = path.join(dir, "f1");
      const f2 = path.join(dir, "f2");
      fs.writeFileSync(watchedFile, "v1");
      fs.writeFileSync(f1, "a1");
      fs.writeFileSync(f2, "b1");
      const { store, registry } = make();
      // Both variables watch the same path (different source files)
      registry.declareFile("v1", f1, { cache: { kind: "watch_file", path: watchedFile } });
      registry.declareFile("v2", f2, { cache: { kind: "watch_file", path: watchedFile } });

      await settle(100);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      fs.writeFileSync(watchedFile, "v2"); // trigger both watchers
      await settle(350);

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });
});

// ─── dispose ──────────────────────────────────────────────────────────────────

describe("SourceRegistry — dispose", () => {
  it("dispose stops TTL updates", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareShell("val", `cat ${f}`, { cache: { kind: "ttl", durationMs: 60 } });

      await settle(100);
      registry.dispose();

      fs.writeFileSync(f, "v2");
      await settle(150);
      // Timer was cleared — box stays at last value before dispose.
      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });

  it("dispose stops file watch updates", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareFile("val", f, { cache: { kind: "watch_file", path: f } });

      await settle(100);
      registry.dispose();

      fs.writeFileSync(f, "v2");
      await settle(350);
      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });
});

// ─── formatGoTime ─────────────────────────────────────────────────────────────

describe("formatGoTime", () => {
  // Fixed reference date: 2024-03-15 09:07:05 (Friday)
  const ref = new Date(2024, 2 /* March */, 15, 9, 7, 5);

  it.each([
    ["2006-01-02", "2024-03-15"],
    ["15:04:05", "09:07:05"],
    ["15:04", "09:07"],
    ["Jan 2, 2006", "Mar 15, 2024"],
    ["January 2006", "March 2024"],
    ["Mon Jan 2", "Fri Mar 15"],
    ["Monday", "Friday"],
    ["3:04 PM", "9:07 AM"],
    ["3:04 pm", "9:07 am"],
    ["06", "24"],
    ["1/2/06", "3/15/24"],
  ] as const)('layout "%s" → "%s"', (layout, expected) => {
    expect(formatGoTime(layout, ref)).toBe(expected);
  });

  it("passes through non-token characters unchanged", () => {
    expect(formatGoTime("Time: 15:04:05!", ref)).toBe("Time: 09:07:05!");
  });

  it("PM marker for hour >= 12", () => {
    const afternoon = new Date(2024, 0, 1, 14, 30, 0);
    expect(formatGoTime("3:04 PM", afternoon)).toBe("2:30 PM");
  });

  it("hour 0 renders as 12 in 12h format", () => {
    const midnight = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatGoTime("3:04 PM", midnight)).toBe("12:00 AM");
  });
});

// ─── template source kind ─────────────────────────────────────────────────────

describe("SourceRegistry — template: basic", () => {
  it("evaluates a static template literal", () => {
    const { store, registry } = make();
    registry.declareLiteral("greeting", "hello");
    registry.declareTemplate("msg", `{{ .greeting }} world`);
    expect(store.read("msg")).toBe("hello world");
    registry.dispose();
  });

  it("type is always 'string'", () => {
    const { store, registry } = make();
    registry.declareLiteral("x", "val");
    registry.declareTemplate("t", "{{ .x }}");
    expect(store.getType("t")).toBe("string");
    registry.dispose();
  });

  it("auto-invalidates when a box dependency changes", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    store.defineBox("name", "string", "Alice");
    registry.declareTemplate("greeting", `Hello, {{ .name }}!`);

    expect(store.read("greeting")).toBe("Hello, Alice!");
    store.setBox("name", "Bob");
    expect(store.read("greeting")).toBe("Hello, Bob!");
    registry.dispose();
  });

  it("auto-invalidates transitively (template reading a template)", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    store.defineBox("base", "string", "foo");
    registry.declareTemplate("mid", `{{ .base }}-mid`);
    registry.declareTemplate("top", `{{ .mid }}-top`);

    expect(store.read("top")).toBe("foo-mid-top");
    store.setBox("base", "bar");
    expect(store.read("top")).toBe("bar-mid-top");
    registry.dispose();
  });

  it("records no last_error on success", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    store.defineBox("x", "string", "ok");
    registry.declareTemplate("t", "{{ .x }}");
    store.read("t");
    expect(registry.getLastError("t")).toBeUndefined();
    registry.dispose();
  });

  it("varDefault returned when template evaluation fails (missing variable)", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    registry.declareTemplate("t", "{{ .nonexistent }}", { varDefault: "fallback" });
    expect(store.read("t")).toBe("fallback");
    expect(registry.getLastError("t")).toBeDefined();
    registry.dispose();
  });

  it("defaultEmptyValue returned when template fails and no varDefault", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "(none)");
    registry.declareTemplate("t", "{{ .nonexistent }}");
    expect(store.read("t")).toBe("(none)");
    registry.dispose();
  });
});

describe("SourceRegistry — template: cycle detection", () => {
  it("self-referencing template records a last_error at declaration", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    registry.declareTemplate("self", "{{ .self }}");
    expect(registry.getLastError("self")).toBeDefined();
    registry.dispose();
  });

  it("self-referencing template returns fallback, not unhandled throw", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "(cycle)");
    registry.declareTemplate("self", "{{ .self }}");
    expect(() => store.read("self")).not.toThrow();
    expect(store.read("self")).toBe("(cycle)");
    registry.dispose();
  });
});

// ─── time source kind ─────────────────────────────────────────────────────────

describe("SourceRegistry — time: basic", () => {
  it("initialises box with a formatted time string", () => {
    const { store, registry } = make();
    registry.declareTime("t", { format: "2006-01-02", ttlMs: 60_000 });
    const val = store.read("t") as string;
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    registry.dispose();
  });

  it("type is always 'string'", () => {
    const { store, registry } = make();
    registry.declareTime("t", { format: "15:04", ttlMs: 60_000 });
    expect(store.getType("t")).toBe("string");
    registry.dispose();
  });

  it("TTL fires and box value is refreshed", async () => {
    const { store, registry } = make();
    registry.declareTime("t", { format: "15:04:05", ttlMs: 60 });
    await settle(200);
    expect(store.read("t")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    registry.dispose();
  });

  it("default TTL is 1 second — no throw when ttlMs is omitted", () => {
    const { registry } = make();
    expect(() =>
      registry.declareTime("t", { format: "15:04:05" }),
    ).not.toThrow();
    registry.dispose();
  });

  it("dispose stops TTL timer from firing", async () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    registry.declareTime("t", { format: "15:04:05", ttlMs: 60 });
    await settle(100);
    const snapshot = store.read("t");
    registry.dispose();
    // After dispose the timer must stop; no unhandled timer callbacks.
    await settle(200);
    // Value in the store stays at whatever it was when disposed.
    expect(store.read("t")).toBe(snapshot);
  });
});

// ─── depends_on cache policy ──────────────────────────────────────────────────

describe("SourceRegistry — depends_on cache policy", () => {
  it("triggers shell re-run when a named dependency changes", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await settle(150);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b");
      await settle(250);

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("does NOT re-run shell when dependency value is unchanged", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await settle(150);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "a"); // same value — reaction data unchanged → no re-run
      await settle(250);

      expect(store.read("val")).toBe("v1");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("multiple deps: triggers when any one changes", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      store.defineBox("a", "string", "x");
      store.defineBox("b", "string", "y");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "depends_on", varNames: ["a", "b"] },
      });

      await settle(150);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("b", "z"); // only "b" changes
      await settle(250);

      expect(store.read("val")).toBe("v2");
      registry.dispose();
    } finally {
      cleanup();
    }
  });

  it("dispose stops depends_on from firing further updates", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await settle(150);
      registry.dispose();

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b"); // reaction must NOT fire after dispose
      await settle(250);

      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });
});
