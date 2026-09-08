// [LAW:verifiable-goals] Acceptance for persistent config writes through the real spine:
// gate derived from the action table a click is realized from, write into the session's
// config file, read back through the watcher a hand edit fires.

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { ReloadSignal } from "./helpers/reload-signal";
import {
  effectiveThemeName,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, boldUrls, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { encodeSegments, parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import {
  deriveConfigActionValidators,
  listConfigKeys,
  registerConfigValidator,
  validateConfigWrite,
} from "../src/daemon/verbs/config-validators";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { persistValueText, writeValue } from "../src/daemon/config-file-store";
import { isGlobalsField } from "../src/config/loader/globals";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { RenderCache } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { PRESET_FLOOR, presetGlobals } from "../src/config/presets";

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

// Every OSC-8 link URL in render order; boldUrls reports only the selected region.
function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return ownLinks(urls);
}

// [LAW:one-source-of-truth] The config FILE is the durable store a persist click edits.
let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-persist-");
});
afterEach(() => {
  durable.dispose();
});

// ─── config-file-store: the wire string → the file's typed JSON5 text ────────

describe("persistValueText", () => {
  test("isGlobalsField accepts real Globals fields and rejects everything else", () => {
    expect(isGlobalsField("palette")).toBe(true);
    expect(isGlobalsField("padding")).toBe(true);
    expect(isGlobalsField("bogus")).toBe(false);
    expect(isGlobalsField("__proto__")).toBe(false);
  });

  test("lifts the canonical wire string into the field's typed JSON5 text", () => {
    expect(persistValueText("palette", "nord")).toBe('"nord"');
    expect(persistValueText("padding", "3")).toBe("3");
    expect(persistValueText("autoWrap", "1")).toBe("true");
    expect(persistValueText("autoWrap", "")).toBe("false");
  });

  // [LAW:verifiable-goals] A persist gate passes members VERBATIM, so all four boolean-ish wire strings must lift.
  test("accepts every canonical boolean-ish wire string, not just 1/empty", () => {
    expect(persistValueText("autoWrap", "true")).toBe("true");
    expect(persistValueText("autoWrap", "1")).toBe("true");
    expect(persistValueText("autoWrap", "false")).toBe("false");
    expect(persistValueText("autoWrap", "0")).toBe("false");
    expect(persistValueText("autoWrap", "")).toBe("false");
  });

  test("throws loudly on an undeliverable numeric string", () => {
    expect(() => persistValueText("padding", "not-a-number")).toThrow(
      /expects a number/,
    );
  });

  test("throws loudly on an undeliverable boolean string", () => {
    expect(() => persistValueText("autoWrap", "maybe")).toThrow(
      /expects boolean-ish/,
    );
  });

  test("a preset-root key names a tree, not a value — refused", () => {
    expect(() => persistValueText("presets.compact.root", "x")).toThrow(
      /names a layout, not a value/,
    );
  });

  // [LAW:no-silent-failure] A swallowed write failure would let the handler's success log lie.
  test("writeValue throws (not silently swallows) when the write fails", () => {
    const blocker = join(durable.projectDir, "blocker");
    writeFileSync(blocker, "not a directory");
    const impossiblePath = join(blocker, "config.json5");
    expect(() =>
      writeValue(
        { historyPath: durable.historyPath, logger: () => {} },
        impossiblePath,
        "palette",
        "nord",
      ),
    ).toThrow();
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
    const contributions = ownValidators(
      config,
      deriveConfigActionValidators(config),
    );
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

  // [LAW:one-type-per-behavior] One algebra instantiated twice: a CONFIG rejection must say "config".
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

  // [LAW:one-source-of-truth] Rejected at REGISTRATION time, naming the wire this keyspace crosses.
  test("a slash-bearing config allow-list member's rejection names the set-config wire", () => {
    expect(() =>
      registerConfigValidator("look", {
        kind: "allow-list",
        allowed: ["a/b"],
      }),
    ).toThrow(/set-config wire/);
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

  // [LAW:no-silent-failure] A typo'd target is a LOAD-time error naming the real field set.
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

// [LAW:one-source-of-truth] A click edits the same file the bar rendered from.
function buildPersistRuntime(src: string, sessionId = "s1") {
  durable.write(src);
  const config = parseAndValidate("<test>", src, ALLOWED);
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
  const ctx: VerbContext = testVerbContext(sessionState);
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

describe("persist action click → the config file", () => {
  const globalsInFile = (): Record<string, unknown> =>
    (durable.parsed().globals ?? {}) as Record<string, unknown>;

  // The comment beside `globals` is the canary: one value span changes, the rest survives.
  const GLOBALS_COMMENT = "// the hand-authored display defaults";
  const SRC = `{
    ${GLOBALS_COMMENT}
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

  test("clicking a persist-option action writes globals.palette into the config file", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const original = durable.text()!;
    const out = render();
    const urls = extractUrls(out);
    const applyUrl = effectsOf(urls[0]!)[0]!;
    expect(applyUrl.verb).toBe("set-config");
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ palette: "nord" });
    const written = durable.text()!;
    expect(written).toContain(GLOBALS_COMMENT);
    expect(written).toContain("applyTheme: { persist: 'palette'");
    expect(durable.history().past).toEqual([
      { before: original, after: written },
    ]);
    dispose();
  });

  test("clicking reset deletes the persisted key from the file", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC);
    const urls = extractUrls(render());
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ palette: "nord" });
    const resetUrl = urls[1]!;
    expect(effectsOf(resetUrl)[0]!.verb).toBe("reset-config");
    click(resetUrl);
    expect(globalsInFile()).toEqual({});
    expect(durable.text()).toContain(GLOBALS_COMMENT);
    dispose();
  });

  // [LAW:verifiable-goals] `preset` reuses the same persist/reset click path, no bespoke plumbing.
  const SRC_PRESET = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
    },
    actions: {
      applyPresetForever: { persist: 'preset', from: 'presets' },
      forgetPreset: { reset: 'preset' },
    },
    segments: { bar: { template: '{{ action "applyPresetForever" "compact" }} {{ action "forgetPreset" "↺" }}', bg: 'surface', fg: 'foreground' } },
    root: 'bar',
    presets: { compact: {} },
  }`;

  test("clicking a persist-option action over preset writes globals.preset into the config file", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC_PRESET);
    const urls = extractUrls(render());
    const applyUrl = effectsOf(urls[0]!)[0]!;
    expect(applyUrl.verb).toBe("set-config");
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ preset: "compact" });
    dispose();
  });

  test("clicking reset deletes the persisted preset from the file", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC_PRESET);
    const urls = extractUrls(render());
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ preset: "compact" });
    const resetUrl = urls[1]!;
    expect(effectsOf(resetUrl)[0]!.verb).toBe("reset-config");
    click(resetUrl);
    expect(globalsInFile()).toEqual({});
    dispose();
  });

  // [LAW:verifiable-goals] A menu's disclosure is a SessionState write while its options
  // are persist writes, so both gates must be derived together.
  test("a persist-option action bound via {{ menu }} opens and its option click writes set-config, not set-state", () => {
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'charset.effective': { kind: 'literal', value: 'unicode' },
        'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
      },
      actions: { applyCharsetForever: { persist: 'charset', from: 'charsets' } },
      segments: {
        bar: { template: '{{ .charset.effective }} {{ menu "applyCharsetForever" "▸" "▾" }}', bg: 'surface', fg: 'foreground' },
      },
      root: 'bar',
    }`;
    durable.write(src);
    const config = parseAndValidate("<test>", src, ALLOWED);
    const sessionState = new SessionState();
    durable.seedOrigin(sessionState, "s1");
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
        { session_id: "s1", project_dir: "/tmp/proj" },
        basePalette,
        opts(),
      );
    const stateDisposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const configDisposers = deriveConfigActionValidators(config).map(
      ({ key, spec }) => registerConfigValidator(key, spec),
    );
    const ctx: VerbContext = testVerbContext(sessionState);
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
    try {
      const toggleUrl = extractUrls(render()).find(
        (u) => effectsOf(u)[0]!.verb === "set-state",
      )!;
      click(toggleUrl);

      const openUrls = extractUrls(render());
      const asciiUrl = openUrls.find((u) =>
        effectsOf(u).some(
          (e) => e.verb === "set-config" && e.args[2] === "ascii",
        ),
      );
      expect(asciiUrl).toBeDefined();
      expect(
        openUrls.some((u) =>
          effectsOf(u).some(
            (e) => e.verb === "set-state" && e.args.includes("ascii"),
          ),
        ),
      ).toBe(false);

      click(asciiUrl!);
      expect(globalsInFile()).toEqual({ charset: "ascii" });
    } finally {
      stateDisposers.forEach((d) => d());
      configDisposers.forEach((d) => d());
      registry.dispose();
    }
  });

  // [LAW:verifiable-goals] persist-literal/cycle/bounded need the same real-handler coverage.
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
    expect(globalsInFile()).toEqual({ look: "vivid" });
    dispose();
  });

  test("clicking a persist-cycle action writes the successor member durably", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[1]!)[0]!;
    expect(effect.verb).toBe("set-config");
    click(urls[1]!);
    expect(globalsInFile()).toEqual({ colorCompatibility: "256" });
    dispose();
  });

  test("clicking a persist-bounded action steps and persists via stepConfig", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[2]!)[0]!;
    expect(effect.verb).toBe("step-config");
    // [LAW:one-source-of-truth] An unset stepper seeds from the value the bar RENDERS, never `min`.
    click(urls[2]!);
    click(urls[2]!);
    expect(globalsInFile()).toEqual({ padding: 3 });
    dispose();
  });

  // [LAW:verifiable-goals] Proves the render-side read-back drives the selection marking.
  test("a persist-option action over a newly-exposed field (charset) marks the matching link active via its *.effective projection", () => {
    const { render, dispose } = buildPersistRuntime(`{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'charset.effective': { kind: 'literal', value: 'ascii' },
      },
      actions: { applyCharset: { persist: 'charset', from: 'charsets' } },
      segments: {
        bar: {
          template: '{{ action "applyCharset" "ascii" }} {{ action "applyCharset" "unicode" }}',
          bg: 'surface', fg: 'foreground',
        },
      },
      root: 'bar',
    }`);
    const active = boldUrls(render()).map(effectsOf);
    expect(active).toHaveLength(1);
    expect(active[0]![0]!.args[2]).toBe("ascii");
    dispose();
  });

  // [LAW:verifiable-goals] autoWrap must land as a real JSON5 boolean, not the string "false".
  test("clicking a persist-cycle action over the boolean autoWrap field writes a real boolean", () => {
    const { render, click, dispose } = buildPersistRuntime(`{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { toggleWrap: { persist: 'autoWrap', cycle: ['true', 'false'] } },
      segments: { bar: { template: '{{ action "toggleWrap" "wrap" }}', bg: 'surface', fg: 'foreground' } },
      root: 'bar',
    }`);
    const urls = extractUrls(render());
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ autoWrap: false });
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
    const ctx: VerbContext = testVerbContext(sessionState);
    const setConfig = VERBS.get("set-config")!;
    expect(() =>
      setConfig(
        `${encodeURIComponent("s1")}/${encodeURIComponent("not-a-real-key")}/${encodeURIComponent("x")}`,
        ctx,
      ),
    ).toThrow();
  });

  // [LAW:verifiable-goals] The session release is folded INTO the durable write for the
  // order guarantee: it happens only after the write landed.
  // [LAW:no-ambient-temporal-coupling] The release KEY is checked before the write, so an
  // unregistered one refuses with the file untouched.
  test("a bad release key fails loudly BEFORE the durable write, leaving the file untouched", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { pin: { persist: 'palette', from: 'themes' } },
        segments: { s: { template: 'x', bg: 'surface', fg: 'foreground' } },
        root: 's',
      }`,
      ALLOWED,
    );
    const disposers = deriveConfigActionValidators(config).map(
      ({ key, spec }) => registerConfigValidator(key, spec),
    );
    const sessionState = new SessionState();
    durable.write(`{ globals: {}, segments: {} }`);
    durable.seedOrigin(sessionState, "s1");
    const ctx: VerbContext = testVerbContext(sessionState);
    const enc = (v: string) => encodeURIComponent(v);
    try {
      expect(() =>
        VERBS.get("set-config")!(
          `${enc("s1")}/${enc("palette")}/${enc("nord")}/${enc("no-such-session-key")}`,
          ctx,
        ),
      ).toThrow(/unknown session key/);
      expect(globalsInFile()).toEqual({});
      expect(durable.history().past).toHaveLength(0);
    } finally {
      for (const d of disposers) d();
    }
  });
});

