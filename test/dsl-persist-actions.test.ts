// [LAW:verifiable-goals] Acceptance for candybar-config-engine-71o.2 —
// persistent config writes — driven through the real spine, mirroring
// dsl-actions.test.ts's model for `set`:
//
//   1. The loader proves the `persist`/`reset` ActionDecl shapes: persist
//      mirrors set's to/from/min-max-by/cycle value sources (no `int` — a
//      page cursor is never persisted); reset is a single slash-free key.
//   2. deriveConfigActionValidators derives the persistent-write gate from
//      the SAME action table the `{{ action }}` fn realizes a click from —
//      the config-file keyspace, kept separate from SessionState's.
//   3. A click on a compiled persist-* action fires VERB_SET_CONFIG/
//      VERB_STEP_CONFIG through the REAL daemon leaf handlers, which
//      validate-then-write durably INTO THE SESSION'S CONFIG FILE
//      (candybar-config-dqe): one value span replaced, every other byte —
//      comments included — preserved, one whole-file history entry.
//   4. RenderCache reads the edited file back through the SAME file-watcher
//      path a hand edit already takes (bundled default < config file <
//      active preset < session pick) — no bespoke apply path, and the write
//      survives a restart because the file IS the write.
//   5. reset-config is gated by key membership and deletes the key's path
//      from the file, so the next reload falls back to the bundled default.

import { ownLinks, ownValidators } from "./helpers/ambient-chrome";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { boldUrls, effectsOf } from "./helpers/click";
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
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return ownLinks(urls);
}

// [LAW:one-source-of-truth] The config FILE is the durable store a persist
// click edits (candybar-config-dqe). One fixture for the whole file — every
// test gets a fresh temp config root, whether or not it clicks — so there is
// no per-describe "does this one need a file" decision to get wrong.
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

  // [LAW:verifiable-goals] A `persist` boolean field's gate is an ALLOW-LIST
  // (a `cycle`/`to` action's declared members pass through membership-checked
  // but otherwise VERBATIM), not validateBoolean's own canonicalizing
  // SessionState validator — so a config author writing `cycle: ["true",
  // "false"]` or `to: "0"` reaches persistValueText with the raw member, not
  // a pre-canonicalized "1"/"". All four canonical boolean-ish wire strings
  // must lift, not just the canonical "1"/"" pair.
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
      /does not name a value/,
    );
  });

  // [LAW:no-silent-failure] A write failure must be OBSERVABLE by the caller
  // — the verb handler logs "set-config: ..." as a success on the line right
  // after this call, so a swallowed failure would let that log lie. Point
  // the write at a path whose parent cannot be a directory (a file standing
  // where one is expected) to force a real fs failure.
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

  // [LAW:one-source-of-truth] A slash-bearing allow-list member is rejected
  // at REGISTRATION (config-load) time, and the thrown message must name the
  // wire the config keyspace actually crosses (set-config), not the
  // SessionState keyspace's set-state wire the shared factory defaults to.
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

// [LAW:one-source-of-truth] The runtime parses `src` for the render AND
// writes the same text as the session's config file, so the value a click
// edits sits in the file the bar rendered from — the daemon's own situation.
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

