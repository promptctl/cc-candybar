// [LAW:verifiable-goals] 2de.6 / S2 acceptance — the stepper as a COMPOSITE NODE
// (the StepperWidget replacement), driven through the real spine (registerDslConfig
// + renderDsl), the real loader (parseAndValidate), and the real set-state gate
// (deriveValidators/deriveNodeValidators + registerStateValidator +
// validateStateWrite) — never a parallel rig. Mirrors the old widget acceptance
// 1:1 so the migration is provably behavior-preserving:
//
//   1. A stepper renders ◀ <current> ▶ — ◀/▶ are OSC-8 set-state links writing
//      current∓step; the current display is a plain (non-link) span.
//   2. Navigation WRAPS: stepping past a bound lands on the other end.
//   3. The value key gets a `range` validator DERIVED from the node; the gate
//      clamps arbitrary wire writes into [min,max].
//   4. Same-key range registrations widen-union their bounds.
//   5. The loader validates the integer domain (min<max, step≥1, integers) and
//      requires a backing state var + session.id.
//   6. End-to-end: a hue stepper drives renderDsl's per-segment hue rotation —
//      clicking ▶ rotates the bar's colors live on the next render.
//
// [LAW:single-enforcer] HUE PIN proof: the stepper is ONE hue unit — it expands to
// one inline leaf, exactly like the old widget inherited one enclosing segment's
// hue. The horizontal-container layout (cells then stepper) consumes the same hue
// units the old [['a','b','ctl']] row did, so rotation is visual-equivalent.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  makeRangeValidator,
  deriveNodeValidators,
  deriveValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import { effectsOf } from "./helpers/click";

const ALLOWED = new Set(listResolvablePaletteNames());

// The effect a hue-step ◀/▶ click applies: one set-state writing the value.
const stepEffects = (...values: string[]) =>
  values.map((v) => [{ verb: "set-state", args: ["s1", "hue-step", v] }]);

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
  };
}

