import { drawPayload } from "./helpers/draw-payload";
import { HOST, locs } from "./helpers/host";
import { unscriptedLauncher, unscriptedRuns } from "./helpers/fake-launcher";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linksOf } from "../src/click/read";
import { TEST_SIGNER } from "./helpers/link-signer";
import { retainerPathsTo } from "./helpers/retainer-path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
  COMPILE_BYTES,
  SOURCES_NOTHING,
  ENTRY_BYTES,
  openView,
  RenderCache,
  VIEW_BYTES,
  type SessionView,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import {
  compileDslConfig,
  compileInputOf,
  declareDslVariables,
  EVERY_SCOPE,
  type CompiledConfig,
} from "../src/dsl/render";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf } from "../src/utils/instant";
import { effectsOf } from "./helpers/click";
import { recordRender, testVerbContext } from "./helpers/click";
import { VERBS } from "../src/daemon/verbs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { linkClick } from "./helpers/click";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { systemTimekeeper } from "../src/time";
import { SourceRuns } from "../src/var-system/source-runs";

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
  const counters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    counters,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const sessionState = new SessionState();
  const cache = new RenderCache(
    {
      clock: systemTimekeeper,
      stateDir: stateDir(HOST),
      locations: locs(),
      env: HOST.env,
      runs: new SourceRuns({ launcher: unscriptedLauncher, clock: systemTimekeeper }),
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState,
      watchers,
      source: SOURCES_NOTHING,
      log: (_level, line) => lines.push(line),
    },
    { budgetBytes: () => budgetBytes, maxEntries },
  );
  // Run first (cleanups run in reverse): every state the cache serves is torn
  // down before the watchers and git close under it.
  cleanups.push(() => cache.close());
  return { cache, lines, sessionState, watchers, counters };
}

