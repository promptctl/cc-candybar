// [LAW:verifiable-goals] bdi.2 acceptance: config-level shared helper templates.
// A `helpers` block compiles to a define-preamble prepended to every template
// this config parses, so `{{ template "name" .arg }}` resolves a single shared
// definition from any segment/predicate/action. These tests pin the four
// acceptance criteria byte-for-byte: a helper renders, a by-name override changes
// output, a malformed helper fails LOUDLY (not silently), and an absent `helpers`
// key is a no-op (output-neutral preamble).

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { DslConfig, ValidatedConfig } from "../src/config/dsl-types";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";

// [LAW:single-enforcer] One strip-opts shape across the file; Infinity width keeps
// each render a single line so substring assertions are stable.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};

const BASE_PALETTE = new PaletteResolver(getThemePalette("textual-dark")!);

// A minimal default to merge onto: an empty config so each test exercises only
// its own helper slice (the production cascade is tested separately via the
// mergeWithDefault unit test below).
const EMPTY_DEFAULT: DslConfig = {
  globals: {},
  variables: {},
  segments: {},
  root: { kind: "container", direction: "vertical", children: [] },
  actions: {},
  helpers: {},
};

function build(source: string, dflt: DslConfig = EMPTY_DEFAULT) {
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, dflt),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  return { config, compiled, store, registry };
}

function render(source: string, payload: unknown, dflt?: DslConfig): string {
  const { config, compiled, store, registry } = build(source, dflt);
  return renderDsl(
    config,
    compiled,
    store,
    registry,
    payload,
    BASE_PALETTE,
    OPTS,
  );
}

// Strip ANSI SGR + OSC-8 so assertions target the rendered TEXT, not styling.
function plain(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("bdi.2 — config-level shared helper templates", () => {
  test("a helper renders: {{ template \"money\" .x }} → $1.50 for x=1.5", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { money: '\${{ printf "%.2f" . }}' },
      segments: { cost: { template: '{{ template "money" .x }}' } },
      layout: [["cost"]],
    }`;
    expect(plain(render(source, { x: 1.5 }))).toContain("$1.50");
  });

  test("a parameterized helper is defined ONCE, called from many segments", () => {
    // [LAW:single-enforcer] The whole point: one define, N call sites, no drift.
    const source = `{
      variables: {
        a: { kind: "input", path: "a", type: "number" },
        b: { kind: "input", path: "b", type: "number" },
      },
      helpers: { money: '\${{ printf "%.2f" . }}' },
      segments: {
        s1: { template: '{{ template "money" .a }}' },
        s2: { template: '{{ template "money" .b }}' },
      },
      layout: [["s1", "s2"]],
    }`;
    const out = plain(render(source, { a: 2, b: 10.005 }));
    expect(out).toContain("$2.00");
    expect(out).toContain("$10.01"); // %.2f rounds half-up at the boundary
  });

  test("a helper may call another helper (defines share one parse unit)", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: {
        money: '\${{ printf "%.2f" . }}',
        labeled: 'cost={{ template "money" . }}',
      },
      segments: { c: { template: '{{ template "labeled" .x }}' } },
      layout: [["c"]],
    }`;
    expect(plain(render(source, { x: 3 }))).toContain("cost=$3.00");
  });

  test("by-name override (merge cascade): user helper wins, renders the override", () => {
    // The default supplies `money`; the user re-declares it by name.
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      helpers: { money: '\${{ printf "%.2f" . }}' },
    };
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { money: '€{{ printf "%.0f" . }}' },
      segments: { cost: { template: '{{ template "money" .x }}' } },
      layout: [["cost"]],
    }`;
    const out = plain(render(source, { x: 7 }, dflt));
    expect(out).toContain("€7");
    expect(out).not.toContain("$7");
  });

  test("mergeWithDefault: helpers merge by name, user wins, others retained", () => {
    // [LAW:one-source-of-truth] Same cascade as variables/segments/actions.
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      helpers: { money: "DFLT-money", tokens: "DFLT-tokens" },
    };
    const merged = mergeWithDefault({ helpers: { money: "USER-money" } }, dflt);
    expect(merged.helpers).toEqual({
      money: "USER-money", // user override
      tokens: "DFLT-tokens", // inherited
    });
  });

  test("a malformed helper body fails LOUDLY with a per-helper diagnostic", () => {
    // [LAW:no-silent-fallbacks] validateHelpers accepts any string; the parse
    // failure surfaces at registerDslConfig, attributed to the helper by name —
    // not blamed on the first segment that calls it, not silently skipped.
    const source = `{
      helpers: { broken: '{{ printf "%.2f" }' },
      segments: { s: { template: 'x' } },
      layout: [["s"]],
    }`;
    expect(() => build(source)).toThrow(/helpers\.broken/);
  });

  test("absent helpers ≡ no-op: merges to {} and renders unaffected", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { plain: { template: 'x={{ .x }}' } },
      layout: [["plain"]],
    }`;
    const { config } = build(source);
    expect(config.helpers).toEqual({});
    expect(plain(render(source, { x: 42 }))).toContain("x=42");
  });

  test("an UNUSED helper is output-neutral (byte-identical to no helpers)", () => {
    // [LAW:dataflow-not-control-flow] The define-preamble emits nothing; a config
    // carrying an unused helper renders the SAME bytes as one with no helpers.
    const withHelper = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { unused: 'NEVER' },
      segments: { plain: { template: 'x={{ .x }}' } },
      layout: [["plain"]],
    }`;
    const without = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { plain: { template: 'x={{ .x }}' } },
      layout: [["plain"]],
    }`;
    expect(render(withHelper, { x: 9 })).toBe(render(without, { x: 9 }));
  });
});
