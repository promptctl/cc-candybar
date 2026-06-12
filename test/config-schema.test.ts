// [LAW:verifiable-goals] The JSON Schema's contract: accept the configs a user
// may legitimately write (including the bare-`string[]`-row sugar the maintainer's
// own config uses), reject structurally-broken ones. We validate the COMMITTED
// artifact (schema/cc-candybar.schema.json) — the same file editors load via
// `$schema` and the package ships — so this test guards the published contract,
// not just the generator.
//
// [LAW:single-enforcer] Schema = shape; lint = meaning. The schema cannot see
// cross-references or cycles (a JSON Schema structurally can't), so each good
// config is asserted to pass BOTH schema and the loader, each structural bad to
// fail BOTH, and one semantically-broken config is asserted to pass the schema
// yet fail the loader — pinning the boundary between the two layers.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { parseDslConfig, validateConfig } from "../src/config/dsl-loader";
import { mergeWithDefault } from "../src/config/loader/merge";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError } from "../src/config/loader/diagnostics";

const SCHEMA_PATH = path.resolve(__dirname, "..", "schema", "cc-candybar.schema.json");

let validate: ValidateFunction;

beforeAll(() => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  // strict:false — the generated schema carries `title`/`$id` annotations and
  // discriminated-by-presence `anyOf`s that ajv's strict mode warns on; none
  // affect validation outcome.
  const ajv = new Ajv({ strict: false, allErrors: true });
  validate = ajv.compile(schema);
});

