// [LAW:behavior-not-structure] The JS oracle these helpers replaced is deleted;
// each literal is the exact string it produced for that input.

import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const BASE_PALETTE = getThemePalette("textual-dark"!);

// All numeric, default 0, so an absent payload key exercises the var default.
const VARS = `{
  v:   { kind: "input", path: "v",   type: "number", default: 0 },
  c:   { kind: "input", path: "c",   type: "number", default: 0 },
  b:   { kind: "input", path: "b",   type: "number", default: 0 },
  w:   { kind: "input", path: "w",   type: "number", default: 0 },
  in:  { kind: "input", path: "in",  type: "number", default: 0 },
  out: { kind: "input", path: "out", type: "number", default: 0 },
  cc:  { kind: "input", path: "cc",  type: "number", default: 0 },
  cr:  { kind: "input", path: "cr",  type: "number", default: 0 },
}`;

function render(call: string, payload: Record<string, number>): string {
  const source = `{
    variables: ${VARS},
    segments: { probe: { template: ${JSON.stringify(call)} } },
    root: "probe",
  }`;
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, DEFAULT_DSL_CONFIG),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  const out = renderDsl(
    config,
    compiled,
    store,
    registry,
    payload,
    BASE_PALETTE,
    OPTS,
  );
  return out
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("bdi.3 — formatCost helper (byte-parity with retired JS)", () => {
  test.each<[number, string]>([
    [0, "<$0.01"],
    [0.004, "<$0.01"],
    [0.01, "$0.01"],
    [1.5, "$1.50"],
    [999, "$999.00"],
    [1000, "$1000.00"],
    [1500, "$1500.00"],
    [1_000_000, "$1000000.00"],
    [1_500_000, "$1500000.00"],
    [-5, "<$0.01"],
  ])("formatCost(%p) === %p", (v, want) => {
    expect(render('{{ template "formatCost" .v }}', { v })).toContain(want);
  });
});

describe("bdi.3 — formatTokens / formatTokenCount helpers", () => {
  test.each<[number, string]>([
    [0, "0 tokens"],
    [0.004, "0.004 tokens"],
    [1.5, "1.5 tokens"],
    [999, "999 tokens"],
    [1000, "1.0K tokens"],
    [1500, "1.5K tokens"],
    [1_000_000, "1.0M tokens"],
    [1_500_000, "1.5M tokens"],
    [-5, "-5 tokens"],
  ])("formatTokens(%p) === %p", (v, want) => {
    expect(render('{{ template "formatTokens" .v }}', { v })).toContain(want);
  });

  test.each<[number, string]>([
    [0, "0"],
    [999, "999"],
    [1000, "1.0K"],
    [1500, "1.5K"],
    [1_000_000, "1.0M"],
    [1_500_000, "1.5M"],
    [-5, "-5"],
  ])("formatTokenCount(%p) === %p", (v, want) => {
    // Wrap in delimiters so "1.0K" doesn't match a prefix of "1.0K tokens" etc.
    expect(render('[{{ template "formatTokenCount" .v }}]', { v })).toContain(
      `[${want}]`,
    );
  });
});

describe("bdi.3 — formatTokenBreakdown helper (dict of 4)", () => {
  const call =
    '{{ template "formatTokenBreakdown" (dict "input" .in "output" .out "cacheCreation" .cc "cacheRead" .cr) }}';
  test.each<[Record<string, number>, string]>([
    [{ in: 0, out: 0, cc: 0, cr: 0 }, "0 tokens"],
    [{ in: 1500, out: 0, cc: 0, cr: 0 }, "1.5K in"],
    [{ in: 0, out: 2500, cc: 0, cr: 0 }, "2.5K out"],
    [{ in: 0, out: 0, cc: 100, cr: 0 }, "100 cached"],
    [{ in: 300, out: 0, cc: 0, cr: 700 }, "300 in + 700 cached"],
    [
      { in: 1500, out: 2_000_000, cc: 500, cr: 500 },
      "1.5K in + 2.0M out + 1.0K cached",
    ],
  ])("formatTokenBreakdown(%p) === %p", (payload, want) => {
    expect(render(call, payload)).toContain(want);
  });
});

describe("bdi.3 — budgetStatus helper (dict {cost, budget, warn})", () => {
  const call =
    '{{ template "budgetStatus" (dict "cost" .c "budget" .b "warn" .w) }}';
  test.each<[Record<string, number>, string]>([
    [{ c: 0, b: 50, w: 80 }, " 0%"],
    [{ c: 4.56, b: 50, w: 80 }, " 9%"],
    [{ c: 25, b: 50, w: 80 }, " +50%"],
    [{ c: 30, b: 50, w: 80 }, " +60%"],
    [{ c: 40, b: 50, w: 80 }, " !80%"],
    [{ c: 45, b: 50, w: 80 }, " !90%"],
    [{ c: 50, b: 50, w: 80 }, " !100%"],
    [{ c: 100, b: 50, w: 80 }, " !100%"], // capped at 100
  ])("budgetStatus(%p) suffix === %p", (payload, want) => {
    expect(render(call, payload)).toContain(want);
  });

  test.each<[Record<string, number>, string]>([
    [{ c: 1.23, b: 0, w: 80 }, "budget<=0"],
    [{ c: -1, b: 50, w: 80 }, "cost<0"],
  ])("budgetStatus(%p) is empty (%s)", (payload) => {
    expect(render(`[${call}]`, payload)).toContain("[]");
  });
});

describe("bdi.3 — null is owned upstream by the var default, not the helper", () => {
  // [LAW:types-are-the-program] VarValue has no null: "missing" resolves to the
  // var's numeric default before the helper sees it, so its domain is `number`.
  test("absent cost → default 0 → formatCost renders the 0 branch", () => {
    expect(render('{{ template "formatCost" .v }}', {})).toContain("<$0.01");
  });
  test("absent tokens → default 0 → formatTokens renders '0 tokens'", () => {
    expect(render('{{ template "formatTokens" .v }}', {})).toContain("0 tokens");
  });
});
