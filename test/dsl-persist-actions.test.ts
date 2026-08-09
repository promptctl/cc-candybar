// [LAW:verifiable-goals] Acceptance for candybar-config-engine-71o.2 —
// persistent config writes — driven through the real spine, mirroring
// dsl-actions.test.ts's model for `set`:
//
//   1. The loader proves the `persist`/`reset` ActionDecl shapes: persist
//      mirrors set's to/from/min-max-by/cycle value sources (no `int` — a
//      page cursor is never persisted); reset is a single slash-free key.
//   2. deriveConfigActionValidators derives the persistent-write gate from
//      the SAME action table the `{{ action }}` fn realizes a click from —
//      the config-overrides keyspace, kept separate from SessionState's.
//   3. A click on a compiled persist-* action fires VERB_SET_CONFIG/
//      VERB_STEP_CONFIG through the REAL daemon leaf handlers, which
//      validate-then-write durably to the daemon-owned overrides file —
//      never the hand-authored config file (byte-identical assertion).
//   4. RenderCache merges the overrides layer on top of the user file every
//      reload (bundled default < user file < overrides precedence), riding
//      the SAME file-watcher path a hand edit to the config file already
//      takes — no bespoke apply path.
//   5. reset-config is gated by key membership and clears one override,
//      restoring the pre-override value on the next reload.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import {
  effectiveThemeName,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  listConfigKeys,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import {
  clearConfigOverride,
  coerceGlobalsValue,
  isGlobalsField,
  loadConfigOverrides,
  writeConfigOverride,
} from "../src/daemon/config-overrides-store";
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

