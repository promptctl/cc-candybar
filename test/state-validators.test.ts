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
  listStateKeys,
  makeAllowListValidator,
  registerStateValidator,
  STATE_VALIDATORS,
  validateStateWrite,
  type ValidateResult,
} from "../src/daemon/verbs/state-validators";
import { listResolvablePaletteNames } from "../src/themes/cascade";
import { STYLE_ORDER } from "../src/themes/default-mapping";

describe("state-validators registry contract", () => {
  test("listStateKeys() exactly enumerates the baseline writable schema", () => {
    // [LAW:single-enforcer] One assertion of "these are THE baseline
    // writable keys." When .2 (this ticket) introduces the extension
    // API, the BASELINE remains the static three — extensions
    // register/dispose around it without polluting the assertion. A
    // future child that adds a baseline key updates THIS list and
    // surfaces the change in the diff, so downstream surfaces (DSL
    // bindings, docs, panel migration) get the signal.
    expect([...listStateKeys()].sort()).toEqual(
      ["style", "theme", "toolbar-expanded"].sort(),
    );
  });

  test("STATE_VALIDATORS keys match listStateKeys() exactly", () => {
    // The exported ReadonlyMap view and the snapshot fn must agree by
    // construction — both read the same private mutable Map. A drift
    // here means somebody mutated one without the other.
    expect([...STATE_VALIDATORS.keys()].sort()).toEqual(
      [...listStateKeys()].sort(),
    );
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
    ];
    for (const [input, normalized] of expected) {
      const result = validateStateWrite("toolbar-expanded", input);
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
    const result = validateStateWrite("toolbar-expanded", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected boolean-ish/);
  });

  test("unknown key rejection lists the registered keys", () => {
    // [LAW:errors-context-in-errors] The rejection IS the schema
    // surface for a confused caller — confirms the error carries the
    // current listStateKeys() contents, not a stale literal.
    const result = validateStateWrite("not-a-key", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const key of listStateKeys()) expect(result.reason).toContain(key);
    }
  });

  test("registerStateValidator adds a key and the disposer removes it", () => {
    // [LAW:locality-or-seam] The caller (widget-config loader) owns the
    // lifecycle of the validator it installed. Disposer-on-register is
    // the seam that lets a hot-reload of a DSL config dispose old +
    // install new without a global reset path that could clobber other
    // configs' entries.
    const disposer = registerStateValidator("mode", (raw) =>
      raw === "full" || raw === "compact"
        ? { ok: true, value: raw }
        : { ok: false, reason: `bad mode "${raw}"` },
    );
    try {
      expect(listStateKeys()).toContain("mode");
      expect(validateStateWrite("mode", "full")).toEqual({
        ok: true,
        value: "full",
      });
      expect(validateStateWrite("mode", "bogus")).toEqual({
        ok: false,
        reason: 'bad mode "bogus"',
      });
    } finally {
      disposer();
    }
    expect(listStateKeys()).not.toContain("mode");
    const after = validateStateWrite("mode", "full");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toMatch(/unknown state key "mode"/);
  });

  test("registerStateValidator throws on duplicate key (no silent shadow)", () => {
    // [LAW:no-silent-fallbacks] Two widget configs both claiming a key
    // is a config-authoring bug; silently shadowing the existing
    // validator would hide it. The throw aborts the second
    // registration entirely — partial installation is unrepresentable.
    const disposer = registerStateValidator("mode-2", () => ({
      ok: true,
      value: "x",
    }));
    try {
      expect(() =>
        registerStateValidator("mode-2", () => ({ ok: true, value: "y" })),
      ).toThrow(/already has a validator/);
      // The original validator is undisturbed.
      expect(validateStateWrite("mode-2", "anything")).toEqual({
        ok: true,
        value: "x",
      });
    } finally {
      disposer();
    }
  });

  test("registerStateValidator throws on baseline key (theme/style/toolbar-expanded)", () => {
    // The baseline three are no different from extensions at the
    // dispatch layer — they share the same Map. A widget config that
    // tries to override `theme` collides loudly rather than silently
    // hijacking the canonical theme validator.
    expect(() =>
      registerStateValidator("theme", () => ({ ok: true, value: "x" })),
    ).toThrow(/already has a validator/);
  });

  test("registerStateValidator rejects empty key", () => {
    expect(() =>
      registerStateValidator("", () => ({ ok: true, value: "x" })),
    ).toThrow(/key is required/);
  });

  test("registerStateValidator rejects slash-bearing keys", () => {
    // [LAW:types-are-the-program] The set-state wire shape splits the
    // tail on "/" — a slash-bearing key would be broken into two
    // segments before dispatch, making it structurally unaddressable.
    // Listing such a key in listStateKeys() while it cannot be written
    // to is the registry-vs-wire drift the registration check forbids.
    expect(() =>
      registerStateValidator("a/b", () => ({ ok: true, value: "x" })),
    ).toThrow(/contains "\/"/);
    // The failing registration must NOT pollute the registry.
    expect(listStateKeys()).not.toContain("a/b");
  });

  test("disposer is idempotent (second call is a no-op)", () => {
    // [LAW:single-enforcer] Double-dispose must not affect a key
    // re-registered by a different caller between calls.
    const dispose1 = registerStateValidator("idem-1", () => ({
      ok: true,
      value: "a",
    }));
    dispose1();
    expect(listStateKeys()).not.toContain("idem-1");
    // Re-register under the same key with a different validator.
    const dispose2 = registerStateValidator("idem-1", () => ({
      ok: true,
      value: "b",
    }));
    try {
      // Second call of the FIRST disposer must NOT remove the new entry.
      dispose1();
      expect(listStateKeys()).toContain("idem-1");
      expect(validateStateWrite("idem-1", "anything")).toEqual({
        ok: true,
        value: "b",
      });
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
    // registerStateValidator: the wire splits BOTH keys and values on
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

  test("makeAllowListValidator composes with registerStateValidator", () => {
    // [LAW:one-type-per-behavior] The canonical "widget options = allow
    // list" registration shape — one factory call + one register call
    // expresses "key X is written from list Y."
    const disposer = registerStateValidator(
      "compose-key",
      makeAllowListValidator(["one", "two"], "compose-key"),
    );
    try {
      expect(validateStateWrite("compose-key", "one")).toEqual({
        ok: true,
        value: "one",
      });
      const bad = validateStateWrite("compose-key", "three");
      expect(bad.ok).toBe(false);
      if (!bad.ok)
        expect(bad.reason).toMatch(/unknown compose-key "three"/);
    } finally {
      disposer();
    }
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
    checkShape(validateStateWrite("theme", aPaletteName!));
    checkShape(validateStateWrite("not-a-key", "x"));
  });
});
