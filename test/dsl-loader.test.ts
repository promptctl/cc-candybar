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
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import type { LayoutNode } from "../src/config/dsl-types";

const FILE = "/tmp/test.json5";

// The bundled default supplies `gitaculous`; merging a user file on top of it is
// the real production cascade. Palettes must be allow-listed because the default
// declares `globals.palette`.
const ALL_PALETTES = new Set(listResolvablePaletteNames());
function validateAgainstDefault(source: string) {
  return parseAndValidate(FILE, source, ALL_PALETTES, DEFAULT_DSL_CONFIG);
}

// Convenience builder for vertical stacks of horizontal rows.
type Row = { segments: readonly string[]; when?: string };
const vert = (...rows: (Row | readonly string[])[]): LayoutNode => ({
  kind: "container",
  direction: "vertical",
  children: rows.map((row): LayoutNode => {
    const r: Row = Array.isArray(row) ? { segments: row } : (row as Row);
    const children = r.segments.map(
      (name): LayoutNode => ({ kind: "segment", name }),
    );
    return r.when !== undefined
      ? { kind: "container", direction: "horizontal", children, when: r.when }
      : { kind: "container", direction: "horizontal", children };
  }),
});

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
      editGlobals: {},
      variables: {},
      segments: {},
      root: { kind: "container", direction: "vertical", children: [] },
      actions: {},
      looks: {},
      presets: {},
      helpers: {},
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

  test("layout key emits migration error", () => {
    // [LAW:no-silent-failure] `layout:` removed in 2de.19 — rejected loudly
    // with an A-grammar rewrite hint rather than an "unknown key" message.
    expectIssue(`{ layout: "not-array" }`, {
      path: "layout",
      message: /no longer supported/,
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
      }}`,
    );
    expect(cfg.globals).toEqual({
      default_bg: "black",
      default_fg: "white",
      default_empty_value: "—",
      default_separator: " ",
      default_truncate_marker: "…",
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

  test("autoWrap accepts a boolean", () => {
    const cfg = parseAndValidate(FILE, `{ globals: { autoWrap: false } }`);
    expect(cfg.globals.autoWrap).toBe(false);
  });

  test("non-boolean autoWrap is rejected", () => {
    expectIssue(`{ globals: { autoWrap: "yes" } }`, {
      path: "globals.autoWrap",
      message: "autoWrap must be a boolean, got string",
    });
  });

  test("padding accepts an integer in range (0 is a legal value)", () => {
    const cfg = parseAndValidate(FILE, `{ globals: { padding: 0 } }`);
    expect(cfg.globals.padding).toBe(0);
    const cfg2 = parseAndValidate(FILE, `{ globals: { padding: 3 } }`);
    expect(cfg2.globals.padding).toBe(3);
  });

  test("non-integer or out-of-range padding is rejected", () => {
    for (const bad of ['"2"', "1.5", "-1", "17"]) {
      expectIssue(`{ globals: { padding: ${bad} } }`, {
        path: "globals.padding",
        message: "padding must be an integer between 0 and 16",
      });
    }
  });

  test("charset accepts each closed-enum member", () => {
    const cfg = parseAndValidate(FILE, `{ globals: { charset: "ascii" } }`);
    expect(cfg.globals.charset).toBe("ascii");
    const cfg2 = parseAndValidate(FILE, `{ globals: { charset: "unicode" } }`);
    expect(cfg2.globals.charset).toBe("unicode");
  });

  test("a charset outside the enum is rejected", () => {
    expectIssue(`{ globals: { charset: "latin1" } }`, {
      path: "globals.charset",
      message: "globals.charset must be one of: unicode, ascii",
    });
  });

  test("colorCompatibility accepts each closed-enum member", () => {
    for (const depth of ["truecolor", "256", "ansi", "none"] as const) {
      const cfg = parseAndValidate(
        FILE,
        `{ globals: { colorCompatibility: "${depth}" } }`,
      );
      expect(cfg.globals.colorCompatibility).toBe(depth);
    }
  });

  test("a colorCompatibility outside the enum is rejected", () => {
    expectIssue(`{ globals: { colorCompatibility: "16m" } }`, {
      path: "globals.colorCompatibility",
      message:
        "globals.colorCompatibility must be one of: truecolor, 256, ansi, none",
    });
  });

  // brandon-display-dam.4: "auto" was the LEGACY display.colorCompatibility
  // default, so migrating configs will carry it. It gets a pointed rejection
  // explaining WHY (daemon env ≠ client terminal), not the generic enum list.
  test('the legacy "auto" is rejected with a migration pointer', () => {
    expectIssue(`{ globals: { colorCompatibility: "auto" } }`, {
      path: "globals.colorCompatibility",
      message: '"auto" is not supported',
    });
    expectIssue(`{ globals: { colorCompatibility: "auto" } }`, {
      path: "globals.colorCompatibility",
      message: "not your terminal's",
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

  // [LAW:no-silent-failure] Non-ttl cache forms on time vars were silently
  // coerced to the default TTL at render; they are now load-time diagnostics
  // naming ttl as the only supported form (brandon-config-validation-cje).
  test("time: cache is ttl-only — non-ttl forms are load-time diagnostics", () => {
    for (const cache of [
      `{ watch_file: ".git/HEAD" }`,
      `{ depends_on: ["x"] }`,
      `{ key: "{{ .x }}" }`,
      `{ never: true }`,
    ]) {
      const cacheKey = cache.match(/\{ (\w+):/)![1]!;
      expectIssue(
        `{ variables: { now: { kind: "time", layout: "15:04", cache: ${cache} } } }`,
        {
          path: `variables.now.cache.${cacheKey}`,
          message: `Unknown time-variable cache key "${cacheKey}". Expected exactly one of: ttl`,
        },
      );
    }
    expectIssue(
      `{ variables: { now: { kind: "time", layout: "15:04", cache: { ttl: "soon" } } } }`,
      {
        path: "variables.now.cache.ttl",
        message: "cache.ttl must be a duration string",
      },
    );
    const ok = parseAndValidate(
      FILE,
      `{ variables: { now: { kind: "time", layout: "15:04", cache: { ttl: "5s" } } } }`,
    );
    expect(ok.variables.now).toEqual({
      kind: "time",
      layout: "15:04",
      cache: { ttl: "5s" },
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

// ─── Layout migration errors (2de.19) ────────────────────────────────────────
// [LAW:no-silent-failure] `layout:` was removed in 2de.19. Any config that
// still uses it must receive a loud, migration-pointing error (not "unknown
// key") so the author knows exactly how to rewrite their config.

describe("loadDslConfig — layout (removed; migration errors)", () => {
  test("any layout: value emits the A-grammar migration error", () => {
    expectIssue(
      `{ segments: { a: { template: "x" } }, layout: [["a"]] }`,
      {
        path: "layout",
        message: /no longer supported/,
      },
    );
  });

  test("migration error message shows A-grammar rewrite examples", () => {
    const err = expectError(
      `{ segments: { a: { template: "x" } }, layout: [["a"]] }`,
    );
    const issue = err.issues.find((i) => i.path === "layout")!;
    expect(issue.message).toMatch(/root.*A-grammar/i);
    expect(issue.message).toMatch(/{ v:/);
    expect(issue.message).toMatch(/{ h:/);
  });

  test("kind: cells in root emits migration error", () => {
    // [LAW:no-silent-failure] `kind: "cells"` was removed in 2de.19.
    expectIssue(
      `{ segments: { a: { template: "x" } }, root: { kind: "cells", segments: ["a"] } }`,
      {
        path: "root",
        message: /kind: "cells" is no longer supported/,
      },
    );
  });

  test("kind: cells migration error shows h-arm equivalent", () => {
    const err = expectError(
      `{ segments: { a: { template: "x" } }, root: { kind: "cells", segments: ["a"] } }`,
    );
    const issue = err.issues.find((i) => i.path === "root")!;
    expect(issue.message).toMatch(/\{ h:/);
  });
});

// ─── Segment rename migration (pdu.4: gitTaculous → gitaculous) ───────────────
// [LAW:no-silent-failure] The built-in segment was renamed. A user config that
// still names the old key (merged on top of the bundled default, which now
// declares `gitaculous`) must get a loud, migration-POINTING error — not the
// generic "does not match" nor a silent empty render.

describe("loadDslConfig — renamed built-in segment", () => {
  test("a root ref to the old name errors with a pointer to the new name", () => {
    const err = (() => {
      try {
        validateAgainstDefault(`{ root: { seg: "gitTaculous" } }`);
      } catch (e) {
        if (e instanceof ConfigError) return e;
        throw e;
      }
      throw new Error("expected ConfigError, got success");
    })();
    const issue = err.issues.find((i) => i.path === "root")!;
    expect(issue.message).toMatch(/gitTaculous/);
    expect(issue.message).toMatch(/renamed to "gitaculous"/);
  });

  test("the new name resolves against the bundled default", () => {
    expect(() =>
      validateAgainstDefault(`{ root: { seg: "gitaculous" } }`),
    ).not.toThrow();
  });
});

// ─── Option A shape grammar (2de.15) ─────────────────────────────────────────

describe("loadDslConfig — A-grammar (seg/h/v)", () => {
  test("bare string lowers to a segment ref", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" } }, root: "a" }`,
    );
    expect(cfg.root).toEqual({ kind: "segment", name: "a" });
  });

  test("{ seg } lowers to a segment node", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" } }, root: { seg: "a" } }`,
    );
    expect(cfg.root).toEqual({ kind: "segment", name: "a" });
  });

  test("{ seg, when } preserves the predicate", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" } }, root: { seg: "a", when: "{{ true }}" } }`,
    );
    expect(cfg.root).toEqual({ kind: "segment", name: "a", when: "{{ true }}" });
  });

  test("{ h: [...] } lowers to a horizontal container", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" }, b: { template: "y" } }, root: { h: ["a", "b"] } }`,
    );
    expect(cfg.root).toEqual({
      kind: "container",
      direction: "horizontal",
      children: [
        { kind: "segment", name: "a" },
        { kind: "segment", name: "b" },
      ],
    });
  });

  test("{ v: [...] } lowers to a vertical container", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" }, b: { template: "y" } }, root: { v: ["a", "b"] } }`,
    );
    expect(cfg.root).toEqual({
      kind: "container",
      direction: "vertical",
      children: [
        { kind: "segment", name: "a" },
        { kind: "segment", name: "b" },
      ],
    });
  });

  test("nested h-in-v-in-h lowers to the expected canonical tree", () => {
    const cfg = parseAndValidate(
      FILE,
      `{
        segments: { a: { template: "x" }, b: { template: "y" }, c: { template: "z" } },
        root: { h: [{ v: ["a", { h: ["b", "c"] }] }] },
      }`,
    );
    expect(cfg.root).toEqual({
      kind: "container",
      direction: "horizontal",
      children: [
        {
          kind: "container",
          direction: "vertical",
          children: [
            { kind: "segment", name: "a" },
            {
              kind: "container",
              direction: "horizontal",
              children: [
                { kind: "segment", name: "b" },
                { kind: "segment", name: "c" },
              ],
            },
          ],
        },
      ],
    });
  });

  test("{ h, when } preserves the predicate on the container", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ segments: { a: { template: "x" } }, root: { h: ["a"], when: "{{ true }}" } }`,
    );
    expect(cfg.root).toEqual({
      kind: "container",
      direction: "horizontal",
      children: [{ kind: "segment", name: "a" }],
      when: "{{ true }}",
    });
  });

  test("bijectivity: A-grammar and canonical spelling lower to identical trees", () => {
    // [LAW:one-source-of-truth] Both spellings must produce the SAME canonical
    // tree — they are two representations of one grammar, not two grammars.
    const canonical = parseAndValidate(
      FILE,
      `{
        segments: { a: { template: "x" }, b: { template: "y" }, c: { template: "z" } },
        root: { kind: "container", direction: "vertical", children: [
          { kind: "container", direction: "horizontal", children: [
            { kind: "segment", name: "a" },
            { kind: "segment", name: "b" },
          ]},
          { kind: "segment", name: "c" },
        ]},
      }`,
    );
    const terse = parseAndValidate(
      FILE,
      `{
        segments: { a: { template: "x" }, b: { template: "y" }, c: { template: "z" } },
        root: { v: [{ h: ["a", "b"] }, "c"] },
      }`,
    );
    expect(terse.root).toEqual(canonical.root);
  });

  test("A-grammar inside group children composes correctly", () => {
    const cfg = parseAndValidate(
      FILE,
      `{
        segments: { m: { template: "M" }, n: { template: "N" } },
        root: {
          kind: "group", name: "g", label: "G",
          children: [{ h: ["m", "n"] }],
        },
        variables: { "session.id": { kind: "input", path: "session_id", default: "" } },
      }`,
    );
    // The group lowers to a vertical container whose body-container holds
    // { h: ["m", "n"] } — a horizontal container of two segment refs.
    expect(cfg.root.kind).toBe("container");
    const root = cfg.root as import("../src/config/dsl-types").ContainerNode;
    expect(root.children[1]).toMatchObject({
      kind: "container",
      children: [
        {
          kind: "container",
          direction: "horizontal",
          children: [
            { kind: "segment", name: "m" },
            { kind: "segment", name: "n" },
          ],
        },
      ],
    });
  });

  test("both h and v present is a load error", () => {
    expectIssue(`{ root: { h: [], v: [] } }`, {
      path: "root",
      message: /exactly one of "seg", "h", or "v"/,
    });
  });

  test("both seg and h present is a load error", () => {
    expectIssue(
      `{ segments: { a: { template: "x" } }, root: { seg: "a", h: ["a"] } }`,
      { path: "root", message: /exactly one of "seg", "h", or "v"/ },
    );
  });

  test("bare empty string is a load error", () => {
    expectIssue(`{ root: "" }`, {
      path: "root",
      message: /non-empty segment name/,
    });
  });
});

// ─── Cross-reference validation ──────────────────────────────────────────────

describe("loadDslConfig — cross-references", () => {
  test("root-authored config reports unknown segment under the `root` path", () => {
    expectIssue(
      `{ segments: { cwd: { template: "t" } },
         root: { h: ["cwd", "missing"] } }`,
      {
        path: "root",
        message: 'root entry "missing" does not match any declared segment',
      },
    );
  });

  test("root node `when` referencing an unknown variable is reported under `root.when`", () => {
    expectIssue(
      `{ segments: { cwd: { template: "t" } },
         root: { kind: "container", direction: "vertical", when: "{{ .nope }}",
                 children: ["cwd"] } }`,
      {
        path: "root.when",
        message: 'Template references unknown variable ".nope"',
      },
    );
  });

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

  test("depends_on naming a sibling local in bare form is rejected with namespaced suggestion", () => {
    // [LAW:one-source-of-truth] The depends_on reaction calls store.read with
    // each listed name verbatim, and segment locals exist in the store only
    // under segName.varName — a bare sibling name throws at runtime, so the
    // validator rejects it at load and names the form that works.
    expectIssue(
      `{ segments: {
        s: {
          template: "{{ .s.recent }}",
          vars: {
            branch: { kind: "git", field: "branch", cache: { watch_file: ".git/HEAD" } },
            recent: { kind: "shell", command: "echo", cache: { depends_on: ["branch"] } }
          }
        }
      }}`,
      {
        path: "segments.s.vars.recent.cache.depends_on[0]",
        message:
          'cache.depends_on references unknown variable "branch" (segment-local vars are namespaced — write "s.branch")',
      },
    );
  });

  test("depends_on naming a bare segment-local from a global var is plainly unknown", () => {
    // No owning segment — no namespaced hint, just the unknown-variable
    // diagnostic (end-anchored to assert the hint's absence).
    expectIssue(
      `{ variables: {
        g: { kind: "shell", command: "echo", cache: { depends_on: ["local"] } }
      },
      segments: {
        s: { template: "{{ .s.local }}", vars: { local: { kind: "literal", value: "hi" } } }
      }}`,
      {
        path: "variables.g.cache.depends_on[0]",
        message: /cache\.depends_on references unknown variable "local"$/,
      },
    );
  });

  test("depends_on naming a namespaced segment-local passes", () => {
    const cfg = parseAndValidate(
      FILE,
      `{ variables: {
        g: { kind: "shell", command: "echo", cache: { depends_on: ["s.local"] } }
      },
      segments: {
        s: { template: "{{ .s.local }}", vars: { local: { kind: "literal", value: "hi" } } }
      }}`,
    );
    expect(cfg.variables.g!.kind).toBe("shell");
  });

  test("depends_on requires an exact store key, not a navigable prefix", () => {
    // [LAW:one-source-of-truth] Template refs may name a dotted prefix and
    // navigate INTO the value (refResolves), but depends_on entries are
    // literal store.read keys — "x" is not a key when only "x.y" is declared.
    expectIssue(
      `{ variables: {
        "x.y": { kind: "literal", value: "1" },
        g: { kind: "shell", command: "echo", cache: { depends_on: ["x"] } }
      }}`,
      {
        path: "variables.g.cache.depends_on[0]",
        message: /cache\.depends_on references unknown variable "x"$/,
      },
    );
  });

  test("bare ref to own segment-local var is rejected with namespaced suggestion", () => {
    // [LAW:one-source-of-truth] The runtime stores segment locals ONLY under
    // segName.varName and the scope proxy resolves only literal store keys —
    // a bare own-segment ref always throws MissingFieldError at render. The
    // validator enforces the same rule at load, and names the form that works.
    expectIssue(
      `{ segments: {
        s: {
          template: "{{ .local }}",
          vars: { local: { kind: "literal", value: "hi" } }
        }
      }}`,
      {
        path: "segments.s.template",
        message:
          'Template references unknown variable ".local" (segment-local vars are namespaced — write ".s.local")',
      },
    );
  });

  test("bare ref to a sibling local from a segment var template gets the suggestion too", () => {
    expectIssue(
      `{ segments: {
        s: {
          template: "{{ .s.b }}",
          vars: {
            a: { kind: "literal", value: "1" },
            b: { kind: "template", template: "{{ .a }}" }
          }
        }
      }}`,
      {
        path: "segments.s.vars.b.template",
        message:
          'Template references unknown variable ".a" (segment-local vars are namespaced — write ".s.a")',
      },
    );
  });

  test("bare segment-local ref outside any segment context is plainly unknown", () => {
    // A global template var has no owning segment — no namespaced hint, just
    // the unknown-variable diagnostic.
    expectIssue(
      `{ variables: { g: { kind: "template", template: "{{ .local }}" } },
         segments: {
        s: {
          template: "{{ .s.local }}",
          vars: { local: { kind: "literal", value: "hi" } }
        }
      }}`,
      {
        path: "variables.g.template",
        // End-anchored: no namespaced hint outside a segment context.
        message: /Template references unknown variable "\.local"$/,
      },
    );
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
      `{ globals: { default_bg: 42 }, variables: { x: { kind: "wat" } }, segments: { s: {} } }`,
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(3);
    expect(err.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "globals.default_bg",
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
      root: { h: ["cwd", "branch", "load"] },
    }`;
    const cfg = parseAndValidate(FILE, source);
    expect(Object.keys(cfg.variables).sort()).toEqual([
      "branch", "constant", "cwd", "cwd_short", "home", "hostname",
      "load_avg", "now", "sid",
    ]);
    expect(cfg.root).toEqual({
      kind: "container", direction: "horizontal",
      children: ["cwd", "branch", "load"].map((name) => ({ kind: "segment", name })),
    });
  });

  test("minimal valid config loads to canonical empty shape", () => {
    expect(parseAndValidate(FILE, "{}")).toEqual({
      globals: {},
      editGlobals: {},
      variables: {},
      segments: {},
      root: { kind: "container", direction: "vertical", children: [] },
      actions: {},
      looks: {},
      presets: {},
      helpers: {},
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
