import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
  COMPILE_BYTES,
  ENTRY_BYTES,
  RenderCache,
} from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import {
  compileDslConfig,
  compileInputOf,
  declareDslVariables,
  renderDsl,
  type CompiledConfig,
} from "../src/dsl/render";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf } from "../src/utils/instant";
import { stripAnsi } from "./helpers/ansi";
import { parseAndValidate } from "./helpers/parse-and-validate";

// brandon-unfiled-3248.8yp: the render cache held one 9.3 MB state per
// directory a session rendered from, and released one only past 256 of them,
// so the daemon's 512 MB RSS backstop tripped several times a day. A compile is
// now one per config, shared by every entry whose config compiles alike, and
// the cache evicts by bytes out of the daemon's one budget.

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-share-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

function makeCache(budgetBytes: number, maxEntries?: number) {
  const lines: string[] = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0 },
    logger: () => {},
  });
  const gitService = new GitDataProvider({ logger: () => {} });
  cleanups.push(() => watchers.closeAll(), () => gitService.close());
  const cache = new RenderCache(
    { gitService, sessionState: new SessionState(), watchers, log: (_level, line) => lines.push(line) },
    { budgetBytes: () => budgetBytes, maxEntries },
  );
  // Run first (cleanups run in reverse): every state the cache serves is torn
  // down before the watchers and git close under it.
  cleanups.push(() => cache.close());
  return { cache, lines };
}

