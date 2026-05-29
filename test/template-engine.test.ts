// [LAW:behavior-not-structure] Tests assert template evaluation outcomes
// (fragment text, error types/messages), never internal AST shapes.

import { createCcCandybarEngine } from "../src/template-engine/engine";
import { buildScope } from "../src/template-engine/scope";
import { ccCandybarFuncs } from "../src/template-engine/funcs";
import { VariableStore } from "../src/var-system/store";
import { MissingFieldError, ParseError } from "@promptctl/go-template-js";

// Helper: evaluate a template against a plain-object scope, return joined text.
function evalText(source: string, scope: object): string {
  const engine = createCcCandybarEngine();
  return engine.parse(source).evaluate(scope).map((rt) => rt.plain).join("");
}

// Helper: evaluate against a VariableStore scope.
function evalStore(source: string, store: VariableStore): string {
  const engine = createCcCandybarEngine();
  const scope = buildScope(store);
  return engine.parse(source).evaluate(scope).map((rt) => rt.plain).join("");
}

// Helper: make a store with one box variable.
function oneBox(name: string, value: string | number | boolean): VariableStore {
  const store = new VariableStore();
  const type = typeof value as "string" | "number" | "boolean";
  store.defineBox(name, type, value);
  return store;
}

// ────────────────────────────────────────────────────────────────
// 1. Text literals and basic interpolation
// ────────────────────────────────────────────────────────────────

