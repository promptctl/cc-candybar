// [LAW:behavior-not-structure] These tests pin the merge cascade's contract:
// per-key precedence for globals/variables/segments, wholesale root replacement,
// and the brand handoff at validateConfig. The renderer accepts only
// ValidatedConfig, so the chain proven here is the chain used in production.

import {
  mergeWithDefault,
  validateConfig,
  ConfigError,
} from "../src/config/dsl-loader";
import type {
  DslConfig,
  LayoutNode,
  RawDslConfig,
  SegmentDecl,
} from "../src/config/dsl-types";

// A vertical container of horizontal rows — convenience builder for test roots.
const vert = (...rows: string[][]): LayoutNode => ({
  kind: "container",
  direction: "vertical",
  children: rows.map((segments) => ({
    kind: "container" as const,
    direction: "horizontal" as const,
    children: segments.map((name) => ({ kind: "segment" as const, name })),
  })),
});

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
  root: vert(["a", "b"]),
  actions: {},
  looks: {
    none: { hueShift: 0, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
  },
  presets: { default: {} },
  helpers: {},
  editGlobals: {},
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

  test("root: user replaces wholesale", () => {
    const raw: RawDslConfig = { root: vert(["b", "a"]) };
    expect(mergeWithDefault(raw, DFLT).root).toEqual(vert(["b", "a"]));
  });

  test("root absent → default root", () => {
    expect(mergeWithDefault({}, DFLT).root).toEqual(vert(["a", "b"]));
  });

  test("root explicit empty container suppresses all default segments", () => {
    // An empty-children vertical container is a valid root — it renders nothing.
    // Distinct from root absent (inherit the default).
    expect(
      mergeWithDefault({ root: vert() }, DFLT).root,
    ).toEqual(vert());
  });

  test("raw root wins over the default and is used verbatim", () => {
    const raw: RawDslConfig = { root: vert(["a"], ["b"]) };
    expect(mergeWithDefault(raw, DFLT).root).toEqual(vert(["a"], ["b"]));
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
      root: vert(["does-not-exist"]),
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
