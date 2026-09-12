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
  decideLookName,
  resolveThemeSelection,
  resolveLookSelection,
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

// ─── Normalization + merge ────────────────────────────────────────────────────

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
// from resolveThemeSelection, the look ThemeKey from effectiveLookName →
// lookKeyByName, threaded into renderDsl. The click drives the REAL wire.
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
    // The daemon's cache installs the derived gate at config load; mirror it so
    // the click below passes through the real validator.
    const disposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const render = (): string => {
      const theme = resolveThemeSelection(
        undefined,
        sessionState.get(SID, "theme"),
        config.globals.palette,
      );
      const look = resolveLookSelection(
        undefined,
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
        OPTS,
        undefined,
        { theme, look },
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

// ─── A look chosen by data (brandon-looks-pe6) ────────────────────────────────

// [LAW:behavior-not-structure] The claim is that the WHOLE BAR is transposed by
// what an expression in `globals.look` evaluates to, per render, and that the
// precedence the three name rungs already had is unchanged — a session pick
// still outranks it. Every assertion measures a serialized background SGR (the
// colour the terminal receives) or the load-time refusal, never which function
// computed the choice.
//
// The rig mirrors the daemon verbatim: `resolveLookSelection` over the three
// rungs, threaded into renderDsl as `RenderSelection.look`, exactly as
// buildRenderPayload → server.ts does.
describe("globals.look as an expression — a look chosen by data", () => {
  // The expression reads a payload field, which is the point: `.context.pct` is
  // stand-in for the rate-limit/idle facts the ticket names. Two declared looks
  // that are visibly different, plus the identity floor.
  const SRC = `{
    globals: {
      palette: '${THEME}',
      look: '{{ if ge (int .ctx.pct) 80 }}inverted{{ else if ge (int .ctx.pct) 40 }}washed{{ else }}none{{ end }}',
    },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      // No \`look\` state var here on purpose: a SCALAR at \`look\` would shadow the
      // \`look.*\` namespace the label below reads, the same way a json document
      // owns its dotted prefix. The bundled config avoids it by namespacing the
      // synthesized picks under \`settings.\`.
      'ctx.pct': { kind: 'input', path: 'ctx.pct', type: 'number', default: 0 },
      'look.effective': { kind: 'input', path: 'look.effective', default: '' },
    },
    looks: {
      none: {},
      washed: { chromaScale: 0.2 },
      inverted: { lightnessScale: -1, lightnessShift: 1 },
    },
    segments: {
      plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
      label: { template: 'L={{ .look.effective }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: ['plain', 'label'] },
  }`;

  function buildRuntime(src = SRC) {
    const config = parseAndValidate("<looks-expr>", src, ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const render = (pct: number, staged?: string): string =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, ctx: { pct }, look: { effective: "none" } },
        OPTS,
        undefined,
        {
          look: resolveLookSelection(
            staged,
            sessionState.get(SID, "look"),
            config.globals.look,
            config.looks,
          ),
        },
      );
    return { sessionState, render, dispose: () => registry.dispose() };
  }

  // The bg SGR of the row carrying a marker — the same row-scoped measure the
  // click tests above use.
  const bgOf = (rendered: string, marker: string): string => {
    const line = rendered.split("\n").find((l) => l.includes(marker));
    expect(line).toBeDefined();
    const m = line!.match(/48;2;(\d+;\d+;\d+)/);
    expect(m).not.toBeNull();
    return m![1]!;
  };
  // What the same bar looks like under a look chosen by NAME — the reference
  // every expression result is checked against, so "it changed colour" is never
  // mistaken for "it changed to the right colour".
  const byName = (name: string): string => {
    const { render, dispose } = buildRuntime(
      SRC.replace(/look: '\{\{[^']*\}\}',/, `look: '${name}',`),
    );
    try {
      return bgOf(render(0), "◆ here");
    } finally {
      dispose();
    }
  };

  test("the expression is evaluated per render, and its result transposes the whole bar", () => {
    const { render, dispose } = buildRuntime();
    try {
      // Each band lands on the SAME colour the named look produces — not merely
      // a different colour from its neighbour.
      expect(bgOf(render(10), "◆ here")).toBe(byName("none"));
      expect(bgOf(render(50), "◆ here")).toBe(byName("washed"));
      expect(bgOf(render(90), "◆ here")).toBe(byName("inverted"));
      // Per render, not once per config: the same runtime moves both ways.
      expect(bgOf(render(10), "◆ here")).toBe(byName("none"));
    } finally {
      dispose();
    }
  });

  test("look.effective reports what the expression chose, so the label cannot disagree with the bar", () => {
    const { render, dispose } = buildRuntime();
    try {
      expect(render(90)).toContain("L=inverted");
      expect(render(50)).toContain("L=washed");
      expect(render(10)).toContain("L=none");
    } finally {
      dispose();
    }
  });

  // [LAW:one-source-of-truth] The ticket's hard requirement: precedence stays
  // exactly as it is. A session pick is decided by the user AFTER the config was
  // written, so it outranks the expression — and the expression is not consulted
  // at all, which is what makes an explicit pick of the FLOOR hold.
  test("a session pick outranks the expression", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      sessionState.set(SID, "look", "washed");
      expect(bgOf(render(90), "◆ here")).toBe(byName("washed"));
      expect(render(90)).toContain("L=washed");
      // The case a floor-equality test would get wrong: picking "none" is a
      // DECISION, not the absence of one, so a hot payload must not recolour.
      sessionState.set(SID, "look", "none");
      expect(bgOf(render(90), "◆ here")).toBe(byName("none"));
    } finally {
      dispose();
    }
  });

  test("a staged (edit-mode) look outranks the expression too", () => {
    const { render, dispose } = buildRuntime();
    try {
      expect(bgOf(render(90, "washed"), "◆ here")).toBe(byName("washed"));
    } finally {
      dispose();
    }
  });

  // [LAW:no-silent-failure] but also: not a throw. A typo in an expression's
  // result is the same class of mistake as a stale session look, and collapses
  // the same way — the bar keeps rendering.
  test("a result naming no declared look collapses to the none floor, and the bar renders", () => {
    const { render, dispose } = buildRuntime(
      SRC.replace(/look: '\{\{[^']*\}\}',/, `look: '{{ "vapor" }}',`),
    );
    try {
      const out = render(90);
      expect(bgOf(out, "◆ here")).toBe(byName("none"));
      expect(out).toContain("L=none");
    } finally {
      dispose();
    }
  });

  // Found by a mutation that did NOT bite: replacing the floor LOOKUP with the
  // identity key changed nothing, because every config in this file declares
  // `none: {}` — which normalizes to the identity, so the two are the same value.
  // `looks` merges BY NAME, so a user's own `none` is authorable and IS the floor;
  // without this case the lookup could be deleted and no test would notice.
  test("the floor is the config's own `none`, not a hardcoded identity", () => {
    const OWN_FLOOR = SRC.replace(
      "none: {},",
      "none: { lightnessScale: -1, lightnessShift: 1 },",
    );
    // An expression naming no declared look collapses to the floor — and the
    // floor here is a real transformation, so the bar must actually wear it.
    const { render, dispose } = buildRuntime(
      OWN_FLOOR.replace(/look: '\{\{[^']*\}\}',/, `look: '{{ "vapor" }}',`),
    );
    // The same bar with `none` named outright: the floor's own colour.
    const ref = buildRuntime(
      OWN_FLOOR.replace(/look: '\{\{[^']*\}\}',/, `look: 'none',`),
    );
    try {
      expect(bgOf(render(90), "◆ here")).toBe(bgOf(ref.render(0), "◆ here"));
      // And it is NOT the identity — which is what makes the assertion above
      // discriminate between reading the config and assuming the identity.
      const identity = buildRuntime(
        SRC.replace(/look: '\{\{[^']*\}\}',/, `look: 'none',`),
      );
      try {
        expect(bgOf(render(90), "◆ here")).not.toBe(
          bgOf(identity.render(0), "◆ here"),
        );
      } finally {
        identity.dispose();
      }
    } finally {
      dispose();
      ref.dispose();
    }
  });

  // Also found by a non-biting mutation: nothing observed the value pushed for
  // `look.effective` BEFORE the expression runs, because the republish overwrites
  // it before any segment renders. The one thing that can observe it is the
  // expression itself, so the documented answer for a self-reference — the floor,
  // i.e. what naming nothing would give you — is pinned here rather than asserted
  // in a comment.
  test("a look expression reading .look.effective sees the floor, not a stale name", () => {
    const { sessionState, render, dispose } = buildRuntime(
      SRC.replace(
        /look: '\{\{[^']*\}\}',/,
        `look: '{{ if eq .look.effective "none" }}inverted{{ else }}washed{{ end }}',`,
      ),
    );
    try {
      expect(bgOf(render(0), "◆ here")).toBe(byName("inverted"));
      expect(render(0)).toContain("L=inverted");
      // Still the floor on the NEXT render, not the previous render's answer —
      // the provisional is a constant, not a carried-over value.
      expect(bgOf(render(0), "◆ here")).toBe(byName("inverted"));
      // And a session pick still wins, so the expression is not even consulted.
      sessionState.set(SID, "look", "washed");
      expect(bgOf(render(0), "◆ here")).toBe(byName("washed"));
    } finally {
      dispose();
    }
  });

  // The load-time half. Shape-detection (a `{{` in the slot) is what tells an
  // expression from a name, so the membership cross-ref must not fire on one —
  // and the template must be PARSED at load, or a malformed one would first be
  // heard about at render, on every render.
  test("an expression is exempt from the membership cross-ref; a plain non-member still is not", () => {
    const withExpr = mergeWithDefault(
      parseDslConfig(
        "<looks-expr>",
        `{ globals: { look: '{{ .x }}' } }`,
        ALLOWED,
      ),
      DEFAULT_DSL_CONFIG,
    );
    expect(() =>
      validateConfig(withExpr, "<looks-expr>", "", ALLOWED),
    ).not.toThrow();
    const withName = mergeWithDefault(
      parseDslConfig("<looks-expr>", `{ globals: { look: "vapor" } }`, ALLOWED),
      DEFAULT_DSL_CONFIG,
    );
    expect(() => validateConfig(withName, "<looks-expr>", "", ALLOWED)).toThrow(
      /globals\.look "vapor" does not match any declared look/,
    );
  });

  test("a malformed look expression fails at LOAD, not at render", () => {
    const config = parseAndValidate(
      "<looks-expr>",
      SRC.replace(/look: '\{\{[^']*\}\}',/, `look: '{{ if .ctx.pct }}hot',`),
      ALLOWED,
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
    try {
      expect(() => registerDslConfig(config, registry)).toThrow(
        /globals\.look/,
      );
    } finally {
      registry.dispose();
    }
  });
});