describe("persist action click → the config file", () => {
  const globalsInFile = (): Record<string, unknown> =>
    (durable.parsed().globals ?? {}) as Record<string, unknown>;

  // The comment beside `globals` is the canary: a click edits ONE value span
  // and everything else in the file — this comment included — survives.
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
    // The first link is applyTheme bound to "nord" (the display text).
    const applyUrl = effectsOf(urls[0]!)[0]!;
    expect(applyUrl.verb).toBe("set-config");
    click(urls[0]!);
    expect(globalsInFile()).toEqual({ palette: "nord" });
    // One span changed; the rest of the file is the author's, byte for byte.
    const written = durable.text()!;
    expect(written).toContain(GLOBALS_COMMENT);
    expect(written).toContain("applyTheme: { persist: 'palette'");
    expect(durable.history().past).toEqual([
      { file: durable.configPath, before: original, after: written },
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

  // [LAW:verifiable-goals] brandon-presets-0yk.2: `preset` reuses persist/
  // reset's SAME click path — no bespoke "pin a preset forever" plumbing,
  // just another globals field name (candybar-config-engine-71o.2's stated
  // "zero engine edits" promise held for the persistence half too).
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

  // [LAW:verifiable-goals] candybar-config-engine-71o.4 found this the hard
  // way against a real daemon: `{{ menu }}`'s picker grid (src/render/
  // picker.ts) hard-required a set-option apply action, so a persist-option
  // apply (the ONLY seam charset/colorCompatibility/autoWrap/padding have —
  // see docs/interaction-authoring.md's "Persisting the display globals",
  // which had ALREADY documented `{{ menu "applyCharset" "▸" "▾" }}` over a persist
  // action as the canonical pattern) threw at render the moment the menu was
  // actually opened. `buildPersistRuntime` above only derives the CONFIG
  // gate; a `{{ menu }}`'s own open/close disclosure is a SessionState write,
  // so this test derives BOTH gates — the same combination a real daemon
  // registers for any config mixing session and persist actions.
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
    try {
      // The disclosure toggle is the menu's OWN SessionState write — open it.
      const toggleUrl = extractUrls(render()).find(
        (u) => effectsOf(u)[0]!.verb === "set-state",
      )!;
      click(toggleUrl);

      // Opened: this must not throw (the bug threw here) and must list
      // "ascii" as a set-config-backed option, never set-state.
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
    expect(globalsInFile()).toEqual({ look: "vivid" });
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
    expect(globalsInFile()).toEqual({ colorCompatibility: "256" });
    dispose();
  });

  test("clicking a persist-bounded action steps and persists via stepConfig", () => {
    const { render, click, dispose } = buildPersistRuntime(SRC2);
    const urls = extractUrls(render());
    const effect = effectsOf(urls[2]!)[0]!;
    expect(effect.verb).toBe("step-config");
    // [LAW:one-source-of-truth] An unset stepper seeds from the value the bar
    // RENDERS with no write at all — this config declares no `globals.padding`,
    // so that is the field's floor (DEFAULT_PADDING = 1), not `min`.
    // candybar-settings-ui-aok.3: seeding from `min` is what made the first ◀
    // on a bar reading `padding 1` wrap to 16, and both write gates now read
    // the same seed source (numericGlobalsSeeds).
    click(urls[2]!); // unset seeds from the floor (1) + by (1) = 2
    click(urls[2]!); // reads the just-written file value (2) + by (1) = 3
    expect(globalsInFile()).toEqual({ padding: 3 });
    dispose();
  });

  // [LAW:verifiable-goals] candybar-config-engine-71o.3: proves the NEW
  // CONFIG_KEY_TO_EFFECTIVE_VAR entries (charset → charset.effective, …)
  // actually drive the "current selection" bold marking — not just that the
  // write lands (covered above), but that the render-side read-back works.
  // Without the wiring this test would see NOTHING marked active (the stale
  // fallback comment removed from render/action.ts): the stateVar would fall
  // back to the bare key "charset", which no variable projects, so readVar
  // would always see "".
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

  // [LAW:verifiable-goals] candybar-config-engine-71o.3: autoWrap is the one
  // BOOLEAN field among the newly-exposed globals — proves a persist-cycle
  // over it round-trips through coercePersistValue's boolean branch (not
  // just its own unit test above) and lands as a real JSON5 boolean in the
  // file, not the string "false".
  test("clicking a persist-cycle action over the boolean autoWrap field writes a real boolean", () => {
    const { render, click, dispose } = buildPersistRuntime(`{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { toggleWrap: { persist: 'autoWrap', cycle: ['true', 'false'] } },
      segments: { bar: { template: '{{ action "toggleWrap" "wrap" }}', bg: 'surface', fg: 'foreground' } },
      root: 'bar',
    }`);
    const urls = extractUrls(render());
    click(urls[0]!); // unset counts as "true" (first member); writes successor "false"
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
    const ctx: VerbContext = { sessionState, dlog: () => {} };
    const setConfig = VERBS.get("set-config")!;
    expect(() =>
      setConfig(
        `${encodeURIComponent("s1")}/${encodeURIComponent("not-a-real-key")}/${encodeURIComponent("x")}`,
        ctx,
      ),
    ).toThrow();
  });

  // [LAW:verifiable-goals] candybar-settings-ui-aok.3's whole reason for
  // folding the session release INTO the durable write, rather than emitting
  // it beside the write as its own effect, is an ORDER guarantee: the release
  // happens only after the write landed, so a failure can never cost the user
  // their session pick with nothing durable in its place.
  //
  // This pins the order from the failing end. An unregistered release key —
  // what a stale link carries after a reload narrowed the gates — must fail
  // LOUDLY and leave the durable write that already succeeded intact on disk.
  // A release that silently no-op'd, or one that somehow rolled the write
  // back, would both pass a happy-path test; only this direction distinguishes
  // them.
  test("a bad release key fails loudly AFTER the durable write has landed", () => {
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
    const ctx: VerbContext = { sessionState, dlog: () => {} };
    const enc = (v: string) => encodeURIComponent(v);
    try {
      expect(() =>
        VERBS.get("set-config")!(
          `${enc("s1")}/${enc("palette")}/${enc("nord")}/${enc("no-such-session-key")}`,
          ctx,
        ),
      ).toThrow(/unknown session key/);
      // The durable half is on disk regardless: the release ran after it, and
      // its failure is reported rather than swallowed or compensated.
      expect(globalsInFile()).toEqual({ palette: "nord" });
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

describe("RenderCache: the config file is the durable store", () => {
  let savedCcConfig: string | undefined;

  beforeEach(() => {
    savedCcConfig = process.env.CC_CANDYBAR_CONFIG;
    delete process.env.CC_CANDYBAR_CONFIG;
  });
  afterEach(() => {
    if (savedCcConfig === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCcConfig;
  });

  const GLOBALS_COMMENT = "// the hand-authored display defaults";

  // [LAW:one-source-of-truth] The click's write reaches the LIVE cache through
  // the SAME watcher a hand edit to the file fires — there is no second
  // "overrides changed" channel. The first application is the click itself;
  // a retry (fs.watch has no ready signal — see reload-signal.ts) re-touches
  // the file with the bytes the click left, so every application ends in the
  // same on-disk state and emits an event. Then a REAL restart (a brand-new
  // RenderCache + GitDataProvider + WatcherRegistry — exactly what the daemon
  // process rebuilds from scratch, reading nothing but the file on disk)
  // sees the same value: the write survives because the file IS the write.
  test("a set-config click edits globals.palette in the file, the live cache reloads it, and a restart reads it back", async () => {
    // Declares its own `pin` action so the cache's derived gate admits
    // exactly the value the test fires — the same gate a rendered click
    // passes through.
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
      expect(entry.state!.config.globals.palette).toBe("textual-dark");

      durable.seedOrigin(sessionState, "s1");
      const ctx: VerbContext = { sessionState, dlog: () => {} };
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
      expect(entry.state!.config.globals.palette).toBe("nord");
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
      expect(entry.state!.config.globals.palette).toBe("nord");
    } finally {
      for (const fn of restartedCleanups) fn();
    }
  });

  // [LAW:verifiable-goals] brandon-presets-0yk.2 done-gate: "switching
  // presets with pending overrides behaves as documented, asserted by a
  // test" — the precedence chain in docs/interaction-authoring.md and
  // src/config/presets.ts, driven through the REAL RenderCache (so the
  // file's globals are genuinely baked into config.globals, not asserted
  // against a hand-built fixture) and the real presetGlobals composition the
  // daemon calls: a preset's own fields win over the file's default (a
  // "compact" preset must actually change padding, even for a user who once
  // persisted a padding they liked); a field the active preset says nothing
  // about still reads the file's default underneath it.
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

      // No active preset (the floor): the file's globals apply as-is.
      const atFloor = presetGlobals(entry.state!.config, PRESET_FLOOR);
      expect(atFloor.padding).toBe(2);
      expect(atFloor.charset).toBe("ascii");

      // "roomy" declares padding — it wins over the file's 2. It says
      // nothing about charset — the file's "ascii" survives underneath.
      const atRoomy = presetGlobals(entry.state!.config, "roomy");
      expect(atRoomy.padding).toBe(4);
      expect(atRoomy.charset).toBe("ascii");
    } finally {
      for (const fn of cleanups) fn();
    }
  });

  // [LAW:verifiable-goals] The precedence chain the epic requires documented
  // AND asserted: bundled default < config file < session pick. A `persist`
  // write changes the DEFAULT every session reads; it must NOT override a
  // session's own `set` pick for that session — the effective* resolution
  // reads session state before the config default.
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
      // The file's default is every session's starting point.
      expect(entry.state!.config.globals.palette).toBe("nord");

      // A session that picked its own theme via `set` still overrides it —
      // session state is consulted BEFORE globals.palette, so the file only
      // ever changes what a session sees when it hasn't picked anything.
      const sessionState = new SessionState();
      sessionState.set("s1", "theme", "dracula");
      expect(
        effectiveThemeName(
          undefined,
          sessionState.get("s1", "theme"),
          entry.state!.config.globals.palette,
        ),
      ).toBe("dracula");
      // A session that never picked reads the file's default.
      expect(
        effectiveThemeName(
          undefined,
          sessionState.get("s2-no-pick", "theme"),
          entry.state!.config.globals.palette,
        ),
      ).toBe("nord");
    } finally {
      for (const fn of cleanups) fn();
    }
  });
});
