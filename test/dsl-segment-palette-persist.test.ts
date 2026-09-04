// [LAW:verifiable-goals] Acceptance for candybar-config-engine-71o.6 —
// per-segment palette override as a menu-able domain — mirroring
// dsl-persist-actions.test.ts's model for the Globals-scoped `persist`
// surface it generalizes, over the config-FILE store (candybar-config-dqe):
//
//   1. parsePersistTarget classifies a bare persist/reset key STRING as
//      either a Globals field or a `segments.<name>.palette` target — the
//      one shared authority cross-ref.ts, config-file-store.ts, and the
//      daemon write path all classify a key through. A target IS a path
//      into the config file (persistPath).
//   2. loader/cross-ref.ts rejects a segment-palette key naming an
//      undeclared segment, and rejects a bounded stepper (min/max/by) over
//      one — both at LOAD time, not click time.
//   3. deriveConfigActionValidators derives the SAME allow-list gate for a
//      segment-palette persist action as it does for a Globals one — zero
//      new derivation code, just a differently-shaped key string.
//   4. A click on a compiled persist action targeting `segments.<name>.
//      palette` writes `palette` INTO THE CONFIG FILE'S declaration of that
//      segment — the same file a Globals `persist` edits, at the path the
//      key spells. A segment the file already declares changes in exactly
//      one span: every other field, and every byte outside it (comments,
//      quote style), survives verbatim. A segment the file does NOT declare
//      but the bundled default does is materialized wholesale first
//      (`segments` merge by name), then pinned. `reset` deletes `palette`
//      from the file's declaration; a `palette` the file never authored
//      changes nothing and records no history.
//   5. RenderCache reads the pin back from the file through the SAME watcher
//      a hand edit uses, patching the segment's OWN `palette` field (never
//      wholesale-replacing it, never touching sibling segments); it survives
//      a restart because the file IS the store; and a segment neither the
//      file nor the bundled default declares cannot be pinned at all — the
//      store refuses loudly rather than authoring a hollow declaration.

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { existsSync } from "node:fs";
import { getThemePalette } from "@promptctl/rich-js";
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
import { writeValue, type EditStore } from "../src/daemon/config-file-store";
import {
  parsePersistTarget,
  persistPath,
} from "../src/config/loader/persist-target";
import {
  DEFAULT_DSL_CONFIG,
  RAW_DEFAULT_DSL_CONFIG,
} from "../src/config/default-dsl-config";
import type { DslConfig } from "../src/config/dsl-types";
import { RenderCache } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { ReloadSignal } from "./helpers/reload-signal";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";

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
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

type SegmentDecls = Record<string, Record<string, unknown>>;

// The file's `segments` block, as JSON5 parses it — what a reload will see.
function fileSegments(durable: DurableConfig): SegmentDecls {
  return durable.parsed().segments as SegmentDecls;
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

  test("a segment-palette target IS the config-file path the key spells", () => {
    expect(
      persistPath({ scope: "segment-palette", segment: "directory" }),
    ).toEqual(["segments", "directory", "palette"]);
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
    ).toThrow(
      /names segment "ghost" which is not declared \(have segments: sidebar\)/,
    );
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
        base(
          `{ a: { persist: 'segments.sidebar.palette', min: 0, max: 5, by: 1 } }`,
        ),
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
    const contributions = ownValidators(
      config,
      deriveConfigActionValidators(config),
    );
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
      expect(validateConfigWrite("segments.sidebar.palette", "nord")).toEqual({
        ok: true,
        value: "nord",
      });
      expect(validateConfigWrite("segments.sidebar.palette", "bogus").ok).toBe(
        false,
      );
    } finally {
      dispose();
    }
  });
});

// ─── end-to-end: click → the config file, through the real daemon handlers ──

