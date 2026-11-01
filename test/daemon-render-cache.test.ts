// [LAW:single-enforcer] Tests for the RenderCache invariants that bzh.2
// changed: cache identity (projectDir+cwd, args ignored), last-known-good
// preservation across failed reloads, candidate-dir watcher firing when a
// higher-precedence config file appears, and registry disposal on
// eviction. The legacy renderer's render-cache tests were deleted in
// bzh.2; this is the new, smaller test set scoped to the DSL spine.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RenderCache,
  type CacheEntry,
  type LoadCause,
  type Hold,
  type RenderCacheObservers,
  type SessionView,
  DECLARES_NOTHING,
  SOURCES_NOTHING,
  openView,
  ENTRY_BYTES,
  COMPILE_BYTES,
  VIEW_BYTES,
} from "../src/daemon/cache/render";
import { SessionState } from "../src/daemon/session-state";
import { parseClientHints } from "../src/daemon/protocol";
import type { ViewFacts } from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import type { Holds } from "../src/utils/holds";
import { stateGate } from "../src/daemon/verbs/state-validators";
import {
  WatcherRegistry,
  type WatcherCounters,
} from "../src/daemon/cache/watchers";
import type { DaemonLogger } from "../src/utils/logger";
import { writeAtomic } from "../src/utils/atomic-write";
import { editedConfig, editProjectConfig } from "./helpers/edited-config";
import { ReloadSignal } from "./helpers/reload-signal";
import { until } from "./helpers/until";
import {
  walkNodes,
  type LayoutNode,
  type LiteralVarDecl,
} from "../src/config/dsl-types";
import { rootNode, rootOf } from "../src/config/root";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { PRESET_FLOOR, presetRoot } from "../src/config/presets";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { answerRepo } from "./helpers/repo-approval";
import { repoConfigsDir, repoConfigsPath } from "../src/daemon/repo-configs";
import { stateDir } from "../src/daemon/paths";

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
  counters: WatcherCounters;
} {
  const cleanups: Array<() => void> = [];
  const counters: WatcherCounters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const watchers = new WatcherRegistry({ counters, logger: () => {} });
  cleanups.push(() => watchers.closeAll());
  const sessionState = new SessionState();
  const reloads = new ReloadSignal();
  const cache = new RenderCache(
    {
      launcher: processLauncher,
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      sessionState,
      watchers,
      log,
      source: SOURCES_NOTHING,
      declare: DECLARES_NOTHING,
    },
    {
      // Room for four entries over one compile: the fifth evicts the oldest.
      budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES,
      observers: observers ?? reloads.observers,
    },
  );
  cleanups.unshift(() => cache.close());
  return { cache, cleanups, reloads, watchers, counters };
}

function mkConfigDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-"));
  // The config the cache loads here is the directory's own.
  answerRepo(dir);
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

  // A dotfiles-managed config: the project's file is a link into a sibling
  // directory. A write lands in the target (writeAtomic follows the link), so
  // the target's directory is where the change appears, and a watch on the
  // file's inode is deaf after the first rename replaces it.
  describe("a symlinked config", () => {
    const configWith = (value: string): string =>
      JSON.stringify({
        globals: {},
        variables: { x: { kind: "literal", value } },
        segments: {
          only: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
        },
        root: { h: ["only"] },
      });
    const literalX = (entry: CacheEntry): LiteralVarDecl["value"] => {
      const x = entry.state.config.variables.x;
      if (x?.kind !== "literal") throw new Error(`x is ${JSON.stringify(x)}`);
      return x.value;
    };

    // The bind events for `dir`'s entry: one per target set the entry has
    // heard through, each naming the directories it hears.
    const bound = (lines: readonly string[], dir: string): string[] =>
      lines.filter((l) =>
        l.startsWith(`config watch bound projectDir=${dir} cwd=${dir} dirs=`),
      );
    const hears = (line: string, dir: string): boolean =>
      / dirs=(.*) deaf=\d+$/
        .exec(line)![1]!
        .split(",")
        .includes(realpathSync(dir));

    test("a write-then-rename of the link's target reloads, every time", async () => {
      const { dir, cleanup } = mkConfigDir();
      const lines: string[] = [];
      const { cache, cleanups, reloads } = makeCache(undefined, (_l, msg) =>
        lines.push(msg),
      );
      try {
        mkdirSync(join(dir, "dotfiles"));
        const target = join(dir, "dotfiles", "candybar.json5");
        writeFileSync(target, configWith("first"));
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(target, link);
        const entry = cache.getOrCreate(dir, dir, undefined);
        expect(entry.configLayers).toEqual([link]);
        expect(literalX(entry)).toBe("first");
        // Bound once, hearing the target's directory as well as the link's.
        expect(bound(lines, dir)).toHaveLength(1);
        expect(hears(bound(lines, dir)[0]!, join(dir, "dotfiles"))).toBe(true);
        expect(hears(bound(lines, dir)[0]!, dir)).toBe(true);

        // A menu click: the daemon writes through the link.
        await reloads.after(entry, () =>
          writeAtomic(link, configWith("second")),
        );
        expect(literalX(entry)).toBe("second");
        // A hand edit in the dotfiles tree, and the second rename, which an
        // inode watch never hears.
        await reloads.after(entry, () =>
          writeAtomic(target, configWith("third")),
        );
        expect(literalX(entry)).toBe("third");
        // The target set did not move, so nothing rebound.
        expect(bound(lines, dir)).toHaveLength(1);
      } finally {
        for (const fn of cleanups) fn();
        cleanup();
      }
    });

    test("re-pointing the link reloads from the new target", async () => {
      const { dir, cleanup } = mkConfigDir();
      const lines: string[] = [];
      const { cache, cleanups, reloads } = makeCache(undefined, (_l, msg) =>
        lines.push(msg),
      );
      try {
        mkdirSync(join(dir, "dotfiles"));
        const first = join(dir, "dotfiles", "first.json5");
        const second = join(dir, "dotfiles", "second.json5");
        writeFileSync(first, configWith("first"));
        writeFileSync(second, configWith("second"));
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(first, link);
        const entry = cache.getOrCreate(dir, dir, undefined);
        expect(literalX(entry)).toBe("first");

        // `ln -sfn`: a new link renamed over the old entry.
        await reloads.after(entry, () => {
          symlinkSync(second, `${link}.tmp`);
          renameSync(`${link}.tmp`, link);
        });
        expect(literalX(entry)).toBe("second");
        // The target set moved (first.json5 → second.json5 in dotfiles), so
        // the entry rebound once, still hearing the dotfiles directory.
        expect(bound(lines, dir)).toHaveLength(2);
        expect(hears(bound(lines, dir)[1]!, join(dir, "dotfiles"))).toBe(true);
        // The rebind follows: a write to the new target reloads too.
        await reloads.after(entry, () =>
          writeAtomic(second, configWith("third")),
        );
        expect(literalX(entry)).toBe("third");
      } finally {
        for (const fn of cleanups) fn();
        cleanup();
      }
    });

    // A profile switch: the config links to a `current` link that picks a
    // profile. Re-pointing the middle link changes what the config reads, and
    // it appears only in the middle link's own directory.
    test("re-pointing a middle link of a chain reloads from the new target", async () => {
      const { dir, cleanup } = mkConfigDir();
      const lines: string[] = [];
      const { cache, cleanups, reloads } = makeCache(undefined, (_l, msg) =>
        lines.push(msg),
      );
      try {
        mkdirSync(join(dir, "dotfiles", "profiles"), { recursive: true });
        const work = join(dir, "dotfiles", "profiles", "work.json5");
        const home = join(dir, "dotfiles", "profiles", "home.json5");
        writeFileSync(work, configWith("work"));
        writeFileSync(home, configWith("home"));
        const current = join(dir, "dotfiles", "current.json5");
        symlinkSync(work, current);
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(current, link);
        const entry = cache.getOrCreate(dir, dir, undefined);
        expect(literalX(entry)).toBe("work");
        // Every hop's directory is heard.
        expect(hears(bound(lines, dir)[0]!, dir)).toBe(true);
        expect(hears(bound(lines, dir)[0]!, join(dir, "dotfiles"))).toBe(true);
        expect(
          hears(bound(lines, dir)[0]!, join(dir, "dotfiles", "profiles")),
        ).toBe(true);

        await reloads.after(entry, () => {
          symlinkSync(home, `${current}.tmp`);
          renameSync(`${current}.tmp`, current);
        });
        expect(literalX(entry)).toBe("home");
        await reloads.after(entry, () => writeAtomic(link, configWith("away")));
        expect(literalX(entry)).toBe("away");
        expect(readFileSync(home, "utf8")).toBe(configWith("away"));
      } finally {
        for (const fn of cleanups) fn();
        cleanup();
      }
    });

    // A candidate the kernel refuses to follow is watched as spelled, and the
    // bind says so by path: a config that hears less than it should is loud.
    test("a link loop in a candidate is reported as unresolved", () => {
      const { dir, cleanup } = mkConfigDir();
      const lines: string[] = [];
      const { cache, cleanups } = makeCache(undefined, (level, msg) =>
        lines.push(`${level} ${msg}`),
      );
      try {
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(`${link}.other`, link);
        symlinkSync(link, `${link}.other`);
        cache.getOrCreate(dir, dir, undefined);
        expect(
          lines.filter((l) =>
            l.startsWith(
              `warn config watch unresolved projectDir=${dir} path=${link} reason=`,
            ),
          ),
        ).toHaveLength(1);
      } finally {
        for (const fn of cleanups) fn();
        cleanup();
      }
    });
  });

  // A reload that keeps its watch retries nothing: a config folder the OS
  // refused waits for the registry's period or a new slot on it, so the fault
  // the bar shows stands while the OS still refuses and clears within one
  // period of the OS watching it again.
  test("a refused config directory stays deaf through a refused retry, is heard again on the period's judgment, and a reload leaves it as it is", () => {
    const { dir, cleanup } = mkConfigDir();
    const at = realpathSync(dir);
    const watch = fs.watch.bind(fs);
    let refuse = true;
    const spy = jest.spyOn(fs, "watch").mockImplementation(((
      ...args: Parameters<typeof fs.watch>
    ) => {
      if (refuse && args[0] === at) throw new Error("EMFILE: too many open files");
      return watch(...args);
    }) as typeof fs.watch);
    const { cache, cleanups, watchers } = makeCache();
    try {
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.watch!.held.handle.deaf.map((d) => d.path)).toEqual([at]);
      watchers.judge();
      expect(entry.watch!.held.handle.deaf.map((d) => d.path)).toEqual([at]);
      refuse = false;
      cache.reload(dir, dir, undefined, { kind: "doctor" });
      expect(entry.watch!.held.handle.deaf.map((d) => d.path)).toEqual([at]);
      watchers.judge();
      expect(entry.watch!.held.handle.deaf).toEqual([]);
    } finally {
      for (const fn of cleanups) fn();
      spy.mockRestore();
      cleanup();
    }
  });

  // On Linux a directory watch binds an inode, and a strict ancestor renamed
  // away reports nothing to it, so an entry whose project directory's parent
  // is swapped (a project re-cloned beside the old one and moved into place)
  // keeps a handle on the old tree, listening and deaf to the new one. The
  // period's judgment rebinds it, and the edit after that is heard.
  test("an entry whose project directory's parent is replaced by rename reads the new tree on the period's judgment, and hears the edit after it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-candybar-cache-swap-")));
    const proj = join(root, "proj", "app");
    const { cache, cleanups, reloads, watchers, counters } = makeCache();
    try {
      mkdirSync(proj, { recursive: true });
      answerRepo(proj);
      const cfg = join(proj, ".cc-candybar.json5");
      const config = (value: string): string =>
        JSON.stringify({
          globals: {},
          variables: { x: { kind: "literal", value } },
          segments: {
            only: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
          },
          root: { h: ["only"] },
        });
      writeFileSync(cfg, config("old"));
      const entry = cache.getOrCreate(proj, proj, undefined);
      const x = (): unknown => {
        const decl = entry.state.config.variables.x;
        if (decl === undefined) return "absent";
        return decl.kind === "literal" ? decl.value : decl.kind;
      };
      expect(entry.configLayers).toEqual([cfg]);
      expect(x()).toBe("old");

      renameSync(join(root, "proj"), join(root, "old"));
      mkdirSync(proj, { recursive: true });
      writeFileSync(cfg, config("new"));
      // On macOS the watch follows the path and would hear the write on its
      // own, so what proves the judgment on both platforms is the handle it
      // closes, before any window can land.
      const closed = counters.dirWatchesClosed;
      watchers.judge();
      expect(counters.dirWatchesClosed).toBe(closed + 1);
      await until(() => x() === "new", "the entry read the tree now at its path");
      expect(entry.configLayers).toEqual([cfg]);

      await reloads.after(entry, () => writeFileSync(cfg, config("edited")));
      expect(x()).toBe("edited");
    } finally {
      for (const fn of cleanups) fn();
      rmSync(root, { recursive: true, force: true });
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
      // watcher fires on file deletion in the same dir.
      await reloads.afterRemoving(entry, cfgJson, () =>
        writeFileSync(cfgJson, validCfg),
      );
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

  test("a placement of an undeclared segment drops only its cell: the config loads, and the drop is its error", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(
        cfg,
        `{ segments: { s: { template: "mine" } }, root: { h: ["s", "nope"] } }`,
      );
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.state.dropped[0]?.message).toMatch(
        /root entry "nope" does not match any declared segment/,
      );
      const placed = JSON.stringify(entry.state.config.root);
      expect(placed).toContain('"s"');
      expect(placed).not.toContain('"nope"');
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
      // The duplicate plus a dangling variable reference: the reference is
      // fatal; the advisory still reaches the bar beside it.
      writeFileSync(cfg, DUPLICATE_KEY_CONFIG.replace("{{ .x }}", "{{ .nope }}"));
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
    // The cache's own watch, on the answers for repositories.
    const own = watchers.size();
    try {
      expect(() => cache.getOrCreate(dir, dir, undefined)).toThrow(
        "observer boom",
      );
      // The entry — and the live registry + watcher it owns — is in the
      // cache, so eviction/dispose can still reach it.
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
      // A second lookup finds it rather than building a duplicate: the
      // observer (which would throw again) does not run, and no second
      // watcher opens.
      cache.getOrCreate(dir, dir, undefined);
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // The book's folder, never the state directory, whose log writes on every
  // request.
  test("the cache watches the answers' folder, not the state directory", () => {
    const { cleanups, watchers } = makeCache();
    try {
      const dirs = watchers.watchedDirs();
      expect(dirs).toContain(realpathSync.native(repoConfigsDir()));
      expect(dirs).not.toContain(realpathSync.native(stateDir()));
    } finally {
      for (const fn of cleanups) fn();
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
    const own = watchers.size();
    try {
      for (let i = 0; i < 5; i++) {
        expect(() => cache.getOrCreate(`/p${i}`, `/p${i}`, undefined)).toThrow(
          "observer boom",
        );
      }
      expect(cache.size).toBe(4);
      expect(watchers.size()).toBe(own + 4);
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
    const own = watchers.size();
    try {
      const outer = cache.getOrCreate(dir, dir, undefined);
      expect(inner).toBe(outer);
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // The answers for repositories are one watch for the whole cache, never one
  // per entry, and a change to them reloads the entries under the new answer.
  test("an entry follows the answers through the cache's one watch", async () => {
    const { dir, cleanup } = mkConfigDir();
    const causes: LoadCause["kind"][] = [];
    const { cache, cleanups, reloads, watchers } = makeCache({
      onReload: (entry, sessions, cause, settled) => {
        causes.push(cause.kind);
        reloads.observers.onReload!(entry, sessions, cause, settled);
      },
    });
    try {
      const own = watchers.size();
      const file = join(dir, ".cc-candybar.json5");
      writeFileSync(file, `{ segments: { t: { template: "x" } } }`);
      const entry = cache.getOrCreate(dir, dir, undefined);
      expect(entry.configLayers).toEqual([file]);
      expect(watchers.size()).toBe(own + 1);
      // A rewrite of the book, so every retry the signal makes is an event.
      const declined = JSON.stringify({
        [realpathSync.native(dir)]: "declined",
      });
      await reloads.after(entry, () =>
        writeFileSync(repoConfigsPath(), declined),
      );
      expect(entry.configLayers).toEqual([]);
      expect(entry.repos.declined).toEqual([realpathSync.native(dir)]);
      expect(causes).toContain("answers-watch");
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
    // The entry the test reloads loads a file it edits, so the reload builds.
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    const fileOf = (i: number) => (i === 4 ? cfg.file : undefined);
    try {
      cache
        .holdSession("/p0", "/p0", undefined, viewFacts("/p0", "s0"))
        [Symbol.dispose]();
      for (let i = 0; i < 5; i++)
        cache.getOrCreate(`/p${i}`, `/p${i}`, fileOf(i));
      const evict = lines.filter((l) => l.startsWith("config disposed "));
      expect(evict).toHaveLength(1);
      expect(evict[0]).toMatch(
        /^config disposed reason=evict released=\d+ held=0$/,
      );
      expect(lines.filter((l) => l.startsWith("session view closed "))).toEqual(
        [
          expect.stringMatching(
            /^session view closed sid="s0" reason=evict released=[1-9]\d* held=0 /,
          ),
        ],
      );

      cfg.edit();
      cache.reload("/p4", "/p4", cfg.file, { kind: "write" });
      const reload = lines.filter((l) =>
        l.startsWith("config disposed reason=reload"),
      );
      expect(reload).toHaveLength(1);
      expect(reload[0]).toMatch(
        /^config disposed reason=reload released=\d+ held=0$/,
      );

      // A close tears every entry down at once, but a state a render still
      // holds waits for it, as an eviction's does.
      const hold = cache.hold("/p4", "/p4", cfg.file);
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
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    try {
      const hold = cache.hold("/p0", "/p0", cfg.file);
      cfg.edit();
      cache.reload("/p0", "/p0", cfg.file, { kind: "write" });
      // The entry serves the fresh state; the render keeps the one it
      // started on, undisposed, until it returns.
      expect(hold.entry.state).not.toBe(hold.state);
      expect(cache.getOrCreate("/p0", "/p0", cfg.file)).toBe(hold.entry);
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
      cfg.edit();
      cache.reload("/p0", "/p0", cfg.file, { kind: "write" });
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
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    try {
      const holds: Hold[] = [
        cache.hold("/p0", "/p0", cfg.file),
        cache.hold("/p0", "/p0", cfg.file),
      ];
      expect(holds[1]!.state).toBe(holds[0]!.state);
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 0 });
      cfg.edit();
      cache.reload("/p0", "/p0", cfg.file, { kind: "write" });
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
        entry.state.config.segments["repo.deploy.status"],
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
        entry.state.config.segments["repo.deploy.status"],
      ).toBeDefined();
    } finally {
      cleanup();
      for (const fn of cleanups) fn();
    }
  });
});

// brandon-unfiled-3248.8ro6: what a session's view holds of the daemon's shared
// entries (a repo, a pane, a plugin's session file) keeps their owners' periods
// running, so a hold the view's renders have not read across a whole sweep is
// released — whether or not the view is still drawn — and the next render that
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
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        source: SOURCES_NOTHING,
        declare: DECLARES_NOTHING,
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    try {
      let released = 0;
      {
        using hold = cache.holdSession(
          dir,
          dir,
          undefined,
          viewFacts(dir, "s1"),
        );
        hold.view.holds.take("repo", () => () => {
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
      expect(() =>
        cache.reload(dir, dir, undefined, { kind: "write" }),
      ).toThrow("render cache used after close");
    } finally {
      cache.close();
      jest.useRealTimers();
      watchers.closeAll();
      cleanup();
    }
  });

  // [LAW:single-enforcer] A view opened outside the cache (the demo, a tool)
  // is torn down by its one dispose, which releases what its renders held.
  test("a view's dispose releases its holds and refuses new ones", () => {
    const { dir, cleanup } = mkConfigDir();
    const watchers = new WatcherRegistry({ logger: () => {} });
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        source: SOURCES_NOTHING,
        declare: DECLARES_NOTHING,
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    try {
      const view = openView(
        cache.getOrCreate(dir, dir, undefined).state,
        dir,
        viewFacts(dir, "s1"),
        {
          sessionState: new SessionState(),
          source: SOURCES_NOTHING,
          declare: DECLARES_NOTHING,
          changed: () => {},
          log: () => {},
        },
      );
      let released = 0;
      view.holds.take("repo", () => () => {
        released++;
      });
      view.dispose();
      expect(released).toBe(1);
      expect(() => view.holds.take("repo", () => () => {})).toThrow(
        "hold taken after close: repo",
      );
    } finally {
      cache.close();
      watchers.closeAll();
      cleanup();
    }
  });

  test("a view holds what its declaration takes: a request naming other keys, or the session's preset moving, declares again at once", () => {
    const { dir, cleanup } = mkConfigDir();
    const watchers = new WatcherRegistry({ logger: () => {} });
    const sessionState = new SessionState();
    // Each declaration takes one hold per key its request names and one per
    // closure, so what it holds says which request and which preset it read.
    const closures: Array<ReadonlySet<string>> = [];
    const declarations: string[] = [];
    const released: string[] = [];
    const take = (holds: Holds, key: string): void =>
      holds.take(key, () => () => {
        released.push(key);
      });
    const logs: string[] = [];
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState,
        watchers,
        log: (_level, message) => logs.push(message),
        source: SOURCES_NOTHING,
        declare: (holds, facts, closure, sources) => {
          if (!closures.includes(closure)) closures.push(closure);
          const preset = `closure:${closures.indexOf(closure)}`;
          declarations.push(`${facts.cwd} ${preset}`);
          take(holds, `repo:${facts.cwd}`);
          take(holds, preset);
          return DECLARES_NOTHING(holds, facts, closure, sources);
        },
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    const request = (cwd: string): ViewFacts => ({
      sessionId: sessionIdOf("s1"),
      hookData: {
        hook_event_name: "Status",
        session_id: "s1",
        transcript_path: join(dir, "t.jsonl"),
        cwd,
        model: { id: "m", display_name: "M" },
        workspace: { current_dir: cwd, project_dir: dir },
      },
      cwd,
      hints: parseClientHints({}),
    });
    try {
      const a = request("/a");
      const view = (() => {
        using hold = cache.holdSession(dir, dir, undefined, a);
        return hold.view;
      })();
      // A view opens declared, at the request it opens with.
      expect(declarations).toEqual(["/a closure:0"]);
      expect(view.holds.size).toBe(2);
      // The same request — a frame drawn by it — declares nothing again.
      view.requested(a);
      expect(declarations).toHaveLength(1);

      // A request naming another key: the one it no longer names goes now.
      view.requested(request("/b"));
      expect(declarations).toEqual(["/a closure:0", "/b closure:0"]);
      expect(released).toEqual(["repo:/a"]);

      // A pick of another session's, or of this one's that moves no preset,
      // declares nothing.
      sessionState.set("s2", "preset", "compact");
      sessionState.set("s1", "theme", "nord");
      expect(declarations).toHaveLength(2);

      // The session's preset moving declares its closure, with no render.
      sessionState.set("s1", "preset", "compact");
      expect(declarations).toEqual([
        "/a closure:0",
        "/b closure:0",
        "/b closure:1",
      ]);
      expect(released).toEqual(["repo:/a", "closure:0"]);
      expect(view.holds.size).toBe(2);
      // Each declaration that moved a hold says so; the repeat of `a` and the
      // picks that moved no preset wrote nothing.
      expect(logs.filter((l) => l.startsWith("session view declared"))).toEqual(
        [
          'session view declared sid="s1" acquired=2 released=0 held=2',
          'session view declared sid="s1" acquired=1 released=1 held=2',
          'session view declared sid="s1" acquired=1 released=1 held=2',
        ],
      );

      // Closing the view stops its declarations and releases what it held.
      cache.releaseIdle();
      cache.releaseIdle();
      expect(released).toEqual([
        "repo:/a",
        "closure:0",
        "repo:/b",
        "closure:1",
      ]);
      sessionState.set("s1", "preset", "verbose");
      expect(declarations).toHaveLength(3);
    } finally {
      cache.close();
      watchers.closeAll();
      cleanup();
    }
  });
});

// [LAW:effects-at-boundaries] A frame's door into the cache (brandon-unfiled-
// 3248.8ro6, step 5): `holdView` only finds the session's view, an open feed's
// pin keeps that view and its entry, and a click that moved the session's
// config moves its view (`follow`). Only an event opens a view.
describe("RenderCache frames and pins", () => {
  function pinCache() {
    const watchers = new WatcherRegistry({ logger: () => {} });
    const logs: string[] = [];
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        log: (_level, line) => logs.push(line),
        source: SOURCES_NOTHING,
        declare: DECLARES_NOTHING,
      },
      // Room for four entries over one compile, and the view of one.
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    const dirs = [0, 1, 2, 3, 4, 5].map(() => mkConfigDir());
    const close = (): void => {
      cache.close();
      watchers.closeAll();
      for (const d of dirs) d.cleanup();
    };
    const request = (sessionId: string, dir: string): SessionView => {
      using hold = cache.holdSession(
        dir,
        dir,
        undefined,
        viewFacts(dir, sessionId),
      );
      return hold.view;
    };
    const opened = (): string[] =>
      logs.filter((l) => l.startsWith("session view opened"));
    return {
      cache,
      logs,
      dirs: dirs.map((d) => d.dir),
      close,
      request,
      opened,
    };
  }

  test("holdView opens nothing: no entry, no view, before or after a session's request", () => {
    const { cache, dirs, close, request, logs } = pinCache();
    try {
      expect(cache.holdView("s1")).toBeNull();
      expect(cache.size).toBe(0);
      expect(cache.stats.views).toBe(0);
      const view = request("s1", dirs[0]!);
      const before = logs.length;
      for (let i = 0; i < 5; i++) {
        using hold = cache.holdView("s1");
        expect(hold?.view).toBe(view);
        expect(hold?.entry.cwd).toBe(dirs[0]);
      }
      // A frame wrote no line: it opened no view, built no entry, declared
      // nothing.
      expect(logs.slice(before)).toEqual([]);
      expect(cache.holdView("s2")).toBeNull();
      expect(cache.size).toBe(1);
    } finally {
      close();
    }
  });

  test("a pinned session's entry is never evicted, and its view never closed idle, while the pin is held", () => {
    const { cache, dirs, close, request } = pinCache();
    try {
      const view = request("s1", dirs[0]!);
      const unpin = cache.pin("s1");
      expect(cache.stats.pinned).toBe(1);
      // Other directories push the cache over its budget: the least recently
      // used entry is the pinned session's, and it is passed over.
      for (const dir of dirs.slice(1)) cache.getOrCreate(dir, dir, undefined);
      expect(cache.size).toBeLessThan(dirs.length);
      {
        using hold = cache.holdView("s1");
        expect(hold?.view).toBe(view);
        expect(hold?.entry.cwd).toBe(dirs[0]);
      }
      // No request across three sweeps: the pin keeps the view.
      cache.releaseIdle();
      cache.releaseIdle();
      cache.releaseIdle();
      expect(cache.holdView("s1")?.view).toBe(view);
      // The feed closed: frames no longer drawing it, and a frame's hold is no
      // request, so two sweeps close it.
      unpin();
      expect(cache.stats.pinned).toBe(0);
      {
        using _frame = cache.holdView("s1");
      }
      cache.releaseIdle();
      cache.releaseIdle();
      expect(cache.holdView("s1")).toBeNull();
      expect(() => unpin()).toThrow("render-cache pin released twice");
    } finally {
      close();
    }
  });

  test("without a pin, the same pressure evicts the session's entry and its view with it", () => {
    const { cache, dirs, close, request } = pinCache();
    try {
      request("s1", dirs[0]!);
      for (const dir of dirs.slice(1)) cache.getOrCreate(dir, dir, undefined);
      expect(cache.holdView("s1")).toBeNull();
    } finally {
      close();
    }
  });

  test("follow moves a session's view to the config its origin resolves to, and opens none for a session without one", () => {
    const { cache, dirs, close, request, opened } = pinCache();
    try {
      const view = request("s1", dirs[0]!);
      request("s3", dirs[0]!);
      cache.follow("s1", dirs[0]!, dirs[0]!, undefined);
      // Its origin did not move: nothing opened, and the click is no render,
      // so the latest rendered session is still the one that rendered.
      expect(opened()).toHaveLength(2);
      expect(cache.holdView("s1")?.view).toBe(view);
      expect(cache.latestView()?.sessionId).toBe("s3");
      cache.follow("s1", dirs[1]!, dirs[1]!, undefined);
      expect(opened().at(-1)).toMatch(
        /^session view opened sid="s1" by=click /,
      );
      {
        using hold = cache.holdView("s1");
        expect(hold?.entry.cwd).toBe(dirs[1]);
        // Declared with the request the view drew by.
        expect(hold?.view.facts()).toBe(view.facts());
      }
      // A session with no view has nothing to move, and gets no view.
      const size = cache.size;
      cache.follow("s2", dirs[2]!, dirs[2]!, undefined);
      expect(cache.holdView("s2")).toBeNull();
      expect(cache.size).toBe(size);
    } finally {
      close();
    }
  });

  test("a reload whose successor view fails to open leaves the session with no view and its error, which a frame does not reopen", () => {
    const watchers = new WatcherRegistry({ logger: () => {} });
    const logs: string[] = [];
    const { dir, cleanup } = mkConfigDir();
    let opens = 0;
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        log: (_level, line) => logs.push(line),
        declare: DECLARES_NOTHING,
        // The second view built over the entry, the reload's successor, fails.
        source: (view) => {
          if (++opens === 2) throw new Error("the successor broke");
          return SOURCES_NOTHING(view);
        },
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    try {
      {
        using _request = cache.holdSession(
          dir,
          dir,
          undefined,
          viewFacts(dir, "s1"),
        );
      }
      const unpin = cache.pin("s1");
      editProjectConfig(dir);
      cache.reload(dir, dir, undefined, { kind: "write" });
      expect(logs).toContainEqual(
        expect.stringMatching(
          /^session view reopen failed sid="s1": Error: the successor broke/,
        ),
      );
      // Frames find nothing, and open nothing; they find the error instead,
      // which a pin keeps across a sweep.
      expect(cache.holdView("s1")).toBeNull();
      expect(cache.holdView("s1")).toBeNull();
      expect(opens).toBe(2);
      cache.releaseIdle();
      expect(String(cache.openFailure("s1")?.error)).toBe(
        "Error: the successor broke",
      );
      // The session's next request opens its view, and the error goes.
      {
        using _request = cache.holdSession(
          dir,
          dir,
          undefined,
          viewFacts(dir, "s1"),
        );
      }
      expect(cache.holdView("s1")).not.toBeNull();
      expect(cache.openFailure("s1")).toBeNull();
      unpin();
    } finally {
      cache.close();
      watchers.closeAll();
      cleanup();
    }
  });

  // A failure no open feed shows has no frame to draw it in, so a sweep
  // forgets it.
  test("an unpinned session's open failure is forgotten by the next sweep", () => {
    const watchers = new WatcherRegistry({ logger: () => {} });
    const { dir, cleanup } = mkConfigDir();
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        log: () => {},
        declare: DECLARES_NOTHING,
        source: () => {
          throw new Error("the view broke");
        },
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    try {
      expect(() =>
        cache.holdSession(dir, dir, undefined, viewFacts(dir, "s1")),
      ).toThrow("the view broke");
      expect(cache.openFailure("s1")).not.toBeNull();
      cache.releaseIdle();
      expect(cache.openFailure("s1")).toBeNull();
    } finally {
      cache.close();
      watchers.closeAll();
      cleanup();
    }
  });

  // A click that moves the origin of a session whose opening failed opens
  // by the request that opening was for, so a pick that fixes it shows with
  // no request after it.
  test("follow retries a failed opening by its request, and the error goes", () => {
    const watchers = new WatcherRegistry({ logger: () => {} });
    const first = mkConfigDir();
    const second = mkConfigDir();
    let opens = 0;
    const cache = new RenderCache(
      {
        launcher: processLauncher,
        storage: NO_PLUGIN_STORAGE,
        signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        log: () => {},
        declare: DECLARES_NOTHING,
        source: (view) => {
          if (++opens === 1) throw new Error("the view broke");
          return SOURCES_NOTHING(view);
        },
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    try {
      const facts = viewFacts(first.dir, "s1");
      expect(() =>
        cache.holdSession(first.dir, first.dir, undefined, facts),
      ).toThrow("the view broke");
      const unpin = cache.pin("s1");
      cache.follow("s1", second.dir, second.dir, undefined);
      {
        using hold = cache.holdView("s1");
        expect(hold?.entry.cwd).toBe(second.dir);
        expect(hold?.view.facts()).toBe(facts);
      }
      expect(cache.openFailure("s1")).toBeNull();
      unpin();
    } finally {
      cache.close();
      watchers.closeAll();
      first.cleanup();
      second.cleanup();
    }
  });

  test("a view says what opened it", () => {
    const { cache, dirs, close, request, opened } = pinCache();
    try {
      request("s1", dirs[0]!);
      editProjectConfig(dirs[0]!);
      cache.reload(dirs[0]!, dirs[0]!, undefined, { kind: "write" });
      expect(opened().map((l) => l.match(/ by=(\w+) /)?.[1])).toEqual([
        "request",
        "reload",
      ]);
    } finally {
      close();
    }
  });
});
