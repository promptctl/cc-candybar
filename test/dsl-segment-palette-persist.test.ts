// [LAW:verifiable-goals] Acceptance for candybar-config-engine-71o.6 —
// per-segment palette override as a menu-able domain — mirroring
// dsl-persist-actions.test.ts's model for the Globals-scoped `persist`
// surface it generalizes:
//
//   1. parsePersistTarget classifies a bare persist/reset key STRING as
//      either a Globals field or a `segments.<name>.palette` target — the
//      one shared authority cross-ref.ts, config-overrides-store.ts, and
//      the daemon write path all classify a key through.
//   2. loader/cross-ref.ts rejects a segment-palette key naming an
//      undeclared segment, and rejects a bounded stepper (min/max/by) over
//      one — both at LOAD time, not click time.
//   3. deriveConfigActionValidators derives the SAME allow-list gate for a
//      segment-palette persist action as it does for a Globals one — zero
//      new derivation code, just a differently-shaped key string.
//   4. A click on a compiled persist action targeting `segments.<name>.
//      palette` writes durably to the SAME overrides file Globals fields
//      use, under the literal dotted key.
//   5. RenderCache overlays a segment-palette override onto the segment's
//      OWN `palette` field (never wholesale-replacing the segment, never
//      touching the hand-authored file, never touching sibling segments),
//      and it survives a real restart.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import {
  clearConfigOverride,
  coercePersistValue,
  loadConfigOverrides,
  loadSegmentPaletteOverrides,
  writeConfigOverride,
} from "../src/daemon/config-overrides-store";
import { parsePersistTarget } from "../src/config/loader/persist-target";
import { applySegmentPaletteOverrides } from "../src/config/loader/merge";
import type { DslConfig } from "../src/config/dsl-types";
import { RenderCache } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-seg-palette-"));
  return {
    path: join(dir, "config-overrides.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── parsePersistTarget: the shared key-classification authority ────────────

describe("parsePersistTarget", () => {
  test("classifies a real Globals field", () => {
    expect(parsePersistTarget("palette")).toEqual({
      scope: "globals",
      field: "palette",
    });
  });

  test("classifies segments.<name>.palette", () => {
    expect(parsePersistTarget("segments.directory.palette")).toEqual({
      scope: "segment-palette",
      segment: "directory",
    });
  });

  test("rejects an unrelated string", () => {
    expect(parsePersistTarget("bogus")).toBeNull();
  });

  test("rejects a segment field other than palette", () => {
    expect(parsePersistTarget("segments.directory.bg")).toBeNull();
  });

  test("rejects a nested/malformed segments path", () => {
    expect(parsePersistTarget("segments.a.b.palette")).toBeNull();
    expect(parsePersistTarget("segments..palette")).toBeNull();
    expect(parsePersistTarget("segments.palette")).toBeNull();
  });
});

// ─── loader: cross-ref validation of a segment-palette persist/reset target ─

describe("loader: segment-palette persist/reset target validation", () => {
  const base = (actions: string) =>
    `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { sidebar: { template: 'x', bg: 'surface', fg: 'foreground' } },
      actions: ${actions},
      root: 'sidebar',
    }`;

  test("persist targeting a declared segment's palette passes", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'segments.sidebar.palette', from: 'themes' } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });

  test("reset targeting a declared segment's palette passes", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { reset: 'segments.sidebar.palette' } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });

  test("persist targeting an undeclared segment is a load error naming declared segments", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'segments.ghost.palette', from: 'themes' } }`),
        ALLOWED,
      ),
    ).toThrow(/names segment "ghost" which is not declared \(have segments: sidebar\)/);
  });

  test("reset targeting an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { reset: 'segments.ghost.palette' } }`),
        ALLOWED,
      ),
    ).toThrow(/names segment "ghost" which is not declared/);
  });

  test("a bounded stepper over a segment-palette target is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'segments.sidebar.palette', min: 0, max: 5, by: 1 } }`),
        ALLOWED,
      ),
    ).toThrow(
      /"segments\.sidebar\.palette" is a segment palette target and cannot use a bounded stepper/,
    );
  });

  test("a key that is neither a Globals field nor a segments.<name>.palette shape still gets the original error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'pallete', to: 'nord' } }`),
        ALLOWED,
      ),
    ).toThrow(/"pallete" is not a config globals field \(have: /);
  });
});