let durable: DurableConfig;

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND
// writes the same text as the session's config file, so the tree a click
// edits is the tree the bar rendered — exactly the daemon's own situation.
// `dflt` is what the file merges over: the empty default by default, the
// bundled DEFAULT_DSL_CONFIG when a test's subject is a segment the FILE does
// not author but the bar still renders (the production cascade).
function buildRuntime(src: string, sessionId = "s1", dflt?: DslConfig) {
  if (durable.text() === null) durable.write(src);
  const config = parseAndValidate("<test>", src, ALLOWED, dflt);
  const sessionState = new SessionState();
  durable.seedOrigin(sessionState, sessionId);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
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

describe("segment-palette persist action click → the config file", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-seg-persist-");
  });
  afterEach(() => {
    durable.dispose();
  });

  // The sidebar's declaration carries a `when` and sits under a comment, so
  // the assertions can tell "one field spliced in" from "decl rewritten".
  const SIDEBAR_DECL =
    "sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground', when: '{{ true }}' }";
  const SIDEBAR_COMMENT =
    "// the sidebar's own declaration — a pin lands INSIDE it";
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
    },
    actions: {
      applySidebarPalette: { persist: 'segments.sidebar.palette', from: 'themes' },
      forgetSidebarPalette: { reset: 'segments.sidebar.palette' },
    },
    segments: {
      ${SIDEBAR_COMMENT}
      ${SIDEBAR_DECL},
      bar: { template: '{{ action "applySidebarPalette" "nord" }} {{ action "forgetSidebarPalette" "↺" }}', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['sidebar', 'bar'] },
  }`;

  test("clicking writes palette INTO the file's sidebar declaration, not the whole-bar palette", () => {
    const { render, click, dispose } = buildRuntime(SRC);
    const original = durable.text()!;
    const barBefore = fileSegments(durable).bar;
    const applyUrl = extractUrls(render())[0]!;
    click(applyUrl);

    expect(fileSegments(durable).sidebar).toEqual({
      template: "sidebar-text",
      bg: "surface",
      fg: "foreground",
      when: "{{ true }}",
      palette: "nord",
    });
    // Not a whole-bar pin: globals is still empty.
    expect(durable.parsed().globals).toEqual({});
    // The sibling segment is untouched.
    expect(fileSegments(durable).bar).toEqual(barBefore);
    // Exactly one span changed: the authored decl's text (its single quotes,
    // its `when`) and the comment above it are still there verbatim — the
    // pin was appended inside the decl, not rewritten around it.
    const written = durable.text()!;
    expect(written).toContain(SIDEBAR_COMMENT);
    expect(written).toContain(SIDEBAR_DECL.slice(0, -2)); // up to the closing ` }`
    expect(durable.history().past).toEqual([
      { before: original, after: written },
    ]);
    dispose();
  });

  test("clicking reset deletes palette from the file's sidebar declaration, leaving its other fields", () => {
    const { render, click, dispose } = buildRuntime(SRC);
    const [applyUrl, resetUrl] = extractUrls(render());
    click(applyUrl!);
    expect(fileSegments(durable).sidebar!.palette).toBe("nord");

    click(resetUrl!);
    expect(fileSegments(durable).sidebar).toEqual({
      template: "sidebar-text",
      bg: "surface",
      fg: "foreground",
      when: "{{ true }}",
    });
    expect(durable.text()).toContain(SIDEBAR_COMMENT);
    // The delete is its own history entry — one history over every shape.
    expect(durable.history().past).toHaveLength(2);
    dispose();
  });

  test("reset over a palette the file never authored changes nothing and records nothing", () => {
    const { render, click, dispose } = buildRuntime(SRC);
    const original = durable.text()!;
    const resetUrl = extractUrls(render())[1]!;
    click(resetUrl);
    expect(durable.text()).toBe(original);
    expect(existsSync(durable.historyPath)).toBe(false);
    dispose();
  });

  // [LAW:one-source-of-truth] `segments` merge BY NAME, WHOLESALE, so a
  // one-field `directory: { palette }` in the file would shadow the bundled
  // decl and lose its template. The first pin on a bundled segment therefore
  // copies the whole bundled declaration into the file, then sets palette.
  test("pinning a segment the file does not declare materializes the bundled decl first, then sets palette", () => {
    const SRC_BUNDLED = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
      },
      actions: {
        applyDirectoryPalette: { persist: 'segments.directory.palette', from: 'themes' },
        forgetDirectoryPalette: { reset: 'segments.directory.palette' },
      },
      segments: {
        bar: { template: '{{ action "applyDirectoryPalette" "nord" }} {{ action "forgetDirectoryPalette" "↺" }}', bg: 'surface', fg: 'foreground' },
      },
      root: { h: ['directory', 'bar'] },
    }`;
    const bundled = RAW_DEFAULT_DSL_CONFIG.segments.directory;
    const { render, click, dispose } = buildRuntime(
      SRC_BUNDLED,
      "s1",
      DEFAULT_DSL_CONFIG,
    );
    expect(fileSegments(durable).directory).toBeUndefined();

    const [applyUrl, resetUrl] = extractUrls(render());
    click(applyUrl!);
    expect(fileSegments(durable).directory).toEqual({
      ...bundled,
      palette: "nord",
    });
    expect(fileSegments(durable).directory!.template).toBe(bundled.template);

    // Reset deletes ONLY palette: the materialized decl stays authored,
    // exactly as if the user had written it by hand.
    click(resetUrl!);
    expect(fileSegments(durable).directory).toEqual(bundled);
    dispose();
  });
});

// ─── config-file-store: what a segment-palette pin may target ───────────────

