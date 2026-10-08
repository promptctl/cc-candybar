// [LAW:verifiable-goals] brandon-themes-dzl done-gates: (1) `globals.palette`
// accepts a TEMPLATE, evaluated per render, so the bar's theme can follow data;
// (2) precedence comes out IDENTICAL to the style's — staged over session over the
// expression — and an explicit session pick of the FLOOR name still holds; (3)
// renderDsl is the one producer of `theme.effective`, so a label cannot disagree
// with the palette the bar wears; (4) an expression result naming no installed
// theme renders the floor AND SAYS SO, rather than throwing the bar away or
// repainting it in silence; (5) a malformed template is a LOAD error, and the
// loader's palette-name check exempts a rule in that slot while a per-segment
// `palette:` pin still refuses one.
//
// [LAW:single-enforcer] Drives the real spine — parse/merge/validate for the
// loader, registerDslConfig + renderDsl for rendering, and the same
// resolveThemeSelection the daemon calls. No parallel rig.
//
// [LAW:behavior-not-structure] Every colour assertion compares against the SAME
// bar rendered under that theme BY NAME, so "it changed colour" is never mistaken
// for "it changed to the right colour" — the discipline pe6's style-expression
// tests established one dimension over. And a cell's colour is read BY SEGMENT
// NAME off the `perSegmentSink` the daemon itself renders with, never as "the
// first background SGR on the row": every row leads with the synthesized `🍫`
// door, so a positional read measures the door's accent and would agree with
// itself while measuring the wrong cell.

import { stripAnsi } from "./helpers/ansi";
import { transposePalette, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { ConfigError } from "../src/config/dsl-loader";
import type { RichText } from "@promptctl/rich-js";
import {
  declaredBasePalette,
  decideThemeName,
  resolveStyleSelection,
  resolveThemeSelection,
  THEME_FLOOR,
} from "../src/themes";
import { resolvedStyle } from "../src/render/rich-theme.js";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";

const SID = "s-theme-expr";
// Four visibly different installed themes: the floor, plus three the expression
// picks between. Every one is in ALLOWED so the by-name reference configs load.
const NAMED = ["nord", "solarized-light", "dracula"] as const;
const ALLOWED = new Set<string>([THEME_FLOOR, ...NAMED, "tokyo-night"]);

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// The expression reads a payload field, which is the point: `.ctx.pct` stands in
// for the rate-limit/idle facts the ticket names ("this is the production
// checkout", "things are hot").
const RULE =
  "{{ if ge (int .ctx.pct) 80 }}dracula" +
  "{{ else if ge (int .ctx.pct) 40 }}solarized-light" +
  "{{ else }}nord{{ end }}";

const src = (palette: string, extra = ""): string => `{
  globals: { palette: '${palette}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'ctx.pct': { kind: 'input', path: 'ctx.pct', type: 'number', default: 0 },
    'theme.effective': { kind: 'input', path: 'theme.effective', default: '' },
  },
  ${extra}
  segments: {
    plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
    label: { template: 'T={{ .theme.effective }}', bg: 'surface', fg: 'foreground' },
  },
  root: { v: ['plain', 'label'] },
}`;

// One render: the bytes, plus each segment's own first-cell background.
interface Painted {
  readonly text: string;
  readonly bg: (segName: string) => string;
}

interface Runtime {
  readonly sessionState: SessionState;
  readonly warnings: readonly string[];
  render(pct: number, staged?: string): Painted;
  dispose(): void;
}

function buildRuntime(source = src(RULE)): Runtime {
  const config = parseAndValidate("<theme-expr>", source, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const warnings: string[] = [];
  const sink = new Map<string, readonly RichText[]>();
  const render = (pct: number, staged?: string): Painted => {
    const text = renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID, ctx: { pct } },
      OPTS,
      { perSegmentSink: sink, onRenderWarning: (m) => warnings.push(m) },
      {
        // Resolved exactly as src/daemon/server.ts resolves it.
        theme: resolveThemeSelection(
          staged,
          sessionState.get(SID, "theme"),
          config.globals.palette,
        ),
        style: resolveStyleSelection(
          undefined,
          sessionState.get(SID, "style"),
          config.globals.style,
          config.styles,
        ),
      },
    );
    // [LAW:no-ambient-temporal-coupling] Snapshot the sink HERE: renderDsl clears
    // it at the top of the next call, so a colour read deferred past that call
    // would measure a render this Painted never described.
    const bgs = new Map(
      [...sink].map(([name, cells]) => [
        name,
        (cells[0] && resolvedStyle(cells[0].style).bgcolor?.value?.hex) ?? "(no bg)",
      ]),
    );
    return {
      text,
      bg: (segName) => {
        const hex = bgs.get(segName);
        if (hex === undefined)
          throw new Error(`segment "${segName}" did not render`);
        return hex;
      },
    };
  };
  return { sessionState, warnings, render, dispose: () => registry.dispose() };
}

