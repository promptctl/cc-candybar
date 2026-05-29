// [LAW:behavior-not-structure] Tests assert on the observable contract:
// either a returned DslConfig with the expected shape, or a ConfigError
// whose issues describe the problem. Tests never reach into private
// helpers — extractTemplateRefs and findKeyLine are exported for direct
// unit-test coverage of their tricky bits, but everything else goes
// through parseDslConfig.

import {
  ConfigError,
  extractTemplateRefs,
  findKeyLine,
} from "../src/config/dsl-loader";
import { parseAndValidate } from "./helpers/parse-and-validate";

const FILE = "/tmp/test.json5";

function expectError(source: string): ConfigError {
  try {
    parseAndValidate(FILE, source);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected ConfigError, got success");
}

function expectIssue(
  source: string,
  matcher: { path?: string | RegExp; message: string | RegExp },
): void {
  const err = expectError(source);
  const matched = err.issues.find((i) => {
    const pathOk =
      matcher.path === undefined
        ? true
        : matcher.path instanceof RegExp
          ? matcher.path.test(i.path)
          : i.path === matcher.path;
    const msgOk =
      matcher.message instanceof RegExp
        ? matcher.message.test(i.message)
        : i.message.includes(matcher.message);
    return pathOk && msgOk;
  });
  if (!matched) {
    throw new Error(
      `expected an issue matching ${JSON.stringify(matcher)}; got:\n${err.message}`,
    );
  }
}

// ─── JSON5 syntax errors ─────────────────────────────────────────────────────

describe("loadDslConfig — JSON5 syntax", () => {
  test("malformed JSON throws with line/col", () => {
    const err = expectError("{ globals: { default_bg: ");
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]!.message).toMatch(/JSON5 syntax error/);
    expect(err.issues[0]!.line).toBeGreaterThan(0);
  });

  test("trailing comma + comments are accepted (JSON5 superset)", () => {
    const cfg = parseAndValidate(
      FILE,
      `// a comment
{ globals: { default_bg: "blue", }, /* trailing comma OK */ }`,
    );
    expect(cfg.globals.default_bg).toBe("blue");
  });

  test("root must be an object", () => {
    expectIssue("[1, 2, 3]", { path: "", message: "Config root must be an object" });
  });
});

// ─── Top-level shape ─────────────────────────────────────────────────────────

describe("loadDslConfig — top-level shape", () => {
  test("empty config is valid", () => {
    const cfg = parseAndValidate(FILE, "{}");
    expect(cfg).toEqual({
      globals: {},
      variables: {},
      segments: {},
      layout: [],
      widgets: {},
    });
  });

  test("unknown top-level keys are reported", () => {
    expectIssue(`{ wrongkey: 1 }`, {
      path: "wrongkey",
      message: 'Unknown top-level key "wrongkey"',
    });
  });

  test("globals must be an object", () => {
    expectIssue(`{ globals: "not-an-object" }`, {
      path: "globals",
      message: "globals must be an object",
    });
  });

  test("variables must be an object", () => {
    expectIssue(`{ variables: [] }`, {
      path: "variables",
      message: "variables must be an object",
    });
  });

  test("segments must be an object", () => {
    expectIssue(`{ segments: 5 }`, {
      path: "segments",
      message: "segments must be an object",
    });
  });

  test("layout must be an array", () => {
    expectIssue(`{ layout: "not-array" }`, {
      path: "layout",
      message: "layout must be an array",
    });
  });
});

// ─── Globals ─────────────────────────────────────────────────────────────────

