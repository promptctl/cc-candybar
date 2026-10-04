// [LAW:one-source-of-truth] The set-state verb's writable surface IS the
// clicking session's gate (stateGate). The verb's wire-level tests in
// dsl-state-cascade.test.ts assert end-to-end behavior (cascade
// propagation, error messages); this file asserts the SessionState
// keyspace's CONTRACT directly — the built-in keys every session has, and a
// daemon-wide key — so the schema cannot drift silently. What a config
// contributes, and how two configs stay apart, is validator-registry.test.ts.
//
// [LAW:behavior-not-structure] The assertions pin the writable schema
// (the set of keys, what each validator accepts/rejects), not the
// implementation (Map vs object, internal helper structure). A revert
// from ReadonlyMap to a plain object would not fail these tests on its
// own — that contract is pinned in test/daemon-click.test.ts's
// prototype-pollution regression. Different invariants, different test
// homes.

import {
  makeAllowListValidator,
  registerStateValidator,
  stateGate,
  type ValidateResult,
} from "../src/daemon/verbs/state-validators";
import { listResolvablePaletteNames, ENDCAPS_SHAPES } from "../src/themes/policy";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";

// The gate of a session whose config declares no action: the built-in keys,
// and whatever is registered daemon-wide at the moment it is asked.
const bare = () => stateGate(EMPTY_DEFAULT);

describe("state-validators contract", () => {
  test("a config declaring nothing has exactly the built-in writable keys", () => {
    // [LAW:single-enforcer] One assertion of "these are THE built-in
    // writable keys." A future change that adds one updates THIS list and
    // surfaces the change in the diff, so downstream surfaces (DSL
    // bindings, docs, panel migration) get the signal.
    expect([...bare().listKeys()].sort()).toEqual(
      ["endcaps", "theme", "toolbar-expanded"].sort(),
    );
  });

  test("theme validator accepts every resolvable palette name", () => {
    // [LAW:one-source-of-truth] The validator's accepted-set IS
    // listResolvablePaletteNames(). Bridging the two via this test means
    // a future change to either source surfaces here — preventing a
    // drift where the theme registry adds a palette but the validator
    // rejects it (or vice versa).
    for (const themeName of listResolvablePaletteNames()) {
      const result = bare().validate("theme", themeName);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(themeName);
    }
  });

  test("style validator accepts every ENDCAPS_SHAPES entry", () => {
    for (const shape of ENDCAPS_SHAPES) {
      const result = bare().validate("endcaps", shape);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(shape);
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
    ];
    for (const [input, normalized] of expected) {
      const result = bare().validate("toolbar-expanded", input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(normalized);
    }
  });

  test("toolbar-expanded validator rejects the empty string (no silent guess)", () => {
    // [LAW:no-silent-fallbacks] Empty value on the wire is structurally
    // ambiguous (did the operator mean "0", or did they forget to provide
    // a value?). Accepting it would be a silent semantic guess; the
    // validator rejects it explicitly so the operator sees the malformed
    // input rather than a quietly-applied default.
    const result = bare().validate("toolbar-expanded", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected boolean-ish/);
  });

  test("unknown key rejection lists the gate's keys", () => {
    // [LAW:errors-context-in-errors] The rejection IS the schema
    // surface for a confused caller — confirms the error carries the
    // gate's own keys, not a stale literal.
    const result = bare().validate("not-a-key", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const key of bare().listKeys()) expect(result.reason).toContain(key);
    }
  });

  test("a daemon-wide key is writable in a session until its disposer runs", () => {
    const disposer = registerStateValidator("mode", {
      kind: "allow-list",
      allowed: ["full", "compact"],
    });
    try {
      expect(bare().listKeys()).toContain("mode");
      expect(bare().validate("mode", "full")).toEqual({
        ok: true,
        value: "full",
      });
      const bad = bare().validate("mode", "bogus");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toMatch(/unknown state "mode" "bogus"/);
    } finally {
      disposer();
    }
    expect(bare().listKeys()).not.toContain("mode");
    const after = bare().validate("mode", "full");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toMatch(/unknown state key "mode"/);
  });

  test("a built-in key cannot be re-claimed daemon-wide", () => {
    // [LAW:no-silent-fallbacks] Built-in keys are permanent; a claim on
    // `theme` collides loudly rather than silently hijacking the canonical
    // theme validator.
    expect(() =>
      registerStateValidator("theme", { kind: "allow-list", allowed: ["x"] }),
    ).toThrow(/built-in state key/);
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
    // [LAW:types-are-the-program] The validator's `!raw` early-reject
    // fires BEFORE the allow-list lookup, so an "" in the allowed list
    // would render in the picker but never deliver as a writable
    // value. Same shape of registry-vs-wire drift as slash-bearing
    // values — caught at factory-build time per [LAW:verifiable-goals].
    expect(() => makeAllowListValidator(["a", "", "b"], "mode")).toThrow(
      /empty string is not a writable option/,
    );
    // The validator built from a list without "" doesn't reject at
    // factory time and rejects empty INPUT at runtime — the existing
    // validateBoolean / validateTheme contract for missing values is
    // preserved.
    const v = makeAllowListValidator(["a", "b"], "mode");
    expect(v("")).toEqual({
      ok: false,
      reason: "mode value is required",
    });
  });

  test("makeAllowListValidator rejects slash-bearing allowed values at factory time", () => {
    // [LAW:types-are-the-program] Symmetric with the slash-rejection on
    // a gate's keys: the wire splits BOTH keys and values on
    // "/" so a slash-bearing option could never be delivered to the
    // validator as a single value. Catching at factory-build (config-
    // load time) per [LAW:verifiable-goals] — a misconfigured widget
    // declaration surfaces immediately, not on the operator's first
    // click.
    expect(() =>
      makeAllowListValidator(["good", "with/slash", "another/bad"], "mode"),
    ).toThrow(/contain "\/"/);
    // The error names every offender so the operator can find all
    // misconfigurations in one fix pass.
    expect(() =>
      makeAllowListValidator(["with/slash", "another/bad"], "mode"),
    ).toThrow(/with\/slash, another\/bad/);
    // Slash-free lists build fine.
    expect(() =>
      makeAllowListValidator(["a", "b", "c"], "mode"),
    ).not.toThrow();
  });

  test("ValidateResult discriminant is exhaustive (type-level)", () => {
    // [LAW:types-are-the-program] Exhaustiveness is a COMPILE-TIME
    // theorem about the union, not a runtime branch coverage check.
    // The `_exhaustive: never = s` assignment fails `pnpm typecheck`
    // (not Jest runtime) if ValidateResult grows an arm beyond
    // {ok:true,value} | {ok:false,reason} — because TS narrows `s` to
    // `never` only when both ok-arms are returned from above. Adding
    // a third arm (e.g. {ok:"pending", token}) leaves `s` non-never
    // at the assignment site, which the build rejects.
    //
    // [LAW:locality-or-seam] The sample theme is derived from the live
    // palette registry so this test depends only on what it asserts
    // (the union shape) — not on any particular theme name. A palette
    // rename or alias change leaves this test undisturbed; the
    // "accepts every resolvable palette" test above owns the registry-
    // ↔-validator bridge.
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
    checkShape(bare().validate("theme", aPaletteName!));
    checkShape(bare().validate("not-a-key", "x"));
  });
});