// Every OSC-8 link URL in render order, active or not — unlike boldUrls,
// which only reports the CURRENTLY-SELECTED region, a persist-option/reset
// link is not always "active" (bold), so tests asserting on the click itself
// (not the current-selection marking) need every link.
function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-config-overrides-"));
  return {
    path: join(dir, "config-overrides.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── config-overrides-store: the daemon-owned overrides file ─────────────────

describe("config-overrides-store", () => {
  test("missing file loads as empty overrides", () => {
    const { path, cleanup } = tmpFile();
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });

  test("write then load round-trips a string field", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "palette", "nord");
    expect(loadConfigOverrides(path)).toEqual({ palette: "nord" });
    cleanup();
  });

  test("write then load round-trips a numeric field as a real number", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "padding", 3);
    const overrides = loadConfigOverrides(path);
    expect(overrides.padding).toBe(3);
    expect(typeof overrides.padding).toBe("number");
    cleanup();
  });

  test("multiple writes accumulate (read-modify-write)", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "palette", "nord");
    writeConfigOverride(path, "look", "vivid");
    expect(loadConfigOverrides(path)).toEqual({
      palette: "nord",
      look: "vivid",
    });
    cleanup();
  });

  test("clear removes exactly one key, leaving the rest", () => {
    const { path, cleanup } = tmpFile();
    writeConfigOverride(path, "palette", "nord");
    writeConfigOverride(path, "look", "vivid");
    clearConfigOverride(path, "palette");
    expect(loadConfigOverrides(path)).toEqual({ look: "vivid" });
    cleanup();
  });

  test("clear on an absent key is a no-op, not an error", () => {
    const { path, cleanup } = tmpFile();
    expect(() => clearConfigOverride(path, "palette")).not.toThrow();
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });

  test("corrupt JSON recovers to empty, not a thrown error", () => {
    const { path, cleanup } = tmpFile();
    writeFileSync(path, "{ not valid json");
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });

  test("a value of the wrong shape (whole file) recovers to empty", () => {
    const { path, cleanup } = tmpFile();
    writeFileSync(path, JSON.stringify({ padding: "sixteen" })); // string, not number
    expect(loadConfigOverrides(path)).toEqual({});
    cleanup();
  });

  test("isGlobalsField accepts real Globals fields and rejects everything else", () => {
    expect(isGlobalsField("palette")).toBe(true);
    expect(isGlobalsField("padding")).toBe(true);
    expect(isGlobalsField("bogus")).toBe(false);
    expect(isGlobalsField("__proto__")).toBe(false);
  });

  test("coerceGlobalsValue coerces per-field type from the canonical wire string", () => {
    expect(coerceGlobalsValue("palette", "nord")).toBe("nord");
    expect(coerceGlobalsValue("padding", "3")).toBe(3);
    expect(coerceGlobalsValue("autoWrap", "1")).toBe(true);
    expect(coerceGlobalsValue("autoWrap", "")).toBe(false);
  });

  // [LAW:verifiable-goals] A `persist` boolean field's gate is an ALLOW-LIST
  // (a `cycle`/`to` action's declared members pass through membership-checked
  // but otherwise VERBATIM), not validateBoolean's own canonicalizing
  // SessionState validator — so a config author writing `cycle: ["true",
  // "false"]` or `to: "0"` reaches coerceGlobalsValue with the raw member,
  // not a pre-canonicalized "1"/"". All four canonical boolean-ish wire
  // strings must coerce, not just the canonical "1"/"" pair.
  test("coerceGlobalsValue accepts every canonical boolean-ish wire string, not just 1/empty", () => {
    expect(coerceGlobalsValue("autoWrap", "true")).toBe(true);
    expect(coerceGlobalsValue("autoWrap", "1")).toBe(true);
    expect(coerceGlobalsValue("autoWrap", "false")).toBe(false);
    expect(coerceGlobalsValue("autoWrap", "0")).toBe(false);
    expect(coerceGlobalsValue("autoWrap", "")).toBe(false);
  });

  test("coerceGlobalsValue throws loudly on an undeliverable numeric string", () => {
    expect(() => coerceGlobalsValue("padding", "not-a-number")).toThrow(
      /expects a number/,
    );
  });

  test("coerceGlobalsValue throws loudly on an undeliverable boolean string", () => {
    expect(() => coerceGlobalsValue("autoWrap", "maybe")).toThrow(
      /expects boolean-ish/,
    );
  });

  // [LAW:no-silent-failure] A write failure must be OBSERVABLE by the caller
  // — the verb handler logs "set-config: ..." as a success on the line right
  // after this call, so a swallowed failure would let that log lie. Point
  // the write at a path whose parent cannot be created (a file standing
  // where a directory is expected) to force a real fs failure.
  test("writeConfigOverride throws (not silently swallows) when the write fails", () => {
    const { path: blocker, cleanup } = tmpFile();
    writeFileSync(blocker, "not a directory");
    const impossiblePath = join(blocker, "config-overrides.json");
    expect(() =>
      writeConfigOverride(impossiblePath, "palette", "nord"),
    ).toThrow();
    cleanup();
  });
});

// ─── config-validators: the persistent-write gate ─────────────────────────────

