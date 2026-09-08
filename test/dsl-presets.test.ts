// [LAW:single-enforcer] Drives the real spine — the loader, renderDsl, the derived
// gate and real dispatch, checkConfig, effectivePresetName. No parallel rig.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import {
  ConfigError,
  mergeWithDefault,
  parseDslConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { rootNode } from "../src/config/root";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  PRESET_FLOOR,
  effectivePresetName,
  presetGlobals,
  presetRoot,
} from "../src/config/presets";
import { paletteForThemeName } from "../src/themes";
import { checkConfig } from "../src/check";

const SID = "s-presets";
const THEME = "textual-dark";
const ALLOWED = new Set([THEME]);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// The loader's real error text — the same strings `cc-candybar check` prints.
describe("presets block — loader validation", () => {
  // Structural issues surface at parse; cross-reference ones only at validate.
  const parseIssues = (src: string): string => {
    try {
      parseAndValidate("<presets>", src, ALLOWED);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).message;
    }
    throw new Error("expected ConfigError");
  };

  // A preset may carry what the bar RESOLVES per render, never what the daemon REGISTERS per process.
  test.each(["segments", "variables", "actions", "helpers"])(
    "a preset may not carry %s — the cap names the two legal sections",
    (section) => {
      const msg = parseIssues(`{ presets: { wide: { ${section}: {} } } }`);
      expect(msg).toContain(`Unknown preset key "${section}"`);
      expect(msg).toContain("root, globals");
    },
  );

  test("a preset may not select a preset, and the error says why", () => {
    const msg = parseIssues(
      `{ presets: { wide: { globals: { preset: 'other' } } } }`,
    );
    expect(msg).toContain("a preset cannot select a preset");
    expect(msg).toContain("globals.preset");
  });

  test("a non-object presets block is rejected", () => {
    expect(parseIssues(`{ presets: [] }`)).toContain(
      "presets must be an object mapping preset names to config fragments",
    );
  });

  test("a slash-bearing preset name is rejected at load, not at click time", () => {
    expect(parseIssues(`{ presets: { 'a/b': {} } }`)).toContain(
      "must be non-empty, slash-free, and newline-free",
    );
  });

  // A preset name is spliced as display text into a synthesized template literal whose escaper handles backslash/quote only.
  test("a newline-bearing preset name is rejected at load", () => {
    expect(parseIssues(`{ presets: { ${JSON.stringify("a\nb")}: {} } }`)).toContain(
      "must be non-empty, slash-free, and newline-free",
    );
  });

  // Two names collapsing to the same synthesis identifier would silently overwrite each other's synthesized action/segment.
  test("two preset names that collapse to the same synthesis identifier are rejected at load", () => {
    const msg = parseIssues(
      `{ presets: { 'quick-look': {}, 'quick_look': {} } }`,
    );
    expect(msg).toContain('"quick-look"');
    expect(msg).toContain('"quick_look"');
    expect(msg).toContain("collapse to the same synthesis identifier");
  });

  test("preset names that don't collide are unaffected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{ presets: { compact: {}, verbose: {} } }`,
        ALLOWED,
      ),
    ).not.toThrow();
  });

  // A preset's root goes through THE layout validator, inheriting every migration error the top-level root gets.
  test("a preset's root uses the same A-grammar validator as the top-level root", () => {
    const msg = parseIssues(
      `{ presets: { wide: { root: { cells: ['a'] } } } }`,
    );
    expect(msg).toContain("presets.wide.root.kind");
    expect(msg).toContain("use the terse A-grammar");
  });

  test("globals.preset naming an undeclared preset is a load error", () => {
    expect(
      parseIssues(`{ globals: { preset: 'nope' }, presets: { wide: {} } }`),
    ).toContain('globals.preset "nope" does not match any declared preset');
  });

  test("a preset staging an undeclared segment is a load error naming the preset", () => {
    const msg = parseIssues(
      `{ presets: { wide: { root: { v: ['ghost'] } } } }`,
    );
    expect(msg).toContain("presets.wide.root");
    expect(msg).toContain('"ghost" does not match any declared segment');
  });

  test("a valid two-preset config parses", () => {
    expect(() =>
      parseAndValidate(
        "<presets>",
        `{
          segments: { a: { template: ' A ' }, b: { template: ' B ' } },
          root: { v: ['a'] },
          presets: {
            wide: { root: { v: ['a', 'b'] } },
            tight: { globals: { padding: 0 } },
          },
        }`,
        ALLOWED,
      ),
    ).not.toThrow();
  });
});