function file(rel: string, text: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

// A session's frame, drawn through its view as the daemon draws one.
const drawn = (view: SessionView): string => textOf(drawnBytes(view));

const drawnBytes = (view: SessionView): Frame =>
  drawPayload(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    { session_id: view.sessionId, project_dir: dir },
    instantOf(new Date()),
    {
      endcaps: "powerline",
      colorCompatibility: "truecolor",
      wrap: true,
      padding: 1,
      width: 200,
    },
  ).frame;

// A frame of `state` through a view of its own, disposed after.
const render = (
  state: ReturnType<RenderCache["getOrCreate"]>["state"],
): Frame => {
  const view = openView(state, dir, viewFacts(dir, "s"), {
    source: SOURCES_NOTHING,
    changed: () => {},
    log: () => {},
  });
  try {
    return drawnBytes(view);
  } finally {
    view.dispose();
  }
};

// A store whose own name a heap snapshot can find it by, since a plain
// VariableStore is also what every other case in the process draws from.
class ProbeStore extends VariableStore {}

// Draw one frame of `compiled` from a store and registry of its own, as a
// render-cache entry would, then dispose the registry; the store is returned
// so a caller can watch whether anything still holds it.
const drawAlone = (
  config: ValidatedConfig,
  compiled: CompiledConfig,
): VariableStore => {
  const store = new ProbeStore(systemTimekeeper);
  const registry = new SourceRegistry(unscriptedRuns(),
    store,
    "",
    new SessionState(),
  );
  declareDslVariables(config, registry, dir, EVERY_SCOPE);
  drawPayload(
    config,
    compiled,
    store,
    registry,
    { session_id: "s", project_dir: dir },
    instantOf(new Date()),
    {
      endcaps: "powerline",
      colorCompatibility: "truecolor",
      wrap: true,
      padding: 1,
      width: 200,
    },
  ).frame;
  registry.dispose();
  return store;
};

const exposeGc = (): (() => void) => {
  v8.setFlagsFromString("--expose_gc");
  return vm.runInNewContext("gc") as () => void;
};

// Where a frame's carousel's ▶ steps to. Over its two options that is the one
// the key does not hold, so it shows which variable the ring read back.
const nextOf = (bytes: Frame): string | undefined =>
  effectsOf(linksOf(bytes).find((l) => l.text === "▶")!.url)[0]!.args[2];

// One action over session key `k`, and a carousel centred on what reads it
// back; `reader` names the state variable over `k`, `value` its default.
const carouselConfig = (reader: string, value: string): string =>
  JSON.stringify({
    variables: { [reader]: { kind: "state", key: "k", default: value } },
    actions: {
      pick: { set: "k", from: ["alpha", "beta"] },
      list: { copy: "x" },
    },
    segments: { ring: { template: '{{ carousel "pick" "list" "k" }}' } },
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
    expect(
      lines.filter((l) => l.startsWith("render-cache compile built ")),
    ).toHaveLength(1);
    const made = lines.filter((l) => l.startsWith("render-cache entry "));
    expect(made).toHaveLength(3);
    expect(made[2]).toMatch(/ entries=3 compiles=1 accounted=\d+\/\d+MB$/);
    for (const s of states) expect(nextOf(render(s))).toBe("beta");
  });

  // An edit to a config many directories render from reloads every one of
  // their entries. The first reload builds the edited config's compile; the
  // rest take it from the table, so the edit costs one compile, not one per
  // entry.
  test("a changed config reloaded across its entries builds one compile", () => {
    const { cache, lines } = makeCache(64 * COMPILE_BYTES);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const dirs = ["a", "b", "c"].map((d) => path.join(dir, d));
    for (const d of dirs) {
      fs.mkdirSync(d);
      cache.getOrCreate(d, d, cfg);
    }
    const built = () =>
      lines.filter((l) => l.startsWith("render-cache compile built ")).length;
    expect(built()).toBe(1);
    fs.writeFileSync(cfg, carouselConfig("other", "beta"));
    for (const d of dirs) cache.reload(d, d, cfg, { kind: "write" });
    expect(built()).toBe(2);
    const states = dirs.map((d) => cache.getOrCreate(d, d, cfg).state);
    expect(new Set(states.map((s) => s.compiled)).size).toBe(1);
    expect(cache.stats).toMatchObject({ size: 3, compiles: 1 });
    for (const s of states) expect(nextOf(render(s))).toBe("alpha");
  });

  // [LAW:types-are-the-program] The one per-entry fact a compile reads is
  // which variable reads a session key back. Two configs differing only there
  // must not share: the second's carousel would read a variable its store
  // never declared.
  test("configs differing only in which variable reads a key back get two compiles", () => {
    const { cache, sessionState } = makeCache(64 * COMPILE_BYTES);
    const one = file("one.json5", carouselConfig("mode", "alpha"));
    const two = file("two.json5", carouselConfig("other", "beta"));
    const a = cache.getOrCreate(dir, dir, one).state;
    const b = cache.getOrCreate(dir, dir, two).state;
    expect(a.compiled).not.toBe(b.compiled);
    expect(cache.stats.compiles).toBe(2);
    expect(nextOf(render(a))).toBe("beta");
    expect(nextOf(render(b))).toBe("alpha");
  });
});