describe("config-file-store: segment-palette placement", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-seg-store-");
  });
  afterEach(() => {
    durable.dispose();
  });

  const store = (): EditStore => ({
    historyPath: durable.historyPath,
    logger: () => {},
  });

  // [LAW:no-silent-failure] The gate admits keys from the config a session
  // rendered; a key naming a segment that neither this file nor the bundled
  // default declares cannot be materialized, and a hollow `ghost: { palette }`
  // would be a declaration with no template. The store refuses loudly and
  // touches nothing.
  test("a segment neither the file nor the bundled default declares cannot be pinned", () => {
    const text = `{
      globals: {},
      segments: { sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground' } },
      root: 'sidebar',
    }`;
    durable.write(text);
    expect(() =>
      writeValue(store(), durable.configPath, "segments.ghost.palette", "nord"),
    ).toThrow(
      /cannot persist segments\.ghost\.palette: neither the config file nor the bundled default declares segments\.ghost/,
    );
    expect(durable.text()).toBe(text);
    expect(existsSync(durable.historyPath)).toBe(false);
  });
});

// ─── RenderCache integration: reload, restart, isolation ────────────────────

function makeCache(): {
  cache: RenderCache;
  cleanups: Array<() => void>;
  reloads: ReloadSignal;
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
  const reloads = new ReloadSignal();
  const cache = new RenderCache(
    { gitService, sessionState, watchers },
    { observers: reloads.observers },
  );
  return { cache, cleanups, reloads };
}

describe("RenderCache: a segment-palette pin in the config file is the effective config", () => {
  beforeEach(() => {
    durable = durableConfig("cc-candybar-seg-rc-");
  });
  afterEach(() => {
    durable.dispose();
  });

  const store = (): EditStore => ({
    historyPath: durable.historyPath,
    logger: () => {},
  });

  const OTHER_DECL =
    "other: { template: 'other-text', bg: 'panel', fg: 'foreground' }";
  const TWO_SEGMENTS = `{
    globals: { palette: 'textual-dark' },
    segments: {
      sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground' },
      // untouched by a pin on its sibling
      ${OTHER_DECL},
    },
    root: { h: ['sidebar', 'other'] },
  }`;

  test("a pin written by the store reloads through the SAME watcher a hand edit does, patching one field of one segment", async () => {
    durable.write(TWO_SEGMENTS);
    const { cache, cleanups, reloads } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(entry.state!.config.segments.sidebar!.palette).toBeUndefined();

      await reloads.after(entry, () =>
        writeValue(
          store(),
          durable.configPath,
          "segments.sidebar.palette",
          "nord",
        ),
      );

      expect(entry.lastError).toBeNull();
      expect(entry.state!.config.segments.sidebar!.palette).toBe("nord");
      // Every other field of the pinned segment survives — the write
      // splices ONE field, it does not wholesale-replace the segment.
      expect(entry.state!.config.segments.sidebar!.template).toBe(
        "sidebar-text",
      );
      expect(entry.state!.config.segments.sidebar!.bg).toBe("surface");
      // The sibling segment is completely unaffected — in the effective
      // config AND in the file's own text.
      expect(entry.state!.config.segments.other!.palette).toBeUndefined();
      expect(entry.state!.config.segments.other!.template).toBe("other-text");
      expect(durable.text()).toContain(OTHER_DECL);
      expect(durable.text()).toContain("// untouched by a pin on its sibling");
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a segment-palette pin survives a real restart — the file IS the store", () => {
    durable.write(`{
      globals: {},
      segments: { sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground' } },
      root: 'sidebar',
    }`);
    writeValue(
      store(),
      durable.configPath,
      "segments.sidebar.palette",
      "gruvbox",
    );

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.state!.config.segments.sidebar!.palette).toBe("gruvbox");
    } finally {
      for (const fn of cleanups) fn();
    }

    // Restart: a fresh cache/services pair, reading only the config file on
    // disk — no in-memory state carries over.
    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.state!.config.segments.sidebar!.palette).toBe("gruvbox");
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  test("a pin on a bundled segment the file never declared renders that segment with the bundled template AND the pin", () => {
    durable.write(`{
      globals: {},
      segments: { sidebar: { template: 'sidebar-text', bg: 'surface', fg: 'foreground' } },
      root: { h: ['directory', 'sidebar'] },
    }`);
    writeValue(
      store(),
      durable.configPath,
      "segments.directory.palette",
      "nord",
    );

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      const directory = entry.state!.config.segments.directory!;
      expect(directory.palette).toBe("nord");
      expect(directory.template).toBe(
        RAW_DEFAULT_DSL_CONFIG.segments.directory.template,
      );
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