describe("text literals", () => {
  test("plain text passes through unchanged", () => {
    expect(evalText("hello world", {})).toBe("hello world");
  });

  test("empty template produces empty string", () => {
    expect(evalText("", {})).toBe("");
  });

  test("field interpolation from plain object", () => {
    expect(evalText("{{ .name }}", { name: "ada" })).toBe("ada");
  });

  test("number field interpolated as string", () => {
    expect(evalText("{{ .count }}", { count: 42 })).toBe("42");
  });

  test("boolean field interpolated as string", () => {
    expect(evalText("{{ .flag }}", { flag: true })).toBe("true");
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Variable resolver (VariableStore → scope Proxy)
// ────────────────────────────────────────────────────────────────

describe("variable resolver (store scope)", () => {
  test("top-level variable reads from store", () => {
    const store = oneBox("cwd", "/home/user/project");
    expect(evalStore("{{ .cwd }}", store)).toBe("/home/user/project");
  });

  test("dotted variable name routes through namespace proxy", () => {
    const store = oneBox("session.id", "abc123");
    expect(evalStore("{{ .session.id }}", store)).toBe("abc123");
  });

  test("multiple dotted namespaces in one store", () => {
    const store = new VariableStore();
    store.defineBox("git.branch", "string", "main");
    store.defineBox("git.dirty", "boolean", false);
    const scope = buildScope(store);
    const engine = createCcCandybarEngine();
    const tpl = engine.parse("{{ .git.branch }}:{{ .git.dirty }}");
    const result = tpl.evaluate(scope).map((rt) => rt.plain).join("");
    expect(result).toBe("main:false");
  });

  test("three-segment dotted variable", () => {
    const store = oneBox("a.b.c", "deep");
    expect(evalStore("{{ .a.b.c }}", store)).toBe("deep");
  });

  test("computed variable resolves correctly", () => {
    const store = new VariableStore();
    store.defineBox("prefix", "string", "hello");
    store.defineComputed("greeting", "string", (read) => read("prefix") + " world");
    expect(evalStore("{{ .greeting }}", store)).toBe("hello world");
  });

  test("unknown variable throws MissingFieldError", () => {
    const store = oneBox("cwd", "/home");
    const engine = createCcCandybarEngine();
    const scope = buildScope(store);
    const tpl = engine.parse("{{ .missing }}");
    expect(() => tpl.evaluate(scope)).toThrow(MissingFieldError);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. String filter functions (from sprigStrings)
// ────────────────────────────────────────────────────────────────

describe("string filters", () => {
  test("lower", () => {
    expect(evalText('{{ lower "HELLO" }}', {})).toBe("hello");
  });

  test("upper", () => {
    expect(evalText('{{ upper "hello" }}', {})).toBe("HELLO");
  });

  test("trunc truncates to n chars", () => {
    expect(evalText('{{ trunc 5 "hello world" }}', {})).toBe("hello");
  });

  test("trim removes whitespace", () => {
    expect(evalText('{{ trim "  hi  " }}', {})).toBe("hi");
  });

  test("trimPrefix removes prefix", () => {
    expect(evalText('{{ trimPrefix "refs/heads/" "refs/heads/main" }}', {})).toBe("main");
  });

  test("trimSuffix removes suffix", () => {
    expect(evalText('{{ trimSuffix ".go" "main.go" }}', {})).toBe("main");
  });

  test("replace replaces substring", () => {
    expect(evalText('{{ replace "-" "_" "foo-bar" }}', {})).toBe("foo_bar");
  });

  test("contains checks substring", () => {
    expect(evalText('{{ if contains "ell" "hello" }}yes{{ end }}', {})).toBe("yes");
  });

  test("hasPrefix checks prefix", () => {
    expect(evalText('{{ if hasPrefix "he" "hello" }}yes{{ end }}', {})).toBe("yes");
  });

  test("hasSuffix checks suffix", () => {
    expect(evalText('{{ if hasSuffix "lo" "hello" }}yes{{ end }}', {})).toBe("yes");
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Path functions (cc-candybar custom)
// ────────────────────────────────────────────────────────────────

describe("path functions", () => {
  test("basename extracts filename", () => {
    expect(evalText('{{ basename "/home/user/project" }}', {})).toBe("project");
  });

  test("dirname extracts parent directory", () => {
    expect(evalText('{{ dirname "/home/user/project" }}', {})).toBe("/home/user");
  });

  test("basename piped from field", () => {
    expect(evalText("{{ basename .cwd }}", { cwd: "/home/user/myproject" })).toBe("myproject");
  });
});

// ────────────────────────────────────────────────────────────────
// 4b. URL-encoding (cc-candybar custom)
// ────────────────────────────────────────────────────────────────

// [LAW:single-enforcer] urlEncode mirrors encodeURIComponent — the same
// function the legacy SegmentRenderer.renderToolbar uses when constructing
// cc-candybar:// click URLs. Templates that build URLs from path-shaped
// values (`.cwd`, `.session.id`, etc.) need this to produce URLs that
// byte-match the legacy form. Surfaced by the chunk-7 toolbar/tray DSL
// migration (lit brandon-segment-dsl-protocol-vhi.3).
describe("urlEncode", () => {
  test("encodes path separators and reserved characters", () => {
    expect(evalText('{{ urlEncode "/work/acme/src" }}', {})).toBe(
      "%2Fwork%2Facme%2Fsrc",
    );
  });

  test("passes alphanumeric strings through unchanged", () => {
    expect(evalText('{{ urlEncode "0a1b2c3d" }}', {})).toBe("0a1b2c3d");
  });

  test("piped from field", () => {
    expect(
      evalText("{{ urlEncode .cwd }}", { cwd: "/home/user space/x" }),
    ).toBe("%2Fhome%2Fuser%20space%2Fx");
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Cast functions (int / string / bool)
// ────────────────────────────────────────────────────────────────

describe("cast functions", () => {
  test("int converts numeric string to number", () => {
    expect(evalText('{{ int "42" }}', {})).toBe("42");
  });

  test("string converts number to string", () => {
    expect(evalText("{{ string .count }}", { count: 7 })).toBe("7");
  });

  test("bool converts 'true' string to boolean", () => {
    expect(evalText('{{ bool "true" }}', {})).toBe("true");
  });

  test("bool converts 'false' string to boolean", () => {
    expect(evalText('{{ bool "false" }}', {})).toBe("false");
  });

  test("int throws on non-numeric string", () => {
    const engine = createCcCandybarEngine();
    const tpl = engine.parse('{{ int "abc" }}');
    expect(() => tpl.evaluate({})).toThrow(TypeError);
  });

  test("bool throws on ambiguous string", () => {
    const engine = createCcCandybarEngine();
    const tpl = engine.parse('{{ bool "yes" }}');
    expect(() => tpl.evaluate({})).toThrow(TypeError);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Default function and conditionals
// ────────────────────────────────────────────────────────────────

describe("default function and conditionals", () => {
  test("default returns fallback when value is empty", () => {
    expect(evalText('{{ default "n/a" .branch }}', { branch: "" })).toBe("n/a");
  });

  test("default returns value when non-empty", () => {
    expect(evalText('{{ default "n/a" .branch }}', { branch: "main" })).toBe("main");
  });

  test("if/else conditional on boolean", () => {
    expect(evalText("{{ if .dirty }}●{{ else }}○{{ end }}", { dirty: true })).toBe("●");
    expect(evalText("{{ if .dirty }}●{{ else }}○{{ end }}", { dirty: false })).toBe("○");
  });

  test("if with eq builtin", () => {
    expect(evalText('{{ if eq .env "prod" }}PROD{{ end }}', { env: "prod" })).toBe("PROD");
  });

  test("if with ne builtin", () => {
    expect(evalText('{{ if ne .branch "" }}{{ .branch }}{{ end }}', { branch: "main" })).toBe("main");
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Filter chains
// ────────────────────────────────────────────────────────────────

describe("filter chains", () => {
  test("basename | upper", () => {
    expect(evalText('{{ "/a/b/foo" | basename | upper }}', {})).toBe("FOO");
  });

  test("field piped through multiple filters", () => {
    expect(evalText("{{ .cwd | basename | trunc 5 }}", { cwd: "/home/user/longproject" })).toBe("longp");
  });

  test("field piped through trimPrefix then lower", () => {
    expect(
      evalText('{{ .branch | trimPrefix "refs/heads/" | lower }}', { branch: "refs/heads/MAIN" })
    ).toBe("main");
  });

  test("printf with field", () => {
    expect(evalText('{{ printf "#%s" .id }}', { id: "abc123" })).toBe("#abc123");
  });
});

// ────────────────────────────────────────────────────────────────
// 8. Error cases
// ────────────────────────────────────────────────────────────────

describe("error cases", () => {
  test("unbalanced action throws ParseError", () => {
    const engine = createCcCandybarEngine();
    expect(() => engine.parse("{{ .foo")).toThrow(ParseError);
  });

  test("unknown function throws at eval time", () => {
    const engine = createCcCandybarEngine();
    const tpl = engine.parse("{{ nonexistent .x }}");
    expect(() => tpl.evaluate({ x: "y" })).toThrow();
  });

  test("missing field on namespace prefix throws MissingFieldError", () => {
    const store = oneBox("session.id", "x");
    const engine = createCcCandybarEngine();
    const scope = buildScope(store);
    const tpl = engine.parse("{{ .session.notreal }}");
    expect(() => tpl.evaluate(scope)).toThrow(MissingFieldError);
  });
});

// ────────────────────────────────────────────────────────────────
// 9. ccCandybarFuncs shape
// ────────────────────────────────────────────────────────────────

describe("ccCandybarFuncs registry", () => {
  test("registers exactly the expected names", () => {
    const funcs = ccCandybarFuncs();
    expect(Object.keys(funcs).sort()).toEqual([
      "basename",
      "bool",
      "dirname",
      "int",
      "string",
      "styles",
      "themes",
      "urlEncode",
    ]);
  });

  test("all entries have argTypes array", () => {
    const funcs = ccCandybarFuncs();
    for (const [name, entry] of Object.entries(funcs)) {
      expect(Array.isArray(entry.argTypes)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 10. Domain-list bindings (themes / styles)
// ────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The DSL `themes()` and `styles()` bindings
// project the SAME canonical sources as the set-state validators
// (listResolvablePaletteNames / STYLE_ORDER). A widget config that
// `range`s over themes() to emit OSC-8 picker cells is iterating the
// allow-list the validator will enforce on the resulting click — the
// list and the gate cannot diverge. These tests pin the projection
// shape (zero-arg, list-returning) so a refactor that changed the
// signature would break here loudly.
describe("themes / styles domain-list bindings", () => {
  test("themes() returns the canonical resolvable-palette list", async () => {
    const { listResolvablePaletteNames } = await import(
      "../src/themes/cascade"
    );
    const expected = [...listResolvablePaletteNames()];
    const result = evalText(
      "{{ range themes }}{{ . }}|{{ end }}",
      {},
    );
    expect(result).toBe(expected.join("|") + "|");
  });

  test("styles() returns the canonical STYLE_ORDER list", async () => {
    const { STYLE_ORDER } = await import("../src/themes/default-mapping");
    const expected = [...STYLE_ORDER];
    const result = evalText(
      "{{ range styles }}{{ . }}|{{ end }}",
      {},
    );
    expect(result).toBe(expected.join("|") + "|");
  });

  test("themes() participates in `has` membership checks", () => {
    // [LAW:dataflow-not-control-flow] A picker template uses `has`
    // against themes() to mark the currently-active item. This exercises
    // the same composition path the widget will use in chunk-11 .3.
    const result = evalText(
      '{{ if has "nord" themes }}yes{{ else }}no{{ end }}',
      {},
    );
    expect(result).toBe("yes");
  });

  test("themes() and styles() are zero-arg list-returning bindings", () => {
    const funcs = ccCandybarFuncs();
    const themesEntry = funcs.themes;
    const stylesEntry = funcs.styles;
    expect(themesEntry).toBeDefined();
    expect(stylesEntry).toBeDefined();
    expect(themesEntry?.argTypes).toEqual([]);
    expect(stylesEntry?.argTypes).toEqual([]);
  });
});