// A load can fail after its compile is built: the gates are derived from the
// action table last. The table learns a compile only from a state it serves,
// so the refused load leaves none that nothing could ever reclaim.
test("a load that fails after compiling leaves no compile behind", () => {
  const { cache, sessionState } = makeCache(64 * COMPILE_BYTES);
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
    const at = (d: string) =>
      cache.getOrCreate(path.join(dir, d), path.join(dir, d), cfg);
    const [, b, c] = ["a", "b", "c"].map((d) => at(d).state);
    expect(cache.stats).toMatchObject({ size: 2, compiles: 1 });
    expect(cache.stats.accountedBytes).toBeLessThanOrEqual(
      cache.stats.budgetBytes,
    );
    expect(
      lines.filter((l) => l.startsWith("config disposed reason=evict")),
    ).toHaveLength(1);
    // `b` and `c` are still served; `a` left, so asking for it builds it again.
    const built = () =>
      lines.filter((l) => l.startsWith("render-cache entry ")).length;
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
    const at = (d: string) =>
      cache.getOrCreate(path.join(dir, d), path.join(dir, d), cfg);
    const [, b, c] = ["a", "b", "c"].map((d) => at(d).state);
    expect(cache.stats.size).toBe(2);
    expect(cache.stats.accountedBytes).toBeLessThan(cache.stats.budgetBytes);
    expect(
      lines.filter((l) => l.startsWith("config disposed reason=evict")),
    ).toHaveLength(1);
    expect(at("b").state).toBe(b);
    expect(at("c").state).toBe(c);
  });

  test("a budget no entry fits still serves the newest", () => {
    const { cache } = makeCache(0);
    const cfg = file("config.json5", carouselConfig("mode", "alpha"));
    const state = cache.getOrCreate(dir, dir, cfg).state;
    expect(cache.stats.size).toBe(1);
    expect(nextOf(render(state))).toBe("beta");
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
    cache.reload(b, b, cfgB, { kind: "write" });
    // `b` moved onto a compile of its own; `a`, least recently used, left.
    expect(cache.stats).toMatchObject({ size: 1, compiles: 1 });
    expect(cache.stats.accountedBytes).toBeLessThanOrEqual(
      cache.stats.budgetBytes,
    );
    expect(
      lines.filter((l) => l.startsWith("config disposed reason=evict")),
    ).toHaveLength(1);
    expect(nextOf(render(cache.getOrCreate(b, b, cfgB).state))).toBe("alpha");
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
      expect(nextOf(render(held.state))).toBe("alpha");
    }
    expect(cache.stats).toMatchObject({ size: 1, compiles: 1, retired: 0 });
  });
});

test("a compile's clock is the draw's: read outside one, it refuses", () => {
  const compiled = compileDslConfig(
    compileInputOf(
      parseAndValidate(
        "<test>",
        `{ segments: { clock: { template: '{{ now | date "15:04" }}' } }, root: { h: ["clock"] } }`,
      ),
    ),
    TEST_SIGNER,
  );
  expect(() => compiled.segments["clock"]!.template.evaluate({})).toThrow(
    /the clock was read outside a draw/,
  );
});

// A compile outlives the entries that share it, so it may keep nothing of a
// render once that render returns: the store, the scope its layout rows were
// laid under. Kept, an evicted entry's store would stay on the heap for as
// long as any other entry carried the compile, charged to no one.
const heldStores: object[] = [];
test("a compile keeps nothing of a render once it returns", async () => {
  const config = parseAndValidate("<test>", carouselConfig("mode", "alpha"));
  const compiled = compileDslConfig(compileInputOf(config), TEST_SIGNER);
  // [LAW:verifiable-goals] Reachability is read off a heap snapshot, which
  // collects first and follows only strong edges, so no collection count or
  // wait is in the verdict. One store is held on purpose, as the control: it
  // is the one path the snapshot must show, so an empty answer for the drawn
  // store is one this reader could have failed to give, whatever happens to
  // the class's name. The drawn store's result is dropped here, so a second
  // path is a holder the draw left behind, printed from the heap's roots.
  heldStores.push(new ProbeStore(systemTimekeeper));
  try {
    drawAlone(config, compiled);
    expect(await retainerPathsTo("ProbeStore")).toHaveLength(1);
  } finally {
    heldStores.length = 0;
  }
  expect(compiled.menuRuntime.action.bound).toBeUndefined();
});