// What the same bar's `plain` cell looks like under that theme chosen BY NAME —
// the reference every expression result is checked against.
const byName = (name: string): string => {
  const { render, dispose } = buildRuntime(src(name));
  try {
    return render(0).bg("plain");
  } finally {
    dispose();
  }
};

describe("globals.palette as an expression — a theme chosen by data", () => {
  test("the expression is evaluated per render, and its result paints the whole bar", () => {
    const { render, dispose } = buildRuntime();
    try {
      // Each band lands on the SAME colour the named theme produces — not merely
      // a different colour from its neighbour.
      expect(render(10).bg("plain")).toBe(byName("nord"));
      expect(render(50).bg("plain")).toBe(byName("solarized-light"));
      expect(render(90).bg("plain")).toBe(byName("dracula"));
      // Per render, not once per config: the same runtime moves both ways.
      expect(render(10).bg("plain")).toBe(byName("nord"));
    } finally {
      dispose();
    }
  });

  test("theme.effective reports what the expression chose, so the label cannot disagree with the bar", () => {
    const { render, dispose } = buildRuntime();
    try {
      expect(stripAnsi(render(90).text)).toContain("T=dracula");
      expect(stripAnsi(render(10).text)).toContain("T=nord");
    } finally {
      dispose();
    }
  });

  test("a session pick outranks the expression", () => {
    const { sessionState, render, dispose } = buildRuntime();
    try {
      sessionState.set(SID, "theme", "tokyo-night");
      // pct 90 would have chosen dracula; the session pick holds at every value.
      expect(render(90).bg("plain")).toBe(byName("tokyo-night"));
      expect(stripAnsi(render(90).text)).toContain("T=tokyo-night");
    } finally {
      dispose();
    }
  });

  test("a session pick of the FLOOR name is a decision that holds, not a fall-through", () => {
    // The structural half of the precedence requirement: an expression can only
    // occupy the globals rung, so a higher rung deciding leaves no expression to
    // evaluate — even when what it decided IS the floor. A "did it come out as
    // the floor?" test would get this exact case wrong.
    const { sessionState, render, dispose } = buildRuntime();
    try {
      sessionState.set(SID, "theme", THEME_FLOOR);
      expect(render(90).bg("plain")).toBe(byName(THEME_FLOOR));
      expect(stripAnsi(render(90).text)).toContain(`T=${THEME_FLOOR}`);
    } finally {
      dispose();
    }
  });

  test("a staged (edit-mode) palette outranks the expression too", () => {
    const { render, dispose } = buildRuntime();
    try {
      expect(render(90, "tokyo-night").bg("plain")).toBe(byName("tokyo-night"));
    } finally {
      dispose();
    }
  });

  test("the rule composes with a style: the style transposes the rule's own base, once", () => {
    const STYLES = "styles: { none: {}, washed: { chromaScale: 0.2 } },";
    const { sessionState, render, dispose } = buildRuntime(src(RULE, STYLES));
    try {
      // [LAW:one-source-of-truth] The expectation is built with rich-js
      // `transposePalette` DIRECTLY, never `transposedPalette` — that memo keys on
      // the base palette's NAME, which transposition preserves, so computing the
      // expected value through it would hand back whatever the implementation
      // cached and the assertion would pass for any base
      // (memoized-expectation-masks-mutation).
      const washed = transposePalette(getThemePalette("dracula")!, {
        hueShift: 0,
        chromaScale: 0.2,
        lightnessScale: 1,
        lightnessShift: 0,
      });
      const want = washed.get("surface")!.hex;
      // Premise first: the unstyled bar must be the rule's own base, so "the style
      // moved it" is a claim about the style and not about the theme.
      const unlooked = render(90).bg("plain");
      expect(unlooked).toBe(byName("dracula"));
      sessionState.set(SID, "style", "washed");
      const looked = render(90).bg("plain");
      expect(looked).not.toBe(unlooked);
      expect(looked).toBe(want);
    } finally {
      dispose();
    }
  });

  test("a result naming no installed theme renders the floor, says so, and the bar still renders", () => {
    const rt = buildRuntime(
      src("{{ if ge (int .ctx.pct) 50 }}gruvbux-dark{{ else }}nord{{ end }}"),
    );
    try {
      // The good branch is unaffected and silent.
      expect(rt.render(10).bg("plain")).toBe(byName("nord"));
      expect(rt.warnings).toEqual([]);
      // The bad branch renders — the bar is never thrown away over a data value —
      // in the floor theme, and reports once, naming the slot and the bad name.
      const bad = rt.render(90);
      expect(bad.bg("plain")).toBe(byName(THEME_FLOOR));
      expect(stripAnsi(bad.text)).toContain(`T=${THEME_FLOOR}`);
      expect(rt.warnings).toHaveLength(1);
      expect(rt.warnings[0]).toContain("globals.palette");
      expect(rt.warnings[0]).toContain("gruvbux-dark");
      expect(rt.warnings[0]).toContain(THEME_FLOOR);
    } finally {
      rt.dispose();
    }
  });

  test("a rule reading .theme.effective sees the floor, not a stale name", () => {
    // Self-reference: the provisional push carries the floor, which is what a
    // rule naming nothing collapses to — never a value left over from the render
    // before, which would make one render's theme depend on its predecessor.
    const rt = buildRuntime(
      src('{{ if eq .theme.effective "" }}nord{{ else }}dracula{{ end }}'),
    );
    try {
      expect(rt.render(0).bg("plain")).toBe(byName("dracula"));
      // Twice, to prove the second render does not read the first's answer.
      expect(rt.render(0).bg("plain")).toBe(byName("dracula"));
      expect(stripAnsi(rt.render(0).text)).toContain("T=dracula");
    } finally {
      rt.dispose();
    }
  });

  test("registration does not resolve the rule as a palette NAME", () => {
    // The ActionRuntime's compile-only base palette went through
    // paletteForThemeName of `globals.palette`, which THROWS on a name it cannot
    // resolve — so a rule there would have failed at LOAD for a config that
    // renders perfectly well. `declaredBasePalette` is the one resolution.
    expect(() => buildRuntime().dispose()).not.toThrow();
    expect(declaredBasePalette(RULE).name).toBe(
      getThemePalette(THEME_FLOOR)!.name,
    );
    expect(declaredBasePalette("nord").name).toBe(
      getThemePalette("nord")!.name,
    );
    expect(declaredBasePalette(undefined).name).toBe(
      getThemePalette(THEME_FLOOR)!.name,
    );
  });

  test("an omitted theme selection renders what the CONFIG declares, not the floor", () => {
    // renderDsl takes no base-palette argument any more, so the default must be
    // the config's own declared theme — substituting the floor would silently
    // repaint every compile-only render (the demo, `cc-candybar check`, tests).
    const config = parseAndValidate("<theme-default>", src("nord"), ALLOWED);
    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
      const sink = new Map<string, readonly RichText[]>();
      const out = renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, ctx: { pct: 0 } },
        OPTS,
        { perSegmentSink: sink },
      );
      const plainBg = resolvedStyle(sink.get("plain")![0]!.style).bgcolor!.value!.hex;
      expect(plainBg).toBe(byName("nord"));
      expect(stripAnsi(out)).toContain("T=nord");
    } finally {
      registry.dispose();
    }
  });

  test("an omitted selection evaluates a RULE too, rather than falling to the floor", () => {
    const config = parseAndValidate("<theme-default-rule>", src(RULE), ALLOWED);
    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
      const sink = new Map<string, readonly RichText[]>();
      const out = renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, ctx: { pct: 90 } },
        OPTS,
        { perSegmentSink: sink },
      );
      const plainBg = resolvedStyle(sink.get("plain")![0]!.style).bgcolor!.value!.hex;
      expect(plainBg).toBe(byName("dracula"));
    } finally {
      registry.dispose();
    }
  });
});

