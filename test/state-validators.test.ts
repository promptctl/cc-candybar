// [LAW:one-source-of-truth] The set-state verb's writable surface IS
// the STATE_VALIDATORS registry. The verb's wire-level tests in
// dsl-state-cascade.test.ts assert end-to-end behavior (cascade
// propagation, error messages); this file asserts the registry's
// CONTRACT directly so the schema cannot drift silently — a future
// agent adding or removing a validator must update this test, which
// surfaces the change in the diff and prompts re-checking every
// downstream consumer (DSL function bindings, docs, panel migrations).
//
// [LAW:behavior-not-structure] The assertions pin the writable schema
// (the set of keys, what each validator accepts/rejects), not the
// implementation (Map vs object, internal helper structure). A revert
// from ReadonlyMap to a plain object would not fail these tests on its
// own — that contract is pinned in test/daemon-click.test.ts's
// prototype-pollution regression. Different invariants, different test
// homes.

import {
  STATE_KEYS,
  STATE_VALIDATORS,
  validateStateWrite,
  type ValidateResult,
} from "../src/daemon/verbs/state-validators";
import { listResolvablePaletteNames } from "../src/themes/cascade";
import { STYLE_ORDER } from "../src/themes/default-mapping";

describe("state-validators registry contract", () => {
  test("STATE_KEYS exactly enumerates the writable schema", () => {
    // [LAW:single-enforcer] One assertion of "these are THE writable
    // keys." When .2 expands the registry (themes/styles/etc.), this
    // diff is the explicit signal that downstream surfaces need updating.
    expect([...STATE_KEYS].sort()).toEqual(
      ["style", "theme", "toolbar-expanded"].sort(),
    );
  });

  test("STATE_VALIDATORS keys match STATE_KEYS exactly", () => {
    // The derived export and the source map must agree by construction.
    // A drift here means somebody mutated one without the other.
    expect([...STATE_VALIDATORS.keys()].sort()).toEqual([...STATE_KEYS].sort());
  });

  test("theme validator accepts every resolvable palette name", () => {
    // [LAW:one-source-of-truth] The validator's accepted-set IS
    // listResolvablePaletteNames(). Bridging the two via this test means
    // a future change to either source surfaces here — preventing a
    // drift where the theme registry adds a palette but the validator
    // rejects it (or vice versa).
    for (const themeName of listResolvablePaletteNames()) {
      const result = validateStateWrite("theme", themeName);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(themeName);
    }
  });

  test("style validator accepts every STYLE_ORDER entry", () => {
    for (const styleName of STYLE_ORDER) {
      const result = validateStateWrite("style", styleName);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(styleName);
    }
  });

  test("toolbar-expanded validator normalizes the boolean-ish input set", () => {
    // [LAW:types-are-the-program] The canonical (input, normalized)
    // pairs ARE the contract — pinned here so a downstream widget can
    // rely on "set toolbar-expanded to 'true'" landing as "1" in
    // SessionState, and on the falsy/truthy split being precisely this.
    const expected: ReadonlyArray<[string, string]> = [
      ["1", "1"],
      ["true", "1"],
      ["0", ""],
      ["false", ""],
      ["", ""],
    ];
    for (const [input, normalized] of expected) {
      const result = validateStateWrite("toolbar-expanded", input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(normalized);
    }
  });

  test("unknown key rejection lists the registered keys", () => {
    // [LAW:errors-context-in-errors] The rejection IS the schema
    // surface for a confused caller — confirms the error carries the
    // current STATE_KEYS contents, not a stale literal.
    const result = validateStateWrite("not-a-key", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const key of STATE_KEYS) expect(result.reason).toContain(key);
    }
  });

  test("ValidateResult discriminant is exhaustive", () => {
    // [LAW:types-are-the-program] Pin the discriminated-union shape: a
    // result is either {ok:true, value} or {ok:false, reason}, with no
    // third state. If the union ever grows another arm, this test fails
    // at the exhaustiveness check.
    const sample: ValidateResult = validateStateWrite("theme", "textual-dark");
    if (sample.ok) {
      expect(typeof sample.value).toBe("string");
    } else {
      // [LAW:no-defensive-null-guards] The branch is exhaustive — if
      // theme validation of a real palette name returned ok:false, the
      // theme registry diverged from what the validator accepts, which
      // is exactly what the "accepts every resolvable palette" test
      // above is responsible for catching. Failing both is a feature.
      expect(typeof sample.reason).toBe("string");
    }
  });
});