describe("loadDslConfig — globals", () => {
  test("all string fields accepted", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ globals: {
        default_bg: "black", default_fg: "white",
        default_empty_value: "—", default_separator: " ",
        default_truncate_marker: "…",
        hueStep: 12,
      }}`,
    );
    expect(cfg.globals).toEqual({
      default_bg: "black",
      default_fg: "white",
      default_empty_value: "—",
      default_separator: " ",
      default_truncate_marker: "…",
      hueStep: 12,
    });
  });

  test("unknown globals key is reported", () => {
    expectIssue(`{ globals: { mystery: "x" } }`, {
      path: "globals.mystery",
      message: 'Unknown globals key "mystery"',
    });
  });

  test("non-string default_bg is rejected", () => {
    expectIssue(`{ globals: { default_bg: 42 } }`, {
      path: "globals.default_bg",
      message: "globals.default_bg must be a string",
    });
  });

  test("non-numeric hueStep is rejected", () => {
    expectIssue(`{ globals: { hueStep: "12" } }`, {
      path: "globals.hueStep",
      message: "globals.hueStep must be a finite number",
    });
  });

  test("Infinity hueStep is rejected", () => {
    expectIssue(`{ globals: { hueStep: Infinity } }`, {
      path: "globals.hueStep",
      message: "globals.hueStep must be a finite number",
    });
  });
});

// ─── Variable kinds ──────────────────────────────────────────────────────────

describe("loadDslConfig — variable source kinds", () => {
  test("literal: string/number/boolean values", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        a: { kind: "literal", value: "hi" },
        b: { kind: "literal", value: 42 },
        c: { kind: "literal", value: true },
      }}`,
    );
    expect(cfg.variables.a).toEqual({ kind: "literal", value: "hi" });
    expect(cfg.variables.b).toEqual({ kind: "literal", value: 42 });
    expect(cfg.variables.c).toEqual({ kind: "literal", value: true });
  });

  test("literal: object value is rejected", () => {
    expectIssue(`{ variables: { a: { kind: "literal", value: { x: 1 } } } }`, {
      path: "variables.a.value",
      message: "literal value must be string|number|boolean",
    });
  });

  test("input: requires path", () => {
    expectIssue(`{ variables: { sid: { kind: "input" } } }`, {
      path: "variables.sid.path",
      message: "variables.sid.path must be a string",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { sid: { kind: "input", path: "session.id" } } }`,
    );
    expect(ok.variables.sid).toEqual({ kind: "input", path: "session.id" });
  });

  test("env: requires name", () => {
    expectIssue(`{ variables: { home: { kind: "env" } } }`, {
      path: "variables.home.name",
      message: "variables.home.name must be a string",
    });
  });

  test("unknown source kind is rejected", () => {
    expectIssue(`{ variables: { x: { kind: "wat" } } }`, {
      path: "variables.x.kind",
      message: 'Unknown source kind "wat"',
    });
  });

  test("missing kind is rejected", () => {
    expectIssue(`{ variables: { x: { value: "hi" } } }`, {
      path: "variables.x.kind",
      message: "variables.x.kind must be a string",
    });
  });

  test("shell: requires command + cache", () => {
    expectIssue(`{ variables: { x: { kind: "shell" } } }`, {
      path: "variables.x.command",
      message: "variables.x.command must be a string",
    });
    expectIssue(`{ variables: { x: { kind: "shell", command: "echo" } } }`, {
      path: "variables.x.cache",
      message: "shell variables must declare a cache policy",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { x: { kind: "shell", command: "uptime", cache: { ttl: "5s" } } } }`,
    );
    expect(ok.variables.x).toEqual({
      kind: "shell",
      command: "uptime",
      cache: { ttl: "5s" },
    });
  });

  test("file: requires path + cache; readMode optional", () => {
    expectIssue(`{ variables: { x: { kind: "file" } } }`, {
      path: "variables.x.path",
      message: "variables.x.path must be a string",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { x: { kind: "file", path: "/etc/hostname", readMode: "first-line", cache: { watch_file: "/etc/hostname" } } } }`,
    );
    expect(ok.variables.x).toEqual({
      kind: "file",
      path: "/etc/hostname",
      readMode: "first-line",
      cache: { watch_file: "/etc/hostname" },
    });
  });

  test("file: invalid readMode rejected", () => {
    expectIssue(
      `{ variables: { x: { kind: "file", path: "/x", readMode: "weird", cache: { ttl: "5s" } } } }`,
      {
        path: "variables.x.readMode",
        message: "variables.x.readMode must be one of: whole, first-line",
      },
    );
  });

  test("template: requires template; cache optional", () => {
    expectIssue(`{ variables: { x: { kind: "template" } } }`, {
      path: "variables.x.template",
      message: "variables.x.template must be a string",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { cwd_short: { kind: "template", template: "static" } } }`,
    );
    expect(ok.variables.cwd_short).toEqual({
      kind: "template",
      template: "static",
    });
  });

  test("time: requires layout", () => {
    expectIssue(`{ variables: { now: { kind: "time" } } }`, {
      path: "variables.now.layout",
      message: "variables.now.layout must be a string",
    });
  });

  test("git: field must be in closed set + cache required", () => {
    expectIssue(`{ variables: { b: { kind: "git" } } }`, {
      path: "variables.b.field",
      message: "git field must be one of: branch, sha, dirty, ahead, behind, stash",
    });
    expectIssue(
      `{ variables: { b: { kind: "git", field: "not-a-field", cache: { ttl: "5s" } } } }`,
      {
        path: "variables.b.field",
        message: "git field must be one of",
      },
    );
    expectIssue(`{ variables: { b: { kind: "git", field: "branch" } } }`, {
      path: "variables.b.cache",
      message: "git variables must declare a cache policy",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { b: { kind: "git", field: "branch", cache: { watch_file: ".git/HEAD" }, default: "(detached)" } } }`,
    );
    expect(ok.variables.b).toEqual({
      kind: "git",
      field: "branch",
      cache: { watch_file: ".git/HEAD" },
      default: "(detached)",
    });
  });
});

// ─── Cache policies ──────────────────────────────────────────────────────────

describe("loadDslConfig — cache policies", () => {
  const base = (cache: string) =>
    `{ variables: { x: { kind: "shell", command: "echo", cache: ${cache} } } }`;

  test("ttl: requires duration string format", () => {
    expectIssue(base(`{ ttl: "forever" }`), {
      path: "variables.x.cache.ttl",
      message: "cache.ttl must be a duration string",
    });
    const ok = parseAndValidate(FILE, base(`{ ttl: "100ms" }`));
    expect(ok.variables.x).toEqual({
      kind: "shell",
      command: "echo",
      cache: { ttl: "100ms" },
    });
  });

  test("watch_file: non-empty string", () => {
    expectIssue(base(`{ watch_file: "" }`), {
      path: "variables.x.cache.watch_file",
      message: "cache.watch_file must be a non-empty path string",
    });
  });

  test("depends_on: array of strings", () => {
    expectIssue(base(`{ depends_on: "branch" }`), {
      path: "variables.x.cache.depends_on",
      message: "cache.depends_on must be an array of variable-name strings",
    });
    expectIssue(base(`{ depends_on: [1, 2] }`), {
      path: "variables.x.cache.depends_on",
      message: "cache.depends_on must be an array of variable-name strings",
    });
  });

  test("never: must be literal true", () => {
    expectIssue(base(`{ never: false }`), {
      path: "variables.x.cache.never",
      message: "cache.never must be the literal boolean true",
    });
    const ok = parseAndValidate(
      FILE,
      `{ variables: { x: { kind: "template", template: "x", cache: { never: true } } } }`,
    );
    expect(ok.variables.x).toEqual({
      kind: "template",
      template: "x",
      cache: { never: true },
    });
  });

  test("zero cache keys rejected", () => {
    expectIssue(base(`{}`), {
      path: "variables.x.cache",
      message: "cache must declare exactly one of",
    });
  });

  test("multiple cache keys rejected", () => {
    expectIssue(base(`{ ttl: "5s", never: true }`), {
      path: "variables.x.cache",
      message: /found:.*ttl.*never|found:.*never.*ttl/,
    });
  });

  test("unknown cache key rejected", () => {
    expectIssue(base(`{ forever: true }`), {
      path: "variables.x.cache.forever",
      message: 'Unknown cache key "forever"',
    });
  });
});

// ─── Segments ────────────────────────────────────────────────────────────────

describe("loadDslConfig — segments", () => {
  test("template required", () => {
    expectIssue(`{ segments: { cwd: {} } }`, {
      path: "segments.cwd.template",
      message: "segments.cwd.template must be a string",
    });
  });

  test("width: 'auto' or positive int", () => {
    expectIssue(`{ segments: { x: { template: "t", width: 0 } } }`, {
      path: "segments.x.width",
      message: 'width must be "auto" or a positive integer',
    });
    expectIssue(`{ segments: { x: { template: "t", width: "wide" } } }`, {
      path: "segments.x.width",
      message: 'width must be "auto" or a positive integer',
    });
    const ok = parseAndValidate(
      FILE,
      `{ segments: { x: { template: "t", width: 12 }, y: { template: "u", width: "auto" } } }`,
    );
    expect(ok.segments.x!.width).toBe(12);
    expect(ok.segments.y!.width).toBe("auto");
  });

  test("justify: closed set", () => {
    expectIssue(`{ segments: { x: { template: "t", justify: "middle" } } }`, {
      path: "segments.x.justify",
      message: "segments.x.justify must be one of: left, center, right",
    });
  });

  test("truncate: closed set", () => {
    expectIssue(`{ segments: { x: { template: "t", truncate: "nope" } } }`, {
      path: "segments.x.truncate",
      message: "segments.x.truncate must be one of: right, left, middle",
    });
  });

  test("unknown segment key reported", () => {
    expectIssue(`{ segments: { x: { template: "t", mystery: 1 } } }`, {
      path: "segments.x.mystery",
      message: 'Unknown segment key "mystery"',
    });
  });

  test("optional fields preserved when valid", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { context: {
        template: "{{ .context_percent }}%",
        width: 6, justify: "right", truncate: "middle",
        bg: "warning", fg: "auto 60%",
        when: "{{ gt .context_percent 0 }}",
      }}, variables: { context_percent: { kind: "input", path: "context.percent" } } }`,
    );
    expect(cfg.segments.context).toEqual({
      template: "{{ .context_percent }}%",
      width: 6,
      justify: "right",
      truncate: "middle",
      bg: "warning",
      fg: "auto 60%",
      when: "{{ gt .context_percent 0 }}",
    });
  });
});

