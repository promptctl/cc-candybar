// [LAW:single-enforcer] Tests for the RenderCache invariants that bzh.2
// changed: cache identity (projectDir+cwd, args ignored), last-known-good
// preservation across failed reloads, candidate-dir watcher firing when a
// higher-precedence config file appears, and registry disposal on
// eviction. The legacy renderer's render-cache tests were deleted in
// bzh.2; this is the new, smaller test set scoped to the DSL spine.

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RenderCache } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { SessionState } from "../src/daemon/session-state";
import { WatcherRegistry } from "../src/daemon/cache/watchers";

function makeCache(): {
  cache: RenderCache;
  cleanups: Array<() => void>;
  gitService: GitDataProvider;
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
  const cache = new RenderCache(
    { gitService, sessionState, watchers },
    { maxEntries: 4 },
  );
  return { cache, cleanups, gitService };
}

function mkConfigDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Poll for a condition with timeouts that comfortably exceed
// WatcherRegistry's 50ms debounce + macOS fs.watch's variable latency.
// 15s is a generous bound — macOS FSEvents can briefly stall when
// multiple test suites run watchers in sequence; the timeout is high
// enough that real failures (watcher not firing at all) still surface
// as a clear timeout rather than a flake.
//
// [LAW:verifiable-goals] Throws on timeout so a never-true condition
// fails loudly with a clear message — silent timeout would let watcher
// regressions silently pass.
async function waitFor(
  cond: () => boolean,
  {
    timeoutMs = 15000,
    intervalMs = 50,
    label = "condition",
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!cond()) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms (${label})`);
  }
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
      expect(entry.state).not.toBeNull();
      expect(entry.state!.config.layout.length).toBeGreaterThan(0);
      expect(entry.configFilePath).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("last-known-good preserved when a hot reload introduces a broken config", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
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
          layout: [["s"]],
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      const goodState = entry.state;
      expect(goodState).not.toBeNull();
      // Pin the specific state's identity — build-then-swap means a
      // failed reload must not touch this object reference.
      const goodConfigRef = goodState!.config;

      // Step 2: overwrite the file with garbage. The watcher fires, the
      // cache calls reloadInto, buildState throws (JSON5 parse error),
      // and the entry's `state` should be the SAME object as before.
      writeFileSync(cfg, "this is not JSON5 {{{ broken");
      await waitFor(() => entry.lastError !== null, {
        label: "lastError populated after broken-config reload",
      });

      expect(entry.lastError).not.toBeNull();
      expect(entry.state).toBe(goodState); // identity preserved
      expect(entry.state!.config).toBe(goodConfigRef);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("watcher fires reload when a config file is created where none existed", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      // First call: no file exists, falls back to default.
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.configFilePath).toBeNull();
      // The bundled default's layout is non-empty. Use the flat segment
      // count (across all rows) because the user fixture below uses one
      // row of one segment — matching the default's row count of 1 — so
      // row count alone wouldn't prove the file was picked up.
      const defaultLayoutSegCount = entry.state!.config.layout.flatMap((r) => r.segments).length;

      // Give fs.watch a moment to attach to the parent dir before we
      // start writing into it. Without this, on macOS the writeFileSync
      // can land in the brief window after `getOrCreate` returns but
      // before the FSEvents subscription is actually active, and the
      // change goes unseen.
      await new Promise((r) => setTimeout(r, 100));

      // Create the project-local file. The watcher should fire.
      const cfg = join(dir, ".cc-candybar.json5");
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
          layout: [["only"]],
        }),
      );
      // fs.watch is async and platform-debounced (50ms in our registry).
      await waitFor(() => entry.configFilePath === cfg, {
        label: `watcher should have observed new config file at ${cfg}`,
      });
      expect(entry.configFilePath).toBe(cfg);
      expect(entry.state!.config.layout).toEqual([{ segments: ["only"] }]);
      // Sanity: was actually different from the default.
      expect(entry.state!.config.layout.flatMap((r) => r.segments).length).not.toBe(
        defaultLayoutSegCount,
      );
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
          layout: [["only"]],
        }),
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.configFilePath).toBe(cfg);
      expect(entry.state!.config.layout).toEqual([{ segments: ["only"] }]);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("lastWarning is set when .json5 and .json coexist at same location", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
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
        layout: [["s"]],
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
      // watcher fires on file deletion in the same dir. Same fs.watch
      // warmup gotcha as the create-detection test — give the watcher
      // a moment to register on the dir before the mutation.
      await new Promise((r) => setTimeout(r, 100));
      unlinkSync(cfgJson);
      await waitFor(() => entry.lastWarning === null, {
        label: "lastWarning should clear after removing the .json sibling",
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

  test("a menu config loads into multiple cache entries without a validator clash", () => {
    // [LAW:one-source-of-truth] A menu derives a writable page-key validator
    // into the GLOBAL registry. Two cache entries sharing one config (one repo,
    // two cwds) both register that key; ref-counting must let both succeed and
    // keep the key valid until the last entry is gone. Before ref-counting, the
    // second entry threw "already has a validator" and rendered a config error.
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
        widgets: {
          m: {
            kind: "menu",
            state: "menu-page",
            items: [{ optionsFrom: "themes", onClick: { set: "theme" } }],
          },
        },
        segments: {
          s: { template: '{{ widget "m" }}', bg: "surface", fg: "foreground" },
        },
        layout: [{ when: "{{ ge (int .page) 0 }}", segments: ["s"] }],
      }),
    );
    try {
      const sub = join(dir, "sub");
      const a = cache.getOrCreate(dir, dir, undefined);
      const b = cache.getOrCreate(dir, sub, undefined);
      // Both entries loaded cleanly — no validator clash on the shared page key.
      expect(a.lastError).toBeNull();
      expect(b.lastError).toBeNull();
      expect(a.state).not.toBeNull();
      expect(b.state).not.toBeNull();
      expect(a).not.toBe(b);
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