function file(rel: string, text: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

const render = (state: ReturnType<RenderCache["getOrCreate"]>["state"]): string =>
  stripAnsi(
    renderDsl(
      state.config,
      state.compiled,
      state.store,
      state.registry,
      { session_id: "s", project_dir: dir },
      instantOf(new Date()),
      { endcaps: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, width: 200 },
    ),
  );

// Draw one frame of `compiled` from a store and registry of its own, as a
// render-cache entry would, then dispose the registry; the store is returned
// so a caller can watch whether anything still holds it.
const drawAlone = (config: ValidatedConfig, compiled: CompiledConfig): VariableStore => {
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  declareDslVariables(config, registry, dir);
  renderDsl(
    config,
    compiled,
    store,
    registry,
    { session_id: "s", project_dir: dir },
    instantOf(new Date()),
    { endcaps: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, width: 200 },
  );
  registry.dispose();
  return store;
};

const exposeGc = (): (() => void) => {
  v8.setFlagsFromString("--expose_gc");
  return vm.runInNewContext("gc") as () => void;
};

// One action over session key `k`, and a carousel centred on what reads it
// back; `reader` names the state variable over `k`, `value` its default.
const carouselConfig = (reader: string, value: string): string =>
  JSON.stringify({
    variables: { [reader]: { kind: "state", key: "k", default: value } },
    actions: { pick: { set: "k", from: ["alpha", "beta"] } },
    segments: { ring: { template: '{{ carousel "pick" 0 }}' } },
    root: { h: ["ring"] },
  });

describe("entries share a compile exactly when their configs compile alike", () => {
  test("one config in many directories: one compile, a further entry costs ENTRY_BYTES", () => {
    const { cache, lines } = makeCache(64 * COMPILE_BYTES);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const states = ["a", "b", "c"].map((d) => {
      const cwd = path.join(dir, d);
      fs.mkdirSync(cwd);
      return cache.getOrCreate(cwd, cwd, cfg).state;
    });
    expect(new Set(states.map((s) => s.compiled)).size).toBe(1);
    expect(cache.stats).toMatchObject({
      size: 3,
      compiles: 1,
      accountedBytes: 3 * ENTRY_BYTES + COMPILE_BYTES,
    });
    // [LAW:verifiable-goals] The cache says what it built and what it shared.
    expect(lines.filter((l) => l.startsWith("render-cache compile built "))).toHaveLength(1);
    const made = lines.filter((l) => l.startsWith("render-cache entry "));
    expect(made).toHaveLength(3);
    expect(made[2]).toMatch(/ entries=3 compiles=1 accounted=\d+\/\d+MB$/);
    for (const s of states) expect(render(s)).toContain("alpha");
  });

  // [LAW:types-are-the-program] The one per-entry fact a compile reads is
  // which variable reads a session key back. Two configs differing only there
  // must not share: the second's carousel would read a variable its store
  // never declared.
  test("configs differing only in which variable reads a key back get two compiles", () => {
    const { cache } = makeCache(64 * COMPILE_BYTES);
    const one = file("one.json5", carouselConfig("mode", "alpha"));
    const two = file("two.json5", carouselConfig("other", "beta"));
    const a = cache.getOrCreate(dir, dir, one).state;
    const b = cache.getOrCreate(dir, dir, two).state;
    expect(a.compiled).not.toBe(b.compiled);
    expect(cache.stats.compiles).toBe(2);
    expect(render(a)).toContain("alpha");
    expect(render(b)).toContain("beta");
  });
});

// A load can fail after its compile is built: the gates are derived from the
// action table last. The table learns a compile only from a state it serves,
// so the refused load leaves none that nothing could ever reclaim.
test("a load that fails after compiling leaves no compile behind", () => {
  const { cache } = makeCache(64 * COMPILE_BYTES);
  const clash = file(
    "clash.json5",
    `{ actions: { step: { set: "k", min: 0, max: 3, by: 1 }, flip: { set: "k", cycle: ["x", "y"] } } }`,
  );
  const entry = cache.getOrCreate(dir, dir, clash);
  expect(entry.lastError).toMatch(/key "k" is an integer spec/);
  // The entry draws the bundled default: its compile is the only one held.
  expect(cache.stats).toMatchObject({ size: 1, compiles: 1 });
});

describe("the cache is bounded by bytes", () => {
  test("past the budget the least recently used entry leaves, never the newest", () => {
    const { cache, lines } = makeCache(2 * ENTRY_BYTES + COMPILE_BYTES);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const at = (d: string) => cache.getOrCreate(path.join(dir, d), path.join(dir, d), cfg);
    const [, b, c] = ["a", "b", "c"].map((d) => at(d).state);
    expect(cache.stats).toMatchObject({ size: 2, compiles: 1 });
    expect(cache.stats.accountedBytes).toBeLessThanOrEqual(cache.stats.budgetBytes);
    expect(lines.filter((l) => l.startsWith("config disposed reason=evict"))).toHaveLength(1);
    // `b` and `c` are still served; `a` left, so asking for it builds it again.
    const built = () => lines.filter((l) => l.startsWith("render-cache entry ")).length;
    expect(at("c").state).toBe(c);
    expect(at("b").state).toBe(b);
    expect(built()).toBe(3);
    at("a");
    expect(built()).toBe(4);
  });

  // Every entry holds watchers and timers the byte budget does not see; the
  // count ceiling bounds them however high the RSS limit is raised.
  test("past the count ceiling the least recently used entry leaves, whatever the bytes", () => {
    const { cache, lines } = makeCache(64 * COMPILE_BYTES, 2);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const at = (d: string) => cache.getOrCreate(path.join(dir, d), path.join(dir, d), cfg);
    const [, b, c] = ["a", "b", "c"].map((d) => at(d).state);
    expect(cache.stats.size).toBe(2);
    expect(cache.stats.accountedBytes).toBeLessThan(cache.stats.budgetBytes);
    expect(lines.filter((l) => l.startsWith("config disposed reason=evict"))).toHaveLength(1);
    expect(at("b").state).toBe(b);
    expect(at("c").state).toBe(c);
  });

  test("a budget no entry fits still serves the newest", () => {
    const { cache } = makeCache(0);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const state = cache.getOrCreate(dir, dir, cfg).state;
    expect(cache.stats.size).toBe(1);
    expect(render(state)).toContain("alpha");
  });

  // [LAW:single-enforcer] The budget is held after every change to what the
  // map serves: a reload can move an entry onto a compile no other entry
  // carries, which charges a compile as surely as a new entry does.
  test("a reload onto a compile of its own is held to the budget", () => {
    const { cache, lines } = makeCache(2 * ENTRY_BYTES + COMPILE_BYTES);
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const cfgA = file("a.json5", carouselConfig("mode", "alpha"));
    const cfgB = file("b.json5", carouselConfig("mode", "alpha"));
    cache.getOrCreate(a, a, cfgA);
    cache.getOrCreate(b, b, cfgB);
    expect(cache.stats).toMatchObject({ size: 2, compiles: 1 });
    fs.writeFileSync(cfgB, carouselConfig("other", "beta"));
    cache.reload(b, b, cfgB);
    // `b` moved onto a compile of its own; `a`, least recently used, left.
    expect(cache.stats).toMatchObject({ size: 1, compiles: 1 });
    expect(cache.stats.accountedBytes).toBeLessThanOrEqual(cache.stats.budgetBytes);
    expect(lines.filter((l) => l.startsWith("config disposed reason=evict"))).toHaveLength(1);
    expect(render(cache.getOrCreate(b, b, cfgB).state)).toContain("beta");
  });

  test("a compile leaves with the last state carrying it, held or not", () => {
    const { cache } = makeCache(ENTRY_BYTES + COMPILE_BYTES);
    const one = file("one.json5", carouselConfig("mode", "alpha"));
    const two = file("two.json5", carouselConfig("other", "beta"));
    const three = file("three.json5", carouselConfig("third", "alpha"));
    cache.getOrCreate(dir, dir, one);
    cache.getOrCreate(dir, dir, two);
    // `one`'s entry was evicted unheld: its compile left with it.
    expect(cache.stats).toMatchObject({ size: 1, compiles: 1 });
    {
      using held = cache.hold(dir, dir, two);
      cache.getOrCreate(dir, dir, three);
      // `two`'s state is retired but a render draws with it: its compile stays.
      expect(cache.stats).toMatchObject({ size: 1, compiles: 2, retired: 1 });
      expect(render(held.state)).toContain("beta");
    }
    expect(cache.stats).toMatchObject({ size: 1, compiles: 1, retired: 0 });
  });
});

test("a compile's store and clocks are the render's: read outside one, it refuses", () => {
  const compiled = compileDslConfig(
    compileInputOf(
      parseAndValidate(
        "<test>",
        `{ segments: { clock: { template: '{{ now | date "15:04" }}' } }, root: { h: ["clock"] } }`,
      ),
    ),
  );
  expect(() => compiled.segments["clock"]!.template.evaluate({})).toThrow(
    /now ran outside a render: no render bound its store and clocks/,
  );
});

// A compile outlives the entries that share it, so it may keep nothing of a
// render once that render returns: the store, the scope its layout rows were
// laid under. Kept, an evicted entry's store would stay on the heap for as
// long as any other entry carried the compile, charged to no one.
test("a compile keeps nothing of a render once it returns", async () => {
  const gc = exposeGc();
  const config = parseAndValidate("<test>", carouselConfig("mode", "alpha"));
  const compiled = compileDslConfig(compileInputOf(config));
  const drawn = new WeakRef(drawAlone(config, compiled));
  // A WeakRef holds its target until the job that made it ends.
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  gc();
  expect(drawn.deref()).toBeUndefined();
  expect(compiled.menuRuntime.action.bound).toBeUndefined();
});

// [LAW:verifiable-goals] ENTRY_BYTES and COMPILE_BYTES are the cache's map of
// what an entry and a compile hold; this redraws the map from the heap, so a
// change that grows either fails here rather than quietly over-filling the
// budget. The bundled default, as `test/setup.ts` leaves the XDG config empty.
test("an entry and a compile hold no more than the cache charges for them", () => {
  const gc = exposeGc();
  const heapUsed = (): number => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  // A compile outlives the entry that built it whenever another entry shares
  // it, so it is charged for everything it holds then: its own heap, and
  // whatever of its builder's config it still reaches — measured after it has
  // drawn, with that config, store and registry all dropped. The bundled
  // default; the first compile in a process also pays the process's one-time
  // allocations, which are no compile's, so a second is measured.
  const orphan = (): CompiledConfig => {
    const config = parseAndValidate("<test>", "{}", undefined, DEFAULT_DSL_CONFIG);
    const compiled = compileDslConfig(compileInputOf(config));
    drawAlone(config, compiled);
    return compiled;
  };
  const held: Array<CompiledConfig | undefined> = [orphan()];
  const beforeCompile = heapUsed();
  held.push(orphan());
  const compileBytes = heapUsed() - beforeCompile;
  expect(held).toHaveLength(2);
  held.length = 0;
  expect(compileBytes).toBeLessThan(COMPILE_BYTES);

  const { cache } = makeCache(64 * COMPILE_BYTES);
  // Rendered once, as every entry the daemon holds has been: a render fills
  // the store and the per-segment sink the entry keeps.
  const entry = (i: number) => {
    const cwd = path.join(dir, `c${i}`);
    fs.mkdirSync(cwd);
    const { state } = cache.getOrCreate(cwd, cwd, undefined);
    render(state);
    return state;
  };
  const keep = [entry(0)];
  const before = heapUsed();
  const N = 6;
  for (let i = 1; i <= N; i++) keep.push(entry(i));
  const perEntry = (heapUsed() - before) / N;
  expect(cache.stats.compiles).toBe(1);
  expect(perEntry).toBeLessThan(ENTRY_BYTES);
});
