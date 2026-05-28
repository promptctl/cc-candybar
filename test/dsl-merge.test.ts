// [LAW:behavior-not-structure] These tests pin the merge cascade's contract:
// per-key precedence for globals/variables/segments, wholesale replace for
// layout, and the brand handoff at validateConfig. The renderer accepts only
// ValidatedConfig, so the chain proven here is the chain used in production.

import {
  mergeWithDefault,
  validateConfig,
  ConfigError,
} from "../src/config/dsl-loader";
import type {
  DslConfig,
  RawDslConfig,
  SegmentDecl,
} from "../src/config/dsl-types";

// Self-contained default for these tests. Avoids coupling to
// DEFAULT_DSL_CONFIG's evolving content — merge semantics are the subject,
// not the bundled default's specific shape.
const DFLT: DslConfig = {
  globals: { default_bg: "black", default_fg: "white", palette: "textual-dark" },
  variables: {
    foo: { kind: "literal", value: "default-foo" },
    bar: { kind: "literal", value: "default-bar" },
  },
  segments: {
    a: { template: " A " } as SegmentDecl,
    b: { template: " B " } as SegmentDecl,
  },
  layout: ["a", "b"],
};

describe("mergeWithDefault", () => {
  test("empty raw equals the default", () => {
    expect(mergeWithDefault({}, DFLT)).toEqual(DFLT);
  });

  test("globals: shallow merge — user wins per field, others retained", () => {
    const raw: RawDslConfig = { globals: { default_fg: "cyan" } };
    const out = mergeWithDefault(raw, DFLT);
    expect(out.globals).toEqual({
      default_bg: "black", // from default
      default_fg: "cyan", // from user
      palette: "textual-dark", // from default
    });
  });

  test("variables: merge by name — user override, defaults retained", () => {
    const raw: RawDslConfig = {
      variables: {
        foo: { kind: "literal", value: "user-foo" },
        baz: { kind: "literal", value: "user-baz" },
      },
    };
    const out = mergeWithDefault(raw, DFLT);
    expect(out.variables.foo).toEqual({ kind: "literal", value: "user-foo" });
    expect(out.variables.bar).toEqual({ kind: "literal", value: "default-bar" });
    expect(out.variables.baz).toEqual({ kind: "literal", value: "user-baz" });
  });

  test("segments: merge by name — user override, defaults retained", () => {
    const raw: RawDslConfig = {
      segments: {
        a: { template: " A-user " } as SegmentDecl,
        c: { template: " C " } as SegmentDecl,
      },
    };
    const out = mergeWithDefault(raw, DFLT);
    expect(out.segments.a!.template).toBe(" A-user ");
    expect(out.segments.b!.template).toBe(" B ");
    expect(out.segments.c!.template).toBe(" C ");
  });

  test("layout: user replaces wholesale when present and non-empty", () => {
    const raw: RawDslConfig = { layout: ["b", "a"] };
    expect(mergeWithDefault(raw, DFLT).layout).toEqual(["b", "a"]);
  });

  test("layout: absent → default layout", () => {
    expect(mergeWithDefault({}, DFLT).layout).toEqual(["a", "b"]);
  });

  test("layout: explicit [] → empty layout (user suppresses all default segments)", () => {
    // [LAW:types-are-the-program] RawDslConfig.layout carries three states
    // (absent / [] / non-empty). The merge respects that discriminator —
    // explicit [] means "render no segments", distinct from absent.
    expect(mergeWithDefault({ layout: [] }, DFLT).layout).toEqual([]);
  });

  test("default arg is DEFAULT_DSL_CONFIG when omitted (sanity)", () => {
    // Without a `dflt` argument, mergeWithDefault uses the bundled default —
    // a real ValidatedConfig fixture flows through without throwing.
    const out = mergeWithDefault({});
    expect(out.layout.length).toBeGreaterThan(0); // bundled default has a layout
  });
});

describe("validateConfig", () => {
  test("returns ValidatedConfig for a clean merged config", () => {
    // ValidatedConfig is structurally DslConfig + a phantom brand; runtime
    // identity is preserved.
    const merged = mergeWithDefault({}, DFLT);
    const validated = validateConfig(merged, "<test>");
    expect(validated).toBe(merged);
  });

  test("throws ConfigError when a merged layout references an unknown segment", () => {
    const merged: DslConfig = {
      ...DFLT,
      layout: ["does-not-exist"],
    };
    expect(() => validateConfig(merged, "<test>")).toThrow(ConfigError);
  });

  test("throws ConfigError when a merged template references an unknown variable", () => {
    const merged: DslConfig = {
      ...DFLT,
      segments: {
        ...DFLT.segments,
        a: { template: " {{ .does_not_exist }} " } as SegmentDecl,
      },
    };
    expect(() => validateConfig(merged, "<test>")).toThrow(ConfigError);
  });
});