// ─── Per-segment palette switch (3rq.2) ──────────────────────────────────────

describe("loadDslConfig — palette switch", () => {
  // Inject a tiny set so validation behavior is independent of registry
  // contents; "real" names (gruvbox/monokai/nord) exercise the default path.
  const ALLOWED = new Set(["gruvbox", "monokai", "solar"]);

  test("globals.palette is preserved when a known name", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ globals: { palette: "gruvbox" }, segments: { cwd: { template: "t" } } }`,
    );
    expect(cfg.globals.palette).toBe("gruvbox");
  });

  test("per-segment palette is preserved when a known name", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ globals: { palette: "gruvbox" }, segments: {
        cwd: { template: "t" },
        toolbar: { template: "u", palette: "monokai" },
      } }`,
    );
    expect(cfg.segments.cwd!.palette).toBeUndefined();
    expect(cfg.segments.toolbar!.palette).toBe("monokai");
  });

  test("unknown globals palette fails loudly at load", () => {
    expectIssue(`{ globals: { palette: "nope" } }`, {
      path: "globals.palette",
      message: 'Unknown palette "nope"',
    });
  });

  test("unknown per-segment palette fails loudly at load", () => {
    expectIssue(`{ segments: { x: { template: "t", palette: "nope" } } }`, {
      path: "segments.x.palette",
      message: 'Unknown palette "nope"',
    });
  });

  test("unknown palette issue carries a source line", () => {
    const err = expectError(
      `{\n  globals: {\n    palette: "nope",\n  },\n}`,
    );
    const issue = err.issues.find((i) => i.path === "globals.palette");
    expect(issue?.line).toBe(3);
  });

  test("palette must be a string", () => {
    expectIssue(`{ globals: { palette: 7 } }`, {
      path: "globals.palette",
      message: "globals.palette must be a string",
    });
  });

  test("injected allowed set overrides the default registry", () => {
    // A name in the injected set passes even though it is not a real theme.
    const ok = parseAndValidate(
      FILE,
      `{ globals: { palette: "solar" } }`,
      ALLOWED,
    );
    expect(ok.globals.palette).toBe("solar");

    // A real theme name fails when the injected set excludes it — proving the
    // injected set is authoritative, not merely additive.
    const err = (() => {
      try {
        parseAndValidate(FILE, `{ globals: { palette: "nord" } }`, ALLOWED);
      } catch (e) {
        if (e instanceof ConfigError) return e;
        throw e;
      }
      throw new Error("expected ConfigError");
    })();
    expect(err.issues.some((i) => i.path === "globals.palette")).toBe(true);
  });
});