// ─── RenderCache integration: the file is the store, reload, restart ────────

function makeCache(): {
  cache: RenderCache;
  sessionState: SessionState;
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
  return { cache, sessionState, cleanups, reloads };
}

describe("a durable click lands in the file the next reload reads", () => {
  // The origin's `configFile` is the sole candidate; the click creates it when missing.
  test("an origin with an explicit path writes that path, even before it exists", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { pin: { persist: "palette", from: "themes" } },
      }`,
      ALLOWED,
    );
    const disposers = deriveConfigActionValidators(config).map(
      ({ key, spec }) => registerConfigValidator(key, spec),
    );
    const sessionState = new SessionState();
    const named = join(durable.projectDir, "named.json5");
    durable.seedOrigin(sessionState, "s1", named);
    durable.write(`{ globals: { palette: "textual-dark" } }`);
    const ctx: VerbContext = testVerbContext(sessionState);
    try {
      VERBS.get("set-config")!(encodeSegments(["s1", "palette", "nord"]), ctx);
      expect(
        (
          JSON5.parse(readFileSync(named, "utf8")) as {
            globals: { palette: unknown };
          }
        ).globals.palette,
      ).toBe("nord");
      expect(durable.parsed()).toEqual({
        globals: { palette: "textual-dark" },
      });
      expect(existsSync(durable.xdgConfigPath)).toBe(false);
    } finally {
      for (const fn of disposers) fn();
    }
  });

  // [LAW:one-source-of-truth] The render records resolution INPUTS, so the click lands on the file the NEXT render reads.
  test("no file yet creates the XDG tail; a project file appearing afterwards takes the next click", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { pin: { persist: "palette", from: "themes" } },
      }`,
      ALLOWED,
    );
    const disposers = deriveConfigActionValidators(config).map(
      ({ key, spec }) => registerConfigValidator(key, spec),
    );
    const sessionState = new SessionState();
    durable.seedOrigin(sessionState, "s1");
    const ctx: VerbContext = testVerbContext(sessionState);
    const click = (palette: string): void =>
      VERBS.get("set-config")!(encodeSegments(["s1", "palette", palette]), ctx);
    const paletteIn = (file: string): unknown =>
      (
        JSON5.parse(readFileSync(file, "utf8")) as {
          globals: { palette: unknown };
        }
      ).globals.palette;
    try {
      expect(durable.text()).toBeNull();
      click("nord");
      expect(paletteIn(durable.xdgConfigPath)).toBe("nord");
      expect(durable.text()).toBeNull();

      durable.write(`{ globals: { palette: "textual-dark" } }`);
      click("dracula");
      expect(paletteIn(durable.configPath)).toBe("dracula");
      expect(paletteIn(durable.xdgConfigPath)).toBe("nord");
    } finally {
      for (const fn of disposers) fn();
    }
  });
});

