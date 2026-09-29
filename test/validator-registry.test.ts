// [LAW:single-enforcer] Whether two contributions may share a key is decided by
// mergeKeySpecs alone, whether they come from one config's action table or
// from two configs the daemon holds at once. Every config's settings menu
// registers `padding` as a clearable key (an empty allow-list) while a user's
// own `persist` stepper registers it as a range — the two must coexist.

import { createValidatorRegistry } from "../src/daemon/verbs/validator-registry";

describe("a registry key shared across configs", () => {
  test("an empty allow-list and a range coexist, gated by the range", () => {
    const registry = createValidatorRegistry({}, "config");
    const disposeClearable = registry.register("padding", {
      kind: "allow-list",
      allowed: [],
    });
    registry.register("padding", { kind: "range", min: 0, max: 16 });
    expect(registry.rangeParamsFor("padding")).toEqual({
      min: 0,
      max: 16,
    });
    expect(registry.validate("padding", "4")).toMatchObject({ ok: true });
    expect(registry.validate("padding", "40")).toEqual({
      ok: true,
      value: "16",
    });
    expect(registry.validate("padding", "wide").ok).toBe(false);
    disposeClearable();
    expect(registry.rangeParamsFor("padding")).not.toBeNull();
  });

  test("an incoherent pair throws, and leaves the key as it was", () => {
    const registry = createValidatorRegistry({}, "config");
    registry.register("padding", { kind: "range", min: 0, max: 16 });
    expect(() =>
      registry.register("padding", { kind: "allow-list", allowed: ["wide"] }),
    ).toThrow(/non-integer/);
    expect(registry.validate("padding", "4")).toMatchObject({ ok: true });
    expect(registry.rangeParamsFor("padding")).toEqual({
      min: 0,
      max: 16,
    });
  });
});
