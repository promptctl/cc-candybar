import { processLauncher } from "../src/proc/launch";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { reaction } from "mobx";
import { ColorDepth, ensureContrast, parseRgbHex } from "@promptctl/rich-js";
import { feedInputs } from "./helpers/inputs";
import { shellGate } from "./helpers/shell-gate";
import { until } from "./helpers/until";
import { handDelivery } from "./helpers/hand-delivery";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { EventEmitter } from "events";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import type { Delivery } from "../src/daemon/cache/file-events";
import {
  VariableStore,
  SourceRegistry,
  parseDuration,
  MIN_SHELL_TTL_MS,
  type Published,
  type SourceParse,
} from "../src/var-system";
import { SessionState } from "../src/daemon/session-state";
import { createLauncher } from "../src/proc/launch";
import { readPending } from "../src/var-system/types";
import { PENDING } from "../src/utils/outcome";
import { drawingAt } from "./helpers/test-engine";
import { buildScope } from "../src/template-engine/scope";

// [LAW:one-source-of-truth] Tests pin to the production constant so a future
// MIN_SHELL_TTL_MS bump doesn't silently desync test timings.
//
// [LAW:dataflow-not-control-flow] Real subprocess timing can't be advanced
// by fake timers (the OS does the spawning, not the test runner), so these
// TTL tests are unavoidably real-time. The buffer accounts for setInterval
// drift; the run the tick starts is awaited through `ran`, not guessed here.
const TTL_TICK_BUFFER_MS = 200;
const TTL_TICK_WAIT_MS = MIN_SHELL_TTL_MS + TTL_TICK_BUFFER_MS;

// The parse step every shell/file declaration names: the identity, the
// identity with a fallback, or a group-1 slice (with an optional fallback).
const TEXT: SourceParse = { kind: "text", default: undefined };
const text = (dflt: string): SourceParse => ({ kind: "text", default: dflt });
const regex = (pattern: string, dflt?: string): SourceParse => ({
  kind: "regex",
  regex: new RegExp(pattern),
  default: dflt,
});

// [LAW:single-enforcer] The one owner of a registry's teardown: every registry a
// test builds is disposed after it, pass or fail, so a failed assertion cannot
// leave a TTL interval spawning `cat` — or a watcher — under the rest of the
// suite and holding Jest open. A test whose subject is dispose still calls it;
// dispose is idempotent.
const live = new Set<SourceRegistry>();
afterEach(() => {
  for (const registry of live) registry.dispose();
  live.clear();
});
type AfterLauncher<T> = T extends [unknown, ...infer Rest] ? Rest : never;
function registryOver(
  ...args: AfterLauncher<ConstructorParameters<typeof SourceRegistry>>
): SourceRegistry {
  const registry = new SourceRegistry(processLauncher, ...args);
  live.add(registry);
  return registry;
}

// Helper: fresh pair so tests are fully isolated.
function make(defaultEmptyValue?: string) {
  const store = new VariableStore();
  return { store, registry: registryOver(store, defaultEmptyValue) };
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

describe("SourceRegistry — input: before its first payload", () => {
  // brandon-unfiled-3248.8ro6: not answered yet is its own state. An input has
  // no value until a payload writes it — never its default, which answers a
  // payload that lacks the path — so what reads it before then waits.
  it("an input not answered yet reports no earlier read's error", () => {
    const { store, registry } = make("(unset)");
    registry.declareInput("count", "count", "number", undefined, "computed");
    feedInputs(registry, { count: "not a number" });
    // An input is derived: its error is recorded when it is read.
    expect(store.read("count")).toBe(0);
    expect(registry.getLastError("count")).toBeDefined();
    feedInputs(registry, { count: PENDING });
    expect(() => store.read("count")).toThrow(/no value yet/);
    expect(registry.getLastError("count")).toBeUndefined();
  });

  it("is not answered yet, whatever its default", () => {
    const { store, registry } = make("(unset)");
    registry.declareInput("cwd", "cwd", "string", "/default", "computed");
    registry.declareInput("count", "count", "number", undefined, "computed");
    registry.declareInput("flag", "flag", "boolean", undefined, "computed");
    for (const name of ["cwd", "count", "flag"]) {
      let thrown: unknown;
      try {
        store.read(name);
      } catch (e) {
        thrown = e;
      }
      expect(readPending(thrown)?.variable).toBe(name);
    }
    expect(store.changeKey("cwd")).toEqual(PENDING);
    expect(registry.getLastError("cwd")).toBeUndefined();
    feedInputs(registry, {});
    expect(store.read("cwd")).toBe("/default");
    // A default that cannot be the input's type answers as its zero.
    expect(store.read("count")).toBe(0);
    expect(store.read("flag")).toBe(false);
  });
});

describe("SourceRegistry — input: round-trip", () => {
  it("resolves a top-level path and updates the box", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", undefined, "computed");
    feedInputs(registry, { cwd: "/home/user/project" });
    expect(store.read("cwd")).toBe("/home/user/project");
  });

  it("resolves a nested dotted path", () => {
    const { store, registry } = make();
    registry.declareInput("session_id", "session_id", "string", undefined, "computed");
    feedInputs(registry, { session_id: "abc123" });
    expect(store.read("session_id")).toBe("abc123");
  });

  it("resolves deeply nested paths", () => {
    const { store, registry } = make();
    registry.declareInput("model_name", "model.display_name", "string", undefined, "computed");
    feedInputs(registry, { model: { display_name: "claude-opus-4" } });
    expect(store.read("model_name")).toBe("claude-opus-4");
  });

  it("resolves a number field", () => {
    const { store, registry } = make();
    registry.declareInput("tokens", "context_window.total_input_tokens", "number", undefined, "computed");
    feedInputs(registry, { context_window: { total_input_tokens: 5000 } });
    expect(store.read("tokens")).toBe(5000);
  });

  it("resolves a boolean field", () => {
    const { store, registry } = make();
    registry.declareInput("expanded", "state.toolbarExpanded", "boolean", undefined, "computed");
    feedInputs(registry, { state: { toolbarExpanded: true } });
    expect(store.read("expanded")).toBe(true);
  });

  it("clears last_error on successful resolution", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", undefined, "computed");
    // First payload fails
    feedInputs(registry, {});
    store.read("cwd");
    expect(registry.getLastError("cwd")).toBeDefined();
    // Second payload succeeds — error cleared
    feedInputs(registry, { cwd: "/now/present" });
    store.read("cwd");
    expect(registry.getLastError("cwd")).toBeUndefined();
  });
});

describe("SourceRegistry — input: missing path fallback chain", () => {
  it("uses varDefault when path is missing", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", "/fallback", "computed");
    feedInputs(registry, {});
    expect(store.read("cwd")).toBe("/fallback");
  });

  it("records last_error when path is missing", () => {
    const { store, registry } = make();
    const before = Date.now();
    registry.declareInput("cwd", "cwd", "string", undefined, "computed");
    feedInputs(registry, {});
    store.read("cwd");
    const err = registry.getLastError("cwd");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not found in payload/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("uses defaultEmptyValue when path missing and no varDefault (string)", () => {
    const { store, registry } = make("(none)");
    registry.declareInput("cwd", "cwd", "string", undefined, "computed");
    feedInputs(registry, {});
    expect(store.read("cwd")).toBe("(none)");
  });

  it("uses zero value when path missing, no varDefault, defaultEmptyValue incompatible (number)", () => {
    const { store, registry } = make("not-a-number");
    registry.declareInput("count", "count", "number", undefined, "computed");
    feedInputs(registry, {});
    expect(store.read("count")).toBe(0);
  });

  it("uses zero value for boolean type when all fallbacks fail", () => {
    const { store, registry } = make("not-a-bool");
    registry.declareInput("flag", "flag", "boolean", undefined, "computed");
    feedInputs(registry, {});
    expect(store.read("flag")).toBe(false);
  });

  it("returns undefined for missing intermediate path segment", () => {
    const { store, registry } = make();
    registry.declareInput("name", "model.display_name", "string", "default-name", "computed");
    feedInputs(registry, { model: null });
    expect(store.read("name")).toBe("default-name");
  });
});

describe("SourceRegistry — input: runInAction batching", () => {
  it("updates multiple input boxes in one action so dependents invalidate once", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    let evalCount = 0;

    registry.declareInput("a", "a", "string", undefined, "computed");
    registry.declareInput("b", "b", "string", undefined, "computed");

    // computed that reads both input boxes
    store.defineComputed("combined", "string", (read) => {
      evalCount++;
      return `${read("a")}:${read("b")}`;
    });

    // warm the computed over the first payload
    feedInputs(registry, {});
    expect(store.read("combined")).toBe(":");
    evalCount = 0; // reset after warmup

    // Apply both inputs together — computed should re-evaluate at most once
    feedInputs(registry, { a: "hello", b: "world" });
    expect(store.read("combined")).toBe("hello:world");

    // MobX batching: keepAlive computed re-runs on first access after invalidation,
    // not during the action. Eval count should be exactly 1.
    expect(evalCount).toBe(1);
  });

  it("updates independently across multiple payloads fed in turn", () => {
    const { store, registry } = make();
    registry.declareInput("cwd", "cwd", "string", undefined, "computed");

    feedInputs(registry, { cwd: "/first" });
    expect(store.read("cwd")).toBe("/first");

    feedInputs(registry, { cwd: "/second" });
    expect(store.read("cwd")).toBe("/second");
  });
});

// ─── interaction with VariableStore computeds ─────────────────────────────────