// ─── Layout ──────────────────────────────────────────────────────────────────

describe("loadDslConfig — layout", () => {
  test("string entries must match a declared segment", () => {
    expectIssue(
      `{ segments: { cwd: { template: "t" } }, layout: [["cwd", "missing"]] }`,
      {
        path: "layout[0][1]",
        message: 'layout entry "missing" does not match any declared segment',
      },
    );
  });

  test("non-string entries reported", () => {
    expectIssue(
      `{ segments: { cwd: { template: "t" } }, layout: [["cwd", 42]] }`,
      {
        path: "layout[0][1]",
        message: "layout entries must be strings",
      },
    );
  });

  test("valid layout passes through", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" }, b: { template: "y" } }, layout: [["a", "b", "a"]] }`,
    );
    expect(cfg.layout).toEqual([{ segments: ["a", "b", "a"] }]);
  });

  test("multi-row layout passes through (row order preserved)", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" }, b: { template: "y" }, c: { template: "z" } }, layout: [["a", "b"], ["c"]] }`,
    );
    expect(cfg.layout).toEqual([{ segments: ["a", "b"] }, { segments: ["c"] }]);
  });

  test("object-form row with when normalizes to { when, segments }", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" } }, layout: [{ when: '{{ true }}', segments: ["a"] }] }`,
    );
    expect(cfg.layout).toEqual([{ when: "{{ true }}", segments: ["a"] }]);
  });

  test("unknown layout-row key is rejected", () => {
    expectIssue(
      `{ segments: { a: { template: "x" } }, layout: [{ rows: ["a"] }] }`,
      { path: "layout[0].rows", message: "Unknown layout-row key" },
    );
  });

  test("structural error path reflects the row form the user wrote", () => {
    // [LAW:locality-or-seam] bare-array row → layout[r][c]; object row →
    // layout[r].segments[c]. The path mirrors the input, never asserting a
    // `.segments` key a sugar-form config never wrote.
    expectIssue(`{ segments: { a: { template: "x" } }, layout: [["a", 42]] }`, {
      path: "layout[0][1]",
      message: "layout entries must be strings",
    });
    expectIssue(
      `{ segments: { a: { template: "x" } }, layout: [{ segments: ["a", 42] }] }`,
      { path: "layout[0].segments[1]", message: "layout entries must be strings" },
    );
  });

  test("legacy flat string[] layout rejected with migration message", () => {
    // [LAW:no-silent-fallbacks] A pre-multiline-layout-ilg config with a flat
    // string[] layout must fail loudly. Auto-wrapping into [[...]] would
    // silently convert an outdated file into a working one and hide the
    // breaking change from users upgrading.
    expectIssue(
      `{ segments: { cwd: { template: "t" } }, layout: ["cwd"] }`,
      {
        path: "layout[0]",
        message: "wrap your segment list in an outer []",
      },
    );
  });

  test("row entries must be arrays", () => {
    expectIssue(
      `{ segments: { cwd: { template: "t" } }, layout: [42] }`,
      {
        path: "layout[0]",
        message: "layout row must be an array of segment names",
      },
    );
  });
});

