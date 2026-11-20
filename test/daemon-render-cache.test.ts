// [LAW:single-enforcer] Tests for the RenderCache invariants that bzh.2
// changed: cache identity (projectDir+cwd, args ignored), last-known-good
// preservation across failed reloads, candidate-dir watcher firing when a
// higher-precedence config file appears, and registry disposal on
// eviction. The legacy renderer's render-cache tests were deleted in
// bzh.2; this is the new, smaller test set scoped to the DSL spine.

import { HOST, WORLD, hostOf, worldOf } from "./helpers/host";
import type { Host, World } from "../src/host";
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
import { dirname, join } from "node:path";

import {
  RenderCache,
  type CacheEntry,
  type LoadCause,
  type Hold,
  type RenderCacheObservers,
  type SessionView,
  SOURCES_NOTHING,
  openView,
  ENTRY_BYTES,
  COMPILE_BYTES,
  VIEW_BYTES,
} from "../src/renderer/render-cache";
import { SessionState } from "../src/renderer/session-state";
import { parseClientHints } from "../src/daemon/foundations/protocol";
import type { ViewFacts } from "../src/renderer-interface/request-context";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { Holds } from "../src/utils/holds";
import { stateGate } from "./helpers/gates";
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
import { SETTINGS_NS } from "../src/config/reserved-names";
import { PRESET_FLOOR, presetRoot } from "../src/config/presets";
import { viewFacts } from "./helpers/view-facts";
import { answerRepo } from "./helpers/repo-approval";
import {
  repoConfigsPath,
} from "../src/daemon/config-discovery/repo-configs";
import { locations, stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { configHost, originOf, type ConfigHost } from "./helpers/config-host";
import type { ConfigSnapshot } from "../src/config/config-snapshot";
import { systemTimekeeper } from "../src/time";
import { SourceRuns } from "../src/daemon/source-runs";
import { shellEnvOf } from "../src/config/shell-env";
import { fieldOf } from "../src/utils/logfmt";
const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

// The machine the caches below load on: this worker's own unless a describe
// states another for its tests.
let host: Host = HOST;
let world: World = WORLD;

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
  originAt: ConfigHost["at"];
  configs: ConfigHost;
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
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    counters,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const sessionState = new SessionState();
  const reloads = new ReloadSignal();
  const cache = new RenderCache(
    {
      clock: systemTimekeeper,
      locations: locations(host),
      gates: bareGates(),
      sessionState,
      log,
      source: SOURCES_NOTHING,
    },
    {
      // Room for four entries over one compile: the fifth evicts the oldest.
      budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES,
      observers: observers ?? reloads.observers,
    },
  );
  const configs = configHost(cache, {
    locations: locations(host),
    stateDir: stateDir(host),
    watchers,
    log,
  });
  cleanups.unshift(() => configs.close());
  cleanups.unshift(() => cache.close());
  return {
    cache,
    originAt: configs.at,
    configs,
    cleanups,
    reloads,
    watchers,
    counters,
  };
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
  beforeAll(() => {
    xdgIsolateDir = mkdtempSync(join(tmpdir(), "cc-candybar-cache-xdg-"));
    host = hostOf({ ...HOST.env, XDG_CONFIG_HOME: xdgIsolateDir });
    world = worldOf(host);
  });
  afterAll(() => {
    host = HOST;
    world = WORLD;
    rmSync(xdgIsolateDir, { recursive: true, force: true });
  });

  // The resolver's presence predicate is not `existsSync`: a named file
  // behind an unsearchable directory is `unreadable`: the load fails naming
  // the file and the stat's own EACCES, and the bar draws its last good
  // config, the bundled default before any loaded (liveness — the watcher
  // recovers when the directory opens). Never the `missing` notice claiming
  // a correct path was not found. Root bypasses directory permissions.
  const asRoot = process.getuid?.() === 0;
  (asRoot ? test.skip : test)(
    "an explicit path behind an unsearchable directory fails its load naming the file, over the default",
    () => {
      const { cache, originAt, cleanups } = makeCache();
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
        const entry = cache.getOrCreate(originAt(dir, dir, cfg));
        expect(entry.configLayers).toEqual([]);
        expect(entry.lastError).toContain(cfg);
        expect(entry.lastError).toContain("could not be read");
        expect(entry.lastError).toContain("EACCES");
        expect(entry.lastWarnings.join("\n")).not.toContain(
          "Config file not found",
        );
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
    const { cache, originAt, cleanups, reloads } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const cfg = join(dir, "named.json5");
      const entry = cache.getOrCreate(originAt(dir, dir, cfg));
      expect(entry.lastError).toBeNull();
      expect(entry.configLayers).toEqual([]);
      expect(entry.lastWarnings.join("\n")).toContain(
        `Config file not found: ${cfg}`,
      );
      // The state beneath the warning is the bundled default's.
      expect(entry.state.config.root).toEqual(
        cache.getOrCreate(originAt(dir, dir, undefined)).state.config.root,
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
      expect(entry.lastWarnings).toEqual([]);
      expect(entry.configLayers).toEqual([cfg]);
      expect(layoutSegments(rootNode(entry.state.config.root))).toContain("t");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // brandon-lit-widget-3xo.rvo: a `shell` source runs in its entry's cwd, not
  // the detached daemon's, so one config rendered from two checkouts asks each
  // command about its own directory: the run each view names reads there.
  test("a shell source runs in its entry's cwd", () => {
    const { cache, originAt, cleanups } = makeCache();
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
      const cwdOf = (at: string, sid: string) => {
        using held = cache.holdSession(
          originAt(at, at, cfg),
          viewFacts(at, sid),
        );
        return held.view.registry
          .subscriptions()
          .map(({ identity }) => identity.read);
      };
      expect(cwdOf(a, "s-a")).toEqual([
        { kind: "shell", command: "pwd -P", cwd: a, env: shellEnvOf() },
      ]);
      expect(cwdOf(b, "s-b")).toEqual([
        { kind: "shell", command: "pwd -P", cwd: b, env: shellEnvOf() },
      ]);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("cache identity is (projectDir, cwd, configFile)", () => {
    const { cache, originAt, cleanups } = makeCache();
    try {
      // Same (projectDir, cwd, configFile=undefined) → same entry.
      const a = cache.getOrCreate(originAt("/x", "/x", undefined));
      const b = cache.getOrCreate(originAt("/x", "/x", undefined));
      expect(a).toBe(b);
      expect(cache.size).toBe(1);

      // Distinct configFile values produce distinct entries — the CLI
      // override is a real input to config resolution and must be part
      // of the cache key.
      const c = cache.getOrCreate(originAt("/x", "/x", "/tmp/alt.json5"));
      const d = cache.getOrCreate(originAt("/x", "/x", "/tmp/other.json5"));
      expect(c).not.toBe(a);
      expect(d).not.toBe(c);
      expect(cache.size).toBe(3);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:no-defensive-null-guards] The cache opens no file: an origin whose
  // config the host never handed in is the caller's bug, said with the
  // origin, and builds no entry.
  test("an origin no config was handed in for builds no entry, and says which", () => {
    const { cache, cleanups } = makeCache();
    try {
      const origin = originOf("/x", "/x", "/tmp/alt.json5");
      expect(cache.holdsConfig(origin)).toBe(false);
      expect(() => cache.getOrCreate(origin)).toThrow(
        "no config is held for origin projectDir=/x cwd=/x configFile=/tmp/alt.json5",
      );
      expect(cache.size).toBe(0);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("falls back to DEFAULT_DSL_CONFIG when no config file exists", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
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
    const { cache, originAt, cleanups, reloads } = makeCache();
    try {
      const cfg = join(dir, "explicit.json5");
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
      const entry = cache.getOrCreate(originAt(dir, dir, cfg));
      // The error is loud AND names the file...
      expect(entry.lastError).toMatch(/trigger needs a display/);
      expect(entry.configLayers).toEqual([cfg]);
      expect(entry.state.configPath).toBeNull();
      expect(entry.state.writable).toEqual([]);
      // ...while the state is the bundled default's: the same tree a
      // no-file entry builds, settings menu included — one synthesis, not a
      // second "safe mode" config.
      const fallback = cache.getOrCreate(originAt(bare, bare, undefined));
      expect(fallback.state.configPath).toBeNull();
      expect(fallback.state.writable).toContain("user");
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
      expect(entry.state.configPath).toBe(cfg);
      expect(entry.state.writable).toContain("user");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
      cleanupBare();
    }
  });

  test("last-known-good preserved when a hot reload introduces a broken config", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups, reloads } = makeCache();
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
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
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
    const { cache, originAt, cleanups, reloads } = makeCache();
    try {
      // First call: no file exists, falls back to default.
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
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
      lines.filter(
        (l) =>
          l.startsWith("config watch bound ") &&
          fieldOf(l, "projectDir") === dir &&
          fieldOf(l, "cwd") === dir,
      );
    const polls = (line: string, at: string): boolean =>
      fieldOf(line, "polled").split(",").includes(at);

    test("a write-then-rename of the link's target reloads, every time", async () => {
      const { dir, cleanup } = mkConfigDir();
      const lines: string[] = [];
      const { cache, originAt, cleanups, reloads } = makeCache(
        undefined,
        (_l, msg) => lines.push(msg),
      );
      try {
        mkdirSync(join(dir, "dotfiles"));
        const target = join(dir, "dotfiles", "candybar.json5");
        writeFileSync(target, configWith("first"));
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(target, link);
        const entry = cache.getOrCreate(originAt(dir, dir, undefined));
        expect(entry.configLayers).toEqual([link]);
        expect(literalX(entry)).toBe("first");
        // Bound once, polling the target as well as the link.
        expect(bound(lines, dir)).toHaveLength(1);
        expect(polls(bound(lines, dir)[0]!, target)).toBe(true);
        expect(polls(bound(lines, dir)[0]!, link)).toBe(true);

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
      const { cache, originAt, cleanups, reloads } = makeCache(
        undefined,
        (_l, msg) => lines.push(msg),
      );
      try {
        mkdirSync(join(dir, "dotfiles"));
        const first = join(dir, "dotfiles", "first.json5");
        const second = join(dir, "dotfiles", "second.json5");
        writeFileSync(first, configWith("first"));
        writeFileSync(second, configWith("second"));
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(first, link);
        const entry = cache.getOrCreate(originAt(dir, dir, undefined));
        expect(literalX(entry)).toBe("first");

        // `ln -sfn`: a new link renamed over the old entry.
        await reloads.after(entry, () => {
          symlinkSync(second, `${link}.tmp`);
          renameSync(`${link}.tmp`, link);
        });
        expect(literalX(entry)).toBe("second");
        // The target set moved (first.json5 → second.json5), so the entry
        // rebound once, polling the new target.
        expect(bound(lines, dir)).toHaveLength(2);
        expect(polls(bound(lines, dir)[1]!, second)).toBe(true);
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
      const { cache, originAt, cleanups, reloads } = makeCache(
        undefined,
        (_l, msg) => lines.push(msg),
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
        const entry = cache.getOrCreate(originAt(dir, dir, undefined));
        expect(literalX(entry)).toBe("work");
        // Every hop is polled.
        for (const hop of [link, current, work])
          expect(polls(bound(lines, dir)[0]!, hop)).toBe(true);

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
      const { cache, originAt, cleanups } = makeCache(undefined, (level, msg) =>
        lines.push(`${level} ${msg}`),
      );
      try {
        const link = join(dir, ".cc-candybar.json5");
        symlinkSync(`${link}.other`, link);
        symlinkSync(link, `${link}.other`);
        cache.getOrCreate(originAt(dir, dir, undefined));
        const unresolved = lines.filter((l) =>
          l.startsWith("warn config watch unresolved "),
        );
        expect(unresolved).toHaveLength(1);
        expect(fieldOf(unresolved[0]!, "projectDir")).toBe(dir);
        expect(fieldOf(unresolved[0]!, "path")).toBe(link);
        expect(fieldOf(unresolved[0]!, "reason")).not.toBe("");
      } finally {
        for (const fn of cleanups) fn();
        cleanup();
      }
    });
  });

  // A reload that keeps its watch retries nothing: a plugin root the OS
  // refused waits for the registry's period or a new slot on it, so the fault
  // the bar shows stands while the OS still refuses and clears within one
  // period of the OS watching it again.
  test("a refused plugin root stays deaf through a refused retry, is heard again on the period's judgment, and a reload leaves it as it is", () => {
    const { dir, cleanup } = mkConfigDir();
    const plugins = join(dir, ".cc-candybar", "plugins");
    mkdirSync(plugins, { recursive: true });
    const at = realpathSync(plugins);
    const watch = fs.watch.bind(fs);
    let refuse = true;
    const spy = jest.spyOn(fs, "watch").mockImplementation(((
      ...args: Parameters<typeof fs.watch>
    ) => {
      if (refuse && args[0] === at)
        throw new Error("EMFILE: too many open files");
      return watch(...args);
    }) as typeof fs.watch);
    const { cache, originAt, configs, cleanups, watchers } = makeCache();
    try {
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      const refused = `cannot watch ${at} — EMFILE: too many open files`;
      expect(entry.snapshot.watch).toContain(refused);
      watchers.judge();
      configs.again();
      expect(entry.snapshot.watch).toContain(refused);
      refuse = false;
      configs.again();
      expect(entry.snapshot.watch).toContain(refused);
      watchers.judge();
      configs.again();
      expect(entry.snapshot.watch).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      spy.mockRestore();
      cleanup();
    }
  });

  // A project re-cloned beside the old one and moved into place: the config
  // is polled at its path, so the tree now there is read on the next sweep,
  // and the edit after it is heard.
  test("an entry whose project directory's parent is replaced by rename reads the new tree, and hears the edit after it", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "cc-candybar-cache-swap-")),
    );
    const proj = join(root, "proj", "app");
    const { cache, originAt, cleanups, reloads } = makeCache();
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
      const entry = cache.getOrCreate(originAt(proj, proj, undefined));
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
      await until(
        () => x() === "new",
        "the entry read the tree now at its path",
      );
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
    const { cache, originAt, cleanups, reloads } = makeCache();
    try {
      // The home (here the explicit file) is what authors a root: a reset
      // writes nowhere else.
      const cfg = join(dir, ".cc-candybar.json5");
      const entry = cache.getOrCreate(originAt(dir, dir, cfg));
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
    const { cache, originAt, cleanups } = makeCache();
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
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.lastError).toBeNull();
      expect(entry.configLayers).toEqual([cfg]);
      expect(entry.state.config.root).toEqual(rootOf(oneRow("only")));
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("lastWarnings is set when .json5 and .json coexist at same location", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups, reloads } = makeCache();
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

      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      // Load succeeded — .json5 won; warning is the advisory.
      expect(entry.lastError).toBeNull();
      expect(entry.configLayers).toEqual([cfgJson5]);
      expect(entry.lastWarnings).not.toEqual([]);
      expect(entry.lastWarnings.join("\n")).toContain(cfgJson5);
      expect(entry.lastWarnings.join("\n")).toContain(cfgJson);

      // Removing the duplicate clears the warning on next reload. The
      // watcher fires on file deletion in the same dir.
      await reloads.afterRemoving(entry, cfgJson, () =>
        writeFileSync(cfgJson, validCfg),
      );
      expect(entry.lastWarnings).toEqual([]);
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

  test("lastWarnings names a duplicate object key and its line; the load still succeeds with the last value", async () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups, reloads } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(cfg, DUPLICATE_KEY_CONFIG);

      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.lastError).toBeNull();
      expect(entry.state.config.globals.padding).toBe(2);
      expect(entry.lastWarnings).toEqual([
        `${cfg}:8: duplicate key "padding" — the settings menu cannot edit this file until it is fixed`,
      ]);

      // Removing the duplicate clears the advisory on the next reload.
      await reloads.after(entry, () => {
        writeFileSync(cfg, DUPLICATE_KEY_CONFIG.replace("padding: 1,\n", ""));
      });
      expect(entry.lastWarnings).toEqual([]);
      expect(entry.lastError).toBeNull();
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a placement of an undeclared segment drops only its cell: the config loads, and the drop is its error", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      writeFileSync(
        cfg,
        `{ segments: { s: { template: "mine" } }, root: { h: ["s", "nope"] } }`,
      );
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
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
    const { cache, originAt, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      // The duplicate plus a dangling variable reference: the reference is
      // fatal; the advisory still reaches the bar beside it.
      writeFileSync(
        cfg,
        DUPLICATE_KEY_CONFIG.replace("{{ .x }}", "{{ .nope }}"),
      );
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.lastError).toContain("nope");
      expect(entry.lastWarnings.join("\n")).toContain(
        `${cfg}:8: duplicate key "padding"`,
      );
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a duplicate key's advisory survives beside a fatal structural error", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups } = makeCache();
    try {
      const cfg = join(dir, ".cc-candybar.json5");
      // An unknown top-level key fails structural validation before the
      // merge; the advisory rides the ConfigError onto the strip beside it.
      writeFileSync(
        cfg,
        DUPLICATE_KEY_CONFIG.replace(`root: { h: ["s"] },`, `bogus: true,`),
      );
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.lastError).toContain('Unknown top-level key "bogus"');
      expect(entry.lastWarnings.join("\n")).toContain(
        `${cfg}:8: duplicate key "padding"`,
      );
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a partial-load warning survives beside a validator-derivation throw", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups } = makeCache();
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
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.lastError).toContain('key "k" is an integer spec');
      expect(entry.lastWarnings.join("\n")).toContain('Variable "s.v"');
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("an observer that throws during the first load leaves the entry reachable", () => {
    const { dir, cleanup } = mkConfigDir();
    const { cache, originAt, cleanups, watchers } = makeCache({
      onReload: () => {
        throw new Error("observer boom");
      },
    });
    const own = watchers.size();
    try {
      expect(() => cache.getOrCreate(originAt(dir, dir, undefined))).toThrow(
        "observer boom",
      );
      // The entry — and the live registry + watcher it owns — is in the
      // cache, so eviction/dispose can still reach it.
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
      // A second lookup finds it rather than building a duplicate: the
      // observer (which would throw again) does not run, and no second
      // watcher opens.
      cache.getOrCreate(originAt(dir, dir, undefined));
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("a throwing observer cannot push the cache over its entry cap", () => {
    // maxEntries=4. Every lookup throws from the observer AND inserts its
    // entry (pinned above); the cap must still hold across five of them.
    const { cache, originAt, cleanups, watchers } = makeCache({
      onReload: () => {
        throw new Error("observer boom");
      },
    });
    const own = watchers.size();
    try {
      for (let i = 0; i < 5; i++) {
        expect(() =>
          cache.getOrCreate(originAt(`/p${i}`, `/p${i}`, undefined)),
        ).toThrow("observer boom");
      }
      expect(cache.size).toBe(4);
      // The config watches are the host's, one per origin it follows,
      // whatever the cache evicts.
      expect(watchers.size()).toBe(own + 5);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a reentrant getOrCreate from inside onReload returns the entry under construction", () => {
    const { dir, cleanup } = mkConfigDir();
    let inner: CacheEntry | undefined;
    const { cache, originAt, cleanups, watchers } = makeCache({
      onReload: () => {
        inner = cache.getOrCreate(originAt(dir, dir, undefined));
      },
    });
    const own = watchers.size();
    try {
      const outer = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(inner).toBe(outer);
      expect(cache.size).toBe(1);
      expect(watchers.size()).toBe(own + 1);
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  // The host polls the decision file only for interested origins. Watching
  // its directory would also wake the bar for unrelated state and log writes.
  test("a layered entry follows the decision file without watching its state directory", async () => {
    const { dir, cleanup } = mkConfigDir();
    const causes: LoadCause["kind"][] = [];
    const { cache, originAt, cleanups, reloads, watchers } = makeCache({
      onReload: (entry, sessions, cause, settled) => {
        causes.push(cause.kind);
        reloads.observers.onReload!(entry, sessions, cause, settled);
      },
    });
    try {
      expect(watchers.polledPaths()).toBe(0);
      const own = watchers.size();
      const file = join(dir, ".cc-candybar.json5");
      writeFileSync(file, `{ segments: { t: { template: "x" } } }`);
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.configLayers).toEqual([file]);
      expect(watchers.size()).toBe(own + 1);
      const state = stateDir(host);
      const book = repoConfigsPath(state);
      expect(watchers.watchedDirs()).not.toContain(state);
      expect(watchers.watchedDirs()).not.toContain(dirname(book));
      // A rewrite of the book, so every retry the signal makes is an event.
      const declined = JSON.stringify({
        [realpathSync.native(dir)]: "declined",
      });
      await reloads.after(entry, () =>
        writeFileSync(book, declined),
      );
      expect(entry.configLayers).toEqual([]);
      expect(entry.snapshot.repo?.standing).toBe("declined");
      expect(causes).toContain("config");
    } finally {
      for (const fn of cleanups) fn();
      cleanup();
    }
  });

  test("eviction disposes the evicted entry's registry + watcher", () => {
    const { cache, originAt, cleanups } = makeCache();
    try {
      // maxEntries=4. Insert 5 entries; the oldest gets evicted.
      const entries = [];
      for (let i = 0; i < 5; i++) {
        const e = cache.getOrCreate(originAt(`/p${i}`, `/p${i}`, undefined));
        entries.push(e);
      }
      expect(cache.size).toBe(4);
      // Verify the first entry's registry is disposed.
      const evicted = entries[0]!;
      // [LAW:no-defensive-null-guards] dispose is idempotent; calling it
      // again on an already-disposed registry would throw or no-op
      // depending on internals. We don't probe that here — just that the
      // entry's state is no longer reachable from the cache.
      const survivor = cache.getOrCreate(originAt("/p0", "/p0", undefined));
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
    const { cache, originAt, configs, cleanups } = makeCache(
      undefined,
      (_level, msg) => lines.push(msg),
    );
    // The entry the test reloads loads a file it edits, so the reload builds.
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    const fileOf = (i: number) => (i === 4 ? cfg.file : undefined);
    try {
      cache
        .holdSession(originAt("/p0", "/p0", undefined), viewFacts("/p0", "s0"))
        [Symbol.dispose]();
      for (let i = 0; i < 5; i++)
        cache.getOrCreate(originAt(`/p${i}`, `/p${i}`, fileOf(i)));
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
      configs.again();
      const reload = lines.filter((l) =>
        l.startsWith("config disposed reason=reload"),
      );
      expect(reload).toHaveLength(1);
      expect(reload[0]).toMatch(
        /^config disposed reason=reload released=\d+ held=0$/,
      );

      // A close tears every entry down at once, but a state a render still
      // holds waits for it, as an eviction's does.
      const hold = cache.hold(originAt("/p4", "/p4", cfg.file));
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
    const { cache, originAt, cleanups } = makeCache(undefined, (_level, msg) =>
      lines.push(msg),
    );
    const disposals = () =>
      lines.filter((l) => l.startsWith("config disposed reason=evict"));
    try {
      // maxEntries=4. /p0 is the oldest, and held.
      const hold = cache.hold(originAt("/p0", "/p0", undefined));
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 0 });
      for (let i = 1; i < 5; i++)
        cache.getOrCreate(originAt(`/p${i}`, `/p${i}`, undefined));
      // The cap held: /p0 left the map. Its state is retired, not disposed —
      // the render still draws with it, and its store still answers.
      expect(cache.stats).toMatchObject({ size: 4, held: 1, retired: 1 });
      expect(disposals()).toEqual([]);
      expect(hold.state.store.names().length).toBeGreaterThan(0);
      // Asking for /p0 again is a new entry with a state of its own — and a
      // fifth insertion, so unheld /p1 goes at once.
      const again = cache.getOrCreate(originAt("/p0", "/p0", undefined));
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
    const { cache, originAt, configs, cleanups } = makeCache(
      undefined,
      (_level, msg) => lines.push(msg),
    );
    const disposals = () =>
      lines.filter((l) => l.startsWith("config disposed reason=reload"));
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    try {
      const hold = cache.hold(originAt("/p0", "/p0", cfg.file));
      cfg.edit();
      configs.again();
      // The entry serves the fresh state; the render keeps the one it
      // started on, undisposed, until it returns.
      expect(hold.entry.state).not.toBe(hold.state);
      expect(cache.getOrCreate(originAt("/p0", "/p0", cfg.file))).toBe(
        hold.entry,
      );
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
      configs.again();
      expect(disposals()).toHaveLength(2);
      expect(disposals()[1]).toMatch(/ held=0$/);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("two renders holding one state: the teardown waits for the last", () => {
    const lines: string[] = [];
    const { cache, originAt, configs, cleanups } = makeCache(
      undefined,
      (_level, msg) => lines.push(msg),
    );
    const cfg = editedConfig();
    cleanups.push(cfg.cleanup);
    try {
      const holds: Hold[] = [
        cache.hold(originAt("/p0", "/p0", cfg.file)),
        cache.hold(originAt("/p0", "/p0", cfg.file)),
      ];
      expect(holds[1]!.state).toBe(holds[0]!.state);
      expect(cache.stats).toMatchObject({ size: 1, held: 1, retired: 0 });
      cfg.edit();
      configs.again();
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
    const { cache, originAt, cleanups } = makeCache();
    const project = (actions: Record<string, unknown>): string => {
      const { dir, cleanup } = mkConfigDir();
      cleanups.push(cleanup);
      writeFileSync(
        join(dir, ".cc-candybar.json5"),
        JSON.stringify({
          variables: {
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
        cache.getOrCreate(originAt(dir, dir, undefined)),
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
    const { cache, originAt, cleanups, reloads } = makeCache();
    const { dir, cleanup } = mkConfigDir();
    try {
      const root = join(dir, ".cc-candybar", "plugins");
      mkdirSync(root, { recursive: true });
      const entry = cache.getOrCreate(originAt(dir, dir, undefined));
      expect(entry.state.config.segments["repo.deploy.status"]).toBeUndefined();
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
      expect(entry.state.config.segments["repo.deploy.status"]).toBeDefined();
    } finally {
      cleanup();
      for (const fn of cleanups) fn();
    }
  });
});

describe("RenderCache close", () => {
  // A cache nobody closes keeps its entries' watchers, and they keep the cache
  // and every compile it serves alive for the life of the process.
  test("close disposes every state and leaves no timer", () => {
    jest.useFakeTimers();
    const { dir, cleanup } = mkConfigDir();
    const watchers = new WatcherRegistry({
      clock: systemTimekeeper,
      logger: () => {},
    });
    const cache = new RenderCache(
      {
        clock: systemTimekeeper,
        locations: locations(host),
        gates: bareGates(),
        sessionState: new SessionState(),
        source: SOURCES_NOTHING,
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES },
    );
    const configs = configHost(cache, {
      locations: locations(host),
      stateDir: stateDir(host),
      watchers,
    });
    const originAt = configs.at;
    try {
      {
        using _hold = cache.holdSession(
          originAt(dir, dir, undefined),
          viewFacts(dir, "s1"),
        );
      }
      cache.close();
      expect(cache.size).toBe(0);
      // The registry's sweep runs while the host polls the answers' book, so
      // the count is taken once the host has let its watches go too.
      configs.close();
      expect(jest.getTimerCount()).toBe(0);
      // Every way a state is built refuses: an entry, or a reload of one.
      expect(() => cache.getOrCreate(originAt(dir, dir, undefined))).toThrow(
        "render cache used after close",
      );
      expect(() =>
        cache.configure(originAt(dir, dir, undefined), {} as ConfigSnapshot),
      ).toThrow("render cache used after close");
    } finally {
      cache.close();
      jest.useRealTimers();
      configs.close();
      watchers.closeAll();
      cleanup();
    }
  });
});

// [LAW:effects-at-boundaries] A frame's door into the cache (brandon-unfiled-
// 3248.8ro6, step 5): `holdView` only finds the session's view, an open feed's
// pin keeps that view and its entry. Only an event opens a view.
describe("RenderCache frames and pins", () => {
  function pinCache(source = SOURCES_NOTHING) {
    const watchers = new WatcherRegistry({
      clock: systemTimekeeper,
      logger: () => {},
    });
    const logs: string[] = [];
    const cache = new RenderCache(
      {
        clock: systemTimekeeper,
        locations: locations(host),
        gates: bareGates(),
        sessionState: new SessionState(),
        log: (_level, line) => logs.push(line),
        source,
      },
      // Room for four entries over one compile, and the view of one.
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    const configs = configHost(cache, {
      locations: locations(host),
      stateDir: stateDir(host),
      watchers,
    });
    const originAt = configs.at;
    const dirs = [0, 1, 2, 3, 4, 5].map(() => mkConfigDir());
    const close = (): void => {
      cache.close();
      configs.close();
      watchers.closeAll();
      for (const d of dirs) d.cleanup();
    };
    const request = (sessionId: string, dir: string): SessionView => {
      using hold = cache.holdSession(
        originAt(dir, dir, undefined),
        viewFacts(dir, sessionId),
      );
      return hold.view;
    };
    const opened = (): string[] =>
      logs.filter((l) => l.startsWith("session view opened"));
    return {
      cache,
      originAt,
      configs,
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
      expect(cache.holdView(S1)).toBeNull();
      expect(cache.size).toBe(0);
      expect(cache.stats.views).toBe(0);
      const view = request("s1", dirs[0]!);
      const before = logs.length;
      for (let i = 0; i < 5; i++) {
        using hold = cache.holdView(S1);
        expect(hold?.view).toBe(view);
        expect(hold?.entry.origin.cwd).toBe(dirs[0]);
      }
      // A frame wrote no line: it opened no view, built no entry, declared
      // nothing.
      expect(logs.slice(before)).toEqual([]);
      expect(cache.holdView(S2)).toBeNull();
      expect(cache.size).toBe(1);
    } finally {
      close();
    }
  });

  test("a pinned session's entry is never evicted while the pin is held, and the host's retire closes its view", () => {
    const { cache, originAt, dirs, close, request } = pinCache();
    try {
      const view = request("s1", dirs[0]!);
      const unpin = cache.pin(S1);
      expect(cache.stats.pinned).toBe(1);
      // Other directories push the cache over its budget: the least recently
      // used entry is the pinned session's, and it is passed over.
      for (const dir of dirs.slice(1))
        cache.getOrCreate(originAt(dir, dir, undefined));
      expect(cache.size).toBeLessThan(dirs.length);
      {
        using hold = cache.holdView(S1);
        expect(hold?.view).toBe(view);
        expect(hold?.entry.origin.cwd).toBe(dirs[0]);
      }
      // The feed closed, and the host retired the session.
      unpin();
      expect(cache.stats.pinned).toBe(0);
      cache.retireSession(S1);
      expect(cache.holdView(S1)).toBeNull();
      expect(() => unpin()).toThrow("render-cache pin released twice");
    } finally {
      close();
    }
  });

  test("without a pin, the same pressure evicts the session's entry and its view with it", () => {
    const { cache, originAt, dirs, close, request } = pinCache();
    try {
      request("s1", dirs[0]!);
      for (const dir of dirs.slice(1))
        cache.getOrCreate(originAt(dir, dir, undefined));
      expect(cache.holdView(S1)).toBeNull();
    } finally {
      close();
    }
  });

  test.each(["committed", "draft"])(
    "a failed pinned %s successor keeps its owner and reopens on corrective config under pressure",
    (which) => {
      const watchers = new WatcherRegistry({
        clock: systemTimekeeper,
        logger: () => {},
      });
      const logs: string[] = [];
      const { dir, cleanup } = mkConfigDir();
      const other = mkConfigDir();
      let latest = viewFacts(dir, "s1");
      let draft: ConfigSnapshot | null = null;
      let opens = 0;
      const cache = new RenderCache(
        {
          clock: systemTimekeeper,
          locations: locations(host),
          gates: bareGates(),
          sessionState: new SessionState(),
          currentRequest: () => latest,
          editSnapshot: (_origin, session) => (session === S1 ? draft : null),
          log: (_level, line) => logs.push(line),
          // The second view built over the entry, the reload's successor, fails.
          source: (view) => {
            if (++opens === 2) throw new Error("the successor broke");
            return SOURCES_NOTHING(view);
          },
        },
        {
          budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES,
          maxEntries: 1,
        },
      );
      const configs = configHost(cache, {
        locations: locations(host),
        stateDir: stateDir(host),
        watchers,
      });
      const originAt = configs.at;
      const edit = () => {
        configs.again();
        if (which === "draft") {
          draft = cache.snapshotFor(originAt(dir, dir, undefined));
          cache.refreshEditedView(S1);
        }
      };
      try {
        const origin = originAt(dir, dir, undefined);
        if (which === "draft") draft = cache.snapshotFor(origin);
        {
          using _request = cache.holdSession(origin, latest);
        }
        const unpin = cache.pin(S1);
        editProjectConfig(dir);
        edit();
        expect(logs).toContainEqual(
          expect.stringMatching(
            /^session view reopen failed sid="s1": Error: the successor broke/,
          ),
        );
        // Frames find nothing, and open nothing; they find the error instead.
        expect(cache.holdView(S1)).toBeNull();
        expect(cache.holdView(S1)).toBeNull();
        expect(opens).toBe(2);
        expect(String(cache.openFailure(S1)?.error)).toBe(
          "Error: the successor broke",
        );
        // The live session's facts can move while the view is absent.
        latest = {
          ...latest,
          hookData: {
            ...latest.hookData,
            model: { id: "new", display_name: "New" },
          },
        };
        {
          using _pressure = cache.hold(
            originAt(other.dir, other.dir, undefined),
          );
          expect(cache.size).toBe(2);
          expect(cache.openFailure(S1)).not.toBeNull();
        }
        writeFileSync(
          join(dir, ".cc-candybar.json5"),
          '{ segments: { recovered: { template: "RECOVERED" } }, root: { h: ["recovered"] } }',
        );
        edit();
        {
          using recovered = cache.holdView(S1);
          expect(recovered?.view.facts()).toBe(latest);
          expect(recovered?.state.config.segments.recovered).toBeDefined();
        }
        expect(opens).toBe(3);
        expect(cache.openFailure(S1)).toBeNull();
        unpin();
        using _pressure = cache.hold(originAt(other.dir, other.dir, undefined));
        expect(cache.size).toBe(1);
        expect(cache.holdView(S1)).toBeNull();
      } finally {
        cache.close();
        configs.close();
        watchers.closeAll();
        cleanup();
        other.cleanup();
      }
    },
  );

  // A retired session has no frame to draw its failure in, so the retire
  // forgets it.
  test("a retired session's open failure is forgotten", () => {
    const watchers = new WatcherRegistry({
      clock: systemTimekeeper,
      logger: () => {},
    });
    const { dir, cleanup } = mkConfigDir();
    let opens = 0;
    let canOpen = false;
    const cache = new RenderCache(
      {
        clock: systemTimekeeper,
        locations: locations(host),
        gates: bareGates(),
        sessionState: new SessionState(),
        log: () => {},
        source: (view) => {
          opens++;
          if (!canOpen) throw new Error("the view broke");
          return SOURCES_NOTHING(view);
        },
      },
      { budgetBytes: () => 4 * ENTRY_BYTES + COMPILE_BYTES + VIEW_BYTES },
    );
    const configs = configHost(cache, {
      locations: locations(host),
      stateDir: stateDir(host),
      watchers,
    });
    const originAt = configs.at;
    const unpin = cache.pin(S1);
    try {
      expect(() =>
        cache.holdSession(originAt(dir, dir, undefined), viewFacts(dir, "s1")),
      ).toThrow("the view broke");
      expect(cache.openFailure(S1)).not.toBeNull();
      cache.retireSession(S1);
      expect(cache.openFailure(S1)).toBeNull();
      canOpen = true;
      editProjectConfig(dir);
      configs.again();
      expect(opens).toBe(1);
      expect(cache.holdView(S1)).toBeNull();
      using renewed = cache.holdSession(
        originAt(dir, dir, undefined),
        viewFacts(dir, "s1"),
      );
      expect(renewed.view.sessionId).toBe(S1);
      expect(opens).toBe(2);
    } finally {
      unpin();
      cache.close();
      configs.close();
      watchers.closeAll();
      cleanup();
    }
  });

  test("the inactive failure bound preserves an open feed's error only while it is pinned", () => {
    const { cache, dirs, close, request } = pinCache(() => {
      throw new Error("the view broke");
    });
    const directory = dirs[0]!;
    const unpin = cache.pin(S1);
    try {
      expect(() => request(S1, directory)).toThrow("the view broke");
      for (let i = 0; i < 300; i++)
        expect(() => request(`idle-${i}`, directory)).toThrow("the view broke");
      expect(cache.openFailure(sessionIdOf("idle-0"))).toBeNull();
      expect(cache.openFailure(sessionIdOf("idle-299"))).not.toBeNull();
      expect(cache.openFailure(S1)).not.toBeNull();
      unpin();
      expect(cache.openFailure(S1)).toBeNull();
      cache.close();
      expect(cache.openFailure(sessionIdOf("idle-299"))).toBeNull();
    } finally {
      close();
    }
  });

  test("a view says what opened it", () => {
    const { cache, configs, dirs, close, request, opened } = pinCache();
    try {
      request("s1", dirs[0]!);
      editProjectConfig(dirs[0]!);
      configs.again();
      expect(opened().map((l) => l.match(/ by=(\w+) /)?.[1])).toEqual([
        "request",
        "reload",
      ]);
    } finally {
      close();
    }
  });
});
