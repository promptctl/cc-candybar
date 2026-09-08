// [LAW:verifiable-goals] A `helpers` block compiles to ONE inherited define set.

import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { DslConfig, ValidatedConfig } from "../src/config/dsl-types";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

const BASE_PALETTE = getThemePalette("textual-dark"!);

const EMPTY_DEFAULT: DslConfig = {
  globals: {},
  variables: {},
  segments: {},
  root: { rows: {} },
  actions: {},
  looks: {},
  presets: {},
  helpers: {},
  editGlobals: {},
};

function build(source: string, dflt: DslConfig = EMPTY_DEFAULT) {
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, dflt),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
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
      root: "cost",
    }`;
    expect(plain(render(source, { x: 1.5 }))).toContain("$1.50");
  });

  test("a parameterized helper is defined ONCE, called from many segments", () => {
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
      root: { h: ["s1", "s2"] },
    }`;
    const out = plain(render(source, { a: 2, b: 10.005 }));
    expect(out).toContain("$2.00");
    expect(out).toContain("$10.01");
  });

  test("a helper may call another helper (defines share one parse unit)", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: {
        money: '\${{ printf "%.2f" . }}',
        labeled: 'cost={{ template "money" . }}',
      },
      segments: { c: { template: '{{ template "labeled" .x }}' } },
      root: "c",
    }`;
    expect(plain(render(source, { x: 3 }))).toContain("cost=$3.00");
  });

  test("a helper may call one declared AFTER it: resolution is by name at render, not by declaration order", () => {
    // [LAW:behavior-not-structure] A call resolves on execution, not fold order.
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: {
        labeled: 'cost={{ template "money" . }}',
        money: '\${{ printf "%.2f" . }}',
      },
      segments: { c: { template: '{{ template "labeled" .x }}' } },
      root: "c",
    }`;
    expect(plain(render(source, { x: 3 }))).toContain("cost=$3.00");
  });

  test("by-name override (merge cascade): user helper wins, renders the override", () => {
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      helpers: { money: '\${{ printf "%.2f" . }}' },
    };
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { money: '€{{ printf "%.0f" . }}' },
      segments: { cost: { template: '{{ template "money" .x }}' } },
      root: "cost",
    }`;
    const out = plain(render(source, { x: 7 }, dflt));
    expect(out).toContain("€7");
    expect(out).not.toContain("$7");
  });

  test("mergeWithDefault: helpers merge by name, user wins, others retained", () => {
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      helpers: { money: "DFLT-money", tokens: "DFLT-tokens" },
    };
    const merged = mergeWithDefault({ helpers: { money: "USER-money" } }, dflt);
    expect(merged.helpers).toEqual({
      money: "USER-money",
      tokens: "DFLT-tokens",
    });
  });

  test("a malformed helper body fails LOUDLY with a per-helper diagnostic", () => {
    // [LAW:no-silent-fallbacks] The parse failure is attributed to the helper by
    // name, never blamed on the first segment that calls it.
    const source = `{
      helpers: { broken: '{{ printf "%.2f" }' },
      segments: { s: { template: 'x' } },
      root: "s",
    }`;
    expect(() => build(source)).toThrow(/helpers\.broken/);
  });

  test("absent helpers ≡ no-op: merges to {} and renders unaffected", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { plain: { template: 'x={{ .x }}' } },
      root: "plain",
    }`;
    const { config } = build(source);
    expect(config.helpers).toEqual({});
    expect(plain(render(source, { x: 42 }))).toContain("x=42");
  });

  test("an UNUSED helper is output-neutral (byte-identical to no helpers)", () => {
    // [LAW:dataflow-not-control-flow] An unused helper renders the SAME bytes.
    const withHelper = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { unused: 'NEVER' },
      segments: { plain: { template: 'x={{ .x }}' } },
      root: "plain",
    }`;
    const without = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { plain: { template: 'x={{ .x }}' } },
      root: "plain",
    }`;
    expect(render(withHelper, { x: 9 })).toBe(render(without, { x: 9 }));
  });
});