// The tree a preset STAGES and the path it is DIAGNOSED under can drift: a preset
// with no `root` stages the config's root, authored at `root`, not under its name.
describe("preset compile diagnostics name the authored path", () => {
  const compileError = (src: string): string => {
    const config = parseAndValidate("<presets>", src, ALLOWED);
    const registry = new SourceRegistry(
      new VariableStore(),
      "",
      undefined,
      new SessionState(),
    );
    try {
      registerDslConfig(config, registry);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected a compile error");
  };

  test("a plain config's own root diagnoses under `root`, never presets.default", () => {
    const msg = compileError(`{
      segments: { hello: { template: 'hi', bg: 'surface', fg: 'foreground' } },
      root: { v: [{ seg: 'hello', when: '{{ oops ' }] },
    }`);
    expect(msg).toContain("root.children[0].when");
    expect(msg).not.toContain("presets.");
  });

  test("a preset's OWN root diagnoses under that preset's path", () => {
    const msg = compileError(`{
      segments: { hello: { template: 'hi', bg: 'surface', fg: 'foreground' } },
      root: { v: ['hello'] },
      presets: { wide: { root: { v: [{ seg: 'hello', when: '{{ oops ' }] } } },
    }`);
    expect(msg).toContain("presets.wide.root.children[0].when");
  });
});

// Mirrors the daemon's per-render order: the preset resolves FIRST, its globals feed everything else.
describe("preset selection — the arrangement the bar renders", () => {
  const SRC = `{
    globals: { palette: '${THEME}', padding: 1 },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      preset: { kind: 'state', key: 'preset', default: '${PRESET_FLOOR}' },
    },
    actions: { applyPreset: { set: 'preset', from: 'presets' } },
    segments: {
      alpha: { template: 'ALPHA', bg: 'surface', fg: 'foreground' },
      beta: { template: 'BETA', bg: 'surface', fg: 'foreground' },
      picker: { template: '{{ range presets }}{{ action "applyPreset" . }} {{ end }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: ['alpha', 'picker'] },
    presets: {
      both: { root: { v: ['alpha', 'beta', 'picker'] } },
      roomy: { globals: { padding: 4 } },
    },
  }`;

  function buildRuntime(src: string = SRC) {
    const config = parseAndValidate("<presets>", src, ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const disposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const resolve = (): { preset: string; padding: number } => {
      const preset = effectivePresetName(
        sessionState.get(SID, "preset"),
        config.globals.preset,
        config.presets,
      );
      return { preset, padding: presetGlobals(config, preset).padding ?? 1 };
    };
    const render = (): string => {
      const { preset, padding } = resolve();
      return renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, preset: { effective: preset } },
        paletteForThemeName(THEME),
        { ...OPTS, padding },
        undefined,
        { preset },
      );
    };
    const dispose = (): void => {
      for (const d of disposers) d();
      registry.dispose();
    };
    return { config, sessionState, resolve, render, dispose };
  }

  const clickPreset = (sessionState: SessionState, preset: string): void => {
    clickUrl(effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "preset", preset] }]), testVerbContext(sessionState));
  };

  test("with no pick, the floor renders the config's own root", () => {
    const rt = buildRuntime();
    try {
      expect(rt.resolve().preset).toBe(PRESET_FLOOR);
      const out = rt.render();
      expect(out).toContain("ALPHA");
      expect(out).not.toContain("BETA");
    } finally {
      rt.dispose();
    }
  });

  test("a session pick restages the layout — the click drives the real wire", () => {
    const rt = buildRuntime();
    try {
      clickPreset(rt.sessionState, "both");
      expect(rt.resolve().preset).toBe("both");
      const out = rt.render();
      expect(out).toContain("ALPHA");
      expect(out).toContain("BETA");
    } finally {
      rt.dispose();
    }
  });

  test("a config literal (globals.preset) selects without any session pick", () => {
    const rt = buildRuntime(SRC.replace("padding: 1", "padding: 1, preset: 'both'"));
    try {
      expect(rt.resolve().preset).toBe("both");
      expect(rt.render()).toContain("BETA");
    } finally {
      rt.dispose();
    }
  });

  test("a session pick beats the config literal — the chain's last layer wins", () => {
    const rt = buildRuntime(SRC.replace("padding: 1", "padding: 1, preset: 'both'"));
    try {
      clickPreset(rt.sessionState, PRESET_FLOOR);
      expect(rt.resolve().preset).toBe(PRESET_FLOOR);
      expect(rt.render()).not.toContain("BETA");
    } finally {
      rt.dispose();
    }
  });

  test("a preset's globals shallow-merge over the config's, per field", () => {
    const rt = buildRuntime();
    try {
      expect(rt.resolve().padding).toBe(1);
      clickPreset(rt.sessionState, "roomy");
      expect(rt.resolve().padding).toBe(4);
      // The fragment is a DELTA, not a replacement.
      const out = rt.render();
      expect(out).toContain("ALPHA");
      expect(out).not.toContain("BETA");
      expect(presetGlobals(rt.config, "roomy").palette).toBe(THEME);
    } finally {
      rt.dispose();
    }
  });

  // [LAW:no-silent-failure] A name a prior config admitted must not throw, nor render an arrangement a label misnames.
  test("a stale session pick collapses to the floor, visibly", () => {
    const rt = buildRuntime();
    try {
      rt.sessionState.set(SID, "preset", "deleted-preset");
      expect(rt.resolve().preset).toBe(PRESET_FLOOR);
      expect(() => rt.render()).not.toThrow();
      expect(rt.render()).toContain("ALPHA");
      expect(rt.render()).not.toContain("BETA");
    } finally {
      rt.dispose();
    }
  });

  test("`presets` is a per-config domain in the rendered options AND the wire gate", () => {
    const rt = buildRuntime();
    try {
      const gates = deriveActionValidators(rt.config).filter(
        (g) => g.key === "preset",
      );
      expect(gates).toHaveLength(1);
      for (const name of [PRESET_FLOOR, "both", "roomy"]) {
        expect(gates[0]!.spec).toMatchObject({
          kind: "allow-list",
          allowed: expect.arrayContaining([name]),
        });
      }
      const rendered = rt.render();
      for (const name of [PRESET_FLOOR, "both", "roomy"]) {
        expect(rendered).toContain(name);
      }
    } finally {
      rt.dispose();
    }
  });
});