// ─── config-validators: the persistent-write gate over a segment key ────────

describe("config-validators: segment-palette persist keys", () => {
  test("deriveConfigActionValidators derives the SAME allow-list shape for a segment-palette key", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: { sidebar: { template: 'x', bg: 'surface', fg: 'foreground' } },
        actions: { applySidebarPalette: { persist: 'segments.sidebar.palette', from: 'themes' } },
        root: 'sidebar',
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    expect(contributions.map((c) => c.key)).toEqual([
      "segments.sidebar.palette",
    ]);
    expect(contributions[0]!.spec.kind).toBe("allow-list");
  });

  test("register→validate round trip over a segment-palette key", () => {
    const dispose = registerConfigValidator("segments.sidebar.palette", {
      kind: "allow-list",
      allowed: ["nord", "gruvbox"],
    });
    try {
      expect(validateConfigWrite("segments.sidebar.palette", "nord")).toEqual(
        { ok: true, value: "nord" },
      );
      expect(validateConfigWrite("segments.sidebar.palette", "bogus").ok).toBe(
        false,
      );
    } finally {
      dispose();
    }
  });
});

// ─── config-overrides-store: segment-palette keys share the flat file ───────

describe("config-overrides-store: segment-palette keys", () => {
  test("write then load round-trips through the segment-scoped view only", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "segments.sidebar.palette", "nord");
    expect(loadSegmentPaletteOverrides(path)).toEqual({ sidebar: "nord" });
    // Invisible to the Globals-scoped view — the two views partition the
    // same flat file by key shape, never double-count an entry.
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });

  test("a globals write and a segment-palette write coexist in one file", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "palette", "dracula");
    writeConfigOverride(path, "segments.sidebar.palette", "nord");
    expect(loadConfigOverrides(path)).toEqual({ palette: "dracula" });
    expect(loadSegmentPaletteOverrides(path)).toEqual({ sidebar: "nord" });
    cleanup();
  });

  test("clear removes exactly one segment-palette key, leaving a globals key intact", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "palette", "dracula");
    writeConfigOverride(path, "segments.sidebar.palette", "nord");
    writeConfigOverride(path, "segments.other.palette", "gruvbox");
    clearConfigOverride(path, "segments.sidebar.palette");
    expect(loadSegmentPaletteOverrides(path)).toEqual({ other: "gruvbox" });
    expect(loadConfigOverrides(path)).toEqual({ palette: "dracula" });
    cleanup();
  });

  test("coercePersistValue passes a segment-palette value through as a bare string", () => {
    expect(coercePersistValue("segments.sidebar.palette", "nord")).toBe(
      "nord",
    );
  });

  // [LAW:no-defensive-null-guards] A segment literally named "__proto__" is
  // an unlikely but legal config author choice — nothing rejects it as a
  // segment name today. loadSegmentPaletteOverrides must not crash (a
  // plain-object accumulator's `out["__proto__"] = value` would hit
  // Object.prototype's __proto__ setter, which throws on a non-object value
  // in strict-mode ESM) and must round-trip the entry like any other name.
  test("a segment named __proto__ round-trips without crashing", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "segments.__proto__.palette", "nord");
    expect(() => loadSegmentPaletteOverrides(path)).not.toThrow();
    const result = loadSegmentPaletteOverrides(path);
    // `{ __proto__: "nord" }` as an object LITERAL is the special
    // prototype-setting form (silently dropped, since "nord" isn't an
    // object) — Object.fromEntries creates a genuine OWN data property
    // instead, the correct comparison target for what a real round-trip
    // must produce.
    expect(result).toEqual(Object.fromEntries([["__proto__", "nord"]]));
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
      true,
    );
    // The two views partition the SAME file by key shape (see the
    // coexistence test above) — confirm that boundary holds at the
    // __proto__ edge too, not just for ordinary keys: a bug in
    // isValidOverrides/parsePersistTarget that let this key leak into the
    // Globals-scoped projection would go undetected otherwise.
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });
});

