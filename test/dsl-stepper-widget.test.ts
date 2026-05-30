// [LAW:verifiable-goals] 70m.7 acceptance, driven through the real spine
// (registerDslConfig + renderDsl), the real loader (parseAndValidate), and the
// real set-state gate (deriveWidgetValidators + registerStateValidator +
// validateStateWrite) — never a parallel rig:
//
//   1. A stepper renders ◀ <current> ▶ — ◀/▶ are OSC-8 set-state links writing
//      current∓step; the current display is a plain (non-link) span.
//   2. Navigation WRAPS: stepping past a bound lands on the other end (one
//      behavior for every stepper, no clamp-vs-wrap mode).
//   3. The value key gets a `range` validator DERIVED from the widget; the gate
//      clamps arbitrary wire writes into [min,max].
//   4. Same-key range registrations widen-union their bounds.
//   5. The loader validates the integer domain (min<max, step≥1, integers) and
//      requires a backing state var + session.id.
//   6. End-to-end: a hue stepper drives renderDsl's per-segment hue rotation —
//      clicking ▶ rotates the bar's colors live on the next render (the driving
//      use case: globals.hueStep is gone, hue lives in the store as HUE_STEP_VAR).

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  makeRangeValidator,
  deriveWidgetValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";

const ALLOWED = new Set(listResolvablePaletteNames());

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

// A hue stepper bound to the conventional HUE_STEP_VAR ("hue.step") key
// ("hue-step"), range 0..60 step 2 — the ticket's driving example. Two plain
// segments make per-segment hue rotation observable, plus the stepper segment.
const HUE_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
  },
  widgets: {
    hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2 },
  },
  segments: {
    a: { template: ' A ', bg: 'surface', fg: 'foreground' },
    b: { template: ' B ', bg: 'surface', fg: 'foreground' },
    ctl: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' },
  },
  layout: [['a', 'b', 'ctl']],
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
  // The real set-state gate the daemon installs from the config's widgets.
  const disposers = deriveWidgetValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  // [LAW:single-enforcer] Apply a set-state click exactly as the verb does:
  // validate through the derived gate, then write the canonical value.
  const click = (url: string): void => {
    const tail = url.replace("cc-candybar://set-state/", "").split("/");
    const [sid, key, rawValue] = tail;
    const result = validateStateWrite(key!, rawValue!);
    if (!result.ok) throw new Error(`click rejected: ${result.reason}`);
    sessionState.set(sid!, key!, result.value);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, registry, sessionState, render, click, dispose };
}

// ─── Render shape ────────────────────────────────────────────────────────────

describe("70m.7 — stepper render shape", () => {
  test("renders ◀ <current> ▶ with the current as a plain (non-link) span", () => {
    const { render, dispose } = buildRuntime(HUE_SRC);
    const out = render();
    // The current (default 14) sits between the affordances, space-joined.
    expect(stripAnsi(out)).toContain("◀ 14 ▶");
    // Two links only — ◀ and ▶. The current value carries no OSC-8 URL.
    const urls = extractUrls(out);
    expect(urls).toEqual([
      "cc-candybar://set-state/s1/hue-step/12",
      "cc-candybar://set-state/s1/hue-step/16",
    ]);
    dispose();
  });

  test("◀ writes current−step, ▶ writes current+step", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "30");
    const urls = extractUrls(render());
    expect(urls).toEqual([
      "cc-candybar://set-state/s1/hue-step/28",
      "cc-candybar://set-state/s1/hue-step/32",
    ]);
    expect(stripAnsi(render())).toContain("◀ 30 ▶");
    dispose();
  });
});

// ─── Wrap navigation ─────────────────────────────────────────────────────────

