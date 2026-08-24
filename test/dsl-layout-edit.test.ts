// [LAW:verifiable-goals] brandon-layout-edit-2gc.1 done-gates, driven through
// the real spine (mirroring dsl-persist-actions.test.ts's model one arm
// over):
//
//   1. The loader proves the `removeSegment`/`insertSegment` ActionDecl
//      shapes: persist-only, literal at author time, rejects `:`/`/` in any
//      name, rejects a bad `relation`.
//   2. Cross-ref catches an undeclared preset name, an undeclared segment
//      name, and the wrong ARM paired with a "presets.<name>.rootOps" target
//      (to/from/cycle/bounded have no meaning as a tree op) — all load-time,
//      never a click-time surprise.
//   3. deriveConfigActionValidators derives a ONE-MEMBER allow-list per
//      declared layout action (the op token IS the gate) — a click carrying
//      any other token is a loud rejection, never silently applied
//      (satisfies the ticket's "a template CANNOT write a layout position
//      the declarations do not name").
//   4. A click on a compiled layout-op action fires VERB_APPLY_LAYOUT_OP
//      through the REAL daemon handler, which validates then APPENDS to the
//      accumulated op-token list at "presets.<name>.rootOps" — never
//      overwrites it (the read-modify-write shape a scalar persist write
//      does not need).
//   5. RenderCache replays the accumulated ops on top of the resolved
//      preset root on every reload (bundled default < user file < overrides
//      < ACTIVE PRESET, unchanged) — the SAME watcher-driven reload path a
//      hand edit to the config file already takes, survives a real restart,
//      and never touches the hand-authored config file.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import { writeConfigOverride } from "../src/daemon/config-overrides-store";
import { RenderCache } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { encodeLayoutOp } from "../src/config/layout-ops";
import type { LayoutNode } from "../src/config/dsl-types";

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

// ─── loader: the removeSegment/insertSegment ActionDecl arms ─────────────────

describe("removeSegment/insertSegment loader shape", () => {
  const base = (actions: string, presets = "{}") => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['directory', 'git'] },
    presets: ${presets},
  }`;

  test("removeSegment parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ rm: { persist: 'presets.default.rootOps', removeSegment: 'directory' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.rm).toEqual({
      persist: "presets.default.rootOps",
      removeSegment: "directory",
    });
  });

  test("insertSegment + anchor + relation parses", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ ins: { persist: 'presets.default.rootOps', insertSegment: 'directory', anchor: 'git', relation: 'before' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.ins).toEqual({
      persist: "presets.default.rootOps",
      insertSegment: "directory",
      anchor: "git",
      relation: "before",
    });
  });

  test("insertSegment without anchor is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.rootOps', insertSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("relation must be before/after, not an arbitrary string", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.rootOps', insertSegment: 'directory', anchor: 'git', relation: 'sideways' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a name containing ':' is rejected — layout-ops.ts's own token delimiter", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.default.rootOps', removeSegment: 'a:b' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a name containing '/' is rejected — the click wire's own delimiter", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.default.rootOps', removeSegment: 'a/b' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("removeSegment has no `set` counterpart — persist only", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { set: 'presets.default.rootOps', removeSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });
});

describe("cross-ref: presets.<name>.rootOps target", () => {
  const base = (actions: string) => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['directory', 'git'] },
    presets: { compact: {} },
  }`;

  test("an undeclared preset name is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.bogus.rootOps', removeSegment: 'directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/names preset "bogus" which is not declared/);
  });

  test("removeSegment naming an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ rm: { persist: 'presets.compact.rootOps', removeSegment: 'nope' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/removeSegment "nope" is not a declared segment/);
  });

  test("insertSegment's anchor naming an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.compact.rootOps', insertSegment: 'directory', anchor: 'nope', relation: 'after' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/anchor "nope" is not a declared segment/);
  });

  test("a 'to' literal targeting a rootOps key is a load error — only removeSegment/insertSegment apply", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ bad: { persist: 'presets.compact.rootOps', to: 'remove:directory' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(
      /can only be paired with "removeSegment", "insertSegment", or "insertSegmentFrom"/,
    );
  });

  test("a 'reset' over a rootOps key is legal — the whole-log undo needs no arm check", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ undo: { reset: 'presets.compact.rootOps' } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });
});

