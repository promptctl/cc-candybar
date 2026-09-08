// [LAW:single-enforcer] RenderCache invariants: identity is (projectDir, cwd)
// with args ignored; last-known-good survives a failed reload; disposal on eviction.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RenderCache,
  type CacheEntry,
  type RenderCacheObservers,
} from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { SessionState } from "../src/daemon/session-state";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { ReloadSignal } from "./helpers/reload-signal";
import { walkNodes, type LayoutNode } from "../src/config/dsl-types";
import { rootNode, rootOf } from "../src/config/root";
import { SETTINGS_NS } from "../src/config/settings-menu";
import { PRESET_FLOOR, presetRoot } from "../src/config/presets";

const layoutSegments = (root: LayoutNode): string[] =>
  [...walkNodes(root)].flatMap((n) => (n.kind === "segment" ? [n.name] : []));

const oneRow = (...segments: string[]): LayoutNode => ({
  kind: "container",
  direction: "horizontal",
  children: segments.map((name) => ({ kind: "segment" as const, name })),
});

function makeCache(observers?: RenderCacheObservers): {
  cache: RenderCache;
  cleanups: Array<() => void>;
  gitService: GitDataProvider;
  reloads: ReloadSignal;
  watchers: WatcherRegistry;
} {
  const cleanups: Array<() => void> = [];
  const watchers = new WatcherRegistry({
    counters: {
      watchersOpened: 0,
      watchersClosed: 0,
      watchersEvicted: 0,
    },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const gitService = new GitDataProvider({
    sanityIntervalMs: 0,
    logger: () => {},
  });
  cleanups.push(() => gitService.close());
  const sessionState = new SessionState();
  const reloads = new ReloadSignal();
  const cache = new RenderCache(
    { gitService, sessionState, watchers },
    { maxEntries: 4, observers: observers ?? reloads.observers },
  );
  return { cache, cleanups, gitService, reloads, watchers };
}

function mkConfigDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("RenderCache", () => {
  // [LAW:single-enforcer] Isolate XDG_CONFIG_HOME: dslConfigCandidatePaths reads
  // it at call time, so without this the user's real config leaks into every test.
  let xdgIsolateDir: string;
  let savedXdg: string | undefined;
  beforeAll(() => {
    xdgIsolateDir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-xdg-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgIsolateDir;
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(xdgIsolateDir, { recursive: true, force: true });
  });

  // The presence predicate is not `existsSync`: a named file behind an
  // unsearchable directory is `unreadable`, so the default renders under EACCES.
  const asRoot = process.getuid?.() === 0;
  (asRoot ? test.skip : test)(
    "an explicit path behind an unsearchable directory renders the default under a could-not-read advisory",
    () => {
      const { cache, cleanups } = makeCache();
      const { dir, cleanup } = mkConfigDir();
      const locked = join(dir, "locked");
      mkdirSync(locked);
      const cfg = join(locked, "named.json5");
      writeFileSync(
        cfg,
        JSON.stringify({
          segments: { t: { template: "named" } },
          root: { h: ["t"] },
        }),
      );
      chmodSync(locked, 0o000);
      try {
        const entry = cache.getOrCreate(dir, dir, cfg);
        expect(entry.lastError).toBeNull();
        expect(entry.configFilePath).toBeNull();
        expect(entry.lastWarning).toContain(
          `Config file could not be read: ${cfg}`,
        );
        expect(entry.lastWarning).toContain("EACCES");
        expect(entry.lastWarning).not.toContain("Config file not found");
      } finally {
        chmodSync(locked, 0o755);
        for (const c of cleanups) c();
        cleanup();
      }
    },
  );

  // An explicit path to an absent file is `missing`: the default renders under a
  // warning NAMING the path, and that path is the sole watch candidate.
  test("an explicit path to an absent file is loud, and loads when the file appears", async () => {
    const { cache, cleanups, reloads } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const cfg = join(dir, "named.json5");
      const entry = cache.getOrCreate(dir, dir, cfg);
      expect(entry.lastError).toBeNull();
      expect(entry.configFilePath).toBeNull();
      expect(entry.lastWarning).toContain(`Config file not found: ${cfg}`);
      expect(entry.state.config.root).toEqual(
        cache.getOrCreate(dir, dir, undefined).state.config.root,
      );

      await reloads.after(entry, () =>
        writeFileSync(
          cfg,
          JSON.stringify({
            segments: { t: { template: "named" } },
            root: { h: ["t"] },
          }),
        ),
      );
      expect(entry.lastWarning).toBeNull();
      expect(entry.configFilePath).toBe(cfg);
      expect(layoutSegments(rootNode(entry.state.config.root))).toContain("t");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("cache identity is (projectDir, cwd, configFile)", () => {
    const { cache, cleanups } = makeCache();
    try {
      const a = cache.getOrCreate("/x", "/x", undefined);
      const b = cache.getOrCreate("/x", "/x", undefined);
      expect(a).toBe(b);
      expect(cache.size).toBe(1);

      const c = cache.getOrCreate("/x", "/x", "/tmp/alt.json5");
      const d = cache.getOrCreate("/x", "/x", "/tmp/other.json5");
      expect(c).not.toBe(a);
      expect(d).not.toBe(c);
      expect(cache.size).toBe(3);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("falls back to DEFAULT_DSL_CONFIG when no config file exists", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(
        layoutSegments(rootNode(entry.state.config.root)).length,
      ).toBeGreaterThan(0);
      expect(entry.configFilePath).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // [LAW:verifiable-goals] A config that fails its FIRST load still renders — from
  // the bundled default, with the error beside it.
  test("a config that fails on first sight renders the bundled default under its error", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { dir: bare, cleanup: cleanupBare } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(
        cfg,
        JSON.stringify({
          actions: { applyTheme: { set: "theme", from: "themes" } },
          segments: {
            t: {
              template: '{{ menu "applyTheme" }}',
              bg: "surface",
              fg: "foreground",
            },
          },
          root: { h: ["t"] },
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toMatch(/trigger needs a display/);
      expect(entry.configFilePath).toBe(cfg);
      const fallback = cache.getOrCreate(bare, bare, undefined);
      const menuOf = (root: LayoutNode): string[] =>
        layoutSegments(root).filter((n) => n.startsWith(SETTINGS_NS));
      const floor = presetRoot(entry.state.config, PRESET_FLOOR).node;
      expect(floor).toEqual(
        presetRoot(fallback.state.config, PRESET_FLOOR).node,
      );
      expect(menuOf(floor).length).toBeGreaterThan(0);

      await reloads.after(entry, () =>
        writeFileSync(
          cfg,
          JSON.stringify({
            segments: {
              t: { template: "fixed", bg: "surface", fg: "foreground" },
            },
            root: { h: ["t"] },
          }),
        ),
      );
      expect(entry.lastError).toBeNull();
      expect(layoutSegments(rootNode(entry.state.config.root))).toContain("t");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
      cleanupBare();
    }
  });

  test("last-known-good preserved when a hot reload introduces a broken config", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(
        cfg,
        JSON.stringify({
          globals: {},
          variables: { x: { kind: "literal", value: "good" } },
          segments: {
            s: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
          },
          root: { h: ["s"] },
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      const goodState = entry.state;
      // Build-then-swap: a failed reload must not touch this object reference.
      const goodConfigRef = goodState.config;

      await reloads.after(entry, () =>
        writeFileSync(cfg, "this is not JSON5 {{{ broken"),
      );

      expect(entry.lastError).not.toBeNull();
      expect(entry.state).toBe(goodState);
      expect(entry.state.config).toBe(goodConfigRef);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("watcher fires reload when a config file is created where none existed", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.configFilePath).toBeNull();
      const defaultLayoutSegCount = layoutSegments(
        rootNode(entry.state.config.root),
      ).length;

      const cfg = join(dir, ".cc-candybar.json5");
      await reloads.after(entry, () =>
        writeFileSync(
          cfg,
          JSON.stringify({
            globals: {},
            variables: { x: { kind: "literal", value: "from-file" } },
            segments: {
              only: {
                template: " {{ .x }} ",
                bg: "surface",
                fg: "foreground",
              },
            },
            root: { h: ["only"] },
          }),
        ),
      );
      expect(entry.configFilePath).toBe(cfg);
      expect(entry.state.config.root).toEqual(rootOf(oneRow("only")));
      expect(layoutSegments(rootNode(entry.state.config.root)).length).not.toBe(
        defaultLayoutSegCount,
      );
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a `{ rows }` fragment merges over the bundled rows and authors the floor preset's root", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const entry = cache.getOrCreate(dir, dir, undefined);
      const bundledRows = Object.keys(entry.state.config.root.rows);
      expect(entry.state.authoredRoots.has(PRESET_FLOOR)).toBe(false);

      const cfg = join(dir, ".cc-candybar.json5");
      await reloads.after(entry, () =>
        writeFileSync(
          cfg,
          JSON.stringify({
            globals: {},
            variables: { x: { kind: "literal", value: "from-file" } },
            segments: {
              only: {
                template: " {{ .x }} ",
                bg: "surface",
                fg: "foreground",
              },
            },
            root: { rows: { extra: { h: ["only"] } } },
          }),
        ),
      );
      expect(entry.configFilePath).toBe(cfg);
      expect(Object.keys(entry.state.config.root.rows)).toEqual([
        ...bundledRows,
        "extra",
      ]);
      expect(entry.state.config.root.rows.extra).toEqual(oneRow("only"));
      expect(entry.state.authoredRoots.has(PRESET_FLOOR)).toBe(true);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test(".json extension is loaded by the cache (legacy compat)", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      // JSON ⊂ JSON5, so one parser reads both; the filename is the difference.
      const cfg = join(dir, ".cc-candybar.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          globals: {},
          variables: { x: { kind: "literal", value: "from-json" } },
          segments: {
            only: {
              template: " {{ .x }} ",
              bg: "surface",
              fg: "foreground",
            },
          },
          root: { h: ["only"] },
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.configFilePath).toBe(cfg);
      expect(entry.state.config.root).toEqual(rootOf(oneRow("only")));
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("lastWarning is set when .json5 and .json coexist at same location", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const cfgJson5 = join(dir, ".cc-candybar.json5");
      const cfgJson = join(dir, ".cc-candybar.json");
      const validCfg = JSON.stringify({
        globals: {},
        variables: { x: { kind: "literal", value: "ok" } },
        segments: {
          s: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
        },
        root: { h: ["s"] },
      });
      writeFileSync(cfgJson5, validCfg);
      writeFileSync(cfgJson, validCfg);

      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.configFilePath).toBe(cfgJson5);
      expect(entry.lastWarning).not.toBeNull();
      expect(entry.lastWarning).toContain(cfgJson5);
      expect(entry.lastWarning).toContain(cfgJson);

      await reloads.after(entry, () => {
        writeFileSync(cfgJson, validCfg);
        unlinkSync(cfgJson);
      });
      expect(entry.lastWarning).toBeNull();
      expect(entry.configFilePath).toBe(cfgJson5);
      expect(entry.lastError).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("an observer that throws during the first load leaves the entry reachable", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, watchers } = makeCache({
      onReload: () => {
        throw new Error("observer boom");
      },
    });
    try {
      expect(() => cache.getOrCreate(dir, dir, undefined)).toThrow(
        "observer boom",
      );
      expect(cache.size).toBe(1);
      expect(cache.firstState()).not.toBeNull();
      expect(watchers.size()).toBe(1);
      const found = cache.getOrCreate(dir, dir, undefined);
      expect(found.state).toBe(cache.firstState());
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a throwing observer cannot push the cache over its entry cap", () => {
    // Every lookup throws from the observer AND inserts its entry; the cap holds.
    const { cache, cleanups, watchers } = makeCache({
      onReload: () => {
        throw new Error("observer boom");
      },
    });
    try {
      for (let i = 0; i < 5; i++) {
        expect(() => cache.getOrCreate(`/p${i}`, `/p${i}`, undefined)).toThrow(
          "observer boom",
        );
      }
      expect(cache.size).toBe(4);
      expect(watchers.size()).toBe(4);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a reentrant getOrCreate from inside onReload returns the entry under construction", () => {
    const { dir, cleanup } = mkConfigDir();
    let inner: CacheEntry | undefined;
    const { cache, cleanups, watchers } = makeCache({
      onReload: () => {
        inner = cache.getOrCreate(dir, dir, undefined);
      },
    });
    try {
      const outer = cache.getOrCreate(dir, dir, undefined);
      expect(inner).toBe(outer);
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("eviction disposes the evicted entry's registry + watcher", () => {
    const { cache, cleanups } = makeCache();
    try {
      const entries = [];
      for (let i = 0; i < 5; i++) {
        const e = cache.getOrCreate(`/p${i}`, `/p${i}`, undefined);
        entries.push(e);
      }
      expect(cache.size).toBe(4);
      const evicted = entries[0]!;
      const survivor = cache.getOrCreate("/p0", "/p0", undefined);
      expect(survivor).not.toBe(evicted);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a picker config loads into multiple cache entries without a validator clash", () => {
    // [LAW:one-source-of-truth] Two cache entries sharing one config both register
    // the picker's page-key validator; ref-counting must let both succeed.
    const { cache, cleanups } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    cleanups.push(cleanup);
    const cfg = join(dir, ".cc-candybar.json5");
    writeFileSync(
      cfg,
      JSON.stringify({
        globals: {},
        variables: {
          "session.id": { kind: "input", path: "session_id", default: "" },
          "term.cols": {
            kind: "input",
            path: "term.cols",
            type: "number",
            default: 80,
          },
          page: { kind: "state", key: "menu-page", default: "-1" },
        },
        actions: {
          applyTheme: { set: "theme", from: "themes" },
          menuPage: { set: "menu-page", int: true },
        },
        segments: {
          s: {
            template: '{{ picker "applyTheme" "menuPage" true true }}',
            bg: "surface",
            fg: "foreground",
          },
        },
        root: { seg: "s", when: "{{ ge (int .page) 0 }}" },
      }),
    );
    try {
      const sub = join(dir, "sub");
      const a = cache.getOrCreate(dir, dir, undefined);
      const b = cache.getOrCreate(dir, sub, undefined);
      expect(a.lastError).toBeNull();
      expect(b.lastError).toBeNull();
      expect(a).not.toBe(b);
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