describe("config-validators registry", () => {
  test("an unregistered key is rejected — no baseline keys exist", () => {
    const result = validateConfigWrite("palette", "nord");
    expect(result.ok).toBe(false);
  });

  test("deriveConfigActionValidators ignores `set` actions and only reads `persist`", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: {
          sessionOnly: { set: 'theme', from: 'themes' },
          persistent: { persist: 'palette', from: 'themes' },
        },
        segments: { s: { template: 'x', bg: 'surface', fg: 'foreground' } },
        root: 's',
      }`,
      ALLOWED,
    );
    const contributions = deriveConfigActionValidators(config);
    expect(contributions.map((c) => c.key)).toEqual(["palette"]);
  });

  test("register→validate round trip: rejects out-of-domain, accepts in-domain", () => {
    const dispose = registerConfigValidator("padding", {
      kind: "range",
      min: 0,
      max: 16,
      seed: 1,
    });
    try {
      const bad = validateConfigWrite("padding", "999");
      // range gate CLAMPS rather than rejects, mirroring the SessionState range gate
      expect(bad.ok).toBe(true);
      if (bad.ok) expect(bad.value).toBe("16");
      const ok = validateConfigWrite("padding", "5");
      expect(ok).toEqual({ ok: true, value: "5" });
    } finally {
      dispose();
    }
  });

  test("listConfigKeys reflects live registrations", () => {
    const dispose = registerConfigValidator("charset", {
      kind: "allow-list",
      allowed: ["unicode", "ascii"],
    });
    expect(listConfigKeys()).toContain("charset");
    dispose();
    expect(listConfigKeys()).not.toContain("charset");
  });

  // [LAW:one-type-per-behavior] The shared validator-registry algebra is one
  // implementation instantiated twice — a rejection message from the CONFIG
  // keyspace must say "config", never the SessionState-era "state", or an
  // operator debugging a persist-action click is misled about which gate
  // rejected them.
  test("an out-of-domain rejection names the config keyspace, not state", () => {
    const dispose = registerConfigValidator("charset", {
      kind: "allow-list",
      allowed: ["unicode", "ascii"],
    });
    try {
      const result = validateConfigWrite("charset", "bogus");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("config");
        expect(result.reason).not.toContain("state");
      }
    } finally {
      dispose();
    }
  });
});

// ─── loader: the `persist`/`reset` ActionDecl arms ────────────────────────────

describe("persist/reset action loader shape", () => {
  const base = (actions: string) => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: { s: { template: 'x', bg: 'surface', fg: 'foreground' } },
    root: 's',
  }`;

  test("persist + from parses like set + from, minus the SessionState namespace", () => {
    const config = parseAndValidate(
      "<test>",
      base(`{ applyTheme: { persist: 'palette', from: 'themes' } }`),
      ALLOWED,
    );
    expect(config.actions.applyTheme).toEqual({
      persist: "palette",
      from: "themes",
    });
  });

  test("persist + to, min/max/by, and cycle all parse", () => {
    const config = parseAndValidate(
      "<test>",
      base(`{
        a: { persist: 'look', to: 'vivid' },
        b: { persist: 'padding', min: 0, max: 16, by: 1 },
        c: { persist: 'autoWrap', cycle: ['true', 'false'] },
      }`),
      ALLOWED,
    );
    expect(config.actions.a).toEqual({ persist: "look", to: "vivid" });
    expect(config.actions.b).toEqual({
      persist: "padding",
      min: 0,
      max: 16,
      by: 1,
    });
    expect(config.actions.c).toEqual({
      persist: "autoWrap",
      cycle: ["true", "false"],
    });
  });

  test("persist + int is rejected — a page cursor is never persisted", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'palette', int: true } }`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("reset parses as a bare slash-free key", () => {
    const config = parseAndValidate(
      "<test>",
      base(`{ undo: { reset: 'palette' } }`),
      ALLOWED,
    );
    expect(config.actions.undo).toEqual({ reset: "palette" });
  });

  test("reset rejects sibling keys", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ undo: { reset: 'palette', to: 'nord' } }`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a config with only `persist` actions still requires session.id", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          globals: {},
          variables: {},
          actions: { applyTheme: { persist: 'palette', from: 'themes' } },
          segments: { s: { template: 'x', bg: 'surface', fg: 'foreground' } },
          root: 's',
        }`,
        ALLOWED,
      ),
    ).toThrow(/session\.id/);
  });

  // [LAW:no-silent-failure] A typo'd persist/reset target must be a LOAD-time
  // error naming the real field set, not a confusing click-time
  // "registration invariant broken" message the operator can't act on.
  test("persist targeting a non-Globals field is a load error naming the real fields", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'pallete', to: 'nord' } }`),
        ALLOWED,
      ),
    ).toThrow(/"pallete" is not a config globals field \(have: /);
  });

  test("reset targeting a non-Globals field is a load error naming the real fields", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ a: { reset: 'pallete' } }`), ALLOWED),
    ).toThrow(/"pallete" is not a config globals field \(have: /);
  });

  test("persist targeting a real Globals field passes", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ a: { persist: 'colorCompatibility', to: 'truecolor' } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });
});

// ─── end-to-end: click → durable write, through the real daemon handlers ─────

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

describe("persist action click → durable overrides write", () => {
  let savedXdgState: string | undefined;
  let xdgStateDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-persist-state-"));
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
      'theme.effective': { kind: 'literal', value: 'textual-dark' },
    },
    actions: {
      applyTheme: { persist: 'palette', from: 'themes' },
      undoTheme: { reset: 'palette' },
    },
    segments: { bar: { template: '{{ action "applyTheme" "nord" }} {{ action "undoTheme" "↺" }}', bg: 'surface', fg: 'foreground' } },
    root: 'bar',
  }`;

  test("clicking a persist-option action writes the overrides file durably", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const out = render();
    const urls = extractUrls(out);
    // The first link is applyTheme bound to "nord" (the display text).
    const applyUrl = effectsOf(urls[0]!)[0]!;
    expect(applyUrl.verb).toBe("set-config");
    click(urls[0]!);
    const overrides = loadConfigOverrides(
      join(xdgStateDir, "cc-candybar", "config-overrides.json"),
    );
    expect(overrides).toEqual({ palette: "nord" });
    dispose();
  });

  test("clicking reset clears a previously-persisted override", () => {
    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "palette", "nord");
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const out = render();
    const urls = extractUrls(out);
    const resetUrl = urls[1]!;
    expect(effectsOf(resetUrl)[0]!.verb).toBe("reset-config");
    click(resetUrl);
    expect(loadConfigOverrides(overridesPath)).toEqual({});
    dispose();
  });

  // [LAW:verifiable-goals] The end-to-end click→durable-write path exercised
  // above only covers persist-option and reset. persist-literal, persist-cycle,
  // and persist-bounded (routed through the distinct stepConfig handler —
  // read current override, clamp, wrap, write) are non-trivial code paths of
  // their own and need the same real-daemon-handler coverage.
  const SRC2 = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
    },
    actions: {
      applyLookForever: { persist: 'look', to: 'vivid' },
      cycleColorDepth: { persist: 'colorCompatibility', cycle: ['truecolor', '256'] },
      bumpPadding: { persist: 'padding', min: 0, max: 16, by: 1 },
    },
    segments: { bar: { template: '{{ action "applyLookForever" "vivid" }} {{ action "cycleColorDepth" "cd" }} {{ action "bumpPadding" "+" }}', bg: 'surface', fg: 'foreground' } },
    root: 'bar',
  }`;

  test("clicking a persist-literal (to) action writes the fixed value durably", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[0]!)[0]!;
    expect(effect.verb).toBe("set-config");
    click(urls[0]!);
    const overrides = loadConfigOverrides(
      join(xdgStateDir, "cc-candybar", "config-overrides.json"),
    );
    expect(overrides).toEqual({ look: "vivid" });
    dispose();
  });

  test("clicking a persist-cycle action writes the successor member durably", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[1]!)[0]!;
    expect(effect.verb).toBe("set-config");
    click(urls[1]!);
    // Unset counts as the first member ("truecolor"); the click writes the
    // successor ("256") — same "unknown current counts as first" rule the
    // renderer's cycleIndex uses.
    const overrides = loadConfigOverrides(
      join(xdgStateDir, "cc-candybar", "config-overrides.json"),
    );
    expect(overrides).toEqual({ colorCompatibility: "256" });
    dispose();
  });

  test("clicking a persist-bounded action steps and persists via stepConfig", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[2]!)[0]!;
    expect(effect.verb).toBe("step-config");
    click(urls[2]!); // unset seeds from min (0) + by (1) = 1
    click(urls[2]!); // reads the just-written override (1) + by (1) = 2
    const overrides = loadConfigOverrides(
      join(xdgStateDir, "cc-candybar", "config-overrides.json"),
    );
    expect(overrides).toEqual({ padding: 2 });
    dispose();
  });

  test("an unknown config key is rejected loudly, not silently written", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: {},
        segments: { s: { template: 'x', bg: 'surface', fg: 'foreground' } },
        root: 's',
      }`,
      ALLOWED,
    );
    void config;
    const sessionState = new SessionState();
    const ctx: VerbContext = { sessionState, dlog: () => {} };
    const setConfig = VERBS.get("set-config")!;
    expect(() =>
      setConfig(
        `${encodeURIComponent("s1")}/${encodeURIComponent("not-a-real-key")}/${encodeURIComponent("x")}`,
        ctx,
      ),
    ).toThrow();
  });
});