// ─── config-validators: the derived gate is a one-member allow-list ──────────

describe("deriveConfigActionValidators over layout-op actions", () => {
  test("derives a one-member allow-list keyed by the op's own encoded token", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { rm: { persist: 'presets.default.rootOps', removeSegment: 'directory' } },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          git: { template: 'g', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory', 'git'] },
        presets: {},
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    expect(contributions).toEqual([
      {
        key: "presets.default.rootOps",
        spec: {
          kind: "allow-list",
          allowed: [encodeLayoutOp({ op: "remove", target: "directory" })],
        },
      },
    ]);
  });

  test("two layout actions on the same preset union into a two-member allow-list", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: {
          rm: { persist: 'presets.default.rootOps', removeSegment: 'directory' },
          ins: { persist: 'presets.default.rootOps', insertSegment: 'git', anchor: 'directory', relation: 'after' },
        },
        segments: {
          directory: { template: 'd', bg: 'surface', fg: 'foreground' },
          git: { template: 'g', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['directory'] },
        presets: {},
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    expect(contributions).toHaveLength(1);
    const spec = contributions[0]!.spec;
    if (spec.kind !== "allow-list") throw new Error("expected allow-list");
    expect(new Set(spec.allowed)).toEqual(
      new Set([
        encodeLayoutOp({ op: "remove", target: "directory" }),
        encodeLayoutOp({
          op: "insert",
          segment: "git",
          anchor: "directory",
          relation: "after",
        }),
      ]),
    );
  });

  test("a token no action declares is rejected by the derived gate", () => {
    const dispose = registerConfigValidator("presets.default.rootOps", {
      kind: "allow-list",
      allowed: [encodeLayoutOp({ op: "remove", target: "directory" })],
    });
    try {
      const result = validateConfigWrite(
        "presets.default.rootOps",
        encodeLayoutOp({ op: "remove", target: "git" }),
      );
      expect(result.ok).toBe(false);
    } finally {
      dispose();
    }
  });
});

// ─── end-to-end: click → durable APPEND, through the real daemon handler ─────

function buildLayoutRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(),
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

describe("apply-layout-op click → durable append", () => {
  let savedXdgState: string | undefined;
  let xdgStateDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-layout-state-"));
    process.env.XDG_STATE_HOME = xdgStateDir;
  });
  afterEach(() => {
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    rmSync(xdgStateDir, { recursive: true, force: true });
  });

  const SRC = `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: {
      removeDirectory: { persist: 'presets.default.rootOps', removeSegment: 'directory' },
      insertGitPrAfterGit: { persist: 'presets.default.rootOps', insertSegment: 'gitPr', anchor: 'git', relation: 'after' },
    },
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
      gitPr: { template: 'p', bg: 'surface', fg: 'foreground' },
      bar: { template: '{{ action "removeDirectory" "-" }} {{ action "insertGitPrAfterGit" "+" }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: [ { h: ['directory', 'git'] }, 'bar' ] },
    presets: {},
  }`;

  function overridesPath(): string {
    return join(xdgStateDir, "cc-candybar", "config-overrides.json");
  }

  test("a click fires apply-layout-op and appends one token", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    expect(effectsOf(urls[0]!)[0]!.verb).toBe("apply-layout-op");
    click(urls[0]!);
    const raw = JSON.parse(readFileSync(overridesPath(), "utf8")) as Record<
      string,
      string
    >;
    expect(JSON.parse(raw["presets.default.rootOps"]!)).toEqual([
      encodeLayoutOp({ op: "remove", target: "directory" }),
    ]);
    dispose();
  });

  test("two clicks APPEND — the second does not clobber the first", () => {
    const { render, click, dispose } = buildLayoutRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!); // remove directory
    click(urls[1]!); // insert gitPr after git
    const raw = JSON.parse(readFileSync(overridesPath(), "utf8")) as Record<
      string,
      string
    >;
    expect(JSON.parse(raw["presets.default.rootOps"]!)).toEqual([
      encodeLayoutOp({ op: "remove", target: "directory" }),
      encodeLayoutOp({
        op: "insert",
        segment: "gitPr",
        anchor: "git",
        relation: "after",
      }),
    ]);
    dispose();
  });

  test("a hand-crafted click carrying an undeclared op token is rejected loudly", () => {
    const { dispose } = buildLayoutRuntime(SRC);
    const sessionState = new SessionState();
    const ctx: VerbContext = { sessionState, dlog: () => {} };
    const applyLayoutOp = VERBS.get("apply-layout-op")!;
    expect(() =>
      applyLayoutOp(
        `${encodeURIComponent("s1")}/${encodeURIComponent("presets.default.rootOps")}/${encodeURIComponent(
          encodeLayoutOp({ op: "remove", target: "git" }),
        )}`,
        ctx,
      ),
    ).toThrow();
    dispose();
  });
});