describe("globals.palette as an expression — loader", () => {
  const load = (source: string): void => {
    parseAndValidate("<theme-expr-load>", source, ALLOWED);
  };

  test("a rule is exempt from the palette-name check; a plain unknown name is not", () => {
    expect(() => load(src(RULE))).not.toThrow();
    expect(() => load(src("no-such-theme"))).toThrow(ConfigError);
    expect(() => load(src("no-such-theme"))).toThrow(/Unknown palette/);
  });

  test("a retired theme name is refused with the theme that replaced it", () => {
    const retired = /"dark" was retired; write "textual-dark"/;
    expect(() => load(src("dark"))).toThrow(retired);
    const placed = src(THEME_FLOOR).replace(
      "root: { v: ['plain', 'label'] }",
      "root: { v: [{ seg: 'plain', settings: { theme: 'dark' } }, 'label'] }",
    );
    expect(() => load(placed)).toThrow(retired);
    expect(() => load(src("no-such-theme"))).not.toThrow(/was retired/);
  });

  test("a per-segment palette: pin still refuses a rule — it is frozen at registration", () => {
    // [LAW:one-type-per-behavior] The two slots differ in BEHAVIOUR now, so they
    // differ in spec: a pin can never be settled per render, so a rule there must
    // stay a load error rather than a value nothing will ever evaluate.
    const withPin = src(THEME_FLOOR).replace(
      "plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },",
      `plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground', palette: '${RULE}' },`,
    );
    expect(() => load(withPin)).toThrow(/Unknown palette/);
  });

  test("a malformed rule fails at LOAD, naming its own slot", () => {
    const config = parseAndValidate(
      "<theme-expr-bad>",
      src("{{ if ge (int .ctx.pct) 50 }}nord"),
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
      expect(() => registerDslConfig(config, registry, { cwd: process.cwd() })).toThrow(
        /globals\.palette is not a valid template/,
      );
    } finally {
      registry.dispose();
    }
  });
});