describe("SourceRegistry — input boxes as computed dependencies", () => {
  it("invalidates computeds when input boxes update", () => {
    const store = new VariableStore();
    const registry = registryOver(store);

    registry.declareInput("cwd", "cwd", "string", "/initial", "computed");
    store.defineComputed("basename", "string", (read) => {
      const p = String(read("cwd"));
      return p.split("/").at(-1) ?? "";
    });

    feedInputs(registry, {});
    expect(store.read("basename")).toBe("initial");
    feedInputs(registry, { cwd: "/home/user/project" });
    expect(store.read("basename")).toBe("project");
  });

  it("literal box is stable as a computed dependency", () => {
    const store = new VariableStore();
    const registry = registryOver(store);

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

// A test waits on what it asserts. `ran` waits on the registry's own state
// for "every run it started has finished" — `settled()`, the state
// `cc-candybar check` awaits — and fails naming any run still out; a fixed
// sleep read "" instead of "hello world" whenever a full-suite spawn outlasted
// its guess (brandon-unfiled-3248.e8p). A run a trigger starts (a key or
// depends_on reaction) is tracked the moment the trigger lands, so `ran` covers
// it too.
const RUN_WITHIN_MS = 10_000;
async function ran(registry: SourceRegistry): Promise<void> {
  expect(await registry.settled(RUN_WITHIN_MS)).toEqual([]);
}

// A wall-clock wait, for what no state reports: a TTL tick still to come, or a
// window in which nothing may change.
function elapse(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A watcher (fs.watch, the git cache's) attaches and delivers with no signal,
// so a watcher test repeats an idempotent change until the value it asserts
// appears, then asserts it. Each pass awaits the run the change started, so the
// budget counts deliveries, not how long a spawn takes.
async function repeatUntil(
  registry: SourceRegistry,
  done: () => boolean,
  change: () => void,
  what: string,
): Promise<void> {
  await until(async () => {
    if (done()) return true;
    change();
    await elapse(50);
    await ran(registry);
    return done();
  }, what, 15_000);
}

// ─── shell — basic ────────────────────────────────────────────────────────────

describe("SourceRegistry — shell: basic", () => {
  it("populates box with command stdout (never policy)", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "hello world"', { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    expect(store.read("val")).toBe("hello world");
  });

  it("replaces newlines with spaces in multi-line output", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'printf "a\\nb\\nc"', { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    expect(store.read("val")).toBe("a b c");
  });

  it("folds CRLF and bare CR line breaks to spaces in text and regex output", async () => {
    const { store, registry } = make();
    registry.declareShell("crlf", 'printf "a\\r\\nb\\rc\\r\\n"', { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    registry.declareShell("gap", 'printf "a\\r\\nb"', {
      cwd: process.cwd(),
      parse: regex("a(\\s*)b"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("crlf")).toBe("a b c");
    expect(store.read("gap")).toBe(" ");
  });

  it("extracts regex group-1 from stdout", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "load: 0.52 0.48 0.45"', {
      cwd: process.cwd(),
      parse: regex("load:\\s*([0-9.]+)"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("val")).toBe("0.52");
  });

  it("shell failure → varDefault", async () => {
    const { store, registry } = make();
    registry.declareShell("val", "exit 1", {
      cwd: process.cwd(),
      parse: text("fallback"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("val")).toBe("fallback");
  });

  it("shell failure → records last_error", async () => {
    const before = Date.now();
    const { registry } = make();
    registry.declareShell("val", "exit 2", { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/exited with code/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("a read its launcher refused is a failed read, not the registry's abort", async () => {
    const closing = new AbortController();
    closing.abort(new Error("the daemon closed"));
    const registry = new SourceRegistry(
      createLauncher({ signal: closing.signal }),
      new VariableStore(),
    );
    live.add(registry);
    registry.declareShell("val", "echo x", { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    expect(registry.getLastError("val")!.message).toBe(
      `shell "echo x" aborted: the daemon closed in ${process.cwd()}`,
    );
  });

  it("runs the command in its declared cwd, and every failure names that cwd", async () => {
    const a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cwd-a-")));
    const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cwd-b-")));
    const gone = path.join(b, "removed-worktree");
    const { store, registry } = make();
    try {
      registry.declareShell("inA", "pwd -P", { cwd: a, parse: TEXT, cache: { kind: "never" } });
      registry.declareShell("inB", "pwd -P", { cwd: b, parse: TEXT, cache: { kind: "never" } });
      registry.declareShell("bad", "exit 4", { cwd: b, parse: TEXT, cache: { kind: "never" } });
      registry.declareShell("miss", "echo x", {
        cwd: b,
        parse: { kind: "regex", regex: /(y)/, default: undefined },
        cache: { kind: "never" },
      });
      registry.declareShell("gone", "echo x", { cwd: gone, parse: TEXT, cache: { kind: "never" } });
      await ran(registry);
      expect(store.read("inA")).toBe(a);
      expect(store.read("inB")).toBe(b);
      expect(registry.getLastError("bad")!.message).toBe(
        `shell "exit 4" exited with code 4 in ${b}`,
      );
      expect(registry.getLastError("miss")!.message).toMatch(
        new RegExp(`regex no-match.* in output of "echo x" in ${b}$`),
      );
      // A removed working directory is named as such — Node's own text
      // (`spawn /bin/sh ENOENT`) would blame the shell.
      expect(registry.getLastError("gone")!.message).toBe(
        `shell "echo x" spawn-error: working directory does not exist: ${gone} in ${gone}`,
      );
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("shell failure → defaultEmptyValue when no varDefault", async () => {
    const { store, registry } = make("(none)");
    registry.declareShell("val", "exit 1", { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    expect(store.read("val")).toBe("(none)");
  });

  it("regex no-match → varDefault", async () => {
    const { store, registry } = make();
    registry.declareShell("val", 'echo "nothing here"', {
      cwd: process.cwd(),
      parse: regex("([0-9]+)", "—"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("val")).toBe("—");
  });

  it("regex no-match → records last_error", async () => {
    const { registry } = make();
    registry.declareShell("val", 'echo "no digits"', {
      cwd: process.cwd(),
      parse: regex("([0-9]+)"),
      cache: { kind: "never" },
    });
    await ran(registry);
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/regex no-match/);
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
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "never" },
      });
      await ran(registry);
      expect(registry.getLastError("val")).toBeDefined();

      // Can't re-run on "never" — use a separate variable to test error-clearing
      const { store: store2, registry: registry2 } = make();
      // Command that succeeds
      registry2.declareShell("val", `echo "ok"`, { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
      await ran(registry2);
      expect(registry2.getLastError("val")).toBeUndefined();
      expect(store2.read("val")).toBe("ok");
    } finally {
      cleanup();
    }
  });
});

// ─── shell — TTL floor ───────────────────────────────────────────────────────

// [LAW:single-enforcer] declareShell clamps user-requested TTLs at the floor
// to prevent unbounded subprocess churn from a misconfigured `ttl: 50ms`.
describe("SourceRegistry — shell: TTL floor", () => {
  it("TTL below floor is clamped (no refresh within sub-floor window)", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "v");
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      // Request 50ms — well below the floor. The floor must clamp the
      // effective TTL, so a sub-floor settle window must NOT see the refresh.
      // The interval starts at the declaration, so the window is measured from
      // there, not from when the first read lands.
      const declaredAt = Date.now();
      registry.declareShell("val", `cat ${f}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 50 },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(f, "v2");
      // Sleep less than MIN_SHELL_TTL_MS — refresh has NOT fired yet even
      // though the user's requested 50ms has elapsed many times over.
      await elapse(declaredAt + MIN_SHELL_TTL_MS - 150 - Date.now());
      expect(store.read("val")).toBe("v1");

      // Sleep enough to cross the floor (plus buffer) — refresh now fires.
      await elapse(TTL_TICK_WAIT_MS);
      await ran(registry);
      expect(store.read("val")).toBe("v2");
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
      // [LAW:single-enforcer] Shell TTLs are floored at MIN_SHELL_TTL_MS.
      // Tests use that exact value and wait MIN_SHELL_TTL_MS+buffer for a tick.
      registry.declareShell("val", `cat ${f}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(f, "v2");
      await elapse(TTL_TICK_WAIT_MS); // ≥ 1 TTL tick
      await ran(registry);

      expect(store.read("val")).toBe("v2");
    } finally {
      cleanup();
    }
  });

  // [LAW:nothing-unseen] A user source is a source like any other: its
  // refreshes are recorded in the ledger under its derived scope, by the
  // trigger that asked — its first read, then its period.
  it("records each run in the ledger: its first read, then its period's", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "v");
      fs.writeFileSync(f, "v1");
      const ledger = new RefreshLedger();
      const store = new VariableStore();
      const registry = registryOver(store, "", undefined, null, ledger);
      registry.declareShell("val", `cat ${f}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });
      await ran(registry);
      await elapse(TTL_TICK_WAIT_MS);
      await ran(registry);

      expect(ledger.snapshot()).toEqual([
        {
          name: "var.val",
          scope: "directory",
          refreshes: { first: 1, period: expect.any(Number) },
          failures: 0,
          lastMs: expect.any(Number),
        },
      ]);
      expect(ledger.snapshot()[0]!.refreshes.period).toBeGreaterThanOrEqual(1);
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
      registry.declareShell("v1", `cat ${f1}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });
      registry.declareShell("v2", `cat ${f2}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });

      await ran(registry);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      await elapse(TTL_TICK_WAIT_MS); // ≥ 1 TTL tick
      await ran(registry);

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
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
      registry.declareShell("val", `cat ${f}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      registry.dispose();

      fs.writeFileSync(f, "v2");
      await elapse(TTL_TICK_WAIT_MS); // timer should NOT fire after dispose

      expect(store.read("val")).toBe("v1"); // unchanged
    } finally {
      cleanup();
    }
  });
});

const STALLED_AT = Date.parse("2026-10-27T04:00:00.000Z");

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
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "watch_file", path: watchedFile },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      await repeatUntil(
        registry,
        () => store.read("val") === "v2",
        () => fs.writeFileSync(watchedFile, "x"),
        "the store reading v2",
      );

      expect(store.read("val")).toBe("v2");
    } finally {
      cleanup();
    }
  });

  it("a watched directory fires on a change to an entry inside it", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const watchedDir = path.join(dir, "refs");
      const dataFile = path.join(dir, "data");
      fs.mkdirSync(watchedDir);
      fs.writeFileSync(dataFile, "v1");
      const { store, registry } = make();
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "watch_file", path: watchedDir },
      });
      await ran(registry);
      fs.writeFileSync(dataFile, "v2");
      // fs.watch attaches with no ready signal: repeat the idempotent change.
      let write = 0;
      await repeatUntil(
        registry,
        () => store.read("val") === "v2",
        () => fs.writeFileSync(path.join(watchedDir, "main"), String(write++)),
        "the store reading v2",
      );
      expect(store.read("val")).toBe("v2");
    } finally {
      cleanup();
    }
  });

  it("a file whose directories appear after load is read when it is written", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "state", "deep", "data");
      const { store, registry } = make();
      registry.declareFile("val", f, {
        parse: text("(none)"),
        cache: { kind: "watch_file", path: f },
      });
      await ran(registry);
      expect(store.read("val")).toBe("(none)");
      // Each directory that appears re-arms the watch one level deeper; the
      // watch attaches with no ready signal, so the idempotent write repeats.
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // Let the mkdir's own event land first, so only a write can deliver v1.
      await elapse(500);
      expect(store.read("val")).toBe("(none)");
      await repeatUntil(
        registry,
        () => store.read("val") === "v1",
        () => fs.writeFileSync(f, "v1"),
        "the store reading v1",
      );
      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });

  it("removing the watched file's directory is read as the file's removal", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "state", "data");
      fs.mkdirSync(path.dirname(f));
      fs.writeFileSync(f, "v1");
      const { store, registry } = make();
      registry.declareFile("val", f, {
        parse: text("(none)"),
        cache: { kind: "watch_file", path: f },
      });
      await ran(registry);
      await elapse(100); // the watch attaches with no ready signal, and a removal is not repeatable
      expect(store.read("val")).toBe("v1");
      fs.rmSync(path.dirname(f), { recursive: true });
      await repeatUntil(registry, () => store.read("val") === "(none)", () => undefined, "the store reading (none)");
      expect(store.read("val")).toBe("(none)");
    } finally {
      cleanup();
    }
  });

  it("a watch the OS refuses is the source's error, not a throw", async () => {
    const { dir, cleanup } = makeTmpDir();
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0);
    try {
      const f = path.join(locked, "data");
      const { registry } = make();
      registry.declareFile("val", f, {
        parse: text("(none)"),
        cache: { kind: "watch_file", path: f },
      });
      expect(registry.getLastError("val")?.message).toMatch(
        /watch_file .*cannot watch/,
      );
      // The first read's outcome lands later and does not clear the fault.
      await ran(registry);
      expect(registry.getLastError("val")?.message).toMatch(
        /watch_file .*cannot watch/,
      );
    } finally {
      fs.chmodSync(locked, 0o700);
      cleanup();
    }
  });

  it("a watched symlink fires on a write to its target", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir, "real"));
      const real = path.join(dir, "real", "state");
      const link = path.join(dir, "state");
      fs.writeFileSync(real, "v1");
      fs.symlinkSync(real, link);
      const { store, registry } = make();
      registry.declareFile("val", link, {
        parse: TEXT,
        cache: { kind: "watch_file", path: link },
      });
      await ran(registry);
      await repeatUntil(
        registry,
        () => store.read("val") === "v2",
        () => fs.writeFileSync(real, "v2"),
        "the store reading v2",
      );
      expect(store.read("val")).toBe("v2");
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
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "watch_file", path: watchedFile },
      });
      registry.declareShell("v2", `cat ${f2}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "watch_file", path: watchedFile },
      });

      await ran(registry);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      await repeatUntil(
        registry,
        () => store.read("v1") === "a2" && store.read("v2") === "b2",
        () => fs.writeFileSync(watchedFile, "y"),
        "both stores reading a2 and b2",
      );

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
    } finally {
      cleanup();
    }
  });
});

// ─── shell — key: cache policy ────────────────────────────────────────────────

describe("SourceRegistry — shell: key: cache policy", () => {
  // brandon-unfiled-3248.8ro6: a source whose policy reads a view's inputs
  // waits for them. Its first read is the one its first value asks for — not
  // a read at declaration, under no value, and another when the payload
  // arrives.
  it.each([
    ["key", { kind: "key", template: "{{ .pane }}" }],
    ["depends_on", { kind: "depends_on", varNames: ["pane"] }],
  ] as const)(
    "a %s over an input reads once, at the view's first payload",
    async (_policy, cache) => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const runs = path.join(dir, "runs");
        const store = new VariableStore();
        const registry = registryOver(store);
        registry.declareInput("pane", "tmux.pane", "string", undefined, "computed");
        registry.declareShell("val", `echo run >> ${runs}; echo ran`, {
          cwd: process.cwd(),
          parse: TEXT,
          cache,
        });
        await ran(registry);
        expect(fs.existsSync(runs)).toBe(false);
        // A payload with no pane is an answer: the input's fallback.
        feedInputs(registry, {});
        await ran(registry);
        expect(fs.readFileSync(runs, "utf8")).toBe("run\n");
        expect(store.read("val")).toBe("ran");
        // An unchanged payload reads nothing; a changed one reads once more.
        feedInputs(registry, {});
        await ran(registry);
        feedInputs(registry, { tmux: { pane: "%1" } });
        await ran(registry);
        expect(fs.readFileSync(runs, "utf8")).toBe("run\nrun\n");
      } finally {
        cleanup();
      }
    },
  );

  it("re-runs shell when key template result changes", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = registryOver(store);
      // Put a box directly in the store — the key template will read it.
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "key", template: "{{ .trigger }}" },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      // Mutate the data and change the key — reaction fires, shell re-runs.
      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b");
      await ran(registry);

      expect(store.read("val")).toBe("v2");
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
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "key", template: "{{ .trigger }}" },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      // Change data file, but do NOT change the key.
      fs.writeFileSync(dataFile, "v2");
      // trigger stays "a" — key template still produces "a" — no re-run.
      await elapse(250);
      await ran(registry);

      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });

  it("a key that throws is the variable's error until it evaluates again", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "bad");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: {
          kind: "key",
          template:
            '{{ if hasPrefix "bad" .trigger }}{{ fail "no key" }}{{ end }}{{ .trigger }}',
        },
      });
      const fault = /^cache key: .*no key/;
      expect(registry.getLastError("val")?.message).toMatch(fault);
      expect([...registry.cachePolicyFaults().keys()]).toEqual(["val"]);
      // The fault is published, as a stored value is: what a view reacts to.
      const published: Published[] = [];
      const stop = reaction(() => registry.published(), (p) => published.push(p));
      expect(registry.published().faults).toEqual([
        { timestamp: expect.any(Number), message: expect.stringMatching(fault) },
      ]);

      // A key that throws is no key: the source does not run under it.
      await ran(registry);
      expect(store.read("val")).toBe("");
      expect(registry.getLastError("val")?.message).toMatch(fault);

      // A key that throws again is no key change: still nothing runs.
      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "bad again");
      await ran(registry);
      expect(store.read("val")).toBe("");
      // The same fault standing again publishes nothing.
      expect(published).toEqual([]);

      // The key evaluating again is a key: the source re-runs, the fault clears.
      store.setBox("trigger", "a");
      await ran(registry);
      expect(store.read("val")).toBe("v2");
      expect(registry.getLastError("val")).toBeUndefined();
      expect(registry.cachePolicyFaults().size).toBe(0);
      expect(published.at(-1)).toEqual({ values: ["v2"], faults: [] });
      stop();
    } finally {
      cleanup();
    }
  });

  it("a key that throws and comes back unchanged runs nothing", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "ok");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: {
          kind: "key",
          template: '{{ if eq .trigger "bad" }}{{ fail "no key" }}{{ end }}a',
        },
      });
      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "bad");
      expect(registry.cachePolicyFaults().has("val")).toBe(true);
      // The key is "a" again, the key the source last ran under.
      store.setBox("trigger", "fine");
      await elapse(250);
      await ran(registry);
      expect(store.read("val")).toBe("v1");
      expect(registry.cachePolicyFaults().size).toBe(0);
    } finally {
      cleanup();
    }
  });

  // A key over a document that has not completed its first scan is waiting,
  // not stuck: the reaction tracks the document and fires when it arrives.
  // Read directly, inside a function call (where the engine re-raises with a
  // cause), and through a template variable. A document whose scan FAILED is
  // a fault the key reports (the tests above), since the bar stops moving.
  it("a key over a value that is not there yet is no fault", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const docFile = path.join(dir, "doc.json");
      fs.writeFileSync(docFile, '{"x":"a"}');
      const store = new VariableStore();
      const registry = registryOver(store);
      registry.declareFile("doc", docFile, {
        parse: { kind: "json", default: undefined },
        cache: { kind: "never" },
      });
      registry.declareTemplate("t", "{{ .doc.x }}", DERIVED);
      const keys = {
        direct: "{{ .doc.x }}",
        called: '{{ index (index . "doc") "x" }}',
        derived: "{{ .t }}",
      };
      for (const [name, template] of Object.entries(keys))
        registry.declareShell(name, "echo v", {
          cwd: process.cwd(),
          parse: TEXT,
          cache: { kind: "key", template },
        });
      expect([...registry.cachePolicyFaults()]).toEqual([]);
      await ran(registry);
      expect([...registry.cachePolicyFaults()]).toEqual([]);
      for (const name of Object.keys(keys)) {
        expect(store.read(name)).toBe("v");
        expect(registry.getLastError(name)).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });

  it("a key over a variable declared after it follows that variable", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = registryOver(store);
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "key", template: "{{ .later }}" },
      });
      expect(registry.cachePolicyFaults().has("val")).toBe(true);

      // Declaring it is what the key was missing: the fault goes.
      store.defineBox("later", "string", "a");
      expect(registry.cachePolicyFaults().size).toBe(0);
      await ran(registry);

      fs.writeFileSync(dataFile, "v2");
      store.setBox("later", "b");
      await ran(registry);
      expect(store.read("val")).toBe("v2");
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
      registry.declareFile("val", f, { parse: TEXT, cache: { kind: "never" } });
      await ran(registry);
      expect(store.read("val")).toBe("line1 line2 line3");
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
      registry.declareFile("val", f, { parse: TEXT, readMode: "first-line", cache: { kind: "never" } });
      await ran(registry);
      expect(store.read("val")).toBe("ref: refs/heads/main");
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
        parse: regex("refs/heads/(.+)"),
        cache: { kind: "never" },
      });
      await ran(registry);
      expect(store.read("val")).toBe("feature-branch");
    } finally {
      cleanup();
    }
  });

  it("file missing → varDefault", async () => {
    const { store, registry } = make();
    registry.declareFile("val", "/nonexistent/path/xyz.txt", {
      parse: text("(missing)"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("val")).toBe("(missing)");
  });

  it("file missing → records last_error", async () => {
    const before = Date.now();
    const { registry } = make();
    registry.declareFile("val", "/nonexistent/path/xyz.txt", { parse: TEXT, cache: { kind: "never" } });
    await ran(registry);
    const err = registry.getLastError("val");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/unreadable/);
    expect(err!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("regex no-match → varDefault", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "nothing to match");
      const { store, registry } = make();
      registry.declareFile("val", f, {
        parse: regex("([0-9]+)", "—"),
        cache: { kind: "never" },
      });
      await ran(registry);
      expect(store.read("val")).toBe("—");
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
      registry.declareFile("val", f, { parse: regex("([0-9]+)"), cache: { kind: "never" } });
      await ran(registry);
      expect(registry.getLastError("val")).toBeDefined();
      expect(registry.getLastError("val")!.message).toMatch(/regex no-match/);
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
      registry.declareFile("val", f, { parse: TEXT, cache: { kind: "watch_file", path: f } });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      await repeatUntil(registry, () => store.read("val") === "v2", () => fs.writeFileSync(f, "v2"), "the store reading v2");

      expect(store.read("val")).toBe("v2");
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
      registry.declareFile("v1", f1, { parse: TEXT, cache: { kind: "watch_file", path: watchedFile } });
      registry.declareFile("v2", f2, { parse: TEXT, cache: { kind: "watch_file", path: watchedFile } });

      await ran(registry);
      expect(store.read("v1")).toBe("a1");
      expect(store.read("v2")).toBe("b1");

      fs.writeFileSync(f1, "a2");
      fs.writeFileSync(f2, "b2");
      await repeatUntil(
        registry,
        () => store.read("v1") === "a2" && store.read("v2") === "b2",
        () => fs.writeFileSync(watchedFile, "v2"),
        "both stores reading a2 and b2",
      );

      expect(store.read("v1")).toBe("a2");
      expect(store.read("v2")).toBe("b2");
    } finally {
      cleanup();
    }
  });

  it("a catch-up re-reads every watch_file source, in a view too, as if its watch had reported; a disposed registry hears none", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      // The watched file is never written: only the catch-up can trigger.
      const watchedFile = path.join(dir, "watched");
      const f = path.join(dir, "f");
      fs.writeFileSync(watchedFile, "w");
      fs.writeFileSync(f, "v1");
      const events = handDelivery();
      const store = new VariableStore();
      const registry = registryOver(store, "", undefined, null, new RefreshLedger(), events);
      const view = registry.view();
      live.add(view);
      registry.declareFile("home", f, { parse: TEXT, cache: { kind: "watch_file", path: watchedFile } });
      view.declareFile("own", f, { parse: TEXT, cache: { kind: "watch_file", path: watchedFile } });
      await ran(registry);
      await ran(view);
      expect(store.read("home")).toBe("v1");
      expect(view.variableStore.read("own")).toBe("v1");

      fs.writeFileSync(f, "v2");
      events.notify({ kind: "caught-up", since: STALLED_AT });
      await until(
        () => store.read("home") === "v2" && view.variableStore.read("own") === "v2",
        "both registries re-reading v2",
      );

      view.dispose();
      registry.dispose();
      expect(events.listening()).toBe(0);
    } finally {
      cleanup();
    }
  });

  // A stall is the delivery owner's one fact, so every watch_file variable
  // reads it there. The watched file is never written in these: only the
  // owner's word can move them, and no OS watcher has to break.
  describe("while file events are stalled", () => {
    const STALL = "file events stopped at 2026-10-27T04:00:00.000Z";
    const stalled: Delivery = { kind: "stalled", missedSince: STALLED_AT };
    const delivering: Delivery = { kind: "delivering", unreported: [], missedSince: null };

    function rig(dir: string) {
      const watched = path.join(dir, "watched");
      const data = path.join(dir, "data");
      fs.writeFileSync(watched, "w");
      fs.writeFileSync(data, "before");
      const events = handDelivery();
      const store = new VariableStore();
      const registry = registryOver(store, "", undefined, null, new RefreshLedger(), events);
      const cache = { kind: "watch_file", path: watched } as const;
      return { watched, data, events, store, registry, cache };
    }

    it("every watch_file variable, in a view too, says so with the span's start; a ttl variable does not", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { watched, data, events, store, registry, cache } = rig(dir);
        const view = registry.view();
        live.add(view);
        registry.declareFile("file", data, { parse: TEXT, cache });
        registry.declareShell("shell", `cat ${data}`, { cwd: process.cwd(), parse: TEXT, cache });
        registry.declareFile("timed", data, { parse: TEXT, cache: { kind: "ttl", durationMs: 60_000 } });
        view.declareFile("own", data, { parse: TEXT, cache });
        await ran(registry);
        await ran(view);
        expect(view.cachePolicyFaults().size).toBe(0);
        const before = registry.published();

        events.set(stalled, { kind: "moved" });

        const faults = view.cachePolicyFaults();
        expect([...faults.keys()].sort()).toEqual(["file", "own", "shell"]);
        for (const fault of faults.values()) {
          expect(fault.message).toBe(
            `watch_file ${watched}: ${STALL}; the OS has delivered none since, not even for a file the daemon wrote to test it`,
          );
        }
        // What wakes a session's feed, so the bar draws it without a request.
        expect(registry.published()).not.toEqual(before);
      } finally {
        cleanup();
      }
    });

    it("a variable declared during a stall says so at once", () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { data, events, registry, cache } = rig(dir);
        events.set(stalled, { kind: "moved" });
        registry.declareFile("val", data, { parse: TEXT, cache });
        expect(registry.getLastError("val")?.message).toContain(STALL);
      } finally {
        cleanup();
      }
    });

    it("the catch-up clears the fault, and what was edited during the stall lands", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { data, events, store, registry, cache } = rig(dir);
        registry.declareFile("val", data, { parse: TEXT, cache });
        await ran(registry);
        events.set(stalled, { kind: "moved" });
        await ran(registry);

        fs.writeFileSync(data, "edited");
        events.set(delivering, { kind: "caught-up", since: STALLED_AT });

        expect(registry.cachePolicyFaults().size).toBe(0);
        await until(() => store.read("val") === "edited", "the edit landing");
      } finally {
        cleanup();
      }
    });

    // No variable drops the fault still holding a value from before the stall,
    // and a span still open cannot be left to close it: `end()` never does.
    it("a stall that moves to unmeasured clears the fault by re-reading, with no catch-up", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { data, events, store, registry, cache } = rig(dir);
        registry.declareFile("val", data, { parse: TEXT, cache });
        await ran(registry);
        events.set(stalled, { kind: "moved" });
        await ran(registry);

        fs.writeFileSync(data, "edited");
        events.set(
          { kind: "unmeasured", since: STALLED_AT + 60_000, reason: "disk full", missedSince: STALLED_AT },
          { kind: "moved" },
        );

        expect(registry.cachePolicyFaults().size).toBe(0);
        await until(() => store.read("val") === "edited", "the edit landing");
      } finally {
        cleanup();
      }
    });

    it("a second notice in one stall keeps the fault's record", () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { data, events, registry, cache } = rig(dir);
        registry.declareFile("val", data, { parse: TEXT, cache });
        events.set(stalled, { kind: "moved" });
        const record = registry.cachePolicyFaults().get("val");

        events.notify({ kind: "moved" });

        expect(registry.cachePolicyFaults().get("val")).toBe(record);
      } finally {
        cleanup();
      }
    });
  });

  // A linked path changes wherever any link in its chain is re-pointed, and
  // where the file at its end is replaced or first appears; each lives in a
  // directory of its own here, so only the watch on that directory can hear it.
  // One owner opens, counts and logs every directory watch in the daemon:
  // a directory home and its session's view watching one path hold one slot
  // on one handle, which closes with the last of them.
  it("a watch_file watch is the watcher registry's, shared by a directory home and its view", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1");
      const counters = {
        watchersOpened: 0,
        watchersClosed: 0,
        watchRefusals: 0,
        watchErrors: 0,
        dirWatchesOpened: 0,
        dirWatchesClosed: 0,
      };
      const watchers = new WatcherRegistry({ counters, logger: () => {} });
      const home = registryOver(new VariableStore(), "", undefined, null, new RefreshLedger(), undefined, watchers);
      const view = home.view();
      live.add(view);
      home.declareFile("a", f, { parse: TEXT, cache: { kind: "watch_file", path: f } });
      view.declareFile("b", f, { parse: TEXT, cache: { kind: "watch_file", path: f } });
      await ran(home);
      await ran(view);
      expect(watchers.size()).toBe(1);
      expect(counters).toMatchObject({ watchersOpened: 1, dirWatchesOpened: 1 });
      view.dispose();
      expect(counters).toMatchObject({ watchersClosed: 0, dirWatchesClosed: 0 });
      home.dispose();
      expect(counters).toMatchObject({ watchersClosed: 1, dirWatchesClosed: 1 });
      expect(watchers.size()).toBe(0);
    } finally {
      cleanup();
    }
  });

  describe("through a chain of links", () => {
    // `ln -sfn`: a new link renamed over the old one.
    const relink = (link: string, to: string) => {
      fs.symlinkSync(to, `${link}.new`);
      fs.renameSync(`${link}.new`, link);
    };

    // dir/a → dir/hop/b → dir/one/state
    function chain(dir: string) {
      for (const d of ["hop", "one", "two"]) fs.mkdirSync(path.join(dir, d));
      const a = path.join(dir, "a");
      const b = path.join(dir, "hop", "b");
      fs.symlinkSync(b, a);
      fs.symlinkSync(path.join(dir, "one", "state"), b);
      return { a, b };
    }

    it("re-pointing a link partway along the chain re-reads the var", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { a, b } = chain(dir);
        fs.writeFileSync(path.join(dir, "one", "state"), "v1");
        fs.writeFileSync(path.join(dir, "two", "state"), "v2");
        const { store, registry } = make();
        registry.declareFile("val", a, { parse: TEXT, cache: { kind: "watch_file", path: a } });
        await ran(registry);
        expect(store.read("val")).toBe("v1");
        await repeatUntil(
          registry,
          () => store.read("val") === "v2",
          () => relink(b, path.join(dir, "two", "state")),
          "the store reading v2",
        );
        expect(store.read("val")).toBe("v2");
      } finally {
        cleanup();
      }
    });

    it("replacing the file at the chain's end re-reads the var", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { a } = chain(dir);
        const state = path.join(dir, "one", "state");
        fs.writeFileSync(state, "v1");
        const { store, registry } = make();
        registry.declareFile("val", a, { parse: TEXT, cache: { kind: "watch_file", path: a } });
        await ran(registry);
        expect(store.read("val")).toBe("v1");
        await repeatUntil(
          registry,
          () => store.read("val") === "v2",
          () => {
            fs.writeFileSync(`${state}.new`, "v2");
            fs.renameSync(`${state}.new`, state);
          },
          "the store reading v2",
        );
        expect(store.read("val")).toBe("v2");
      } finally {
        cleanup();
      }
    });

    it("a dangling chain's file appearing re-reads the var", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const { a } = chain(dir);
        const { store, registry } = make();
        registry.declareFile("val", a, { parse: text("(none)"), cache: { kind: "watch_file", path: a } });
        await ran(registry);
        expect(store.read("val")).toBe("(none)");
        await repeatUntil(
          registry,
          () => store.read("val") === "v1",
          () => fs.writeFileSync(path.join(dir, "one", "state"), "v1"),
          "the store reading v1",
        );
        expect(store.read("val")).toBe("v1");
      } finally {
        cleanup();
      }
    });

    // A shell source never reads its trigger path, so only the watch can say
    // the chain cannot be walked; it says so for as long as that holds.
    it("a trigger chain that loops is the variable's refresh fault until it is broken", async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const x = path.join(dir, "x");
        const y = path.join(dir, "y");
        fs.symlinkSync(y, x);
        fs.symlinkSync(x, y);
        fs.writeFileSync(path.join(dir, "real"), "");
        const { registry } = make();
        registry.declareShell("val", "echo hi", {
          cwd: process.cwd(),
          parse: TEXT,
          cache: { kind: "watch_file", path: x },
        });
        expect(registry.cachePolicyFaults().get("val")?.message).toMatch(/symbolic links/);
        await repeatUntil(
          registry,
          () => !registry.cachePolicyFaults().has("val"),
          () => relink(y, path.join(dir, "real")),
          "the loop's fault clearing",
        );
        expect(registry.cachePolicyFaults().has("val")).toBe(false);
      } finally {
        cleanup();
      }
    });

    // No real directory can be made to fail its watch on demand, so each
    // directory's handle is a stand-in the test can make fail. A failed
    // directory is the watcher registry's period to open again: an event on
    // another directory of the watch re-derives and re-reads, and keeps the
    // failed one as it is.
    it("a directory whose watch fails is the variable's fault and a re-read, and is opened again only by the period's judgment", async () => {
      const { dir, cleanup } = makeTmpDir();
      const opened: Array<{ dir: string; handle: EventEmitter; listener: (event: string, changed: string | null) => void }> = [];
      const watch = jest.spyOn(fs, "watch").mockImplementation(((d: string, _opts: unknown, listener: (event: string, changed: string | null) => void) => {
        const handle = Object.assign(new EventEmitter(), { close: () => {} });
        opened.push({ dir: d, handle, listener });
        return handle;
      }) as unknown as typeof fs.watch);
      try {
        const real = fs.realpathSync(dir);
        fs.mkdirSync(path.join(dir, "one"));
        const state = path.join(dir, "one", "state");
        const a = path.join(dir, "a");
        fs.writeFileSync(state, "v1");
        fs.symlinkSync(state, a);
        const watchers = new WatcherRegistry({ logger: () => {} });
        const store = new VariableStore();
        const registry = registryOver(store, undefined, undefined, null, new RefreshLedger(), undefined, watchers);
        registry.declareFile("val", a, { parse: TEXT, cache: { kind: "watch_file", path: a } });
        await ran(registry);
        expect(store.read("val")).toBe("v1");
        const opensOf = (d: string) => opened.filter((o) => o.dir === d);
        const one = path.join(real, "one");
        expect(opensOf(one)).toHaveLength(1);
        expect(registry.cachePolicyFaults().has("val")).toBe(false);

        fs.writeFileSync(state, "v2");
        opensOf(one)[0]!.handle.emit("error", new Error("EMFILE: too many open files"));
        await until(() => store.read("val") === "v2", "the store reading v2");
        expect(registry.cachePolicyFaults().get("val")?.message).toMatch(/watching .*one failed — EMFILE/);
        expect(opensOf(one)).toHaveLength(1);

        // An event on the link's own directory re-derives and re-reads, and
        // the failed directory stays as it is.
        fs.writeFileSync(state, "v3");
        opensOf(real)[0]!.listener("rename", "a");
        await until(() => store.read("val") === "v3", "the store reading v3");
        expect(opensOf(one)).toHaveLength(1);
        expect(registry.cachePolicyFaults().get("val")?.message).toMatch(/watching .*one failed — EMFILE/);

        // The period's judgment opens it again, and the fault clears.
        watchers.judge();
        expect(opensOf(one)).toHaveLength(2);
        await until(() => !registry.cachePolicyFaults().has("val"), "the fault cleared");
      } finally {
        watch.mockRestore();
        cleanup();
      }
    });

    // Linux's inotify follows the inode, so a handle on a directory removed
    // and made again at its path hears nothing more, with no error to say so;
    // the stand-in handles let every platform see that the watch moves to the
    // new directory, and hears the file through it.
    it("a watched directory removed and made again is watched again", async () => {
      const { dir, cleanup } = makeTmpDir();
      const opened: Array<{ dir: string; closed: boolean; listener: (event: string, changed: string | null) => void }> = [];
      const watch = jest.spyOn(fs, "watch").mockImplementation(((d: string, _opts: unknown, listener: (event: string, changed: string | null) => void) => {
        const record = { dir: d, closed: false, listener };
        opened.push(record);
        return Object.assign(new EventEmitter(), { close: () => void (record.closed = true) });
      }) as unknown as typeof fs.watch);
      try {
        const one = path.join(fs.realpathSync(dir), "one");
        fs.mkdirSync(one);
        const state = path.join(one, "state");
        fs.writeFileSync(state, "v1");
        const { store, registry } = make();
        registry.declareFile("val", state, { parse: TEXT, cache: { kind: "watch_file", path: state } });
        await ran(registry);
        expect(store.read("val")).toBe("v1");
        const opensOf = (d: string) => opened.filter((o) => o.dir === d);
        expect(opensOf(one)).toHaveLength(1);

        // `rm -rf one && mkdir one`: the handle reports its own directory's name.
        fs.rmSync(one, { recursive: true });
        fs.mkdirSync(one);
        opensOf(one)[0]!.listener("rename", "one");
        await until(() => opensOf(one).length === 2, "the directory watched again");
        expect(opensOf(one)).toHaveLength(2);
        expect(opensOf(one)[0]!.closed).toBe(true);

        fs.writeFileSync(state, "v2");
        opensOf(one)[1]!.listener("rename", "state");
        await until(() => store.read("val") === "v2", "the store reading v2");
        expect(store.read("val")).toBe("v2");
      } finally {
        watch.mockRestore();
        cleanup();
      }
    });
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
      registry.declareShell("val", `cat ${f}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      });

      await ran(registry);
      registry.dispose();

      fs.writeFileSync(f, "v2");
      await elapse(TTL_TICK_WAIT_MS);
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
      registry.declareFile("val", f, { parse: TEXT, cache: { kind: "watch_file", path: f } });

      await ran(registry);
      registry.dispose();

      fs.writeFileSync(f, "v2");
      await elapse(350);
      await ran(registry);
      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });
});