// [LAW:verifiable-goals] ENTRY_BYTES, COMPILE_BYTES and VIEW_BYTES are the
// cache's map of what an entry, a compile and a session's view hold; this
// redraws the map from the heap, so a change that grows any fails here rather
// than quietly over-filling the budget. The bundled default, as `test/setup.ts`
// leaves the XDG config empty.
test("an entry, a compile and a view hold no more than the cache charges for them", async () => {
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
    const config = parseAndValidate(
      "<test>",
      "{}",
      undefined,
      DEFAULT_DSL_CONFIG,
    );
    const compiled = compileDslConfig(compileInputOf(config), TEST_SIGNER);
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

  const { cache, sessionState } = makeCache(64 * COMPILE_BYTES);
  // Rendered once by a session of its own, as every entry the daemon holds has
  // been: the render fills the session's view of it and the view's sink.
  const entry = (i: number) => {
    const cwd = path.join(dir, `c${i}`);
    fs.mkdirSync(cwd);
    using held = cache.holdSession(
      cwd,
      cwd,
      undefined,
      viewFacts(cwd, `e${i}`),
    );
    drawn(held.view);
    return held.state;
  };
  const keep = [entry(0)];
  const before = heapUsed();
  const N = 6;
  for (let i = 1; i <= N; i++) keep.push(entry(i));
  const perEntry = (heapUsed() - before) / N;
  expect(cache.stats.compiles).toBe(1);
  expect(cache.stats.views).toBe(N + 1);
  expect(perEntry).toBeLessThan(ENTRY_BYTES + VIEW_BYTES);

  // A further session in a directory already rendered from costs its view.
  const shared = keep[0]!;
  const view = (i: number): SessionView => {
    using held = cache.holdSession(
      dir + "/c0",
      dir + "/c0",
      undefined,
      viewFacts(dir + "/c0", `v${i}`),
    );
    expect(held.state).toBe(shared);
    drawn(held.view);
    return held.view;
  };
  const views = [view(0)];
  const beforeViews = heapUsed();
  for (let i = 1; i <= N; i++) views.push(view(i));
  const perView = (heapUsed() - beforeViews) / N;
  expect(cache.stats.views).toBe(2 * N + 2);
  expect(perView).toBeLessThan(VIEW_BYTES);

  // A view keeps the parts of every placement it has drawn until it is
  // disposed (src/dsl/parts.ts), so it is charged for the most the bundled
  // default draws: a session that opened the door, the theme picker, every
  // list behind the ⚙ and the preset list, and every tab.
  const walked = async (i: number): Promise<SessionView> => {
    const sid = `w${i}`;
    using held = cache.holdSession(
      dir + "/c0",
      dir + "/c0",
      undefined,
      viewFacts(dir + "/c0", sid),
    );
    await walkMenu(held.view, sessionState, held.state.config);
    return held.view;
  };
  views.push(await walked(0));
  const beforeWalked = heapUsed();
  for (let i = 1; i <= N; i++) views.push(await walked(i));
  const perWalked = (heapUsed() - beforeWalked) / N;
  expect(perWalked).toBeLessThan(VIEW_BYTES);
});

// A session clicks through MENU_WALK on its view, drawing after each click as
// the daemon draws the frame a click lands on.
const walkMenu = async (
  view: SessionView,
  sessionState: SessionState,
  config: ValidatedConfig,
): Promise<void> => {
  recordRender(sessionState, view.sessionId);
  const ctx = testVerbContext(sessionState, undefined, config);
  let last = drawnBytes(view);
  for (const text of MENU_WALK) {
    const hit = linksOf(last).find((l) => l.text === text);
    if (hit === undefined)
      throw new Error(`no link "${text}" in:\n${textOf(last)}`);
    const { verb, value } = linkClick(hit.url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) await VERBS.get(e.verb)!(e.value, ctx);
    last = drawnBytes(view);
  }
};