describe("resolveThemeSelection", () => {
  test("a plain name decides, carrying both the name and the palette it denotes", () => {
    expect(resolveThemeSelection(undefined, null, "nord")).toEqual({
      kind: "decided",
      name: "nord",
      value: getThemePalette("nord"),
    });
  });

  test("a session pick naming no installed theme falls through to the config rung", () => {
    expect(resolveThemeSelection(undefined, "dark", "nord")).toEqual({
      kind: "decided",
      name: "nord",
      value: getThemePalette("nord"),
    });
  });

  test("an expression is undecided only when no higher rung decided", () => {
    expect(resolveThemeSelection(undefined, null, RULE)).toEqual({
      kind: "expression",
      source: RULE,
    });
    expect(resolveThemeSelection(undefined, "nord", RULE)).toMatchObject({
      kind: "decided",
      name: "nord",
    });
    expect(resolveThemeSelection("dracula", null, RULE)).toMatchObject({
      kind: "decided",
      name: "dracula",
    });
  });

  test("a stale name at any rung falls through to the next, never to an expression it outranks", () => {
    // The theme used to parse its session rung with IDENTITY, so a name nothing
    // installs rode straight through to paletteForThemeName's throw. It now falls
    // through like every other field's — and the rung it falls to is the
    // expression, which is still the CONFIG's rung and must not be skipped.
    expect(resolveThemeSelection(undefined, "no-such-theme", RULE)).toEqual({
      kind: "expression",
      source: RULE,
    });
    expect(
      resolveThemeSelection(undefined, "no-such-theme", "nord"),
    ).toMatchObject({ kind: "decided", name: "nord" });
    // Nothing left below: the floor.
    expect(
      resolveThemeSelection(undefined, "no-such-theme", undefined),
    ).toMatchObject({ kind: "decided", name: THEME_FLOOR });
  });
});

