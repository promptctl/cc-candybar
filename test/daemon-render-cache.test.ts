// [LAW:single-enforcer] Tests for the RenderCache invariants that bzh.2
// changed: cache identity (projectDir+cwd, args ignored), last-known-good
// preservation across failed reloads, candidate-dir watcher firing when a
// higher-precedence config file appears, and registry disposal on
// eviction. The legacy renderer's render-cache tests were deleted in
// bzh.2; this is the new, smaller test set scoped to the DSL spine.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RenderCache,
  type CacheEntry,
  type Hold,
  type RenderCacheObservers,
  ENTRY_BYTES,
  COMPILE_BYTES,
} from "../src/daemon/cache/render";
import { SessionState } from "../src/daemon/session-state";
import { stateGate } from "../src/daemon/verbs/state-validators";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import type { DaemonLogger } from "../src/utils/logger";
import { ReloadSignal } from "./helpers/reload-signal";
import { walkNodes, type LayoutNode } from "../src/config/dsl-types";
import { rootNode, rootOf } from "../src/config/root";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { PRESET_FLOOR, presetRoot } from "../src/config/presets";

// Flatten a layout tree to its segment names, in pre-order — the post-`root`
// equivalent of the old `config.layout.flatMap(r => r.segments)`.
const layoutSegments = (root: LayoutNode): string[] =>
  [...walkNodes(root)].flatMap((n) => (n.kind === "segment" ? [n.name] : []));

// One horizontal container of segment refs — what { h: [...names] } lowers to.
const oneRow = (...segments: string[]): LayoutNode => ({
  kind: "container",
  direction: "horizontal",
  children: segments.map((name) => ({ kind: "segment" as const, name })),
});