// Every list the bundled menu hangs, then every tab, then the door closed.
const MENU_WALK = [
  "🍫",
  "🎨 theme",
  "⚙",
  "◐ style ▀▀▀",
  "🎼 variation",
  "🔆 shade",
  "▦ preset",
  "🎨 look",
  "📐 layout",
  "⚙ config",
  "🧰 tools",
  "⚡ session",
  "✖",
];

// [LAW:verifiable-goals] What a steady daemon holds stays what it held: once
// every session has drawn, drawing again builds nothing, retires nothing and
// moves no watch. A few sessions over a few directories make each claim one
// event, so the case is a count, never a load.
describe("a steady stream of renders", () => {
  const DIRS = ["a", "b", "c"];
  const SESSIONS_PER_DIR = 2;
  beforeEach(() => {
    for (const d of DIRS) fs.mkdirSync(path.join(dir, d));
  });

  // Every session draws once from its directory, as each statusline tick does,
  // and the turn ends, so what a render deferred has run before the next.
  const round = async (cache: RenderCache): Promise<void> => {
    for (const d of DIRS) {
      const cwd = path.join(dir, d);
      for (let s = 0; s < SESSIONS_PER_DIR; s++) {
        using held = cache.holdSession(
          cwd,
          cwd,
          undefined,
          viewFacts(cwd, `${d}${s}`),
        );
        drawn(held.view);
      }
    }
    await new Promise((turn) => setImmediate(turn));
  };

  // The cache logs every entry it builds and every view it opens or closes, so
  // a rebuild on every render, disposed as soon as it is replaced, holds the
  // counts flat and still shows here as a line.
  test("builds and retires nothing: the counts hold and nothing is logged", async () => {
    const { cache, lines, watchers } = makeCache(64 * COMPILE_BYTES);
    // A catch-up reloads one entry a turn, so `due` is the rest of a reload a
    // render left behind.
    const counts = () => {
      const { size, compiles, views, due } = cache.stats;
      return { size, compiles, views, due, watches: watchers.size() };
    };
    await round(cache);
    const first = counts();
    expect(first).toMatchObject({
      size: DIRS.length,
      views: DIRS.length * SESSIONS_PER_DIR,
      due: 0,
    });
    const logged = lines.length;
    await round(cache);
    await round(cache);
    expect({ counts: counts(), logged: lines.slice(logged) }).toEqual({
      counts: first,
      logged: [],
    });
  });

  test("opens and closes no watcher", async () => {
    const { cache, counters } = makeCache(64 * COMPILE_BYTES);
    await round(cache);
    const first = { ...counters };
    // The first round's entries each watch their config, so a reopened watch
    // would count here.
    expect(first.watchersOpened).toBeGreaterThan(0);
    await round(cache);
    await round(cache);
    expect(counters).toEqual(first);
  });

  // A view keeps the parts of every placement it has drawn (src/dsl/parts.ts),
  // so a session's observers rise the first time its menu draws each list and
  // tab. A click keeps none of its own: a second walk over what the view has
  // drawn leaves the count where the first left it, and once the cache closes
  // its views nothing observes the session state at all.
  test("a session's clicks through its menu keep no observer of the session state", async () => {
    const { cache, sessionState } = makeCache(64 * COMPILE_BYTES);
    const cwd = path.join(dir, DIRS[0]!);
    const walks = async () => {
      using held = cache.holdSession(
        cwd,
        cwd,
        undefined,
        viewFacts(cwd, `${DIRS[0]}0`),
      );
      drawn(held.view);
      const bar = sessionState.observers();
      await walkMenu(held.view, sessionState, held.state.config);
      const walked = sessionState.observers();
      await walkMenu(held.view, sessionState, held.state.config);
      return { bar, walked, again: sessionState.observers() };
    };
    const { bar, walked, again } = await walks();
    // The walk drew lists and tabs the bar alone does not, so its clicks landed.
    expect(walked).toBeGreaterThan(bar);
    cache.close();
    expect({ again, released: sessionState.observers() }).toEqual({
      again: walked,
      released: 0,
    });
  });
});
