// [LAW:single-enforcer] Drives the real spine — loader, render, click dispatch — no parallel test rig.

import { ownValidators } from "./helpers/ambient-chrome";
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
  validateConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  effectiveLookName,
  effectiveThemeName,
  lookKeyByName,
  paletteForThemeName,
} from "../src/themes";

const SID = "s-looks";
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

// These are the loader's exact error strings — also quoted by docs/interaction-authoring.md.
describe("looks block — loader validation", () => {
  const parseIssues = (src: string): string => {
    try {
      parseDslConfig("<looks>", src, ALLOWED);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).message;
    }
    throw new Error("expected ConfigError");
  };

  test("unknown axis is rejected with the four-axis vocabulary", () => {
    expect(parseIssues(`{ looks: { neon: { saturation: 2 } } }`)).toContain(
      'Unknown look key "saturation". Expected one of: hueShift, chromaScale, lightnessScale, lightnessShift',
    );
  });

  test("negative chromaScale is rejected (chroma is a >= 0 multiplier)", () => {
    expect(parseIssues(`{ looks: { neon: { chromaScale: -1 } } }`)).toContain(
      "chromaScale must be a finite number >= 0, got -1",
    );
  });

  test("non-finite axis is rejected (JSON5 admits NaN/Infinity literals)", () => {
    expect(
      parseIssues(`{ looks: { neon: { hueShift: Infinity } } }`),
    ).toContain("hueShift must be a finite number, got Infinity");
  });

  test("non-numeric axis is rejected", () => {
    expect(
      parseIssues(`{ looks: { neon: { lightnessShift: "up" } } }`),
    ).toContain('lightnessShift must be a finite number, got "up"');
  });

  test("a slash-bearing look name is rejected with the wire-shape reason", () => {
    expect(parseIssues(`{ looks: { "a/b": {} } }`)).toContain(
      'look name "a/b" must be non-empty and slash-free',
    );
  });

  test("a non-object look value is rejected", () => {
    expect(parseIssues(`{ looks: { neon: 3 } }`)).toContain(
      "looks.neon must be an object, got number",
    );
  });

  test("globals.look must name a declared look on the MERGED config", () => {
    const merged = mergeWithDefault(
      parseDslConfig("<looks>", `{ globals: { look: "vapor" } }`, ALLOWED),
      DEFAULT_DSL_CONFIG,
    );
    expect(() => validateConfig(merged, "<looks>", "", ALLOWED)).toThrow(
      /globals\.look "vapor" does not match any declared look \(have: none, vivid, muted, dim, bright, inverted\)/,
    );
  });

  test("globals.look naming a BUNDLED look passes (cross-ref runs post-merge)", () => {
    const merged = mergeWithDefault(
      parseDslConfig("<looks>", `{ globals: { look: "vivid" } }`, ALLOWED),
      DEFAULT_DSL_CONFIG,
    );
    expect(() => validateConfig(merged, "<looks>", "", ALLOWED)).not.toThrow();
  });
});

describe("looks block — normalization and merge", () => {
  test("absent axes normalize to identity at parse (a full ThemeKey downstream)", () => {
    const raw = parseDslConfig(
      "<looks>",
      `{ looks: { vapor: { hueShift: 30 } } }`,
      ALLOWED,
    );
    expect(raw.looks).toEqual({
      vapor: {
        hueShift: 30,
        chromaScale: 1,
        lightnessScale: 1,
        lightnessShift: 0,
      },
    });
  });

  test("the bundled stdlib survives every merge; user wins per name", () => {
    const raw = parseDslConfig(
      "<looks>",
      `{ looks: { vivid: { chromaScale: 2 }, mine: { hueShift: 10 } } }`,
      ALLOWED,
    );
    const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
    // The identity floor is always present — the collapse target can't be merged away.
    expect(merged.looks.none).toEqual({
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: 1,
      lightnessShift: 0,
    });
    expect(merged.looks.vivid?.chromaScale).toBe(2);
    expect(merged.looks.mine?.hueShift).toBe(10);
    expect(Object.keys(merged.looks)).toEqual(
      expect.arrayContaining([
        "none",
        "vivid",
        "muted",
        "dim",
        "bright",
        "inverted",
        "mine",
      ]),
    );
  });
});

describe('from: "looks" — rendered options and the derived gate share the config', () => {
  const SRC = `{
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      look: { kind: 'state', key: 'look', default: 'none' },
    },
    actions: { applyLook: { set: 'look', from: 'looks' } },
    looks: { none: {}, vapor: { hueShift: 40 }, washed: { chromaScale: 0.3 } },
    segments: {
      picker: { template: '{{ range looks }}{{ action "applyLook" . }} {{ end }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: ['picker'] },
  }`;

  test("deriveActionValidators gates key `look` to exactly the declared names", () => {
    const config = parseAndValidate("<looks>", SRC, ALLOWED);
    expect(ownValidators(config, deriveActionValidators(config))).toEqual([
      {
        key: "look",
        spec: {
          kind: "allow-list",
          allowed: ["none", "vapor", "washed"],
        },
      },
    ]);
  });

  test("the looks() binding renders one option region per declared name", () => {
    const config = parseAndValidate("<looks>", SRC, ALLOWED);
    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
    const compiled = registerDslConfig(config, registry);
    try {
      const rendered = renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID },
        paletteForThemeName(THEME),
        OPTS,
      );
      // Same names the gate above allows, read from the same config map.
      for (const name of ["none", "vapor", "washed"]) {
        expect(rendered).toContain(name);
      }
    } finally {
      registry.dispose();
    }
  });
});

