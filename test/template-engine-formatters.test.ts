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
// 0. Numeric argType gate (validation lives at ONE boundary)
// ────────────────────────────────────────────────────────────────

// [LAW:no-silent-failure][LAW:single-enforcer] Integer formatters declare the
// `int` argType, whose gate (@promptctl/go-template-js) rejects a bigint that
// cannot round-trip to a JS number without precision loss — so a corrupted
// integer fails loudly AT THE BOUNDARY instead of feeding a wrong value into the
// formatter. This replaces the old per-wrapper `num()` runtime guard: the same
// guarantee, moved to the gate that owns numeric carriers. (`formatInteger`
// chosen as a stable single-arg int wrapper.) `round` declares `float`, which
// accepts any finite number (it takes fractional values).
describe("numeric argType gate — precision-losing bigint rejected at the boundary", () => {
  test("int accepts a bigint within safe-integer range", () => {
    // Engine encodes ambiguous Go-template numeric literals as bigint; values
    // inside ±Number.MAX_SAFE_INTEGER (2^53 − 1) round-trip safely.
    const tpl = createCcCandybarEngine().parse("{{ formatInteger 1000000000 }}");
    expect(() => tpl.evaluate({})).not.toThrow();
  });

  test("int rejects a bigint above MAX_SAFE_INTEGER", () => {
    const huge = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const tpl = createCcCandybarEngine().parse(`{{ formatInteger ${huge} }}`);
    expect(() => tpl.evaluate({})).toThrow();
  });

  test("int rejects a bigint below MIN_SAFE_INTEGER", () => {
    const tiny = String(BigInt(Number.MIN_SAFE_INTEGER) - 1n);
    const tpl = createCcCandybarEngine().parse(`{{ formatInteger ${tiny} }}`);
    expect(() => tpl.evaluate({})).toThrow();
  });

  test("int accepts the safe-integer boundaries themselves", () => {
    const maxTpl = createCcCandybarEngine().parse(
      `{{ formatInteger ${Number.MAX_SAFE_INTEGER} }}`,
    );
    const minTpl = createCcCandybarEngine().parse(
      `{{ formatInteger ${Number.MIN_SAFE_INTEGER} }}`,
    );
    expect(() => maxTpl.evaluate({})).not.toThrow();
    expect(() => minTpl.evaluate({})).not.toThrow();
  });

  test("float (round) accepts a large finite value without a precision guard", () => {
    // float is intentionally lossy-tolerant — a big literal converts, not throws.
    const tpl = createCcCandybarEngine().parse("{{ round 1000000000 }}");
    expect(() => tpl.evaluate({})).not.toThrow();
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