// ─── Cross-reference validation ──────────────────────────────────────────────

describe("loadDslConfig — cross-references", () => {
  test("template references unknown variable is reported", () => {
    expectIssue(
      `{ segments: { cwd: { template: "{{ .nope }}" } } }`,
      {
        path: "segments.cwd.template",
        message: 'Template references unknown variable ".nope"',
      },
    );
  });

  test("template referencing declared variable passes", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: { cwd: { kind: "input", path: "cwd" } },
         segments: { d: { template: "{{ .cwd }}" } } }`,
    );
    expect(cfg.segments.d!.template).toBe("{{ .cwd }}");
  });

  test("dotted ref resolves to namespace prefix (.session matches session.id)", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: { "session.id": { kind: "input", path: "session.id" } },
         segments: { s: { template: "{{ .session.id }}" } } }`,
    );
    expect(cfg.segments.s!.template).toContain(".session.id");
  });

  test("dotted ref is rejected when only a scalar prefix is declared", () => {
    // .session.id where only `session` is declared: runtime would try to
    // field-access a scalar and throw MissingFieldError. Loader rejects
    // ahead of time. Mirrors the scope-proxy's leaf-vs-namespace dispatch
    // in src/template-engine/scope.ts.
    expectIssue(
      `{ variables: { session: { kind: "input", path: "session" } },
         segments: { s: { template: "{{ .session.id }}" } } }`,
      {
        path: "segments.s.template",
        message: 'Template references unknown variable ".session.id"',
      },
    );
  });

  test("bare reference to a namespace prefix passes (matches scope.has)", () => {
    // .session where only `session.id` is declared: scope proxy returns a
    // sub-proxy. Loader treats this as a valid ref because the rendering
    // failure (if any) is the template engine's job, not the loader's.
    const cfg = parseAndValidate(
      FILE,
      `{ variables: { "session.id": { kind: "input", path: "session.id" } },
         segments: { s: { template: "{{ if .session }}x{{ end }}" } } }`,
    );
    expect(cfg.segments.s!.template).toContain(".session");
  });

  test("string literals inside templates are NOT scanned for refs", () => {
    // A literal ".foo.bar" inside quotes should not count as a reference.
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { s: { template: "{{ printf \\".foo.bar\\" }}" } } }`,
    );
    expect(cfg.segments.s!.template).toContain("printf");
  });

  test("bg/fg/when templates are validated too", () => {
    expectIssue(
      `{ segments: { s: { template: "x", bg: "{{ .missing }}" } } }`,
      {
        path: "segments.s.bg",
        message: 'Template references unknown variable ".missing"',
      },
    );
    expectIssue(
      `{ segments: { s: { template: "x", when: "{{ ne .missing \\"\\" }}" } } }`,
      {
        path: "segments.s.when",
        message: 'Template references unknown variable ".missing"',
      },
    );
  });

  test("depends_on references unknown variable is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "shell", command: "x", cache: { depends_on: ["nonexistent"] } }
      }}`,
      {
        path: "variables.a.cache.depends_on[0]",
        message: 'cache.depends_on references unknown variable "nonexistent"',
      },
    );
  });

  test("depends_on across declared variables passes", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        branch: { kind: "git", field: "branch", cache: { watch_file: ".git/HEAD" } },
        recent: { kind: "shell", command: "echo", cache: { depends_on: ["branch"] } }
      }}`,
    );
    expect(cfg.variables.recent!.kind).toBe("shell");
  });

  test("segment-local vars visible to that segment's template", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: {
        s: {
          template: "{{ .local }}",
          vars: { local: { kind: "literal", value: "hi" } }
        }
      }}`,
    );
    expect(cfg.segments.s!.vars?.local!.kind).toBe("literal");
  });

  test("segment-local var namespaced ref passes from same segment", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: {
        s: {
          template: "{{ .s.local }}",
          vars: { local: { kind: "literal", value: "hi" } }
        }
      }}`,
    );
    expect(cfg.segments.s!.vars?.local!.kind).toBe("literal");
  });

  test("bare ref to another segment's local is rejected", () => {
    expectIssue(
      `{ segments: {
        a: { template: "x", vars: { shared: { kind: "literal", value: "1" } } },
        b: { template: "{{ .shared }}" }
      }}`,
      {
        path: "segments.b.template",
        message: 'Template references unknown variable ".shared"',
      },
    );
  });

  test("namespaced ref to another segment's local passes", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: {
        a: { template: "x", vars: { val: { kind: "literal", value: "1" } } },
        b: { template: "{{ .a.val }}" }
      }}`,
    );
    expect(cfg.segments.b!.template).toBe("{{ .a.val }}");
  });
});