// A template variable that reads no instant: what the projection fold says of
// every template these tests declare.
const DERIVED = { type: "string", derivation: "computed" } as const;

// ─── template source kind ─────────────────────────────────────────────────────

describe("SourceRegistry — template: basic", () => {
  it("evaluates a static template literal", () => {
    const { store, registry } = make();
    registry.declareLiteral("greeting", "hello");
    registry.declareTemplate("msg", `{{ .greeting }} world`, DERIVED);
    expect(store.read("msg")).toBe("hello world");
  });

  it("its type is 'string' unless declared otherwise", () => {
    const { store, registry } = make();
    registry.declareLiteral("x", "val");
    registry.declareTemplate("t", "{{ .x }}", DERIVED);
    expect(store.getType("t")).toBe("string");
  });

  it("a number template is read as a number, so it compares as one", () => {
    const { store, registry } = make();
    store.defineBox("n", "number", 41);
    registry.declareTemplate("next", "{{ add .n 1 }}", { ...DERIVED, type: "number" });
    registry.declareTemplate("big", "{{ gt .next 40 }}", DERIVED);
    expect(store.getType("next")).toBe("number");
    expect(store.read("next")).toBe(42);
    expect(store.read("big")).toBe("true");
  });

  it("a number template rendering no number is a failed read, never a zero", () => {
    const { store, registry } = make();
    registry.declareTemplate("n", "soon", { ...DERIVED, type: "number" });
    expect(() => store.read("n")).toThrow(/variable "n".*cast "soon" to number/);
    expect(registry.getLastError("n")).toBeDefined();
  });

  it("a number template's default answers its failure as a number", () => {
    const { store, registry } = make();
    registry.declareTemplate("n", "soon", { ...DERIVED, type: "number", varDefault: -1 });
    expect(store.read("n")).toBe(-1);
  });

  it("a readableOn re-measures when the drawn depth moves", () => {
    // Magenta on plum: legible in truecolor, lost once both colours round to
    // 256, so the two depths give different answers. The depth is a per-render
    // fact, and a template variable is a cached derivation — it must observe it.
    const store = new VariableStore();
    const registry = registryOver(store);
    registry.declareTemplate("ink", `{{ readableOn "#e72abb" "#2e082f" 4.5 }}`, DERIVED);
    const [fg, bg] = [parseRgbHex("e72abb"), parseRgbHex("2e082f")];
    const at = (d: ColorDepth) => ensureContrast(fg, bg, 4.5, d).hex;
    expect(at(ColorDepth.EIGHT_BIT)).not.toBe(at(ColorDepth.TRUECOLOR));

    // Before a view source is bound, the depth is not answered yet.
    expect(() => store.read("ink")).toThrow(/no value yet|no view source/);
    feedInputs(registry, {});
    expect(store.read("ink")).toBe(at(ColorDepth.TRUECOLOR));
    feedInputs(registry, {}, ColorDepth.EIGHT_BIT);
    expect(store.read("ink")).toBe(at(ColorDepth.EIGHT_BIT));
    feedInputs(registry, {}, ColorDepth.TRUECOLOR);
    expect(store.read("ink")).toBe(at(ColorDepth.TRUECOLOR));
  });

  it("auto-invalidates when a box dependency changes", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    store.defineBox("name", "string", "Alice");
    registry.declareTemplate("greeting", `Hello, {{ .name }}!`, DERIVED);

    expect(store.read("greeting")).toBe("Hello, Alice!");
    store.setBox("name", "Bob");
    expect(store.read("greeting")).toBe("Hello, Bob!");
  });

  it("auto-invalidates transitively (template reading a template)", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    store.defineBox("base", "string", "foo");
    registry.declareTemplate("mid", `{{ .base }}-mid`, DERIVED);
    registry.declareTemplate("top", `{{ .mid }}-top`, DERIVED);

    expect(store.read("top")).toBe("foo-mid-top");
    store.setBox("base", "bar");
    expect(store.read("top")).toBe("bar-mid-top");
  });

  it("records no last_error on success", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    store.defineBox("x", "string", "ok");
    registry.declareTemplate("t", "{{ .x }}", DERIVED);
    store.read("t");
    expect(registry.getLastError("t")).toBeUndefined();
  });

  it("varDefault returned when template evaluation fails (missing variable)", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    registry.declareTemplate("t", "{{ .nonexistent }}", { ...DERIVED, varDefault: "fallback" });
    expect(store.read("t")).toBe("fallback");
    expect(registry.getLastError("t")).toBeDefined();
  });

  // brandon-var-sources-1p6 NARROWED this deliberately, and the old assertion
  // (defaultEmptyValue standing in for a failed template) is what it replaces.
  // `globals.default_empty_value` is a global cosmetic floor for ABSENT values;
  // letting it also absorb a failed DERIVATION meant one unrelated global
  // silenced every broken template in a config, with nothing to tell the author
  // which of the two mechanisms had swallowed it. Tolerance is now stated per
  // variable, by the `default` on the declaration that wants it.
  it("a failed template is NOT absorbed by defaultEmptyValue: the read is the failure", () => {
    const store = new VariableStore();
    const registry = registryOver(store, "(none)");
    registry.declareTemplate("t", "{{ .nonexistent }}", DERIVED);
    expect(() => store.read("t")).toThrow(/variable "t"/);
    expect(registry.getLastError("t")).toBeDefined();
  });

  // The read IS the failure, which is what carries it to the segment that reads
  // it (⚠ naming the variable) and to `cc-candybar check` (exit 1) with no
  // co-operation from either — the same contract a non-ok document has.
  it("a template that throws with no default reads as the failure, naming variable and reason", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    registry.declareTemplate("c", '{{ ramp 35 "step" 0 "panel" }}', DERIVED);
    // `ramp` is registered per-segment by the renderer, so a variable template
    // evaluated outside any segment cannot see it — the exact shape that found
    // this bug while writing docs/segment-authoring.md.
    expect(() => store.read("c")).toThrow(/variable "c": .*ramp/);
  });

  // Registration stays non-fatal: a template may throw against declare-time
  // values and evaluate cleanly against a real payload, so the eager read
  // records the failure without rejecting the config. Loudness belongs at the
  // read that needs the value.
  it("a throwing template does not make registration throw; its read records the error", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    expect(() => registry.declareTemplate("c", "{{ .nope }}", DERIVED)).not.toThrow();
    expect(() => store.read("c")).toThrow();
    expect(registry.getLastError("c")).toBeDefined();
  });

  // changeKey reads scalars, so a failing template used as a `depends_on`
  // dependency would otherwise throw inside the reaction that asked. Failing is
  // a change, and the key carries it rather than escaping.
  it("a failing template can still be a depends_on dependency", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");
      const store = new VariableStore();
      const registry = registryOver(store);
      registry.declareTemplate("broken", "{{ .nope }}", DERIVED);
      expect(() =>
        registry.declareShell("val", `cat ${dataFile}`, {
          cwd: process.cwd(),
          parse: TEXT,
          cache: { kind: "depends_on", varNames: ["broken"] },
        }),
      ).not.toThrow();
      await ran(registry);
      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });
});