// ─── applySegmentPaletteOverrides: the merge overlay ─────────────────────────

describe("applySegmentPaletteOverrides", () => {
  const baseConfig = (): DslConfig => ({
    globals: { palette: "tokyo-night" },
    variables: {},
    segments: {
      sidebar: {
        template: "sidebar-text",
        bg: "surface",
        fg: "foreground",
        when: "{{ true }}",
      },
      other: { template: "other-text", bg: "panel", fg: "foreground" },
    },
    root: { kind: "container", direction: "vertical", children: [] },
    actions: {},
    looks: {},
    helpers: {},
  });

  test("patches only the palette field, preserving every other field", () => {
    const out = applySegmentPaletteOverrides(baseConfig(), {
      sidebar: "nord",
    });
    expect(out.segments.sidebar).toEqual({
      template: "sidebar-text",
      bg: "surface",
      fg: "foreground",
      when: "{{ true }}",
      palette: "nord",
    });
  });

  test("leaves every other segment untouched", () => {
    const before = baseConfig();
    const out = applySegmentPaletteOverrides(before, { sidebar: "nord" });
    expect(out.segments.other).toBe(before.segments.other);
  });

  test("an override naming a segment the config no longer declares is a no-op", () => {
    const before = baseConfig();
    const out = applySegmentPaletteOverrides(before, { ghost: "nord" });
    expect(out.segments).toEqual(before.segments);
  });

  test("an empty overrides map returns the SAME config object (no needless copy)", () => {
    const before = baseConfig();
    expect(applySegmentPaletteOverrides(before, {})).toBe(before);
  });

  // [LAW:no-defensive-null-guards] The "stale override, segment since
  // removed" no-op path (the test above) is exactly where a segment named
  // `__proto__` is dangerous: `segments["__proto__"]` on a plain object with
  // no OWN "__proto__" property reads the inherited accessor (not
  // `undefined`), so a naive no-op guard wouldn't fire, and the following
  // write would reach the setter. Must stay a genuine no-op, and the actual
  // prototype chain must come out unharmed either way.
  test("a stale override naming a since-removed segment called __proto__ is a no-op, not a prototype write", () => {
    const before = baseConfig();
    const overrides = Object.fromEntries([["__proto__", "nord"]]) as Record<
      string,
      string
    >;
    expect(() =>
      applySegmentPaletteOverrides(before, overrides),
    ).not.toThrow();
    const out = applySegmentPaletteOverrides(before, overrides);
    expect(out.segments).toEqual(before.segments);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

// ─── end-to-end: click → durable write, through the real daemon handlers ────

function buildPersistRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width = Number.POSITIVE_INFINITY): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(width),
    );
  const disposers = deriveConfigActionValidators(config).map(({ key, spec }) =>
    registerConfigValidator(key, spec),
  );
  const ctx: VerbContext = { sessionState, dlog: () => {} };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, render, click, dispose };
}

