// [LAW:behavior-not-structure] Asserts wrapper output equals the canonical
// formatter's output. The wrappers' purpose is to expose src/utils/formatters.ts
// (and src/utils/budget.ts) through the template engine without re-deriving
// the formatting rules; "wrapper === source" is the contract.
//
// [LAW:single-enforcer] These tests pin the contract that the DSL's render
// path produces byte-identical output to the legacy renderer. If a wrapper
// drifts from its source, the parity harness would also fail — but a focused
// test localizes the cause to the wrapper instead of the assembled segment.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { formatterFuncs } from "../src/template-engine/funcs";
import {
  formatCost,
  formatTokens,
  formatTokenCount,
  formatDuration,
  formatLongTimeRemaining,
  formatResponseTime,
  formatInteger,
  formatModelName,
  shortenModelName,
  minutesUntilReset,
} from "../src/utils/formatters";
import { getBudgetStatus } from "../src/utils/budget";

// Helper: evaluate a template against a plain-object scope, return joined text.
function evalText(source: string, scope: object = {}): string {
  const engine = createCcCandybarEngine();
  return engine.parse(source).evaluate(scope).map((rt) => rt.plain).join("");
}

// ────────────────────────────────────────────────────────────────
// 1. Cost / token formatters
// ────────────────────────────────────────────────────────────────

describe("formatCost wrapper", () => {
  test.each([0, 0.005, 0.0099, 0.01, 1.234, 1.2345, 42, 9999.99])(
    "matches source for cost=%p",
    (cost) => {
      expect(evalText("{{ formatCost .c }}", { c: cost })).toBe(formatCost(cost));
    },
  );
});

describe("formatTokens wrapper", () => {
  test.each([0, 1, 500, 999, 1000, 1500, 123456, 999999, 1_000_000, 1_234_567])(
    "matches source for tokens=%p",
    (tokens) => {
      expect(evalText("{{ formatTokens .t }}", { t: tokens })).toBe(
        formatTokens(tokens),
      );
    },
  );
});

describe("formatTokenCount wrapper", () => {
  test("strips trailing ' tokens' (delegates to formatTokenCount)", () => {
    expect(evalText("{{ formatTokenCount .t }}", { t: 123456 })).toBe(
      formatTokenCount(123456),
    );
    // Sanity: source ends without " tokens"
    expect(formatTokenCount(123456)).toBe("123.5K");
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Duration / time formatters
// ────────────────────────────────────────────────────────────────

describe("formatDuration wrapper", () => {
  test.each([0, 30, 59, 60, 90, 3599, 3600, 7200, 86399, 86400, 172800])(
    "matches source for seconds=%p",
    (seconds) => {
      expect(evalText("{{ formatDuration .s }}", { s: seconds })).toBe(
        formatDuration(seconds),
      );
    },
  );
});

describe("formatLongTimeRemaining wrapper", () => {
  test.each([0, 30, 59, 60, 90, 180, 1439, 1440, 2880, 4320])(
    "matches source for minutes=%p",
    (minutes) => {
      expect(
        evalText("{{ formatLongTimeRemaining .m }}", { m: minutes }),
      ).toBe(formatLongTimeRemaining(minutes));
    },
  );
});

describe("formatResponseTime wrapper", () => {
  test.each([0, 5.6, 12.3, 59.9, 60, 120, 600])(
    "matches source for seconds=%p",
    (seconds) => {
      expect(evalText("{{ formatResponseTime .s }}", { s: seconds })).toBe(
        formatResponseTime(seconds),
      );
    },
  );
});

describe("minutesUntilReset wrapper", () => {
  test("matches source: epoch in the future rounds to whole minutes", () => {
    const future = Math.floor(Date.now() / 1000) + 90 * 60;
    expect(evalText("{{ minutesUntilReset .e }}", { e: future })).toBe(
      String(minutesUntilReset(future)),
    );
  });

  test("epoch in the past floors at 0", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(evalText("{{ minutesUntilReset .e }}", { e: past })).toBe("0");
    expect(minutesUntilReset(past)).toBe(0);
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
// 5. budgetStatus
// ────────────────────────────────────────────────────────────────

describe("budgetStatus wrapper", () => {
  test("returns empty string when no budget", () => {
    // budget=0 → calculateBudgetPercentage returns null → displayText is ""
    expect(
      evalText("{{ budgetStatus .c .b .w }}", { c: 1.23, b: 0, w: 80 }),
    ).toBe("");
  });

  test("emits ' <pct>%' suffix below 50%", () => {
    // 4.56 / 50 = 9.12% → " 9%"
    const got = evalText("{{ budgetStatus .c .b .w }}", {
      c: 4.56,
      b: 50,
      w: 80,
    });
    expect(got).toBe(getBudgetStatus(4.56, 50, 80).displayText);
    expect(got).toBe(" 9%");
  });

  test("emits ' +<pct>%' suffix at/above 50% (under warning threshold)", () => {
    // 30 / 50 = 60% → " +60%"
    const got = evalText("{{ budgetStatus .c .b .w }}", { c: 30, b: 50, w: 80 });
    expect(got).toBe(getBudgetStatus(30, 50, 80).displayText);
    expect(got).toBe(" +60%");
  });

  test("emits ' !<pct>%' suffix at/above warning threshold", () => {
    // 45 / 50 = 90% → " !90%"
    const got = evalText("{{ budgetStatus .c .b .w }}", { c: 45, b: 50, w: 80 });
    expect(got).toBe(getBudgetStatus(45, 50, 80).displayText);
    expect(got).toBe(" !90%");
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
      "budgetStatus",
      "formatCost",
      "formatDuration",
      "formatInteger",
      "formatLongTimeRemaining",
      "formatModelName",
      "formatResponseTime",
      "formatTokenCount",
      "formatTokens",
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