describe("SourceRegistry — template: cycle detection", () => {
  it("self-referencing template records a last_error when read", () => {
    const store = new VariableStore();
    const registry = registryOver(store);
    registry.declareTemplate("self", "{{ .self }}", DERIVED);
    expect(() => store.read("self")).toThrow();
    expect(registry.getLastError("self")).toBeDefined();
  });

  // brandon-var-sources-1p6 replaces the old assertion here, which was that this
  // read returns "(cycle)" — the defaultEmptyValue. A cycle can never produce a
  // value, so blanking it meant a config with a self-referencing template
  // rendered empty and `check` exited 0. The read is now the failure, named.
  //
  // The throw is a value-shaped failure at the read boundary, not the unhandled
  // crash the old title feared: the segment reading it renders ⚠. Reading twice
  // pins that — MobX caches the deriver's exception and re-raises the same one,
  // so a second read says the same thing and the store is not left mid-compute.
  it("a self-referencing template reads as the failure, repeatably", () => {
    const store = new VariableStore();
    const registry = registryOver(store, "(cycle)");
    registry.declareTemplate("self", "{{ .self }}", DERIVED);
    expect(() => store.read("self")).toThrow(/variable "self"/);
    expect(() => store.read("self")).toThrow(/variable "self"/);
    expect(registry.getLastError("self")).toBeDefined();
  });
});

