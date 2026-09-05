// [LAW:behavior-not-structure] These tests pin the merge cascade's contract:
// per-key precedence for globals/variables/segments, root rows merged by name
// (a whole tree replaces), and the brand handoff at validateConfig. The
// renderer accepts only ValidatedConfig, so the chain proven here is the chain
// used in production.

import {
  mergeWithDefault,
  validateConfig,
  ConfigError,
} from "../src/config/dsl-loader";
import { rootOf } from "../src/config/root";
import type {
  DslConfig,
  LayoutNode,
  RawDslConfig,
  SegmentDecl,
} from "../src/config/dsl-types";

// A horizontal row of segment refs, and a vertical stack of them —
// convenience builders for test roots.
const hrow = (...segments: string[]): LayoutNode => ({
  kind: "container",
  direction: "horizontal",
  children: segments.map((name) => ({ kind: "segment" as const, name })),
});
const vert = (...rows: string[][]): LayoutNode => ({
  kind: "container",
  direction: "vertical",
  children: rows.map((segments) => hrow(...segments)),
});

// Self-contained default for these tests. Avoids coupling to
// DEFAULT_DSL_CONFIG's evolving content — merge semantics are the subject,
// not the bundled default's specific shape. Two named rows, so a replaced
// row's POSITION is observable.
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
  root: { rows: { main: hrow("a"), status: hrow("b") } },
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

  test("root: a whole tree replaces the default's rows outright", () => {
    const raw: RawDslConfig = { root: vert(["b", "a"]) };
    expect(mergeWithDefault(raw, DFLT).root).toEqual(rootOf(vert(["b", "a"])));
  });

  test("root absent → default root", () => {
    expect(mergeWithDefault({}, DFLT).root).toEqual(DFLT.root);
  });

  test("root: an empty tree suppresses every default row", () => {
    // Distinct from root absent (inherit the default): the bar renders nothing.
    expect(mergeWithDefault({ root: vert() }, DFLT).root).toEqual({ rows: {} });
  });

  test("root: a tree's `when` lifts to the bar", () => {
    const raw: RawDslConfig = { root: { ...vert(["a"]), when: "{{ .x }}" } };
    expect(mergeWithDefault(raw, DFLT).root).toEqual({
      rows: { "#1": hrow("a") },
      when: "{{ .x }}",
    });
  });

  test("rows: replace one row by name, in place — the other inherited", () => {
    const raw: RawDslConfig = { root: { rows: { main: hrow("b", "a") } } };
    expect(mergeWithDefault(raw, DFLT).root).toEqual({
      rows: { main: hrow("b", "a"), status: hrow("b") },
    });
  });

  test("rows: a new row appends after the inherited ones", () => {
    const raw: RawDslConfig = { root: { rows: { extra: hrow("a") } } };
    expect(Object.keys(mergeWithDefault(raw, DFLT).root.rows)).toEqual([
      "main",
      "status",
      "extra",
    ]);
  });

  test("rows: an empty container removes a default row without restating the rest", () => {
    const raw: RawDslConfig = { root: { rows: { status: hrow() } } };
    expect(mergeWithDefault(raw, DFLT).root).toEqual({
      rows: { main: hrow("a"), status: hrow() },
    });
  });

  test("rows: `when` is carried like a globals field", () => {
    const raw: RawDslConfig = { root: { rows: {}, when: "{{ .x }}" } };
    expect(mergeWithDefault(raw, DFLT).root).toEqual({
      ...DFLT.root,
      when: "{{ .x }}",
    });
  });

  test("rows: a fragment without `when` keeps the base's `when`", () => {
    const gated: DslConfig = {
      ...DFLT,
      root: { ...DFLT.root, when: "{{ .gate }}" },
    };
    const raw: RawDslConfig = { root: { rows: { extra: hrow("a") } } };
    expect(mergeWithDefault(raw, gated).root).toEqual({
      rows: { ...DFLT.root.rows, extra: hrow("a") },
      when: "{{ .gate }}",
    });
  });

  test("rows: `{ rows: {} }` is the merge's identity", () => {
    expect(mergeWithDefault({ root: { rows: {} } }, DFLT).root).toEqual(DFLT.root);
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
      root: rootOf(vert(["does-not-exist"])),
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