// Structurally valid AND semantically valid — schema accepts, loader accepts.
const GOOD: ReadonlyArray<readonly [string, string]> = [
  ["empty config", `{}`],
  ["globals only", `{ globals: { palette: 'dracula', default_bg: 'surface' } }`],
  [
    "bare string[] rows (maintainer's form)",
    `{
      segments: { dir: { template: '{{ .cwd }}' }, git: { template: '{{ .git.branch }}' } },
      variables: { cwd: { kind: 'literal', value: '~' }, 'git.branch': { kind: 'literal', value: 'main' } },
      layout: [['dir', 'git'], ['dir']],
    }`,
  ],
  [
    "mixed bare + predicate rows",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' } },
      layout: [['a', 'b'], { when: '{{ true }}', segments: ['a'] }],
    }`,
  ],
  [
    "raw root node grammar",
    `{
      segments: { a: { template: 'a' } },
      root: { kind: 'container', direction: 'horizontal', children: [{ kind: 'segment', name: 'a' }] },
    }`,
  ],
  [
    "actions + variable kinds",
    `{
      segments: { t: { template: '{{ .theme }} {{ action "open" "▸" }}' } },
      variables: { theme: { kind: 'state', key: 'theme', default: 'dracula' } },
      actions: { open: { set: 'menu', to: '0' }, step: { set: 'hue', min: 0, max: 60, by: 2 } },
      layout: [['t']],
    }`,
  ],
  [
    "cycle action (2de.4 toggle form)",
    `{
      segments: { t: { template: '{{ action "toggle" "▸" "▾" }}' } },
      variables: { open: { kind: 'state', key: 'details-open', default: '0' } },
      actions: { toggle: { set: 'details-open', cycle: ['0', '1'] } },
      layout: [['t']],
    }`,
  ],
  [
    "group sugar node (2de.4)",
    `{
      segments: { m: { template: 'M' } },
      root: { kind: 'container', direction: 'vertical', children: [
        { kind: 'group', name: 'details', label: 'details', open: true, key: 'menu',
          children: [{ kind: 'segment', name: 'm' }] },
      ]},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    }`,
  ],
  // ── Option A shape grammar (2de.15) ─────────────────────────────────────
  [
    "A-grammar bare string segment ref",
    `{ segments: { a: { template: 'a' } }, root: "a" }`,
  ],
  [
    "A-grammar { seg, when }",
    `{ segments: { a: { template: 'a' } }, root: { seg: "a", when: "{{ true }}" } }`,
  ],
  [
    "A-grammar { h: [...] } horizontal container",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' } },
      root: { h: ["a", "b"] },
    }`,
  ],
  [
    "A-grammar { v: [...] } vertical container",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' } },
      root: { v: ["a", "b"] },
    }`,
  ],
  [
    "A-grammar nested h-in-v-in-h",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' }, c: { template: 'c' } },
      root: { h: [{ v: ["a", { h: ["b", "c"] }] }] },
    }`,
  ],
  [
    "A-grammar when on every node form",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' }, c: { template: 'c' } },
      root: {
        v: [
          { seg: "a", when: "{{ true }}" },
          { h: ["b", "c"], when: "{{ false }}" },
          { v: ["a"], when: "{{ true }}" },
        ],
      },
    }`,
  ],
  [
    "A-grammar inside group children (2de.4 + 2de.15 compose)",
    `{
      segments: { m: { template: 'M' }, n: { template: 'N' } },
      root: {
        kind: 'group', name: 'g', label: 'G',
        children: [{ h: ["m", "n"] }],
      },
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    }`,
  ],
];

// Structurally broken — schema rejects, loader rejects.
const BAD_STRUCTURAL: ReadonlyArray<readonly [string, string]> = [
  ["unknown top-level key", `{ segmnets: {} }`],
  ["non-string template", `{ segments: { a: { template: 42 } } }`],
  ["bad direction enum", `{ root: { kind: 'container', direction: 'diagonal', children: [] } }`],
  ["unknown variable kind", `{ variables: { x: { kind: 'bogus' } } }`],
  ["non-string palette", `{ globals: { palette: 5 } }`],
  ["legacy flat layout", `{ segments: { a: { template: 'a' } }, layout: ['a', 'b'] }`],
  // A node must carry its mandatory fields — the loader reports a missing
  // direction/name (→ throws), so the schema must require them too. The empty
  // object once passed all three arms vacuously; the layout specs' required-ness
  // closes that, keeping schema and loader in lockstep.
  ["bare container node (missing direction/children)", `{ root: { kind: 'container' } }`],
  ["bare segment node (missing name)", `{ root: { kind: 'segment' } }`],
  // Schema-checkable cycle shape: type + minItems. (Uniqueness/emptiness/slash
  // are loader refinements the schema mirrors structurally where JSON Schema
  // can express them.)
  [
    "one-member cycle",
    `{ segments: { t: { template: '{{ action "a" "x" }}' } }, actions: { a: { set: 'k', cycle: ['solo'] } }, layout: [['t']] }`,
  ],
  [
    "non-array cycle",
    `{ segments: { t: { template: '{{ action "a" "x" }}' } }, actions: { a: { set: 'k', cycle: 'ab' } }, layout: [['t']] }`,
  ],
  [
    "group node missing label/children",
    `{ root: { kind: 'group', name: 'g' } }`,
  ],
  [
    "group node with non-identifier name",
    `{ segments: { m: { template: 'M' } }, root: { kind: 'group', name: 'my-group', label: 'x', children: [{ kind: 'segment', name: 'm' }] } }`,
  ],
  [
    "group node label with embedded newline",
    `{ segments: { m: { template: 'M' } }, root: { kind: 'group', name: 'g', label: 'line1\\nline2', children: [{ kind: 'segment', name: 'm' }] } }`,
  ],
  // ── Option A bad structural (2de.15) ─────────────────────────────────────
  ["A-grammar both h and v present", `{ root: { h: [], v: [] } }`],
  ["A-grammar both seg and h present", `{ segments: { a: { template: 'a' } }, root: { seg: 'a', h: ['a'] } }`],
  ["A-grammar seg missing value (non-string)", `{ root: { seg: 42 } }`],
  ["A-grammar h with non-array value", `{ root: { h: 'not-an-array' } }`],
];

function schemaAccepts(source: string): boolean {
  return validate(JSON5.parse(source)) === true;
}

// The full loader pipeline (parse → merge-with-default → cross-ref + cycles),
// run on a source string without touching disk. loadConfig itself takes a path;
// this mirrors its body so the corpus stays inline.
function loaderAccepts(source: string): boolean {
  try {
    const raw = parseDslConfig("<test>", source);
    const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
    validateConfig(merged, "<test>", source);
    return true;
  } catch (e) {
    if (e instanceof ConfigError) return false;
    throw e;
  }
}

describe("config JSON Schema", () => {
  describe("accepts every good config (schema AND loader)", () => {
    it.each(GOOD)("%s", (_name, source) => {
      expect(schemaAccepts(source)).toBe(true);
      expect(loaderAccepts(source)).toBe(true);
    });
  });

  describe("rejects every structurally-bad config (schema AND loader)", () => {
    it.each(BAD_STRUCTURAL)("%s", (_name, source) => {
      expect(schemaAccepts(source)).toBe(false);
      expect(loaderAccepts(source)).toBe(false);
    });
  });

  // [LAW:single-enforcer] The boundary: a dangling segment reference is a
  // CROSS-REFERENCE error the schema structurally cannot catch. It must pass the
  // schema (shape is fine) and fail the loader (meaning is wrong) — proving the
  // two layers are complementary, not redundant.
  it("schema accepts but loader rejects a dangling reference", () => {
    const source = `{ segments: { a: { template: 'a' } }, layout: [['a', 'does-not-exist']] }`;
    expect(schemaAccepts(source)).toBe(true);
    expect(loaderAccepts(source)).toBe(false);
  });
});