describe("segment-palette persist action click → durable overrides write", () => {
  let savedXdgState: string | undefined;
  let xdgStateDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-seg-persist-state-"));
    process.env.XDG_STATE_HOME = xdgStateDir;
  });
  afterEach(() => {
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    rmSync(xdgStateDir, { recursive: true, force: true });
  });

  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
    },
    actions: {
      applySidebarPalette: { persist: 'segments.sidebar.palette', from: 'themes' },
      undoSidebarPalette: { reset: 'segments.sidebar.palette' },
    },
    segments: {
      sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground' },
      bar: { template: '{{ action "applySidebarPalette" "nord" }} {{ action "undoSidebarPalette" "↺" }}', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['sidebar', 'bar'] },
  }`;

  test("clicking writes segments.sidebar.palette to the overrides file, not the whole-bar palette", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const out = render();
    const urls = extractUrls(out);
    const applyUrl = urls[0]!;
    click(applyUrl);
    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    expect(loadSegmentPaletteOverrides(overridesPath)).toEqual({
      sidebar: "nord",
    });
    expect(loadConfigOverrides(overridesPath)).toEqual({});
    dispose();
  });

  test("clicking reset clears the previously-persisted segment override", () => {
    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "segments.sidebar.palette", "nord");
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const resetUrl = extractUrls(render())[1]!;
    click(resetUrl);
    expect(loadSegmentPaletteOverrides(overridesPath)).toEqual({});
    dispose();
  });
});

// ─── RenderCache integration: merge, byte-identity, restart, isolation ──────

function makeCache(): {
  cache: RenderCache;
  cleanups: Array<() => void>;
} {
  const cleanups: Array<() => void> = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0, watchersEvicted: 0 },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const gitService = new GitDataProvider({
    sanityIntervalMs: 0,
    logger: () => {},
  });
  cleanups.push(() => gitService.close());
  const sessionState = new SessionState();
  const cache = new RenderCache({ gitService, sessionState, watchers });
  return { cache, cleanups };
}

describe("RenderCache: segment-palette overrides merge into the effective config", () => {
  let savedXdgState: string | undefined;
  let savedXdgConfig: string | undefined;
  let savedCcConfig: string | undefined;
  let xdgStateDir: string;
  let xdgConfigDir: string;
  let projectDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    savedXdgConfig = process.env.XDG_CONFIG_HOME;
    savedCcConfig = process.env.CC_CANDYBAR_CONFIG;
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-seg-rc-state-"));
    xdgConfigDir = mkdtempSync(join(tmpdir(), "cc-candybar-seg-rc-xdgcfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "cc-candybar-seg-rc-project-"));
    process.env.XDG_STATE_HOME = xdgStateDir;
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
    delete process.env.CC_CANDYBAR_CONFIG;
  });
  afterEach(() => {
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfig;
    if (savedCcConfig === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCcConfig;
    rmSync(xdgStateDir, { recursive: true, force: true });
    rmSync(xdgConfigDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("an override changes segments.sidebar.palette without touching the user config file or sibling segments", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    const userConfigBody = JSON.stringify({
      globals: { palette: "textual-dark" },
      segments: {
        sidebar: { template: "sidebar-text", bg: "surface", fg: "foreground" },
        other: { template: "other-text", bg: "panel", fg: "foreground" },
      },
      root: { h: ["sidebar", "other"] },
    });
    writeFileSync(userConfigPath, userConfigBody);

    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "segments.sidebar.palette", "nord");

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.state!.config.segments.sidebar!.palette).toBe("nord");
      // Every other field of the overridden segment survives — the overlay
      // patches ONE field, it does not wholesale-replace the segment.
      expect(entry.state!.config.segments.sidebar!.template).toBe(
        "sidebar-text",
      );
      expect(entry.state!.config.segments.sidebar!.bg).toBe("surface");
      // The sibling segment is completely unaffected.
      expect(entry.state!.config.segments.other!.palette).toBeUndefined();
      expect(entry.state!.config.segments.other!.template).toBe(
        "other-text",
      );
      // The hand-authored file is byte-identical — the daemon never wrote to it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a segment-palette override survives a real restart", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        globals: {},
        segments: {
          sidebar: {
            template: "sidebar-text",
            bg: "surface",
            fg: "foreground",
          },
        },
        root: "sidebar",
      }),
    );

    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "segments.sidebar.palette", "gruvbox");

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.state!.config.segments.sidebar!.palette).toBe("gruvbox");
    } finally {
      for (const fn of cleanups) fn();
    }

    // Restart: a fresh cache/services pair, reading only the overrides file
    // on disk — no in-memory state carries over.
    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.state!.config.segments.sidebar!.palette).toBe("gruvbox");
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  test("a segment-palette override for a segment the config no longer declares is a harmless no-op", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    const userConfigBody = JSON.stringify({
      globals: {},
      segments: {
        sidebar: {
          template: "sidebar-text",
          bg: "surface",
          fg: "foreground",
        },
      },
      root: "sidebar",
    });
    writeFileSync(userConfigPath, userConfigBody);

    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    // Names a segment that does not exist in this config at all.
    writeConfigOverride(overridesPath, "segments.ghost.palette", "nord");

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      expect(entry.state!.config.segments.sidebar!.palette).toBeUndefined();
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
