// [LAW:one-source-of-truth] The set-state verb's writable surface IS the STATE_VALIDATORS registry.
// [LAW:behavior-not-structure] These pin the writable schema, not the registry's implementation.

import {
  listStateKeys,
  makeAllowListValidator,
  registerStateValidator,
  validateStateWrite,
  type ValidateResult,
} from "../src/daemon/verbs/state-validators";
import { listResolvablePaletteNames, STRIP_STYLES } from "../src/themes/policy";

describe("state-validators registry contract", () => {
  test("listStateKeys() exactly enumerates the baseline writable schema", () => {
    // [LAW:single-enforcer] One assertion of THE baseline writable keys; extensions register around it.
    expect([...listStateKeys()].sort()).toEqual(
      ["style", "theme", "toolbar-expanded"].sort(),
    );
  });

  test("theme validator accepts every resolvable palette name", () => {
    // [LAW:one-source-of-truth] The validator's accepted-set IS listResolvablePaletteNames().
    for (const themeName of listResolvablePaletteNames()) {
      const result = validateStateWrite("theme", themeName);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(themeName);
    }
  });

  test("style validator accepts every STRIP_STYLES entry", () => {
    for (const styleName of STRIP_STYLES) {
      const result = validateStateWrite("style", styleName);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(styleName);
    }
  });

  test("toolbar-expanded validator normalizes the boolean-ish input set", () => {
    // [LAW:types-are-the-program] The canonical (input, normalized) pairs ARE the contract.
    const expected: ReadonlyArray<[string, string]> = [
      ["1", "1"],
      ["true", "1"],
      ["0", ""],
      ["false", ""],
    ];
    for (const [input, normalized] of expected) {
      const result = validateStateWrite("toolbar-expanded", input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(normalized);
    }
  });

  test("toolbar-expanded validator rejects the empty string (no silent guess)", () => {
    // [LAW:no-silent-fallbacks] An empty wire value is ambiguous, so accepting it would be a silent guess.
    const result = validateStateWrite("toolbar-expanded", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected boolean-ish/);
  });

  test("unknown key rejection lists the registered keys", () => {
    // [LAW:errors-context-in-errors] The error must carry the current listStateKeys(), not a stale literal.
    const result = validateStateWrite("not-a-key", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const key of listStateKeys()) expect(result.reason).toContain(key);
    }
  });

  test("registerStateValidator adds a key and the disposer removes it", () => {
    // [LAW:locality-or-seam] Disposer-on-register lets a hot reload swap one config's entries without a global reset.
    const disposer = registerStateValidator("mode", {
      kind: "allow-list",
      allowed: ["full", "compact"],
    });
    try {
      expect(listStateKeys()).toContain("mode");
      expect(validateStateWrite("mode", "full")).toEqual({
        ok: true,
        value: "full",
      });
      const bad = validateStateWrite("mode", "bogus");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toMatch(/unknown state "mode" "bogus"/);
    } finally {
      disposer();
    }
    expect(listStateKeys()).not.toContain("mode");
    const after = validateStateWrite("mode", "full");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toMatch(/unknown state key "mode"/);
  });

  test("registerStateValidator unions same-kind specs and ref-counts by spec", () => {
    // [LAW:one-source-of-truth] One derived key may register more than once; the gate is the UNION, so
    // neither config's clicks fail, and the key survives until the LAST spec disposes.
    const disposeRed = registerStateValidator("mode-2", {
      kind: "allow-list",
      allowed: ["red"],
    });
    const disposeBlue = registerStateValidator("mode-2", {
      kind: "allow-list",
      allowed: ["blue"],
    });
    try {
      expect(validateStateWrite("mode-2", "red").ok).toBe(true);
      expect(validateStateWrite("mode-2", "blue").ok).toBe(true);
      disposeRed();
      expect(listStateKeys()).toContain("mode-2");
      expect(validateStateWrite("mode-2", "red").ok).toBe(false);
      expect(validateStateWrite("mode-2", "blue").ok).toBe(true);
    } finally {
      disposeBlue();
    }
    expect(listStateKeys()).not.toContain("mode-2");
  });

  test("registerStateValidator throws on a kind change for a live key", () => {
    // [LAW:types-are-the-program] A state key has ONE key shape, so a kind change throws at registration.
    const dispose = registerStateValidator("kind-clash", { kind: "int" });
    try {
      expect(() =>
        registerStateValidator("kind-clash", {
          kind: "allow-list",
          allowed: ["a"],
        }),
      ).toThrow(/already a int state key/);
      expect(validateStateWrite("kind-clash", "5").ok).toBe(true);
    } finally {
      dispose();
    }
    expect(listStateKeys()).not.toContain("kind-clash");
  });

  test("registerStateValidator throws on a baseline key (theme/style/toolbar-expanded)", () => {
    // [LAW:no-silent-fallbacks] Baseline keys are permanent, so a colliding config fails at load, not at click time.
    expect(() =>
      registerStateValidator("theme", { kind: "allow-list", allowed: ["x"] }),
    ).toThrow(/built-in state key/);
  });

  test("registerStateValidator rejects empty key", () => {
    expect(() =>
      registerStateValidator("", { kind: "int" }),
    ).toThrow(/key is required/);
  });

  test("registerStateValidator rejects slash-bearing keys", () => {
    // [LAW:types-are-the-program] The wire splits the tail on "/", so a slash-bearing key is unaddressable.
    expect(() =>
      registerStateValidator("a/b", { kind: "int" }),
    ).toThrow(/contains "\/"/);
    expect(listStateKeys()).not.toContain("a/b");
  });

  test("disposer is idempotent (second call is a no-op)", () => {
    // [LAW:single-enforcer] Double-dispose must not affect a key re-registered between calls.
    const dispose1 = registerStateValidator("idem-1", {
      kind: "allow-list",
      allowed: ["a"],
    });
    dispose1();
    expect(listStateKeys()).not.toContain("idem-1");
    const dispose2 = registerStateValidator("idem-1", {
      kind: "allow-list",
      allowed: ["b"],
    });
    try {
      // The second call removes its OWN (already-gone) spec once, then no-ops.
      dispose1();
      expect(listStateKeys()).toContain("idem-1");
      expect(validateStateWrite("idem-1", "b")).toEqual({
        ok: true,
        value: "b",
      });
      expect(validateStateWrite("idem-1", "a").ok).toBe(false);
    } finally {
      dispose2();
    }
  });

  test("makeAllowListValidator accepts members and rejects non-members", () => {
    const validator = makeAllowListValidator(
      ["alpha", "beta", "gamma"],
      "level",
    );
    expect(validator("alpha")).toEqual({ ok: true, value: "alpha" });
    expect(validator("beta")).toEqual({ ok: true, value: "beta" });
    const bad = validator("delta");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toMatch(/unknown level "delta"/);
      expect(bad.reason).toMatch(/alpha, beta, gamma/);
    }
  });

  test("makeAllowListValidator rejects empty input with label-referencing reason", () => {
    const validator = makeAllowListValidator(["x"], "fruit");
    const result = validator("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("fruit value is required");
  });

  test("makeAllowListValidator rejects empty string in allowed values at factory time", () => {
    // [LAW:types-are-the-program] The `!raw` early-reject fires before the allow-list lookup, so an "" option could never deliver. [LAW:verifiable-goals]
    expect(() => makeAllowListValidator(["a", "", "b"], "mode")).toThrow(
      /empty string is not a writable option/,
    );
    const v = makeAllowListValidator(["a", "b"], "mode");
    expect(v("")).toEqual({
      ok: false,
      reason: "mode value is required",
    });
  });

  test("makeAllowListValidator rejects slash-bearing allowed values at factory time", () => {
    // [LAW:types-are-the-program] The wire splits values on "/" too, caught at factory-build time. [LAW:verifiable-goals]
    expect(() =>
      makeAllowListValidator(["good", "with/slash", "another/bad"], "mode"),
    ).toThrow(/contain "\/"/);
    expect(() =>
      makeAllowListValidator(["with/slash", "another/bad"], "mode"),
    ).toThrow(/with\/slash, another\/bad/);
    expect(() =>
      makeAllowListValidator(["a", "b", "c"], "mode"),
    ).not.toThrow();
  });

  test("an allow-list spec registers as a working gate", () => {
    // [LAW:one-type-per-behavior] An allow-list spec expresses "key X is written from list Y".
    const disposer = registerStateValidator("compose-key", {
      kind: "allow-list",
      allowed: ["one", "two"],
    });
    try {
      expect(validateStateWrite("compose-key", "one")).toEqual({
        ok: true,
        value: "one",
      });
      const bad = validateStateWrite("compose-key", "three");
      expect(bad.ok).toBe(false);
      if (!bad.ok)
        expect(bad.reason).toMatch(/unknown state "compose-key" "three"/);
    } finally {
      disposer();
    }
  });

  test("ValidateResult discriminant is exhaustive (type-level)", () => {
    // [LAW:types-are-the-program] Exhaustiveness is a COMPILE-TIME theorem: the `_exhaustive: never` assignment fails typecheck, not Jest.
    // [LAW:locality-or-seam] The sample theme comes from the live palette registry, so a rename leaves this undisturbed.
    const checkShape = (s: ValidateResult): void => {
      if (s.ok) {
        expect(typeof s.value).toBe("string");
        return;
      }
      if (!s.ok) {
        expect(typeof s.reason).toBe("string");
        return;
      }
      const _exhaustive: never = s;
      void _exhaustive;
    };
    const [aPaletteName] = listResolvablePaletteNames();
    expect(aPaletteName).toBeDefined();
    checkShape(validateStateWrite("theme", aPaletteName!));
    checkShape(validateStateWrite("not-a-key", "x"));
  });
});