function extractUrls(rendered: string): string[] {
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// A hue stepper NODE bound to the conventional HUE_STEP_VAR key ("hue-step"),
// range 0..60 step 2 — the driving example. The stepper is a sibling of a cells
// leaf in a horizontal container, so the bar has the same three hue units the old
// [['a','b','ctl']] widget layout had (a, b, stepper).
const HUE_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
  },
  segments: {
    a: { template: ' A ', bg: 'surface', fg: 'foreground' },
    b: { template: ' B ', bg: 'surface', fg: 'foreground' },
  },
  root: {
    kind: 'container', direction: 'horizontal', children: [
      { kind: 'cells', segments: ['a', 'b'] },
      { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2, unit: '°', bg: 'surface', fg: 'foreground' },
    ],
  },
}`;

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width = Number.POSITIVE_INFINITY): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId },
      basePalette,
      opts(width),
    );
  // [LAW:single-enforcer] The real set-state gate the daemon installs — the SAME
  // deriveValidators the render cache uses (widgets + nodes through one merge).
  const disposers = deriveValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  // Apply a set-state click exactly as the verb does: validate through the derived
  // gate, then write the canonical value.
  const click = (url: string): void => {
    for (const { verb, args } of effectsOf(url)) {
      if (verb !== "set-state") throw new Error(`unexpected click verb ${verb}`);
      const [sid, ...pairs] = args;
      for (let i = 0; i < pairs.length; i += 2) {
        const result = validateStateWrite(pairs[i]!, pairs[i + 1]!);
        if (!result.ok) throw new Error(`click rejected: ${result.reason}`);
        sessionState.set(sid!, pairs[i]!, result.value);
      }
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, registry, sessionState, render, click, dispose };
}

// ─── Render shape ────────────────────────────────────────────────────────────

describe("2de.6 — stepper node render shape", () => {
  test("renders ◀ <current><unit> ▶ with the current+unit as a plain (non-link) span", () => {
    const { render, dispose } = buildRuntime(HUE_SRC);
    const out = render();
    // The unit (°) rides the plain current cell — `◀ 14° ▶`.
    expect(stripAnsi(out)).toContain("◀ 14° ▶");
    // Two links only — ◀ and ▶. The current value (with unit) carries no OSC-8
    // URL, and the ◀/▶ links carry BARE integers (no unit) the gate accepts.
    const urls = extractUrls(out);
    expect(urls.map(effectsOf)).toEqual(stepEffects("12", "16"));
    dispose();
  });

  test("◀ writes current−step, ▶ writes current+step (bare integers, no unit)", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "30");
    const urls = extractUrls(render());
    expect(urls.map(effectsOf)).toEqual(stepEffects("28", "32"));
    expect(stripAnsi(render())).toContain("◀ 30° ▶");
    dispose();
  });

  test("unit is optional — absent renders a bare ◀ <current> ▶", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
      },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2, bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    const { render, dispose } = buildRuntime(src);
    const plain = stripAnsi(render());
    expect(plain).toContain("◀ 14 ▶");
    expect(plain).not.toContain("°");
    dispose();
  });
});

// ─── Wrap navigation ─────────────────────────────────────────────────────────

describe("2de.6 — stepper node wraps at the bounds", () => {
  test("▶ at max wraps to min", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "60"); // max
    const urls = extractUrls(render());
    expect(urls.map(effectsOf)).toEqual(stepEffects("58", "0")); // wrapped, not clamped
    dispose();
  });

  test("◀ at min wraps to max", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "0"); // min
    const urls = extractUrls(render());
    expect(urls.map(effectsOf)).toEqual(stepEffects("60", "2")); // first wrapped to max
    dispose();
  });
});

// ─── Values that bypass the validator are made safe at the read boundary ───────

describe("2de.6 — stepper node tolerates unvalidated state (defaults bypass the gate)", () => {
  const wrapState = (def: string, min: number, max: number) => `{
    globals: { palette: 'textual-dark' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'hue.step': { kind: 'state', key: 'hue-step', default: '${def}' },
    },
    segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
    root: { kind: 'container', direction: 'horizontal', children: [
      { kind: 'cells', segments: ['a'] },
      { kind: 'stepper', state: 'hue-step', min: ${min}, max: ${max}, step: 2, unit: '°', bg: 'surface', fg: 'foreground' },
    ] },
  }`;

  test("an out-of-range state-var default clamps the displayed current", () => {
    const { render, dispose } = buildRuntime(wrapState("999", 0, 60));
    expect(stripAnsi(render())).toContain("◀ 60° ▶"); // clamped to max, not "999"
    dispose();
  });

  test("a non-canonical-integer default is not loosely parsed — starts at the floor", () => {
    const { render, dispose } = buildRuntime(wrapState("14abc", 4, 60));
    expect(stripAnsi(render())).toContain("◀ 4° ▶"); // floor (min), not 14
    dispose();
  });

  test("a hue.step state var with NO default renders without throwing (step 0)", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step' },
      },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2, unit: '°', bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    const { render, dispose } = buildRuntime(src);
    expect(() => render()).not.toThrow();
    expect(stripAnsi(render())).toContain("◀ 0° ▶"); // unset → floor (min)
    dispose();
  });
});

// ─── Derived range validator + clamp gate ──────────────────────────────────────

describe("2de.6 — derived range validator (from the node)", () => {
  test("a stepper node derives a {kind:'range'} spec for its value key", () => {
    const config = parseAndValidate("<test>", HUE_SRC, ALLOWED);
    expect(deriveNodeValidators(config)).toEqual([
      { key: "hue-step", spec: { kind: "range", min: 0, max: 60 } },
    ]);
  });

  test("makeRangeValidator clamps into [min,max] and canonicalizes integers", () => {
    const v = makeRangeValidator(0, 60, "hue");
    expect(v("30")).toEqual({ ok: true, value: "30" });
    expect(v("100")).toEqual({ ok: true, value: "60" }); // clamp high
    expect(v("-5")).toEqual({ ok: true, value: "0" }); // clamp low
    expect(v("007")).toEqual({ ok: true, value: "7" }); // canonical decimal
    expect(v("")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("abc")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("3.5")).toEqual({ ok: false, reason: expect.any(String) });
  });

  test("the gate the daemon installs clamps an out-of-range wire write", () => {
    const { dispose } = buildRuntime(HUE_SRC);
    expect(validateStateWrite("hue-step", "999")).toEqual({
      ok: true,
      value: "60",
    });
    dispose();
  });

  test("an inline cell writing an out-of-range integer to a stepper key throws at derivation", () => {
    // [LAW:no-silent-fallbacks] The range gate clamps at click time; an inline
    // onClick declaring an out-of-bounds literal would silently store a different
    // value than it renders, so it is rejected at config-load instead. (The node
    // analogue of the old buttons-widget out-of-range test.)
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
      },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2, bg: 'surface', fg: 'foreground' },
        { kind: 'inline', cells: [{ text: 'max!', onClick: { set: 'hue-step', to: '100' } }], bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(() => deriveNodeValidators(config)).toThrow(/out-of-range/);
  });

  test("an inline cell writing an IN-range integer to a stepper key is absorbed", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
      },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2, bg: 'surface', fg: 'foreground' },
        { kind: 'inline', cells: [{ text: 'reset', onClick: { set: 'hue-step', to: '0' } }], bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveNodeValidators(config)).toEqual([
      { key: "hue-step", spec: { kind: "range", min: 0, max: 60 } },
    ]);
  });

  test("same-key range registrations widen-union their bounds", () => {
    const d1 = registerStateValidator("k", { kind: "range", min: 0, max: 60 });
    const d2 = registerStateValidator("k", { kind: "range", min: -10, max: 30 });
    expect(validateStateWrite("k", "55")).toEqual({ ok: true, value: "55" });
    expect(validateStateWrite("k", "-8")).toEqual({ ok: true, value: "-8" });
    expect(validateStateWrite("k", "999")).toEqual({ ok: true, value: "60" });
    d1();
    d2();
  });
});

// ─── End-to-end: hue stepper drives per-segment rotation ───────────────────────

describe("2de.6 — hue stepper node drives renderDsl rotation live", () => {
  test("clicking ▶ advances the value and rotates the bar's colors on next render", () => {
    const { render, click, dispose } = buildRuntime(HUE_SRC);
    const before = render();
    expect(stripAnsi(before)).toContain("◀ 14° ▶");

    // The ▶ URL is the second link; click it through the real gate.
    const incUrl = extractUrls(before)[1]!;
    expect(effectsOf(incUrl)).toEqual(stepEffects("16")[0]);
    click(incUrl);

    const after = render();
    expect(stripAnsi(after)).toContain("◀ 16° ▶");
    // …and the per-segment hue rotation changed, so the rendered ANSI differs.
    expect(after).not.toBe(before);
    dispose();
  });

  test("a stepper does NOT require term.cols (it doesn't paginate)", () => {
    expect(() => parseAndValidate("<test>", HUE_SRC, ALLOWED)).not.toThrow();
  });
});

// ─── Loader validation ─────────────────────────────────────────────────────────

describe("2de.6 — loader validates the stepper node domain", () => {
  const wrap = (stepperBody: string) => `{
    globals: { palette: 'textual-dark' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
    },
    segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
    root: { kind: 'container', direction: 'horizontal', children: [
      { kind: 'cells', segments: ['a'] },
      ${stepperBody},
    ] },
  }`;
  // The stepper is children[1] of the root container.
  const stepperOf = (cfg: ReturnType<typeof parseAndValidate>) => {
    const root = cfg.root;
    if (root.kind !== "container") throw new Error("expected container root");
    return root.children[1];
  };

  test("step defaults to 1 when omitted", () => {
    const cfg = parseAndValidate(
      "<test>",
      wrap(`{ kind: 'stepper', state: 'hue-step', min: 0, max: 60 }`),
      ALLOWED,
    );
    expect(stepperOf(cfg)).toEqual({
      kind: "stepper",
      state: "hue-step",
      min: 0,
      max: 60,
      step: 1,
    });
  });

  test("min must be less than max", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', state: 'hue-step', min: 60, max: 0 }`),
        ALLOWED,
      ),
    ).toThrow(/min .* less than max/);
  });

  test("step must be a positive integer", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 0 }`),
        ALLOWED,
      ),
    ).toThrow(/step .* positive/);
  });

  test("non-integer bounds are rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', state: 'hue-step', min: 0, max: 60.5 }`),
        ALLOWED,
      ),
    ).toThrow(/max must be an integer/);
  });

  test("a slash-bearing state key is rejected at load (set-state wire splits on /)", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', state: 'a/b', min: 0, max: 60 }`),
        ALLOWED,
      ),
    ).toThrow(/slash-free/);
  });

  test("a missing state key is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', min: 0, max: 60 }`),
        ALLOWED,
      ),
    ).toThrow(/non-empty "state"/);
  });

  test("an unknown stepper key is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        wrap(`{ kind: 'stepper', state: 'hue-step', min: 0, max: 60, items: [] }`),
        ALLOWED,
      ),
    ).toThrow(/Unknown layout-node key "items"/);
  });

  test("a stepper whose value key has no backing state variable fails at load", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'orphan-val', min: 0, max: 60, bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/orphan-val/);
  });

  test("a stepper config without session.id fails at load (its ◀/▶ are set-state writes)", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: { 'hue.step': { kind: 'state', key: 'hue-step', default: '14' } },
      segments: { a: { template: ' A ', bg: 'surface', fg: 'foreground' } },
      root: { kind: 'container', direction: 'horizontal', children: [
        { kind: 'cells', segments: ['a'] },
        { kind: 'stepper', state: 'hue-step', min: 0, max: 60, bg: 'surface', fg: 'foreground' },
      ] },
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/session\.id/);
  });
});