describe("70m.7 — stepper wraps at the bounds", () => {
  test("▶ at max wraps to min", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "60"); // max
    const urls = extractUrls(render());
    expect(urls).toEqual([
      "cc-candybar://set-state/s1/hue-step/58",
      "cc-candybar://set-state/s1/hue-step/0", // wrapped, not clamped-to-60
    ]);
    dispose();
  });

  test("◀ at min wraps to max", () => {
    const { render, sessionState, dispose } = buildRuntime(HUE_SRC);
    sessionState.set("s1", "hue-step", "0"); // min
    const urls = extractUrls(render());
    expect(urls).toEqual([
      "cc-candybar://set-state/s1/hue-step/60", // wrapped to max
      "cc-candybar://set-state/s1/hue-step/2",
    ]);
    dispose();
  });
});

// ─── Values that bypass the validator are made safe at the read boundary ───────

describe("70m.7 — stepper tolerates unvalidated state (defaults bypass the gate)", () => {
  test("an out-of-range state-var default clamps the displayed current", () => {
    // A `default` is config, not a write, so it never passes through the range
    // validator — the render must clamp it into bounds itself.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '999' },
      },
      widgets: { hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2 } },
      segments: { ctl: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['ctl']],
    }`;
    const { render, dispose } = buildRuntime(src);
    const out = render();
    expect(stripAnsi(out)).toContain("◀ 60 ▶"); // clamped to max, not "999"
    dispose();
  });

  test("a non-canonical-integer default is not loosely parsed — starts at the floor", () => {
    // [LAW:one-source-of-truth] The render boundary mirrors the wire validator's
    // canonical-integer shape: "14abc"/"3.5" are NOT integer strings (parseInt
    // would loosely yield 14/3), so they fall to the floor, not a half-parsed
    // value the wire would reject.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14abc' },
      },
      widgets: { hue: { kind: 'stepper', state: 'hue-step', min: 4, max: 60, step: 2 } },
      segments: { ctl: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['ctl']],
    }`;
    const { render, dispose } = buildRuntime(src);
    expect(stripAnsi(render())).toContain("◀ 4 ▶"); // floor (min), not 14
    dispose();
  });

  test("a hue.step state var with NO default renders without throwing (step 0)", () => {
    // [LAW:no-defensive-null-guards] A state var with no default reads "" until
    // the first click — renderDsl must coerce that to the no-rotation floor (0),
    // not throw casting "" to a number.
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step' },
      },
      widgets: { hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2 } },
      segments: {
        a: { template: ' A ', bg: 'surface', fg: 'foreground' },
        ctl: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' },
      },
      layout: [['a', 'ctl']],
    }`;
    const { render, dispose } = buildRuntime(src);
    expect(() => render()).not.toThrow();
    // Unset (no default) → current starts at the floor (min).
    expect(stripAnsi(render())).toContain("◀ 0 ▶");
    dispose();
  });
});

// ─── Derived range validator + clamp gate ──────────────────────────────────────

describe("70m.7 — derived range validator", () => {
  test("a stepper derives a {kind:'range'} spec for its value key", () => {
    const config = parseAndValidate("<test>", HUE_SRC, ALLOWED);
    expect(deriveWidgetValidators(config)).toEqual([
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
    // A hand-typed URL past the ceiling is clamped, not rejected, not stored raw.
    expect(validateStateWrite("hue-step", "999")).toEqual({
      ok: true,
      value: "60",
    });
    dispose();
  });

  test("a button writing an out-of-range integer to a stepper key throws at derivation", () => {
    // [LAW:no-silent-fallbacks] The range gate clamps at click time; a button
    // declaring an out-of-bounds literal would silently store a different value
    // than it renders, so it is rejected at config-load instead.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
      },
      widgets: {
        hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2 },
        jump: { kind: 'buttons', items: [{ label: 'max!', onClick: { set: 'hue-step', to: '100' } }] },
      },
      segments: { s: { template: '{{ widget "hue" }}{{ widget "jump" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(() => deriveWidgetValidators(config)).toThrow(/out-of-range/);
  });

  test("a button writing an IN-range integer to a stepper key is absorbed", () => {
    // A "reset to 0" button is a legal integer write the range gate honors.
    const src = `{
      globals: {},
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'state', key: 'hue-step', default: '14' },
      },
      widgets: {
        hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60, step: 2 },
        reset: { kind: 'buttons', items: [{ label: 'reset', onClick: { set: 'hue-step', to: '0' } }] },
      },
      segments: { s: { template: '{{ widget "hue" }}{{ widget "reset" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveWidgetValidators(config)).toEqual([
      { key: "hue-step", spec: { kind: "range", min: 0, max: 60 } },
    ]);
  });

  test("same-key range registrations widen-union their bounds", () => {
    const d1 = registerStateValidator("k", { kind: "range", min: 0, max: 60 });
    const d2 = registerStateValidator("k", { kind: "range", min: -10, max: 30 });
    // Union [-10,60]: a value either co-resident stepper could step to is accepted.
    expect(validateStateWrite("k", "55")).toEqual({ ok: true, value: "55" });
    expect(validateStateWrite("k", "-8")).toEqual({ ok: true, value: "-8" });
    expect(validateStateWrite("k", "999")).toEqual({ ok: true, value: "60" });
    d1();
    d2();
  });
});