// ─── Cycle detection ─────────────────────────────────────────────────────────

describe("loadDslConfig — cycle detection", () => {
  test("two-variable cycle is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "template", template: "{{ .b }}" },
        b: { kind: "template", template: "{{ .a }}" }
      }}`,
      {
        path: /variables\.(a|b)/,
        message: /Dependency cycle: .*(a → b → a|b → a → b)/,
      },
    );
  });

  test("self-cycle is reported", () => {
    expectIssue(
      `{ variables: { a: { kind: "template", template: "{{ .a }}" } } }`,
      {
        path: "variables.a",
        message: "Dependency cycle: a → a",
      },
    );
  });

  test("three-node cycle is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "template", template: "{{ .b }}" },
        b: { kind: "template", template: "{{ .c }}" },
        c: { kind: "template", template: "{{ .a }}" }
      }}`,
      { message: /Dependency cycle/ },
    );
  });

  test("non-cycle through input-kind var is fine", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        cwd_short: { kind: "template", template: "{{ .cwd }}" },
        cwd: { kind: "input", path: "cwd" }
      }}`,
    );
    expect(cfg.variables.cwd_short!.kind).toBe("template");
  });

  test("DAG (no cycle) passes", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        a: { kind: "template", template: "{{ .b }} {{ .c }}" },
        b: { kind: "template", template: "{{ .c }}" },
        c: { kind: "literal", value: "leaf" }
      }}`,
    );
    expect(Object.keys(cfg.variables)).toEqual(["a", "b", "c"]);
  });

  // depends_on cycle tests
  test("two-variable depends_on cycle is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "shell", command: "echo a", cache: { depends_on: ["b"] } },
        b: { kind: "shell", command: "echo b", cache: { depends_on: ["a"] } }
      }}`,
      {
        path: /variables\.(a|b)/,
        message: /Dependency cycle:.*(a → b → a|b → a → b)/,
      },
    );
  });

  test("self depends_on cycle is reported", () => {
    expectIssue(
      `{ variables: { a: { kind: "shell", command: "echo", cache: { depends_on: ["a"] } } } }`,
      {
        path: "variables.a",
        message: "Dependency cycle: a → a",
      },
    );
  });

  test("DAG with depends_on does not false-positive", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        a: { kind: "shell", command: "echo a", cache: { depends_on: ["b"] } },
        b: { kind: "shell", command: "echo b", cache: { ttl: "30s" } }
      }}`,
    );
    expect(Object.keys(cfg.variables)).toEqual(["a", "b"]);
  });

  // cache.key cycle tests
  test("two-variable cache.key cycle is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "shell", command: "echo a", cache: { key: "{{ .b }}" } },
        b: { kind: "shell", command: "echo b", cache: { key: "{{ .a }}" } }
      }}`,
      {
        path: /variables\.(a|b)/,
        message: /Dependency cycle:.*(a → b → a|b → a → b)/,
      },
    );
  });

  test("self cache.key cycle is reported", () => {
    expectIssue(
      `{ variables: { a: { kind: "shell", command: "echo", cache: { key: "{{ .a }}" } } } }`,
      {
        path: "variables.a",
        message: "Dependency cycle: a → a",
      },
    );
  });

  // mixed cycle: template var references shell var which depends_on the template var
  test("mixed cycle (template → depends_on → template) is reported", () => {
    expectIssue(
      `{ variables: {
        a: { kind: "template", template: "{{ .b }}" },
        b: { kind: "shell", command: "echo b", cache: { depends_on: ["a"] } }
      }}`,
      {
        path: /variables\.(a|b)/,
        message: /Dependency cycle:.*(a → b → a|b → a → b)/,
      },
    );
  });
});

// ─── Error aggregation ───────────────────────────────────────────────────────

describe("loadDslConfig — error aggregation", () => {
  test("multiple unrelated errors all reported in one throw", () => {
    const err = expectError(
      `{ globals: { hueStep: "no" }, variables: { x: { kind: "wat" } }, segments: { s: {} } }`,
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(3);
    expect(err.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "globals.hueStep",
        "variables.x.kind",
        "segments.s.template",
      ]),
    );
  });

  test("ConfigError.message lists every issue", () => {
    const err = expectError(
      `{ variables: { x: { kind: "shell", command: "echo" } }, segments: { s: {} } }`,
    );
    expect(err.message).toContain("Invalid config in");
    expect(err.message).toContain("variables.x.cache");
    expect(err.message).toContain("segments.s.template");
  });

  test("issues carry a line number when one can be located", () => {
    const source = `{
      globals: {
        mystery: "x"
      }
    }`;
    const err = expectError(source);
    const issue = err.issues.find((i) => i.path === "globals.mystery");
    expect(issue?.line).toBe(3);
  });
});

// ─── Valid corpus ────────────────────────────────────────────────────────────

describe("loadDslConfig — valid corpus", () => {
  test("full-featured DSL config covering every source kind", () => {
    const source = `{
      globals: {
        default_bg: "panel", default_fg: "text",
        default_separator: " ",
        hueStep: 8,
      },
      variables: {
        cwd: { kind: "input", path: "cwd" },
        sid: { kind: "input", path: "session.id" },
        home: { kind: "env", name: "HOME" },
        load_avg: {
          kind: "shell", command: "uptime",
          regex: "load average:\\\\s*([0-9.]+)",
          cache: { ttl: "5s" },
          default: "—",
        },
        hostname: {
          kind: "file", path: "/etc/hostname", readMode: "first-line",
          cache: { watch_file: "/etc/hostname" },
        },
        cwd_short: {
          kind: "template", template: "{{ .cwd }}",
        },
        now: { kind: "time", layout: "15:04", cache: { ttl: "1s" } },
        branch: {
          kind: "git", field: "branch",
          cache: { watch_file: ".git/HEAD" },
          default: "(detached)",
        },
        constant: { kind: "literal", value: "hello" },
      },
      segments: {
        cwd: { template: "{{ .cwd_short }}", width: "auto" },
        branch: {
          template: "{{ .branch }}",
          when: "{{ ne .branch \\"\\" }}",
          bg: "{{ if eq .branch \\"main\\" }}success{{ else }}info{{ end }}",
        },
        load: {
          template: "{{ .load_avg }}",
          width: 8, justify: "right", truncate: "middle",
        },
      },
      layout: [["cwd", "branch", "load"]],
    }`;
    const cfg = parseAndValidate(FILE, source);
    expect(cfg.globals.hueStep).toBe(8);
    expect(Object.keys(cfg.variables).sort()).toEqual([
      "branch", "constant", "cwd", "cwd_short", "home", "hostname",
      "load_avg", "now", "sid",
    ]);
    expect(cfg.layout).toEqual([{ segments: ["cwd", "branch", "load"] }]);
  });

  test("minimal valid config loads to canonical empty shape", () => {
    expect(parseAndValidate(FILE, "{}")).toEqual({
      globals: {},
      variables: {},
      segments: {},
      layout: [],
      widgets: {},
    });
  });
});

// ─── Helper unit tests ───────────────────────────────────────────────────────

describe("extractTemplateRefs", () => {
  test("simple ref", () => {
    expect([...extractTemplateRefs("{{ .foo }}")]).toEqual(["foo"]);
  });

  test("dotted ref", () => {
    expect([...extractTemplateRefs("{{ .session.id }}")]).toEqual(["session.id"]);
  });

  test("multiple refs across blocks", () => {
    const refs = extractTemplateRefs("{{ .a }} static {{ .b | upper }} {{ if .c }}{{ .d }}{{ end }}");
    expect([...refs].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("strips string literals", () => {
    expect([...extractTemplateRefs(`{{ printf ".not.a.ref" .real }}`)]).toEqual(["real"]);
  });

  test("ignores text outside {{ }}", () => {
    expect([...extractTemplateRefs("plain text .not.a.ref here")]).toEqual([]);
  });

  test("numeric literals don't match", () => {
    expect([...extractTemplateRefs("{{ if gt .x 1.5 }}{{ .y }}{{ end }}")]).toEqual([
      "x", "y",
    ]);
  });

  test("function calls aren't refs (no leading dot)", () => {
    expect([...extractTemplateRefs("{{ bold .x }}")]).toEqual(["x"]);
  });
});

describe("findKeyLine", () => {
  test("locates a top-level key", () => {
    const src = "{\n  globals: {},\n  variables: {}\n}";
    expect(findKeyLine(src, ["variables"])).toBe(3);
  });

  test("walks nested keys", () => {
    const src = `{
  variables: {
    foo: {
      kind: "shell"
    }
  }
}`;
    expect(findKeyLine(src, ["variables", "foo", "kind"])).toBe(4);
  });

  test("works with double-quoted keys", () => {
    const src = `{ "globals": { "default_bg": "x" } }`;
    expect(findKeyLine(src, ["globals", "default_bg"])).toBe(1);
  });

  test("returns undefined when key not found", () => {
    expect(findKeyLine("{}", ["nonexistent"])).toBeUndefined();
  });
});