describe("cc-candybar check — presets", () => {
  const withConfigFile = async <T,>(
    body: string,
    fn: (p: string) => Promise<T>,
  ): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-presets-"));
    const p = path.join(dir, ".cc-candybar.json5");
    fs.writeFileSync(p, body);
    try {
      return await fn(p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a preset naming a nonexistent segment is FATAL, and the message locates it", async () => {
    const outcome = await withConfigFile(
      `{ presets: { wide: { root: { v: ['directory', 'no-such-segment'] } } } }`,
      (p) => checkConfig(p),
    );
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind !== "fatal") throw new Error("unreachable");
    expect(outcome.message).toContain("presets.wide.root");
    expect(outcome.message).toContain(
      '"no-such-segment" does not match any declared segment',
    );
  });

  test("a preset staging only real segments is clean", async () => {
    const outcome = await withConfigFile(
      `{ presets: { wide: { root: { v: ['directory'] } } } }`,
      (p) => checkConfig(p),
    );
    expect(outcome.kind).toBe("clean");
  });
});

describe("presetRoot — the path a preset's layout is authored at", () => {
  // Asked of the MERGED tree, before validateConfig materializes an explicit root per preset.
  const merged = (src: string) =>
    mergeWithDefault(parseDslConfig("<presets>", src, ALLOWED), DEFAULT_DSL_CONFIG);

  test("an empty rows map restages nothing: the preset renders the config's root, authored at `root`", () => {
    const cfg = merged(`{ presets: { P: { root: { rows: {} } } } }`);
    expect(presetRoot(cfg, "P")).toEqual({ node: rootNode(cfg.root), path: "root" });
  });

  test("a rows fragment restages: the inherited rows keep their place and the new row appends, authored at the preset", () => {
    const cfg = merged(
      `{ segments: { extra: { template: 'x' } }, presets: { P: { root: { rows: { extra: { h: ['extra'] } } } } } }`,
    );
    const { node, path } = presetRoot(cfg, "P");
    expect(path).toBe("presets.P.root");
    expect(node.when).toBeUndefined();
    expect(node.children).toEqual([
      ...rootNode(cfg.root).children,
      {
        kind: "container",
        direction: "horizontal",
        children: [{ kind: "segment", name: "extra" }],
      },
    ]);
  });

  test("a `when` alone restages: it gates the whole bar, so the layout is authored at the preset", () => {
    const cfg = merged(
      `{ presets: { P: { root: { rows: {}, when: '{{ .x }}' } } } }`,
    );
    const { node, path } = presetRoot(cfg, "P");
    expect(path).toBe("presets.P.root");
    expect(node.when).toBe("{{ .x }}");
    expect(node.children).toEqual(rootNode(cfg.root).children);
  });

  test("a `distribution` alone restages: it re-places the rows, so the layout is authored at the preset", () => {
    const cfg = merged(
      `{ presets: { P: { root: { rows: {}, distribution: 'monotonic' } } } }`,
    );
    const { node, path } = presetRoot(cfg, "P");
    expect(path).toBe("presets.P.root");
    expect(node.distribution).toBe("monotonic");
    expect(node.children).toEqual(rootNode(cfg.root).children);
  });

  test("a rows fragment's unknown distribution is the load error a container's is", () => {
    expect(() =>
      merged(`{ presets: { P: { root: { rows: {}, distribution: 'spiral' } } } }`),
    ).toThrow(
      /distribution must be one of: van-der-corput, golden-angle, ends-interleaved, monotonic, uniform; got "spiral"/,
    );
  });
});