// ─── time source kind ─────────────────────────────────────────────────────────

describe("SourceRegistry — time: the draw's instant, formatted", () => {
  // Built from local fields, so the layout's local-time reading is the same
  // wherever the suite runs.
  const at = (h: number, m: number, sec: number) =>
    new Date(2026, 5, 4, h, m, sec);
  // Fixed reference date: 2024-03-15 09:07:05 (Friday)
  const ref = new Date(2024, 2 /* March */, 15, 9, 7, 5);

  it.each([
    ["2006-01-02", ref, "2024-03-15"],
    ["15:04:05", ref, "09:07:05"],
    ["15:04", ref, "09:07"],
    ["Jan 2, 2006", ref, "Mar 15, 2024"],
    ["January 2006", ref, "March 2024"],
    ["Mon Jan 2", ref, "Fri Mar 15"],
    ["Monday", ref, "Friday"],
    ["3:04 PM", ref, "9:07 AM"],
    ["3:04 pm", ref, "9:07 am"],
    ["06", ref, "24"],
    ["1/2/06", ref, "3/15/24"],
    ["Time: 15:04:05!", ref, "Time: 09:07:05!"],
    ["3:04 PM", new Date(2024, 0, 1, 14, 30, 0), "2:30 PM"],
    ["3:04 PM", new Date(2024, 0, 1, 0, 0, 0), "12:00 AM"],
    // Go's padded day, which a layout reads as a token rather than text.
    ["Jan _2", new Date(2024, 0, 1), "Jan  1"],
  ] as const)('layout "%s" at %s → "%s"', (layout, date, expected) => {
    const { store, registry } = make();
    registry.declareTime("t", { format: layout });
    using _draw = drawingAt(date);
    expect(store.read("t")).toBe(expected);
  });

  it("is a projection: each draw reads its own instant", () => {
    const { store, registry } = make();
    registry.declareTime("t", { format: "15:04:05" });
    expect(store.getNode("t").kind).toBe("projection");
    {
      using _draw = drawingAt(at(9, 0, 0));
      expect(store.read("t")).toBe("09:00:00");
    }
    using _draw = drawingAt(at(9, 0, 1));
    expect(store.read("t")).toBe("09:00:01");
  });

  it("outside a draw, a read says so — or yields the authored default", () => {
    const { store, registry } = make();
    registry.declareTime("bare", { format: "15:04" });
    registry.declareTime("fallback", { format: "15:04", varDefault: "--:--" });
    expect(() => store.read("bare")).toThrow(
      /variable "bare": .*the clock was read outside a draw/,
    );
    expect(store.read("fallback")).toBe("--:--");
    using _draw = drawingAt(at(7, 5, 0));
    expect(store.read("bare")).toBe("07:05");
    expect(store.read("fallback")).toBe("07:05");
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
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b");
      await ran(registry);

      expect(store.read("val")).toBe("v2");
    } finally {
      cleanup();
    }
  });

  // brandon-var-sources-tex. runSource used to return early when the name was
  // already in flight, so this change — arriving while the first read was still
  // out — was dropped, and `val` settled on the pre-change content forever. Only
  // `ttl` survived that, because only `ttl` asks again on a clock.
  it("a dependency change DURING a read is not dropped: the published value is the last trigger's", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const dataFile = path.join(dir, "data");
      fs.writeFileSync(dataFile, "v1");

      const store = new VariableStore();
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      // The pass reports its own state: `cat` captures the file, `read` marks
      // that it has, and the pass then holds until the test releases `go`. So
      // the change below provably lands after the read and before the pass
      // ends — a guessed delay could land before `cat` and prove nothing.
      const readMark = path.join(dir, "read");
      const go = shellGate(path.join(dir, "go"));
      go.close();
      registry.declareShell("val", `cat ${dataFile}; touch ${readMark}; ${go.hold}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await until(() => fs.existsSync(readMark), "the pass reading the file");
      // Change both the dependency and the data: this is the collision, not a
      // sequence.
      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b");
      go.open();

      // The queued re-read is part of the tracked work, so `ran` is what
      // decides when to look — no second sleep guessing at the re-read.
      await ran(registry);
      expect(store.read("val")).toBe("v2");
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
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "a"); // same value — reaction data unchanged → no re-run
      await elapse(250);
      await ran(registry);

      expect(store.read("val")).toBe("v1");
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
      const registry = registryOver(store);
      store.defineBox("a", "string", "x");
      store.defineBox("b", "string", "y");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["a", "b"] },
      });

      await ran(registry);
      expect(store.read("val")).toBe("v1");

      fs.writeFileSync(dataFile, "v2");
      store.setBox("b", "z"); // only "b" changes
      await ran(registry);

      expect(store.read("val")).toBe("v2");
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
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `cat ${dataFile}`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["trigger"] },
      });

      await ran(registry);
      registry.dispose();

      fs.writeFileSync(dataFile, "v2");
      store.setBox("trigger", "b"); // reaction must NOT fire after dispose
      await elapse(250);
      await ran(registry);

      expect(store.read("val")).toBe("v1");
    } finally {
      cleanup();
    }
  });
});

describe("SourceRegistry — state: read-through to SessionState", () => {
  // Build a registry with a real SessionState injected. The state-kind
  // variable reads SessionState[session.id][key]; the cascade through the
  // MobX dep graph is what bzh.7 + vhi.1 rely on for verb→render reactivity.

  function makeWithState() {
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = registryOver(store, "", sessionState);
    // session.id is the conventional source for "which session am I in" —
    // inputs derive from the payload the view is bound to.
    registry.declareInput("session.id", "session_id", "string", undefined, "computed");
    return { store, registry, sessionState };
  }

  test("returns default when SessionState has no entry for the key", () => {
    const { store, registry } = makeWithState();
    registry.declareState("toolbarExpanded", { key: "toolbar-expanded" });
    feedInputs(registry, { session_id: "s1" });
    expect(store.read("toolbarExpanded")).toBe("");
  });

  test("returns SessionState value when present", () => {
    const { store, registry, sessionState } = makeWithState();
    sessionState.set("s1", "toolbar-expanded", "1");
    registry.declareState("toolbarExpanded", { key: "toolbar-expanded" });
    feedInputs(registry, { session_id: "s1" });
    expect(store.read("toolbarExpanded")).toBe("1");
  });

  test("varDefault wins when SessionState key is absent", () => {
    const { store, registry } = makeWithState();
    registry.declareState("theme", { key: "theme", varDefault: "ocean" });
    feedInputs(registry, { session_id: "s1" });
    expect(store.read("theme")).toBe("ocean");
  });

  test("set() on SessionState invalidates the computed (verb → render cascade)", () => {
    // This is the cascade the click-verb path relies on: a verb writes
    // SessionState; the next render reads through the same MobX graph and
    // sees the new value without re-reading disk.
    const { store, registry, sessionState } = makeWithState();
    registry.declareState("theme", { key: "theme" });
    feedInputs(registry, { session_id: "s1" });
    expect(store.read("theme")).toBe("");

    sessionState.set("s1", "theme", "ember");
    expect(store.read("theme")).toBe("ember");

    sessionState.clear("s1", "theme");
    expect(store.read("theme")).toBe("");
  });

  test("different sessionIds yield different state (no cross-session leakage)", () => {
    const { store, registry, sessionState } = makeWithState();
    sessionState.set("a", "theme", "ocean");
    sessionState.set("b", "theme", "ember");
    registry.declareState("theme", { key: "theme" });

    feedInputs(registry, { session_id: "a" });
    expect(store.read("theme")).toBe("ocean");

    feedInputs(registry, { session_id: "b" });
    expect(store.read("theme")).toBe("ember");
  });

  test("declareState without SessionState injection fails loudly", () => {
    // [LAW:no-silent-failure] If the registry was constructed without a
    // SessionState, declareState refuses rather than silently returning
    // empty — that would be a footgun where renders look fine until a
    // verb fires and "nothing happens."
    const store = new VariableStore();
    const registry = registryOver(store);
    expect(() =>
      registry.declareState("theme", { key: "theme" }),
    ).toThrow(/state-kind variables require a SessionState/);
  });
});

// ─── parse seam: read → parse → publish ──────────────────────────────────────

// [LAW:behavior-not-structure] The ticket's done-when, as behavior: one scan
// yields a document whose fields are dotted reads (spawn count asserted, not
// output); a bad scan is a loud error naming the variable, or the declared
// default document with the error recorded; the same parsers apply to a file's
// text, after readMode picked it.
describe("SourceRegistry — parse seam", () => {
  const json = (dflt?: Record<string, unknown>): SourceParse => ({
    kind: "json",
    default: dflt as SourceParse extends { default: infer D } ? D : never,
  });
  // The scope proxy is untyped by design (it is what `.` is in a template). A read
  // of a declared document returns its fields or throws naming the variable — never
  // undefined — so the test reads one named document as the field record it presents.
  const doc = (store: VariableStore, name: string) =>
    Reflect.get(buildScope(store), name) as Record<string, unknown>;
  const readDoc = (store: VariableStore, name: string) => {
    const doc = store.readDocument(name);
    if (doc.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(doc)}`);
    return doc.value;
  };

  it("one scan, many fields: a json shell source is spawned once and read by dotted path", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const counter = path.join(dir, "spawns");
      const { store, registry } = make();
      registry.declareShell(
        "doc",
        `echo >> ${counter}; echo '{"a": 1, "b": "x", "c": true, "nest": {"d": [1, 2]}}'`,
        { cwd: process.cwd(), parse: json(), cache: { kind: "never" } },
      );
      registry.declareTemplate(
        "t",
        "{{ .doc.a }}-{{ .doc.b }}-{{ .doc.c }}-{{ index .doc.nest.d 1 }}",
        { ...DERIVED, varDefault: "(pending)" },
      );
      await ran(registry);
      expect(readDoc(store, "doc")).toEqual({ a: 1, b: "x", c: true, nest: { d: [1, 2] } });
      expect(store.read("t")).toBe("1-x-true-2");
      expect(doc(store, "doc").b).toBe("x");
      // Three fields, one template, a direct scope read: still ONE spawn.
      expect(fs.readFileSync(counter, "utf8").split("\n").length - 1).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("a document is a namespace, never a scalar: the scalar reads refuse it by name", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `echo '{"a": 1}'`, { cwd: process.cwd(), parse: json(), cache: { kind: "never" } });
    await ran(registry);
    expect(() => store.read("doc")).toThrow(/is a document; read its fields by path/);
  });

  it("malformed JSON without a default: the document holds the failure and a read throws naming the variable", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `echo '{not json'`, { cwd: process.cwd(), parse: json(), cache: { kind: "never" } });
    await ran(registry);
    expect(store.readDocument("doc")).toMatchObject({ kind: "failed" });
    expect(() => doc(store, "doc")).toThrow(/^variable "doc": JSON parse failed: /);
    expect(registry.getLastError("doc")!.message).toMatch(/JSON parse failed/);
  });

  it("malformed JSON with a default: still the failure — a default covers nothing to read, not a broken writer", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `echo '{not json'`, {
      cwd: process.cwd(),
      parse: json({ spent: 0, label: "?" }),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.readDocument("doc")).toMatchObject({ kind: "failed" });
    expect(() => doc(store, "doc")).toThrow(/^variable "doc": JSON parse failed: /);
  });

  it("a file caught mid-rewrite keeps its document; one that stays broken shows the failure", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "state.json");
      fs.writeFileSync(f, `{ "state": "one" }`);
      const { store, registry } = make();
      registry.declareFile("doc", f, { parse: json({}), cache: { kind: "watch_file", path: f } });
      await ran(registry);
      expect(readDoc(store, "doc")).toEqual({ state: "one" });
      // In place: a truncate, then a partial write — the document holds.
      await repeatUntil(
        registry,
        () => registry.getLastError("doc") !== undefined,
        () => fs.writeFileSync(f, `{ "sta`),
        "doc's last error",
      );
      expect(readDoc(store, "doc")).toEqual({ state: "one" });
      await repeatUntil(
        registry,
        () => store.readDocument("doc").kind === "ok" && doc(store, "doc").state === "two",
        () => fs.writeFileSync(f, `{ "state": "two" }`),
        "the document reading state two",
      );
      expect(readDoc(store, "doc")).toEqual({ state: "two" });
      // Left broken past the settle: the failure shows.
      fs.writeFileSync(f, `{ "sta`);
      await repeatUntil(registry, () => store.readDocument("doc").kind === "failed", () => undefined, "the document reading failed");
      expect(store.readDocument("doc")).toMatchObject({ kind: "failed" });
    } finally {
      cleanup();
    }
  });

  it("blank output with a default reads the default", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `printf '  \\n'`, {
      cwd: process.cwd(),
      parse: json({ state: "none" }),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(readDoc(store, "doc")).toEqual({ state: "none" });
  });

  it("a failed command with a default reads the default", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `exit 3`, {
      cwd: process.cwd(),
      parse: json({ spent: 0 }),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(readDoc(store, "doc")).toEqual({ spent: 0 });
    expect(registry.getLastError("doc")!.message).toMatch(/exited with code 3/);
  });

  it("a failed command without a default is the same failure state, naming where it came from", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `exit 3`, { cwd: process.cwd(), parse: json(), cache: { kind: "never" } });
    await ran(registry);
    expect(() => doc(store, "doc")).toThrow(/variable "doc": .*exited with code 3/);
  });

  it("before the first scan lands, a read says so; settled() is the state a one-shot render awaits", async () => {
    const { store, registry } = make();
    registry.declareShell("doc", `sleep 0.3; echo '{"a": 1}'`, { cwd: process.cwd(), parse: json(), cache: { kind: "never" } });
    expect(store.readDocument("doc")).toEqual({ kind: "pending" });
    expect(() => doc(store, "doc")).toThrow(
      'variable "doc" has no value yet: its source has not completed a scan',
    );
    expect(await registry.settled(2000)).toEqual([]);
    expect(doc(store, "doc").a).toBe(1);
  });

  it("settled() names the sources still in flight at its deadline", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const gate = shellGate(path.join(dir, "gate"));
      gate.close();
      const { store, registry } = make();
      registry.declareShell("slow", `${gate.hold}; echo x`, { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
      registry.declareShell("fast", `echo y`, { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
      await until(() => store.read("fast") === "y", "fast's run publishing");
      expect(await registry.settled(0)).toEqual(["slow"]);
      gate.open();
      expect(await registry.settled(3000)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("a file source takes the same json parser", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "budget.json");
      fs.writeFileSync(f, '{"spent": 12.5, "limit": 20}\n');
      const { store, registry } = make();
      registry.declareFile("budget", f, { parse: json(), cache: { kind: "never" } });
      await ran(registry);
      expect(doc(store, "budget").spent).toBe(12.5);
    } finally {
      cleanup();
    }
  });

  it("readMode is a reader fact: first-line selects the text the regex parser sees", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "f");
      fs.writeFileSync(f, "v1.2 first\nv9.9 second\n");
      const { store, registry } = make();
      registry.declareFile("first", f, {
        readMode: "first-line",
        parse: regex("v([0-9.]+)"),
        cache: { kind: "never" },
      });
      registry.declareFile("whole", f, { parse: regex("v([0-9.]+) second"), cache: { kind: "never" } });
      await ran(registry);
      expect(store.read("first")).toBe("1.2");
      expect(store.read("whole")).toBe("9.9");
    } finally {
      cleanup();
    }
  });

  it("first-line ends at CR LF too: the regex parser never sees a trailing \\r", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "crlf");
      fs.writeFileSync(f, "v1.2\r\nv9.9\r\n");
      const { store, registry } = make();
      registry.declareFile("first", f, {
        readMode: "first-line",
        parse: regex("^v([0-9.]+)$"),
        cache: { kind: "never" },
      });
      registry.declareFile("head", f, {
        readMode: "first-line",
        parse: json(),
        cache: { kind: "never" },
      });
      await ran(registry);
      expect(store.read("first")).toBe("1.2");
      expect(registry.getLastError("first")).toBeUndefined();
      expect(registry.getLastError("head")?.message).toMatch(/^JSON parse failed/);
    } finally {
      cleanup();
    }
  });

  it("readMode first-line feeds the json parser one line", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const f = path.join(dir, "ndjson");
      fs.writeFileSync(f, '{"n": 1}\n{"n": 2}\n');
      const { store, registry } = make();
      registry.declareFile("head", f, { readMode: "first-line", parse: json(), cache: { kind: "never" } });
      await ran(registry);
      expect(doc(store, "head").n).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("a regex match with an empty group 1 is a match, not a failure", async () => {
    const { store, registry } = make();
    registry.declareShell("val", `echo "prefix:"`, {
      cwd: process.cwd(),
      parse: regex("prefix:(.*)", "fallback"),
      cache: { kind: "never" },
    });
    await ran(registry);
    expect(store.read("val")).toBe("");
    expect(registry.getLastError("val")).toBeUndefined();
  });
});