describe("RenderCache: the config file is the durable store", () => {
  const GLOBALS_COMMENT = "// the hand-authored display defaults";

  // [LAW:one-source-of-truth] The write reaches the live cache through the watcher a hand edit fires.
  test("a set-config click edits globals.palette in the file, the live cache reloads it, and a restart reads it back", async () => {
    durable.write(`{
  ${GLOBALS_COMMENT}
  globals: { palette: "textual-dark" },
  segments: {},
  actions: { pin: { persist: "palette", from: "themes" } },
}
`);
    const { cache, sessionState, cleanups, reloads } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(entry.state.config.globals.palette).toBe("textual-dark");

      durable.seedOrigin(sessionState, "s1");
      const ctx: VerbContext = testVerbContext(sessionState);
      let clicked = false;
      await reloads.after(entry, () => {
        if (clicked) {
          writeFileSync(durable.configPath, durable.text()!);
          return;
        }
        clicked = true;
        VERBS.get("set-config")!(
          ["s1", "palette", "nord"].map(encodeURIComponent).join("/"),
          ctx,
        );
      });

      expect(entry.lastError).toBeNull();
      expect(entry.state.config.globals.palette).toBe("nord");
      expect(
        (durable.parsed().globals as Record<string, unknown>).palette,
      ).toBe("nord");
      expect(durable.text()).toContain(GLOBALS_COMMENT);
    } finally {
      for (const fn of cleanups) fn();
    }

    const { cache: restarted, cleanups: restartedCleanups } = makeCache();
    try {
      const entry = restarted.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();
      expect(entry.state.config.globals.palette).toBe("nord");
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  // [LAW:verifiable-goals] A preset's own fields win over the file's default; the rest read the file's.
  test("an active preset's own field wins over the file's default; a field the preset doesn't touch keeps reading the file", () => {
    durable.write(
      JSON.stringify({
        globals: { padding: 2, charset: "ascii" },
        segments: {},
        presets: { roomy: { globals: { padding: 4 } } },
      }),
    );
    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.lastError).toBeNull();

      const atFloor = presetGlobals(entry.state.config, PRESET_FLOOR);
      expect(atFloor.padding).toBe(2);
      expect(atFloor.charset).toBe("ascii");

      const atRoomy = presetGlobals(entry.state.config, "roomy");
      expect(atRoomy.padding).toBe(4);
      expect(atRoomy.charset).toBe("ascii");
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:verifiable-goals] bundled default < config file < session pick.
  test("a session's own set-state pick still wins over the file's default", () => {
    durable.write(
      JSON.stringify({ globals: { palette: "nord" }, segments: {} }),
    );
    const { cache, cleanups } = makeCache();
    try {
      const entry = cache.getOrCreate(
        durable.projectDir,
        durable.projectDir,
        undefined,
      );
      expect(entry.state.config.globals.palette).toBe("nord");

      const sessionState = new SessionState();
      sessionState.set("s1", "theme", "dracula");
      expect(
        effectiveThemeName(
          undefined,
          sessionState.get("s1", "theme"),
          entry.state.config.globals.palette,
        ),
      ).toBe("dracula");
      expect(
        effectiveThemeName(
          undefined,
          sessionState.get("s2-no-pick", "theme"),
          entry.state.config.globals.palette,
        ),
      ).toBe("nord");
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