// `observers` defaults to the ReloadSignal's — the tests that hand in their
// own are probing the observer contract itself, not awaiting a reload.
function makeCache(
  observers?: RenderCacheObservers,
  log?: DaemonLogger,
): {
  cache: RenderCache;
  cleanups: Array<() => void>;
  reloads: ReloadSignal;
  watchers: WatcherRegistry;
} {
  const cleanups: Array<() => void> = [];
  const watchers = new WatcherRegistry({
    counters: {
      watchersOpened: 0,
      watchersClosed: 0,
    },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const sessionState = new SessionState();
  const reloads = new ReloadSignal();
  const cache = new RenderCache(
    { sessionState, watchers, log },
    {
      // Room for four entries over one compile: the fifth evicts the oldest.
      budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES,
      observers: observers ?? reloads.observers,
    },
  );
  cleanups.unshift(() => cache.close());
  return { cache, cleanups, reloads, watchers };
}

function mkConfigDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("RenderCache", () => {
  // [LAW:single-enforcer] Isolate XDG_CONFIG_HOME for every test in this
  // file. dslConfigCandidatePaths consults it at call time (and reads no
  // CC_CANDYBAR_CONFIG — that is a client hint, brandon-config-5g8); without
  // isolation, tests would pick up the user's real config at
  // `$HOME/.config/cc-candybar/config.{json5,json}` and fail in ways
  // unrelated to what they're asserting. The override points at a fresh
  // tmpdir scoped to this test suite so the XDG layer is empty by default.
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

  // The resolver's presence predicate is not `existsSync`: a named file
  // behind an unsearchable directory is `unreadable`, so the bundled default
  // renders (liveness — the watcher recovers when the directory opens) under
  // an advisory carrying the stat's own EACCES — never the `missing` notice
  // claiming a correct path was not found, and never a load-fatal error
  // about a file nothing read. Root bypasses directory permissions.
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
        expect(entry.configLayers).toEqual([]);
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

  // brandon-config-5g8: an explicit path to an absent file is the `missing`
  // resolution — the bundled default renders (liveness: a long-running bar
  // must not go dark waiting for a file) under a warning that NAMES the
  // path, so it is never the same render as "no config". The explicit path
  // is the sole watch candidate, so the file appearing swaps it in.
  test("an explicit path to an absent file is loud, and loads when the file appears", async () => {
    const { cache, cleanups, reloads } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const cfg = join(dir, "named.json5");
      const entry = cache.getOrCreate(dir, dir, cfg);
      expect(entry.lastError).toBeNull();
      expect(entry.configLayers).toEqual([]);
      expect(entry.lastWarning).toContain(`Config file not found: ${cfg}`);
      // The state beneath the warning is the bundled default's.
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
      expect(entry.configLayers).toEqual([cfg]);
      expect(layoutSegments(rootNode(entry.state.config.root))).toContain("t");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // brandon-lit-widget-3xo.rvo: a `shell` source runs in its entry's cwd, not
  // the detached daemon's, so one config rendered from two checkouts asks each
  // command about its own directory.
  test("a shell source runs in its entry's cwd", async () => {
    const { cache, cleanups } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const cfg = join(dir, "shared.json5");
      writeFileSync(
        cfg,
        JSON.stringify({
          variables: {
            here: { kind: "shell", command: "pwd -P", cache: { never: true } },
          },
        }),
      );
      const a = realpathSync(mkdtempSync(join(tmpdir(), "ccb-entry-a-")));
      const b = realpathSync(mkdtempSync(join(tmpdir(), "ccb-entry-b-")));
      cleanups.push(() => rmSync(a, { recursive: true, force: true }));
      cleanups.push(() => rmSync(b, { recursive: true, force: true }));
      const inA = cache.getOrCreate(a, a, cfg).state;
      const inB = cache.getOrCreate(b, b, cfg).state;
      expect(await inA.registry.settled(5000)).toEqual([]);
      expect(await inB.registry.settled(5000)).toEqual([]);
      expect(inA.store.read("here")).toBe(a);
      expect(inB.store.read("here")).toBe(b);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
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
      expect(
        layoutSegments(rootNode(entry.state.config.root)).length,
      ).toBeGreaterThan(0);
      expect(entry.configLayers).toEqual([]);
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
      expect(entry.configLayers).toEqual([cfg]);
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
      expect(entry.configLayers).toEqual([]);
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
      expect(entry.configLayers).toEqual([cfg]);
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
      // The home (here the explicit file) is what authors a root: a reset
      // writes nowhere else.
      const cfg = join(dir, ".cc-candybar.json5");
      const entry = cache.getOrCreate(dir, dir, cfg);
      const bundledRows = Object.keys(entry.state.config.root.rows);
      expect(entry.state.authoredRoots.has(PRESET_FLOOR)).toBe(false);

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
      expect(entry.configLayers).toEqual([cfg]);
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
      expect(entry.configLayers).toEqual([cfg]);
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
      expect(entry.configLayers).toEqual([cfgJson5]);
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
      expect(entry.configLayers).toEqual([cfgJson5]);
      expect(entry.lastError).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // [LAW:single-enforcer] brandon-config-16g: a duplicate object key is
  // tolerated by the render path (last wins) and refused by the config-file
  // editor; the editor's refusal is the load-time advisory, so the file
  // defect names its line on the bar before any click reaches it.
  const DUPLICATE_KEY_CONFIG = `{
  variables: { x: { kind: "literal", value: "ok" } },
  segments: {
    s: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
  },
  globals: {
    padding: 1,
    padding: 2,
  },
  root: { h: ["s"] },
}
`;

  test("lastWarning names a duplicate object key and its line; the load still succeeds with the last value", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups, reloads } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(cfg, DUPLICATE_KEY_CONFIG);

      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.state.config.globals.padding).toBe(2);
      expect(entry.lastWarning).toBe(
        `${cfg}:8: duplicate key "padding" — the settings menu cannot edit this file until it is fixed`,
      );

      // Removing the duplicate clears the advisory on the next reload.
      await reloads.after(entry, () => {
        writeFileSync(cfg, DUPLICATE_KEY_CONFIG.replace("padding: 1,\n", ""));
      });
      expect(entry.lastWarning).toBeNull();
      expect(entry.lastError).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a duplicate key's advisory survives beside a fatal validation error", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      // The duplicate plus a dangling segment reference: the reference is
      // fatal; the advisory still reaches the strip beside it.
      writeFileSync(
        cfg,
        DUPLICATE_KEY_CONFIG.replace(
          `root: { h: ["s"] }`,
          `root: { h: ["nope"] }`,
        ),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toContain("nope");
      expect(entry.lastWarning).toContain(`${cfg}:8: duplicate key "padding"`);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a duplicate key's advisory survives beside a fatal structural error", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      // An unknown top-level key fails structural validation before the
      // merge; the advisory rides the ConfigError onto the strip beside it.
      writeFileSync(
        cfg,
        DUPLICATE_KEY_CONFIG.replace(`root: { h: ["s"] },`, `bogus: true,`),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toContain('Unknown top-level key "bogus"');
      expect(entry.lastWarning).toContain(`${cfg}:8: duplicate key "padding"`);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a partial-load warning survives beside a validator-derivation throw", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      // `s.v` declared twice — once top-level, once segment-local — is the
      // register pass's partial-load warning; a non-integer literal aimed at
      // a key another action bounds as a range throws in validator derivation
      // AFTER the register pass, so the warning must already be on the strip.
      writeFileSync(
        cfg,
        JSON.stringify({
          variables: {
            "session.id": { kind: "input", path: "session_id", default: "" },
            "s.v": { kind: "literal", value: "top" },
            k: { kind: "state", key: "k", default: "0" },
          },
          actions: {
            lit: { set: "k", to: "x" },
            step: { set: "k", min: 0, max: 3, by: 1 },
          },
          segments: {
            s: {
              vars: { v: { kind: "literal", value: "local" } },
              template: '{{ action "lit" "a" }} {{ action "step" "b" }}',
            },
          },
          root: { h: ["s"] },
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toContain('key "k" is an integer spec');
      expect(entry.lastWarning).toContain('Variable "s.v"');
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
      expect(watchers.size()).toBe(1);
      // A second lookup finds it rather than building a duplicate: the
      // observer (which would throw again) does not run, and no second
      // watcher opens.
      cache.getOrCreate(dir, dir, undefined);
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

  // [LAW:nothing-unseen] brandon-unfiled-3248.t14: a teardown that released
  // nothing was found in a heap snapshot because no teardown said what it
  // did. Both teardown sites log the count the store returns — the state's
  // (its directory's sources: none of the bundled default's computeds) and,
  // with it, each session's view of it, which holds them.
  test("eviction and reload each log the teardown and how many computeds it released", () => {
    const lines: string[] = [];
    const { cache, cleanups } = makeCache(undefined, (_level, msg) =>
      lines.push(msg),
    );
    try {
      cache.holdSession("/p0", "/p0", undefined, "s0")[Symbol.dispose]();
      for (let i = 0; i < 5; i++)
        cache.getOrCreate(`/p${i}`, `/p${i}`, undefined);
      const evict = lines.filter((l) => l.startsWith("config disposed "));
      expect(evict).toHaveLength(1);
      expect(evict[0]).toMatch(
        /^config disposed reason=evict released=\d+ held=0$/,
      );
      expect(
        lines.filter((l) => l.startsWith("session view closed ")),
      ).toEqual([
        expect.stringMatching(
          /^session view closed sid="s0" reason=evict released=[1-9]\d* held=0 /,
        ),
      ]);

      cache.reload("/p4", "/p4", undefined);
      const reload = lines.filter((l) =>
        l.startsWith("config disposed reason=reload"),
      );
      expect(reload).toHaveLength(1);
      expect(reload[0]).toMatch(
        /^config disposed reason=reload released=\d+ held=0$/,
      );

      // A close tears every entry down at once, but a state a render still
      // holds waits for it, as an eviction's does.
      const hold = cache.hold("/p4", "/p4", undefined);
      const closes = () =>
        lines.filter((l) => l.startsWith("config disposed reason=close"));
      cache.close();
      expect(lines.filter((l) => l.startsWith("render-cache closed "))).toEqual(
        ["render-cache closed entries=4 deferred=1"],
      );
      // A closed cache has nothing left to close.
      cache.close();
      expect(
        lines.filter((l) => l.startsWith("render-cache closed ")),
      ).toHaveLength(1);
      expect(closes()).toHaveLength(3);
      for (const line of closes())
        expect(line).toMatch(
          /^config disposed reason=close released=\d+ held=0$/,
        );
      hold[Symbol.dispose]();
      expect(closes()).toHaveLength(4);
      expect(closes()[3]).toMatch(
        /^config disposed reason=close released=\d+ held=1$/,
      );
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:no-ambient-temporal-coupling] brandon-unfiled-3248.6rc: a render
  // holds the state it draws with across its payload await. The map moves
  // at once — the cap stays a bound, a reload swaps at once — and a retired
  // state is disposed when its last holder returns, never under the render.
  test("a held state survives its entry's eviction and is disposed at the release", () => {
    const lines: string[] = [];
    const { cache, cleanups } = makeCache(undefined, (_level, msg) =>
      lines.push(msg),
    );
    const disposals = () =>
      lines.filter((l) => l.startsWith("config disposed reason=evict"));
    try {
      // maxEntries=4. /p0 is the oldest, and held.
      const hold = cache.hold("/p0", "/p0", undefined);
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 0 });
      for (let i = 1; i < 5; i++)
        cache.getOrCreate(`/p${i}`, `/p${i}`, undefined);
      // The cap held: /p0 left the map. Its state is retired, not disposed —
      // the render still draws with it, and its store still answers.
      expect(cache.stats).toMatchObject({ size: 4, held: 1, retired: 1 });
      expect(disposals()).toEqual([]);
      expect(hold.state.store.names().length).toBeGreaterThan(0);
      // Asking for /p0 again is a new entry with a state of its own — and a
      // fifth insertion, so unheld /p1 goes at once.
      const again = cache.getOrCreate("/p0", "/p0", undefined);
      expect(again).not.toBe(hold.entry);
      expect(again.state).not.toBe(hold.state);
      expect(disposals()).toEqual([expect.stringMatching(/ held=0$/)]);
      // The release is the teardown, and the line says one render held it.
      hold[Symbol.dispose]();
      expect(disposals()).toEqual([
        expect.stringMatching(/ held=0$/),
        expect.stringMatching(
          /^config disposed reason=evict released=\d+ held=1$/,
        ),
      ]);
      expect(cache.stats).toMatchObject({ size: 4, held: 0, retired: 0 });
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a reload under a held state swaps the entry and defers the old state's teardown", () => {
    const lines: string[] = [];
    const { cache, cleanups } = makeCache(undefined, (_level, msg) =>
      lines.push(msg),
    );
    const disposals = () =>
      lines.filter((l) => l.startsWith("config disposed reason=reload"));
    try {
      const hold = cache.hold("/p0", "/p0", undefined);
      cache.reload("/p0", "/p0", undefined);
      // The entry serves the fresh state; the render keeps the one it
      // started on, undisposed, until it returns.
      expect(hold.entry.state).not.toBe(hold.state);
      expect(cache.getOrCreate("/p0", "/p0", undefined)).toBe(hold.entry);
      expect(disposals()).toEqual([]);
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 1 });
      hold[Symbol.dispose]();
      expect(disposals()).toEqual([
        expect.stringMatching(
          /^config disposed reason=reload released=\d+ held=1$/,
        ),
      ]);
      expect(cache.stats).toMatchObject({ size: 1, held: 0, retired: 0 });
      // The fresh state is served and torn down like any other.
      cache.reload("/p0", "/p0", undefined);
      expect(disposals()).toHaveLength(2);
      expect(disposals()[1]).toMatch(/ held=0$/);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("two renders holding one state: the teardown waits for the last", () => {
    const lines: string[] = [];
    const { cache, cleanups } = makeCache(undefined, (_level, msg) =>
      lines.push(msg),
    );
    try {
      const holds: Hold[] = [
        cache.hold("/p0", "/p0", undefined),
        cache.hold("/p0", "/p0", undefined),
      ];
      expect(holds[1]!.state).toBe(holds[0]!.state);
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 0 });
      cache.reload("/p0", "/p0", undefined);
      holds[0]![Symbol.dispose]();
      expect(lines.filter((l) => l.startsWith("config disposed "))).toEqual([]);
      holds[1]![Symbol.dispose]();
      expect(lines.filter((l) => l.startsWith("config disposed "))).toEqual([
        expect.stringMatching(/ held=2$/),
      ]);
      // [LAW:no-silent-failure] A second release is a bug, said so.
      expect(() => holds[1]![Symbol.dispose]()).toThrow(
        "render-cache hold released twice",
      );
      expect(cache.stats).toMatchObject({ size: 1, held: 0, retired: 0 });
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("two projects declaring one key differently both load: a gate is its own config's", () => {
    // [LAW:one-source-of-truth] brandon-state-gates-lbs. Each config's click
    // gate is derived from that config alone, so one project declaring `k` as
    // a word list and another as a range are two gates. When every loaded
    // config merged into one gate per key, the second of these failed its load
    // on the first one's members.
    const { cache, cleanups } = makeCache();
    const project = (actions: Record<string, unknown>): string => {
      const { dir, cleanup } = mkConfigDir();
      cleanups.push(cleanup);
      writeFileSync(
        join(dir, ".cc-candybar.json5"),
        JSON.stringify({
          variables: {
            "session.id": { kind: "input", path: "session_id", default: "" },
            k: { kind: "state", key: "k", default: "1" },
          },
          actions,
          segments: { s: { template: "{{ .k }}" } },
          root: { h: ["s"] },
        }),
      );
      return dir;
    };
    try {
      const words = project({ pick: { set: "k", from: ["narrow", "wide"] } });
      const range = project({ step: { set: "k", min: 1, max: 9, by: 1 } });
      const narrower = project({ step: { set: "k", min: 1, max: 3, by: 1 } });
      const entries = [words, range, narrower].map((dir) =>
        cache.getOrCreate(dir, dir, undefined),
      );
      expect(entries.map((e) => e.lastError)).toEqual([null, null, null]);
      const [w, r, n] = entries.map((e) => stateGate(e.state.config));
      expect(w!.validate("k", "wide").ok).toBe(true);
      expect(w!.rangeParamsFor("k")).toBeNull();
      expect(r!.rangeParamsFor("k")).toEqual({ min: 1, max: 9 });
      expect(n!.rangeParamsFor("k")).toEqual({ min: 1, max: 3 });
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // brandon-plugins-ktag.5zv: an app installs a plugin by dropping a folder
  // into a plugin root, with no config edit — the root is watched for every
  // child, so the install reloads the entry and the segment is there.
  test("a plugin folder installed into a repo's plugin root reloads the entry", async () => {
    const { cache, cleanups, reloads } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const root = join(dir, ".cc-candybar", "plugins");
      mkdirSync(root, { recursive: true });
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(
        entry.state.config.segments["plugins.deploy.status"],
      ).toBeUndefined();
      // Staged then renamed in, so every repetition is an event in the root.
      const staging = join(dir, "staging");
      await reloads.after(entry, () => {
        mkdirSync(staging, { recursive: true });
        writeFileSync(
          join(staging, "plugin.json5"),
          `{ data: "./d.json", segments: { status: { template: "up" } } }`,
        );
        rmSync(join(root, "deploy"), { recursive: true, force: true });
        renameSync(staging, join(root, "deploy"));
      });
      expect(entry.lastError).toBeNull();
      expect(
        entry.state.config.segments["plugins.deploy.status"],
      ).toBeDefined();
    } finally {
      cleanup();
      for (const fn of cleanups) fn();
    }
  });
});

// brandon-unfiled-3248.8ro6: what an entry's state holds of the daemon's shared
// entries (a repo, a pane, a memento reading) keeps their owners' periods
// running, so a hold the entry's renders have not read across a whole sweep is
// released — whether or not the entry is still drawn — and the next render that
// reads it takes it back.
describe("RenderCache idle sweep", () => {
  // A cache nobody closes keeps its sweep armed, and the sweep keeps the cache
  // and every compile it serves alive for the life of the process: a jest
  // worker that ran a few such files held a heap snapshot past V8's string
  // limit (brandon-unfiled-3248.8ro6).
  test("close disposes every state, releases its holds and leaves no timer", () => {
    jest.useFakeTimers();
    const { dir, cleanup } = mkConfigDir();
    const watchers = new WatcherRegistry({ logger: () => {} });
    const cache = new RenderCache(
      { sessionState: new SessionState(), watchers },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    try {
      let released = 0;
      {
        using hold = cache.hold(dir, dir, undefined);
        hold.state.registry.holds.take("repo", () => () => {
          released++;
        });
      }
      // The sweep is armed, beside whatever the entry's sources arm.
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      cache.close();
      expect(released).toBe(1);
      expect(cache.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      // Every way a state is built refuses: an entry, or a reload of one.
      expect(() => cache.getOrCreate(dir, dir, undefined)).toThrow(
        "render cache used after close",
      );
      expect(() => cache.reload(dir, dir, undefined)).toThrow(
        "render cache used after close",
      );
    } finally {
      cache.close();
      jest.useRealTimers();
      watchers.closeAll();
      cleanup();
    }
  });

  test("a hold no render read across a whole sweep is released; a render takes it back", () => {
    const { dir, cleanup } = mkConfigDir();
    const watchers = new WatcherRegistry({ logger: () => {} });
    const logs: string[] = [];
    const cache = new RenderCache(
      {
        sessionState: new SessionState(),
        watchers,
        log: (_level, message) => logs.push(message),
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    const released: string[] = [];
    try {
      // One render of the entry, reading the keys it names.
      const render = (...keys: string[]): void => {
        using hold = cache.hold(dir, dir, undefined);
        for (const key of keys) {
          hold.state.registry.holds.take(key, () => () => {
            released.push(key);
          });
        }
      };
      render("repo", "memento:ended-session");
      expect(
        cache.getOrCreate(dir, dir, undefined).state.registry.holds.size,
      ).toBe(2);

      // Read since the last sweep: kept.
      cache.releaseIdle();
      expect(released).toEqual([]);

      // The entry is still drawn, but no render reads the session that ended:
      // its hold goes at the next sweep, the repo's stays.
      render("repo");
      cache.releaseIdle();
      expect(released).toEqual(["memento:ended-session"]);
      expect(logs).toContain("render-cache idle released=1 entries=1");

      // Nothing drawn across a whole sweep: the repo goes too.
      cache.releaseIdle();
      expect(released).toEqual(["memento:ended-session", "repo"]);

      // The next render that reads it takes it back.
      render("repo");
      const state = cache.getOrCreate(dir, dir, undefined).state;
      expect(state.registry.holds.size).toBe(1);
      cache.releaseIdle();
      expect(released).toHaveLength(2);
    } finally {
      cache.close();
      watchers.closeAll();
      cleanup();
    }
  });
});