// ─── in-flight runs are the registry's ────────────────────────────────────────

describe("SourceRegistry — in-flight runs", () => {
  it("settled() waits for the run a publish triggered: a depends_on re-run fired inside the wait", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const spawns = path.join(dir, "spawns");
      const { store, registry } = make();
      // A is the slow one: its first publish lands while settled() is
      // waiting, and that publish is what re-runs B. B's own first run is
      // long done by then, so the re-run is a new in-flight entry that only
      // a re-snapshot of inFlight after A's publish can await.
      registry.declareShell("A", "sleep 0.5; echo a", { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
      registry.declareShell("B", `echo x >> ${spawns}; wc -l < ${spawns} | tr -d ' '`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "depends_on", varNames: ["A"] },
      });
      expect(await registry.settled(3000)).toEqual([]);
      expect(store.read("A")).toBe("a");
      expect(store.read("B")).toBe("2");
    } finally {
      cleanup();
    }
  });

  it("a wait is for a first value, never for a period's re-read: the view's own or its directory's", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const spawns = path.join(dir, "spawns");
      const gate = shellGate(path.join(dir, "gate"));
      gate.close();
      const { registry: home } = make();
      const view = home.view();
      live.add(view);
      const period = { kind: "ttl", durationMs: MIN_SHELL_TTL_MS } as const;
      const counted = (out: string) => `echo x >> ${spawns}; ${gate.hold}; echo ${out}`;
      home.declareShell("dir", counted("d"), { cwd: process.cwd(), parse: TEXT, cache: period });
      view.declareShell("own", counted("o"), { cwd: process.cwd(), parse: TEXT, cache: period });
      expect([...(await view.settled(50))].sort()).toEqual(["dir", "own"]);
      gate.open();
      expect(await view.settled(3000)).toEqual([]);
      // Both periods' re-runs held out: a re-read keeps the answer it has. A
      // re-run can pass the gate while it is open, so only the runs spawned
      // after it closes are the held ones.
      gate.close();
      const spawned = (): number => fs.readFileSync(spawns, "utf8").split("\n").length - 1;
      const closedAt = spawned();
      await until(() => spawned() >= closedAt + 2, "both periods' re-runs spawning", 3000);
      expect(await view.settled(3000)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("a wait is for a run its key moved", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const gate = shellGate(path.join(dir, "gate"));
      const store = new VariableStore();
      const registry = registryOver(store);
      store.defineBox("trigger", "string", "a");
      registry.declareShell("val", `${gate.hold}; echo v`, {
        cwd: process.cwd(),
        parse: TEXT,
        cache: { kind: "key", template: "{{ .trigger }}" },
      });
      expect(await registry.settled(3000)).toEqual([]);
      gate.close();
      store.setBox("trigger", "b");
      expect(await registry.settled(50)).toEqual(["val"]);
      gate.open();
      expect(await registry.settled(3000)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("inFlight() lets go of a run that never ends when its signal aborts", async () => {
    const { registry } = make();
    registry.declareShell("stuck", "sleep 30", { cwd: process.cwd(), parse: TEXT, cache: { kind: "never" } });
    const wait = new AbortController();
    setTimeout(() => wait.abort(), 50);
    const asked = Date.now();
    await registry.inFlight(wait.signal);
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(await registry.settled(0)).toEqual(["stuck"]);
  });

  it("dispose() aborts an in-flight shell run: the child tree dies with the registry and nothing is published", async () => {
    const stamp = `${process.pid}${Date.now()}`;
    const marker = `ccb-registry-abort-${stamp}`;
    const nap = `sleep 5.${stamp}`;
    const alive = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0;
    const { store, registry } = make();
    registry.declareShell("s", `${nap}; echo ${marker}`, {
      cwd: process.cwd(),
      parse: text("pending"),
      cache: { kind: "never" },
    });
    expect(alive(marker)).toBe(true);
    registry.dispose();
    // The run completes (the child is reaped) — the launcher resolves only
    // on the actual exit, so an empty settled() is the proof of death.
    expect(await registry.settled(3000)).toEqual([]);
    expect(alive(marker)).toBe(false);
    expect(alive(nap)).toBe(false);
    expect(store.read("s")).toBe("pending");
    expect(registry.getLastError("s")).toBeUndefined();
  });
});
