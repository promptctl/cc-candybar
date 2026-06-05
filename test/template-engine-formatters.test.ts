// [LAW:behavior-not-structure] Asserts wrapper output equals the canonical
// formatter's output. The wrappers' purpose is to expose src/utils/formatters.ts
// through the template engine without re-deriving the formatting rules;
// "wrapper === source" is the contract.
//
// [LAW:single-enforcer] These tests pin the contract that the DSL's render
// path produces byte-identical output to the legacy renderer. If a wrapper
// drifts from its source, the parity harness would also fail — but a focused
// test localizes the cause to the wrapper instead of the assembled segment.
//
// The cost/token/budget (bdi.3) and duration/time-remaining (bdi.4) families
// moved to DSL helper templates; their byte-parity is pinned in
// test/dsl-formatters-cost-token.test.ts and test/dsl-formatters-duration-time.test.ts.
// What remains here are the JS-func primitives with no template-native
// expression yet (locale grouping, regex model-name parsing) plus the
// clock-reading numeric primitive minutesUntilReset.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { formatterFuncs } from "../src/template-engine/funcs";
import {
  formatInteger,
  formatModelName,
  shortenModelName,
} from "../src/utils/formatters";

// Helper: evaluate a template against a plain-object scope, return joined text.
function evalText(source: string, scope: object = {}): string {
  const engine = createCcCandybarEngine();
  return engine.parse(source).evaluate(scope).map((rt) => rt.plain).join("");
}

// ────────────────────────────────────────────────────────────────
// 0. num() bigint normalization (single-enforcer of bigint→number)
// ────────────────────────────────────────────────────────────────

// [LAW:no-silent-fallbacks] The wrappers' shared num() helper must throw
// for bigint inputs that cannot round-trip to JS number without precision
// loss or overflow — otherwise a formatter silently produces wrong output.
// The check is at the conversion boundary, not at each formatter, so it's
// tested through any formatter wrapper that takes a numeric arg (`round`
// chosen as a stable single-arg numeric wrapper).
describe("num() bigint range guard", () => {
  test("accepts bigint within safe-integer range (round-trips)", () => {
    // Engine encodes Go-template numeric literals as bigint when ambiguous;
    // values inside ±Number.MAX_SAFE_INTEGER (2^53 − 1) are safe to collapse.
    const tpl = createCcCandybarEngine().parse("{{ round 1000000000 }}");
    expect(() => tpl.evaluate({})).not.toThrow();
  });

  test("rejects bigint above MAX_SAFE_INTEGER with informative TypeError", () => {
    // Number.MAX_SAFE_INTEGER + 1n is the smallest positive bigint that loses
    // precision in Number. Template literal forces engine to bigint encoding
    // for values above the safe-integer range.
    const huge = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const tpl = createCcCandybarEngine().parse(`{{ round ${huge} }}`);
    expect(() => tpl.evaluate({})).toThrow(TypeError);
    expect(() => tpl.evaluate({})).toThrow(/safe-integer range/);
  });

  test("rejects bigint below MIN_SAFE_INTEGER", () => {
    const tiny = String(BigInt(Number.MIN_SAFE_INTEGER) - 1n);
    const tpl = createCcCandybarEngine().parse(`{{ round ${tiny} }}`);
    expect(() => tpl.evaluate({})).toThrow(TypeError);
  });

  test("accepts the safe-integer boundaries themselves", () => {
    const maxTpl = createCcCandybarEngine().parse(
      `{{ round ${Number.MAX_SAFE_INTEGER} }}`,
    );
    const minTpl = createCcCandybarEngine().parse(
      `{{ round ${Number.MIN_SAFE_INTEGER} }}`,
    );
    expect(() => maxTpl.evaluate({})).not.toThrow();
    expect(() => minTpl.evaluate({})).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Locale-grouped integer
// ────────────────────────────────────────────────────────────────

describe("formatInteger wrapper", () => {
  test.each([0, 1, 999, 1000, 12345, 50000, 1_234_567])(
    "matches source for n=%p",
    (n) => {
      expect(evalText("{{ formatInteger .n }}", { n })).toBe(formatInteger(n));
    },
  );
});

// ────────────────────────────────────────────────────────────────
// 4. round
// ────────────────────────────────────────────────────────────────

describe("round wrapper", () => {
  test.each([
    [0, 0],
    [0.4, 0],
    [0.5, 1],
    [1.49, 1],
    [1.5, 2],
    [-0.5, 0], // Math.round's half-toward-positive-infinity quirk preserved
    [-0.6, -1],
    [55, 55],
    [55.4, 55],
    [99.9, 100],
  ])("round(%p) === %p", (input, expected) => {
    expect(evalText("{{ round .n }}", { n: input })).toBe(String(expected));
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Model-name normalizers
// ────────────────────────────────────────────────────────────────

describe("formatModelName wrapper", () => {
  test.each([
    "claude-sonnet-4-6",
    "anthropic.claude-opus-4-5-20251101-v1:0",
    "Sonnet 4.6",
    "Opus 4.7 (1M context)",
    "Haiku 4.5 [beta]",
    "",
    "garbled-thing",
  ])("matches source for raw=%p", (raw) => {
    expect(evalText("{{ formatModelName .r }}", { r: raw })).toBe(
      formatModelName(raw),
    );
  });
});

describe("shortenModelName wrapper", () => {
  test.each(["Sonnet 4.6", "Opus 4.7", "Haiku 4", "Claude"])(
    "matches source for formatted=%p",
    (formatted) => {
      expect(evalText("{{ shortenModelName .f }}", { f: formatted })).toBe(
        shortenModelName(formatted),
      );
    },
  );

  test("composes with formatModelName: raw → friendly → short", () => {
    expect(
      evalText('{{ shortenModelName (formatModelName "claude-opus-4-7") }}', {}),
    ).toBe("O4.7");
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Registry shape
// ────────────────────────────────────────────────────────────────

describe("formatterFuncs registry", () => {
  test("registers exactly the expected names", () => {
    const funcs = formatterFuncs();
    expect(Object.keys(funcs).sort()).toEqual([
      "formatInteger",
      "formatModelName",
      "minutesUntilReset",
      "round",
      "shortenModelName",
    ]);
  });

  test("all entries have argTypes arrays", () => {
    for (const [, entry] of Object.entries(formatterFuncs())) {
      expect(Array.isArray(entry.argTypes)).toBe(true);
    }
  });

  // [LAW:single-enforcer] The engine must wire formatterFuncs in alongside
  // ccCandybarFuncs — otherwise a template like "{{ formatCost .x }}" parses
  // but throws FuncNotFoundError at eval time. This regression test catches
  // an engine.ts refactor that drops the spread.
  test("each registered name is callable from the engine", () => {
    const engine = createCcCandybarEngine();
    for (const name of Object.keys(formatterFuncs())) {
      // Parse-only smoke: a missing func is reported at evaluate time, but the
      // engine pre-validates that referenced names exist in the registry.
      // Calling parse alone doesn't trigger the check (Go templates resolve
      // lazily), so build a tiny scope and evaluate.
      const tpl = engine.parse(`{{ ${name} 0 }}`);
      // Argument-shape mismatches (e.g. budgetStatus expects 3 args) throw
      // synchronously; we only assert the engine *knows* the name. Catching
      // TypeError/ParseError is fine; catching FuncNotFoundError is the
      // failure mode this test guards against.
      try {
        tpl.evaluate({});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/not.+(?:defined|found)|FuncNotFound/i);
      }
    }
  });
});
