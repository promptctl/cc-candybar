// [LAW:behavior-not-structure][LAW:single-enforcer] The wrappers expose
// src/utils/formatters.ts through the engine without re-deriving the rules;
// "wrapper === source" is the contract.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { formatterFuncs } from "../src/template-engine/funcs";
import {
  formatInteger,
  formatModelName,
  shortenModelName,
} from "../src/utils/formatters";

function evalText(source: string, scope: object = {}): string {
  const engine = createCcCandybarEngine();
  return engine.parse(source).evaluate(scope).map((rt) => rt.plain).join("");
}

// [LAW:no-silent-failure][LAW:single-enforcer] The `int` argType gate rejects a
// bigint that cannot round-trip to a JS number; `round` declares `float`, which
// accepts any finite number.
describe("numeric argType gate — precision-losing bigint rejected at the boundary", () => {
  test("int accepts a bigint within safe-integer range", () => {
    // The engine encodes ambiguous Go-template numeric literals as bigint.
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
    const tpl = createCcCandybarEngine().parse("{{ round 1000000000 }}");
    expect(() => tpl.evaluate({})).not.toThrow();
  });
});

describe("formatInteger wrapper", () => {
  test.each([0, 1, 999, 1000, 12345, 50000, 1_234_567])(
    "matches source for n=%p",
    (n) => {
      expect(evalText("{{ formatInteger .n }}", { n })).toBe(formatInteger(n));
    },
  );
});

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

  // [LAW:single-enforcer] Guards a refactor that drops the formatterFuncs spread:
  // the template would parse but throw FuncNotFoundError at eval time.
  test("each registered name is callable from the engine", () => {
    const engine = createCcCandybarEngine();
    for (const name of Object.keys(formatterFuncs())) {
      // Go templates resolve lazily, so parse alone does not check the name.
      const tpl = engine.parse(`{{ ${name} 0 }}`);
      try {
        tpl.evaluate({});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/not.+(?:defined|found)|FuncNotFound/i);
      }
    }
  });
});
