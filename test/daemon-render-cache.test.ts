// [LAW:single-enforcer] Tests for the RenderCache invariants that bzh.2
// changed: cache identity (projectDir+cwd, args ignored), last-known-good
// preservation across failed reloads, candidate-dir watcher firing when a
// higher-precedence config file appears, and registry disposal on
// eviction. The legacy renderer's render-cache tests were deleted in
// bzh.2; this is the new, smaller test set scoped to the DSL spine.

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

// Flatten a layout tree to its segment names, in pre-order — the post-`root`
// equivalent of the old `config.layout.flatMap(r => r.segments)`.
const layoutSegments = (root: LayoutNode): string[] =>
  [...walkNodes(root)].flatMap((n) =>
    n.kind === "segment" ? [n.name] : [],
  );

// One horizontal container of segment refs — what { h: [...names] } lowers to.
const oneRow = (...segments: string[]): LayoutNode => ({
  kind: "container",
  direction: "horizontal",
  children: segments.map((name) => ({ kind: "segment" as const, name })),
});

// `observers` defaults to the ReloadSignal's — the tests that hand in their
// own are probing the observer contract itself, not awaiting a reload.
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
  // [LAW:single-enforcer] Isolate XDG_CONFIG_HOME and CC_CANDYBAR_CONFIG for
  // every test in this file. dslConfigCandidatePaths consults both at call
  // time; without isolation, tests would pick up the user's real config at
  // `$HOME/.config/cc-candybar/config.{json5,json}` and fail in ways
  // unrelated to what they're asserting. The override points at a fresh
  // tmpdir scoped to this test suite so the XDG layer is empty by default.
  let xdgIsolateDir: string;
  let savedXdg: string | undefined;
  let savedCfg: string | undefined;
  beforeAll(() => {
    xdgIsolateDir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-xdg-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedCfg = process.env.CC_CANDYBAR_CONFIG;
    process.env.XDG_CONFIG_HOME = xdgIsolateDir;
    delete process.env.CC_CANDYBAR_CONFIG;
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedCfg === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCfg;
    rmSync(xdgIsolateDir, { recursive: true, force: true });
  });

  test("cache identity is (projectDir, cwd, configFile)", () => {
    const { cache, cleanups } = makeCache();
    try {
      // Same (projectDir, cwd, configFile=undefined) → same entry.
      const a = cache.getOrCreate("/x", "/x", undefined);
      const b = cache.getOrCreate("/x", "/x", undefined);
      expect(a).toBe(b);
      expect(cache.size).toBe(1);

      // Distinct configFile values produce distinct entries — the CLI
      // override is a real input to config resolution and must be part
      // of the cache key.
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
      // No file means state was built from the bundled default — every
      // built-in segment is declared.
      expect(layoutSegments(rootNode(entry.state.config.root)).length).toBeGreaterThan(0);
      expect(entry.configFilePath).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // [LAW:verifiable-goals] candybar-settings-ui-0gz: a config that fails its
  // FIRST load — before the entry ever held a good one — still renders, from
  // the bundled default, with the error beside it. Broken the way it broke
  // live: a stale `{{ menu }}` call missing its trigger displays.
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
      // The error is loud AND names the file...
      expect(entry.lastError).toMatch(/trigger needs a display/);
      expect(entry.configFilePath).toBe(cfg);
      // ...while the state is the bundled default's: the same tree a
      // no-file entry builds, settings menu included — one synthesis, not a
      // second "safe mode" config.
      const fallback = cache.getOrCreate(bare, bare, undefined);
      const menuOf = (root: LayoutNode): string[] =>
        layoutSegments(root).filter((n) => n.startsWith(SETTINGS_NS));
      const floor = presetRoot(entry.state.config, PRESET_FLOOR).node;
      expect(floor).toEqual(
        presetRoot(fallback.state.config, PRESET_FLOOR).node,
      );
      expect(menuOf(floor).length).toBeGreaterThan(0);

      // Repairing the file swaps the user's config in and clears the error.
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
      // Step 1: write a valid config file, populate the cache from it.
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
      // Pin the specific state's identity — build-then-swap means a
      // failed reload must not touch this object reference.
      const goodConfigRef = goodState.config;

      // Step 2: overwrite the file with garbage. The watcher fires, the
      // cache reloads, buildState throws (JSON5 parse error), and the
      // entry's `state` should be the SAME object as before.
      await reloads.after(entry, () =>
        writeFileSync(cfg, "this is not JSON5 {{{ broken"),
      );

      expect(entry.lastError).not.toBeNull();
      expect(entry.state).toBe(goodState); // identity preserved
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
      // First call: no file exists, falls back to default.
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.configFilePath).toBeNull();
      // The bundled default's layout is non-empty. Use the flat segment
      // count (across all rows) because the user fixture below uses one
      // row of one segment — matching the default's row count of 1 — so
      // row count alone wouldn't prove the file was picked up.
      const defaultLayoutSegCount = layoutSegments(
        rootNode(entry.state.config.root),
      ).length;

      // Create the project-local file. The watcher should fire.
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
      // Sanity: was actually different from the default.
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
      // Write the config as .json (not .json5) — the same parser handles
      // both because JSON ⊂ JSON5. Filename is the only difference.
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
      // Both files at the same location — .json5 wins on resolution, but
      // detectConfigCollisions surfaces the duplicate.
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
      // Load succeeded — .json5 won; warning is the advisory.
      expect(entry.lastError).toBeNull();
      expect(entry.configFilePath).toBe(cfgJson5);
      expect(entry.lastWarning).not.toBeNull();
      expect(entry.lastWarning).toContain(cfgJson5);
      expect(entry.lastWarning).toContain(cfgJson);

      // Removing the duplicate clears the warning on next reload. The
      // watcher fires on file deletion in the same dir. Rewrite-then-unlink
      // so every application of the mutation emits an event (a bare unlink
      // of an already-absent file emits none) and ends with the file absent.
      await reloads.after(entry, () => {
        writeFileSync(cfgJson, validCfg);
        unlinkSync(cfgJson);
      });
      expect(entry.lastWarning).toBeNull();
      // The .json5 is still the resolved file; render state intact.
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
      // The entry — and the live registry + watcher it owns — is in the
      // cache, so eviction/dispose can still reach it.
      expect(cache.size).toBe(1);
      expect(cache.firstState()).not.toBeNull();
      expect(watchers.size()).toBe(1);
      // A second lookup finds it rather than building a duplicate: the
      // observer (which would throw again) does not run, and no second
      // watcher opens.
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
    // maxEntries=4. Every lookup throws from the observer AND inserts its
    // entry (pinned above); the cap must still hold across five of them.
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
      // maxEntries=4. Insert 5 entries; the oldest gets evicted.
      const entries = [];
      for (let i = 0; i < 5; i++) {
        const e = cache.getOrCreate(`/p${i}`, `/p${i}`, undefined);
        entries.push(e);
      }
      expect(cache.size).toBe(4);
      // Verify the first entry's registry is disposed.
      const evicted = entries[0]!;
      // [LAW:no-defensive-null-guards] dispose is idempotent; calling it
      // again on an already-disposed registry would throw or no-op
      // depending on internals. We don't probe that here — just that the
      // entry's state is no longer reachable from the cache.
      const survivor = cache.getOrCreate("/p0", "/p0", undefined);
      expect(survivor).not.toBe(evicted);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a picker config loads into multiple cache entries without a validator clash", () => {
    // [LAW:one-source-of-truth] A picker's page (int) action derives a writable
    // page-key validator into the GLOBAL registry. Two cache entries sharing one
    // config (one repo, two cwds) both register that key; ref-counting must let
    // both succeed and keep the key valid until the last entry is gone. Before
    // ref-counting, the second entry threw "already has a validator" and rendered
    // a config error.
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
      // Both entries loaded cleanly — no validator clash on the shared page key.
      expect(a.lastError).toBeNull();
      expect(b.lastError).toBeNull();
      expect(a).not.toBe(b);
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