// ─── RenderCache integration: replay + reload + restart + byte-identity ──────

function makeCache(): { cache: RenderCache; cleanups: Array<() => void> } {
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

function segmentNamesOf(root: LayoutNode): string[] {
  const out: string[] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind === "segment") out.push(node.name);
    else for (const c of node.children) walk(c);
  };
  walk(root);
  return out;
}

describe("RenderCache: layout ops replay onto the resolved preset root", () => {
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
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-layout-rc-state-"));
    xdgConfigDir = mkdtempSync(join(tmpdir(), "cc-candybar-layout-rc-xdgcfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "cc-candybar-layout-rc-project-"));
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

  function overridesPath(): string {
    return join(xdgStateDir, "cc-candybar", "config-overrides.json");
  }

  const userConfigBody = JSON.stringify({
    globals: {},
    segments: {
      directory: { template: "d", bg: "surface", fg: "foreground" },
      git: { template: "g", bg: "surface", fg: "foreground" },
      gitPr: { template: "p", bg: "surface", fg: "foreground" },
    },
    root: { h: ["directory", "git"] },
    presets: {},
  });

  test("an accumulated op list removes a segment from the DEFAULT preset's root, and the user file stays byte-identical", () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(userConfigPath, userConfigBody);
    writeConfigOverride(
      overridesPath(),
      "presets.default.rootOps",
      JSON.stringify([encodeLayoutOp({ op: "remove", target: "directory" })]),
    );

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      const root = entry.state!.config.presets.default!.root!;
      expect(segmentNamesOf(root)).toEqual(["git"]);
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("a remove and an insert compose, in order, onto the same preset", () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(userConfigPath, userConfigBody);
    writeConfigOverride(
      overridesPath(),
      "presets.default.rootOps",
      JSON.stringify([
        encodeLayoutOp({ op: "remove", target: "directory" }),
        encodeLayoutOp({
          op: "insert",
          segment: "gitPr",
          anchor: "git",
          relation: "after",
        }),
      ]),
    );

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      const root = entry.state!.config.presets.default!.root!;
      expect(segmentNamesOf(root)).toEqual(["git", "gitPr"]);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:verifiable-goals] "The change survives a daemon restart" — a fresh
  // RenderCache/GitDataProvider/WatcherRegistry (exactly what a real restart
  // rebuilds), reading nothing but the overrides file on disk.
  test("the edit survives a restart", () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(userConfigPath, userConfigBody);
    writeConfigOverride(
      overridesPath(),
      "presets.default.rootOps",
      JSON.stringify([encodeLayoutOp({ op: "remove", target: "directory" })]),
    );

    const { cache, cleanups } = makeCache();
    try {
      cache.getOrCreate(projectDir, projectDir, undefined);
    } finally {
      for (const fn of cleanups) fn();
    }

    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(projectDir, projectDir, undefined);
      const root = entry.state!.config.presets.default!.root!;
      expect(segmentNamesOf(root)).toEqual(["git"]);
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  test("a stale op (target already removed by an earlier op) is a no-op, not a fatal reload error", () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(userConfigPath, userConfigBody);
    writeConfigOverride(
      overridesPath(),
      "presets.default.rootOps",
      JSON.stringify([
        encodeLayoutOp({ op: "remove", target: "directory" }),
        // "directory" is already gone — a stale op, not a crash.
        encodeLayoutOp({ op: "remove", target: "directory" }),
      ]),
    );

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      const root = entry.state!.config.presets.default!.root!;
      expect(segmentNamesOf(root)).toEqual(["git"]);
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