// ─── resolveLookSelection: the fold, and where it stops ───────────────────────

describe("resolveLookSelection", () => {
  const LOOKS = {
    none: { hueShift: 0, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
    vivid: {
      hueShift: 0,
      chromaScale: 1.5,
      lightnessScale: 1,
      lightnessShift: 0,
    },
  };
  const EXPR = "{{ .a }}";

  test("a plain name decides, carrying both the name and its key", () => {
    expect(resolveLookSelection(undefined, null, "vivid", LOOKS)).toEqual({
      kind: "decided",
      name: "vivid",
      value: LOOKS.vivid,
    });
  });

  test("an expression is undecided only when no higher rung decided", () => {
    expect(resolveLookSelection(undefined, null, EXPR, LOOKS)).toEqual({
      kind: "expression",
      source: EXPR,
    });
    // A session pick decides, so the expression is never reached — including a
    // pick of the floor name itself.
    expect(resolveLookSelection(undefined, "vivid", EXPR, LOOKS)).toEqual({
      kind: "decided",
      name: "vivid",
      value: LOOKS.vivid,
    });
    expect(resolveLookSelection(undefined, "none", EXPR, LOOKS)).toEqual({
      kind: "decided",
      name: "none",
      value: LOOKS.none,
    });
    // A staged fragment is the rightmost rung and decides over both.
    expect(resolveLookSelection("vivid", null, EXPR, LOOKS)).toEqual({
      kind: "decided",
      name: "vivid",
      value: LOOKS.vivid,
    });
  });

  test("a stale name at any rung falls through to the next, never to an expression it outranks", () => {
    // A stale session pick is no pick, so the expression below it is reached.
    expect(resolveLookSelection(undefined, "vapor", EXPR, LOOKS)).toEqual({
      kind: "expression",
      source: EXPR,
    });
    // With no expression, a stale name collapses to the floor as it always did.
    expect(resolveLookSelection(undefined, "vapor", undefined, LOOKS)).toEqual({
      kind: "decided",
      name: "none",
      value: LOOKS.none,
    });
  });
});