describe("decideThemeName", () => {
  test("an installed name decides and reports nothing", () => {
    const said: string[] = [];
    expect(decideThemeName("nord", "globals.palette", (m) => said.push(m))).toMatchObject({
      kind: "decided",
      name: "nord",
    });
    expect(said).toEqual([]);
  });

  test("an unresolvable name yields the floor and reports once, naming the slot, the value and the consequence", () => {
    const said: string[] = [];
    const decided = decideThemeName("nope", "globals.palette", (m) => said.push(m));
    expect(decided).toMatchObject({ kind: "decided", name: THEME_FLOOR });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("globals.palette");
    expect(said[0]).toContain("nope");
    expect(said[0]).toContain(THEME_FLOOR);
  });

  test("a rule rendering a retired name is told the theme that replaced it", () => {
    const said: string[] = [];
    decideThemeName("light", "globals.palette", (m) => said.push(m));
    expect(said[0]).toMatch(/"light" was retired; write "textual-light"/);
  });
});

// brandon-themes-owl: the resolution reads the ACTIVE preset's globals over the
// config's, so a rule authored in a preset's `globals` is the config default's
// rule while that preset is active — and must be compiled like one. Resolved
// through `resolveEffectiveGlobals`, the daemon's own chain, because the preset
// rung is exactly what the file-level tests above never reach.
describe("a rule inside a preset's globals", () => {
  const STYLE_RULE =
    "{{ if ge (int .ctx.pct) 80 }}hot{{ else }}none{{ end }}";
  const presetSrc = (palette: string, look = STYLE_RULE): string => `{
    globals: { palette: '${THEME_FLOOR}' },
    styles: { none: {}, hot: { hueShift: 180 } },
    presets: { ruled: { globals: { palette: '${palette}', style: '${look}' } } },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'ctx.pct': { kind: 'input', path: 'ctx.pct', type: 'number', default: 0 },
      'theme.effective': { kind: 'input', path: 'theme.effective', default: '' },
      'style.effective': { kind: 'input', path: 'style.effective', default: '' },
    },
    segments: {
      plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
      label: { template: 'T={{ .theme.effective }} L={{ .style.effective }}', bg: 'surface', fg: 'foreground' },
    },
    root: { v: ['plain', 'label'] },
  }`;

  const withRegistry = <R>(
    source: string,
    body: (
      config: ReturnType<typeof parseAndValidate>,
      registry: SourceRegistry,
      store: VariableStore,
    ) => R,
  ): R => {
    const config = parseAndValidate("<theme-expr-preset>", source, ALLOWED);
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    try {
      return body(config, registry, store);
    } finally {
      registry.dispose();
    }
  };

  test("the active preset's rule is evaluated per render, for both the theme and the style", () => {
    withRegistry(presetSrc(RULE), (config, registry, store) => {
      const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
      const effective = resolveEffectiveGlobals(
        config,
        (key) => (key === "preset" ? "ruled" : null),
        () => false,
      );
      const sink = new Map<string, readonly RichText[]>();
      const render = (pct: number): { text: string; bg: string } => {
        const text = renderDsl(
          config,
          compiled,
          store,
          registry,
          { session_id: SID, ctx: { pct } },
          OPTS,
          { perSegmentSink: sink },
          { theme: effective.theme, style: effective.style },
        );
        const cells = sink.get("plain")!;
        return { text, bg: resolvedStyle(cells[0]!.style).bgcolor!.value!.hex };
      };
      const hot = render(90);
      expect(stripAnsi(hot.text)).toContain("T=dracula L=hot");
      expect(hot.bg).toBe(
        transposePalette(getThemePalette("dracula"), {
          hueShift: 180,
          chromaScale: 1,
          lightnessScale: 1,
          lightnessShift: 0,
        }).get("surface")!.hex,
      );
      expect(stripAnsi(render(10).text)).toContain("T=nord L=none");
      expect(render(10).bg).toBe(byName("nord"));
    });
  });

  test("a malformed rule in a preset fails at LOAD, naming the path it was written at", () => {
    withRegistry(
      presetSrc("{{ if ge (int .ctx.pct) 50 }}nord"),
      (config, registry) => {
        expect(() =>
          registerDslConfig(config, registry, { cwd: process.cwd() }),
        ).toThrow(/presets\.ruled\.globals\.palette is not a valid template/);
      },
    );
  });

  test("an omitting caller renders the ACTIVE preset's rule, not the config's top-level palette", () => {
    withRegistry(presetSrc(RULE), (config, registry, store) => {
      const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
      const text = renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, ctx: { pct: 90 } },
        OPTS,
        {},
        { preset: "ruled" },
      );
      expect(stripAnsi(text)).toContain("T=dracula");
    });
  });

  test("a rule naming no theme is reported at the preset path it was written at", () => {
    withRegistry(
      presetSrc("{{ if true }}no-such-theme{{ end }}"),
      (config, registry, store) => {
        const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
        const said: string[] = [];
        renderDsl(
          config,
          compiled,
          store,
          registry,
          { session_id: SID, ctx: { pct: 0 } },
          OPTS,
          { onRenderWarning: (m) => said.push(m) },
          { preset: "ruled" },
        );
        expect(said).toEqual([
          expect.stringMatching(/^presets\.ruled\.globals\.palette rendered /),
        ]);
      },
    );
  });

  test("one text written in both slots is two rules — the theme report names only the palette", () => {
    const shared = "{{ if true }}none{{ end }}";
    withRegistry(presetSrc(shared, shared), (config, registry, store) => {
      const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
      const said: string[] = [];
      renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: SID, ctx: { pct: 0 } },
        OPTS,
        { onRenderWarning: (m) => said.push(m) },
        { preset: "ruled" },
      );
      expect(said).toEqual([
        expect.stringMatching(/^presets\.ruled\.globals\.palette rendered /),
      ]);
    });
  });

  test("a style NAME in a preset's globals or in editGlobals must be a declared style", () => {
    expect(() =>
      parseAndValidate("<look-preset>", presetSrc(RULE, "vivd"), ALLOWED),
    ).toThrow(/presets\.ruled\.globals\.style "vivd" does not match any declared style/);
    const staged = `{
      editGlobals: { style: 'dimm' },
      segments: { plain: { template: 'x' } },
      root: { v: ['plain'] },
    }`;
    expect(() => parseAndValidate("<look-staged>", staged, ALLOWED)).toThrow(
      /editGlobals\.style "dimm" does not match any declared style/,
    );
  });

  test("editGlobals refuses a rule — the staged rung decides by name only", () => {
    const staged = `{
      editGlobals: { palette: '${RULE}' },
      segments: { plain: { template: 'x' } },
      root: { v: ['plain'] },
    }`;
    expect(() => parseAndValidate("<theme-expr-staged>", staged, ALLOWED)).toThrow(
      /editGlobals\.palette: a rule is not allowed here/,
    );
    const stagedStyle = staged.replace("palette:", "style:");
    expect(() =>
      parseAndValidate("<theme-expr-staged>", stagedStyle, ALLOWED),
    ).toThrow(/editGlobals\.style: a rule is not allowed here/);
  });
});
