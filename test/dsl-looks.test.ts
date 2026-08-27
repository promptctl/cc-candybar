// [LAW:verifiable-goals] brandon-themes-07p done-gates: (1) a `looks` block
// loads/validates loudly; (2) an action `{ set: "look", from: "looks" }` ranges
// the config's look names in BOTH the rendered options and the derived wire
// gate (one source, no drift); (3) clicking a look recolors the whole bar live,
// COMPOSING with the active theme (session look over config default over the
// "none" identity floor); (4) an explicit per-segment `palette:` pin ignores
// the look, exactly as it ignores the session theme; (5) a stale session look
// (a name a prior config's vocabulary admitted) collapses to "none".
//
// [LAW:single-enforcer] Drives the real spine — parse/merge/validate for the
// loader, registerDslConfig + renderDsl for rendering, deriveActionValidators +
// registerStateValidator + the real dispatch for the click, and the same
// effectiveLookName/lookKeyByName the daemon calls. No parallel rig.

import { ownValidators } from "./helpers/ambient-chrome";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { clickUrl } from "./helpers/click";
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

// ─── Loader validation ────────────────────────────────────────────────────────

// The loader's real error text — the same strings docs/interaction-authoring.md
// quotes and `cc-candybar check` prints.
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
    expect(parseIssues(`{ looks: { neon: { hueShift: Infinity } } }`)).toContain(
      "hueShift must be a finite number, got Infinity",
    );
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

// ─── Normalization + merge ────────────────────────────────────────────────────

describe("looks block — normalization and merge", () => {
  test("absent axes normalize to identity at parse (a full ThemeKey downstream)", () => {
    const raw = parseDslConfig(
      "<looks>",
      `{ looks: { vapor: { hueShift: 30 } } }`,
      ALLOWED,
    );
    expect(raw.looks).toEqual({
      vapor: { hueShift: 30, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
    });
  });

  test("the bundled stdlib survives every merge; user wins per name", () => {
    const raw = parseDslConfig(
      "<looks>",
      `{ looks: { vivid: { chromaScale: 2 }, mine: { hueShift: 10 } } }`,
      ALLOWED,
    );
    const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
    // The identity floor is always present — effectiveLookName's collapse
    // target cannot be merged away.
    expect(merged.looks.none).toEqual({
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: 1,
      lightnessShift: 0,
    });
    // User override wins per name; user addition lands beside the stdlib.
    expect(merged.looks.vivid?.chromaScale).toBe(2);
    expect(merged.looks.mine?.hueShift).toBe(10);
    expect(Object.keys(merged.looks)).toEqual(
      expect.arrayContaining(["none", "vivid", "muted", "dim", "bright", "inverted", "mine"]),
    );
  });
});

// ─── Options + derived gate: one source ───────────────────────────────────────

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
    expect(ownValidators(deriveActionValidators(config))).toEqual([
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
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
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
      // Each look name appears as a clickable region writing itself to `look` —
      // the same names the gate above allows, from the same config map.
      for (const name of ["none", "vapor", "washed"]) {
        expect(rendered).toContain(name);
      }
    } finally {
      registry.dispose();
    }
  });
});

// ─── Live recolor: the whole loop, composing with the theme ───────────────────

// Mirrors the daemon's per-render resolution verbatim (server.ts): basePalette
// from effectiveThemeName, the look ThemeKey from effectiveLookName →
// lookKeyByName, threaded into renderDsl. The click drives the REAL wire.
describe("look click — live whole-bar recolor over the active theme", () => {
  const SRC = `{
    globals: { palette: '${THEME}' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      look: { kind: 'state', key: 'look', default: 'none' },
      'hue.step': { kind: 'literal', value: 14 },
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
    // The daemon's cache installs the derived gate at config load; mirror it so
    // the click below passes through the real validator.
    const disposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const render = (): string => {
      const basePalette = paletteForThemeName(
        effectiveThemeName(sessionState.get(SID, "theme"), config.globals.palette),
      );
      const effectiveLook = effectiveLookName(
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
      { sessionState, dlog: () => {} },
    );
  };

  // The bg SGR of the row containing the named glyph run. Row-scoped: each
  // root row holds exactly one segment here, so the row's first bg SGR IS that
  // segment's background (a whole-render scan would match the first row's bg
  // for every marker).
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
      // The inverted look flips lightness — the surface color must move.
      expect(adapted).not.toBe(before);
      // "none" is the identity look, not a special case: byte-exact restore
      // (rich-js isIdentityKey fast-paths the identity transposition).
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
      // The pinned segment's colors are frozen by author intent — the look
      // adapts everything else (the plain segment moved; asserted above).
      expect(bgOf(render(), "▣ pinned")).toBe(before);
    } finally {
      dispose();
    }
  });

  test("a stale session look collapses to the none floor instead of crashing", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      const before = bgOf(render(), "◆ here");
      // A prior config's vocabulary admitted "vapor"; this config doesn't
      // declare it. Write it directly into SessionState (the gate would reject
      // it today — this models the leftover value, not a fresh click).
      sessionState.set(SID, "look", "vapor");
      expect(bgOf(render(), "◆ here")).toBe(before);
    } finally {
      dispose();
    }
  });
});

// ─── Policy: resolution and the loud name→key boundary ────────────────────────

describe("effectiveLookName / lookKeyByName", () => {
  const LOOKS = {
    none: { hueShift: 0, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
    vivid: { hueShift: 0, chromaScale: 1.5, lightnessScale: 1, lightnessShift: 0 },
  };

  test("session over config default over the none floor", () => {
    expect(effectiveLookName("vivid", "none", LOOKS)).toBe("vivid");
    expect(effectiveLookName(null, "vivid", LOOKS)).toBe("vivid");
    expect(effectiveLookName(null, undefined, LOOKS)).toBe("none");
  });

  test("a name outside the declared set collapses to none", () => {
    expect(effectiveLookName("vapor", undefined, LOOKS)).toBe("none");
    expect(effectiveLookName(null, "vapor", LOOKS)).toBe("none");
  });

  test("lookKeyByName throws loudly on a non-member (broken merge invariant)", () => {
    expect(lookKeyByName(LOOKS, "vivid")).toEqual(LOOKS.vivid);
    expect(() => lookKeyByName(LOOKS, "vapor")).toThrow(
      /Look "vapor" is not declared in this config/,
    );
  });
});