// ─── RenderCache integration: merge precedence + reload + byte-identity ──────

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

async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!cond()) throw new Error("waitFor timed out");
}

describe("RenderCache: persistent overrides merge into the effective config", () => {
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
    xdgStateDir = mkdtempSync(join(tmpdir(), "cc-candybar-rc-state-"));
    xdgConfigDir = mkdtempSync(join(tmpdir(), "cc-candybar-rc-xdgcfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "cc-candybar-rc-project-"));
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

  test("an override changes globals.palette without touching the user config file", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    const userConfigBody = JSON.stringify({
      globals: { palette: "textual-dark" },
      segments: {},
    });
    writeFileSync(userConfigPath, userConfigBody);

    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "palette", "nord");

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.lastError).toBeNull();
      // overrides win over the user file's own globals.palette
      expect(entry.state!.config.globals.palette).toBe("nord");
      // the hand-authored file is byte-identical — the daemon never wrote to it
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:verifiable-goals] The precedence chain the epic requires documented
  // AND asserted: bundled default < user file < persisted overrides <
  // session pick. A `persist` write changes the DEFAULT every session reads;
  // it must NOT override a session's own `set` pick for that session — the
  // effective* resolution (unchanged by this ticket) already reads session
  // state before the config default, so this proves the new override layer
  // slots into that existing precedence rather than a parallel one.
  test("a session's own set-state pick still wins over a persisted default", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(
      userConfigPath,
      JSON.stringify({ globals: {}, segments: {} }),
    );

    const overridesPath = join(
      xdgStateDir,
      "cc-candybar",
      "config-overrides.json",
    );
    writeConfigOverride(overridesPath, "palette", "nord");

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      // The persisted default is now every session's starting point.
      expect(entry.state!.config.globals.palette).toBe("nord");

      // A session that picked its own theme via `set` still overrides it —
      // effectiveThemeName is unchanged by this ticket: session state is
      // consulted BEFORE globals.palette, so the persisted layer only ever
      // changes what a session sees when it hasn't picked anything itself.
      const sessionState = new SessionState();
      sessionState.set("s1", "theme", "dracula");
      expect(
        effectiveThemeName(
          sessionState.get("s1", "theme"),
          entry.state!.config.globals.palette,
        ),
      ).toBe("dracula");
      // A session that never picked reads the persisted default.
      expect(
        effectiveThemeName(
          sessionState.get("s2-no-pick", "theme"),
          entry.state!.config.globals.palette,
        ),
      ).toBe("nord");
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  test("writing the overrides file after the entry loads triggers a reload via the existing watcher", async () => {
    const userConfigPath = join(projectDir, ".cc-candybar.json5");
    writeFileSync(
      userConfigPath,
      JSON.stringify({ globals: {}, segments: {} }),
    );
    // The overrides dir must exist BEFORE the first watcher build — fs.watch
    // on a not-yet-existing dir is skipped (documented limitation in
    // rebindWatcher: a dir created after the entry's first build only starts
    // being watched on the entry's NEXT build). Real daemon startup always
    // creates stateDir() first (runDaemon's `mkdirSync(daemonDir())`), so
    // this mirrors production ordering, not a workaround for the test.
    mkdirSync(join(xdgStateDir, "cc-candybar"), { recursive: true });

    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(projectDir, projectDir, undefined);
      expect(entry.state!.config.globals.palette).not.toBe("nord");

      const overridesPath = join(
        xdgStateDir,
        "cc-candybar",
        "config-overrides.json",
      );
      writeConfigOverride(overridesPath, "palette", "nord");

      await waitFor(() => entry.state?.config.globals.palette === "nord");
      expect(entry.state!.config.globals.palette).toBe("nord");
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