// ─── End-to-end: hue stepper drives per-segment rotation ───────────────────────

describe("70m.7 — hue stepper drives renderDsl rotation live", () => {
  test("clicking ▶ advances the value and rotates the bar's colors on next render", () => {
    const { render, click, dispose } = buildRuntime(HUE_SRC);
    const before = render();
    expect(stripAnsi(before)).toContain("◀ 14 ▶");

    // The ▶ URL is the second link; click it through the real gate.
    const incUrl = extractUrls(before)[1]!;
    expect(incUrl).toBe("cc-candybar://set-state/s1/hue-step/16");
    click(incUrl);

    const after = render();
    // The displayed current advanced by the step…
    expect(stripAnsi(after)).toContain("◀ 16 ▶");
    // …and the per-segment hue rotation changed, so the rendered ANSI differs
    // (renderDsl reads HUE_STEP_VAR from the store — the one source).
    expect(after).not.toBe(before);
    dispose();
  });

  test("a stepper does NOT require term.cols (it doesn't paginate)", () => {
    // [LAW:verifiable-goals] Only a width-paginated widget (menu) needs term.cols;
    // a stepper loads without it.
    expect(() => parseAndValidate("<test>", HUE_SRC, ALLOWED)).not.toThrow();
  });
});

// ─── Loader validation ─────────────────────────────────────────────────────────

describe("70m.7 — loader validates the stepper domain", () => {
  const wrap = (widgetBody: string, extraVars = "") => `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      'hue.step': { kind: 'state', key: 'hue-step', default: '14' }${extraVars}
    },
    widgets: { hue: ${widgetBody} },
    segments: { s: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['s']],
  }`;

  test("step defaults to 1 when omitted", () => {
    const cfg = parseAndValidate(
      "<test>",
      wrap(`{ kind: 'stepper', state: 'hue-step', min: 0, max: 60 }`),
      ALLOWED,
    );
    expect(cfg.widgets.hue).toEqual({
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
    ).toThrow(/Unknown widget key "items"/);
  });

  test("a stepper whose value key has no backing state variable fails at load", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { hue: { kind: 'stepper', state: 'orphan-val', min: 0, max: 60 } },
      segments: { s: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/orphan-val/);
  });

  test("a stepper config without session.id fails at load (its ◀/▶ are set-state writes)", () => {
    const src = `{
      globals: {},
      variables: { 'hue.step': { kind: 'state', key: 'hue-step', default: '14' } },
      widgets: { hue: { kind: 'stepper', state: 'hue-step', min: 0, max: 60 } },
      segments: { s: { template: '{{ widget "hue" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/session\.id/);
  });
});