// Mirrors the daemon's per-render resolution verbatim; the click drives the REAL wire.
describe("look click — live whole-bar recolor over the active theme", () => {
  const SRC = `{
    globals: { palette: '${THEME}' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      look: { kind: 'state', key: 'look', default: 'none' },
    },
    actions: { applyLook: { set: 'look', from: 'looks' } },
    looks: { none: {}, inverted: { lightnessScale: -1, lightnessShift: 1 } },
    segments: {
      plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
      pinned: { template: ' ▣ pinned ', bg: 'surface', fg: 'foreground', palette: '${THEME}' },
      picker: { template: '{{ range looks }}{{ action "applyLook" . }} {{ end }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: ['plain', 'pinned', 'picker'] },
  }`;

  function buildRuntime() {
    const config = parseAndValidate("<looks>", SRC, ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    // Mirrors the daemon's gate install so the click below hits the real validator.
    const disposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const render = (): string => {
      const basePalette = paletteForThemeName(
        effectiveThemeName(undefined, 
          sessionState.get(SID, "theme"),
          config.globals.palette,
        ),
      );
      const effectiveLook = effectiveLookName(undefined, 
        sessionState.get(SID, "look"),
        config.globals.look,
        config.looks,
      );
      return renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID },
        basePalette,
        OPTS,
        undefined,
        { look: lookKeyByName(config.looks, effectiveLook) },
      );
    };
    const dispose = (): void => {
      for (const d of disposers) d();
      registry.dispose();
    };
    return { sessionState, render, dispose };
  }

  const clickLook = (sessionState: SessionState, look: string): void => {
    clickUrl(
      effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "look", look] }]),
      testVerbContext(sessionState),
    );
  };

  // Row-scoped: each root row holds exactly one segment, so its first bg SGR is that segment's.
  const bgOf = (rendered: string, marker: string): string => {
    const line = rendered.split("\n").find((l) => l.includes(marker));
    expect(line).toBeDefined();
    const m = line!.match(/48;2;(\d+;\d+;\d+)/);
    expect(m).not.toBeNull();
    return m![1]!;
  };

  test("clicking a look recolors an ordinary segment; clicking none restores", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      const before = bgOf(render(), "◆ here");
      clickLook(sessionState, "inverted");
      const adapted = bgOf(render(), "◆ here");
      expect(adapted).not.toBe(before);
      clickLook(sessionState, "none");
      expect(bgOf(render(), "◆ here")).toBe(before);
    } finally {
      dispose();
    }
  });

  test("an explicit per-segment palette: pin IGNORES the look", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      const before = bgOf(render(), "▣ pinned");
      clickLook(sessionState, "inverted");
      expect(bgOf(render(), "▣ pinned")).toBe(before);
    } finally {
      dispose();
    }
  });

  test("a stale session look collapses to the none floor instead of crashing", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      const before = bgOf(render(), "◆ here");
      // Bypasses the click gate to model a leftover value an older config's vocabulary admitted.
      sessionState.set(SID, "look", "vapor");
      expect(bgOf(render(), "◆ here")).toBe(before);
    } finally {
      dispose();
    }
  });
});

describe("effectiveLookName / lookKeyByName", () => {
  const LOOKS = {
    none: { hueShift: 0, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
    vivid: {
      hueShift: 0,
      chromaScale: 1.5,
      lightnessScale: 1,
      lightnessShift: 0,
    },
  };

  test("session over config default over the none floor", () => {
    expect(effectiveLookName(undefined, "vivid", "none", LOOKS)).toBe("vivid");
    expect(effectiveLookName(undefined, null, "vivid", LOOKS)).toBe("vivid");
    expect(effectiveLookName(undefined, null, undefined, LOOKS)).toBe("none");
  });

  test("a name outside the declared set collapses to none", () => {
    expect(effectiveLookName(undefined, "vapor", undefined, LOOKS)).toBe("none");
    expect(effectiveLookName(undefined, null, "vapor", LOOKS)).toBe("none");
  });

  test("lookKeyByName throws loudly on a non-member (broken merge invariant)", () => {
    expect(lookKeyByName(LOOKS, "vivid")).toEqual(LOOKS.vivid);
    expect(() => lookKeyByName(LOOKS, "vapor")).toThrow(
      /Look "vapor" is not declared in this config/,
    );
  });
});
