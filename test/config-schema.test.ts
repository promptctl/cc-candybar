// [LAW:verifiable-goals] Validates the COMMITTED artifact, not the generator.
// [LAW:single-enforcer] Schema = shape, loader = meaning.

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
  // strict:false — the annotations trip ajv's strict mode, never validation.
  const ajv = new Ajv({ strict: false, allErrors: true });
  validate = ajv.compile(schema);
});

const GOOD: ReadonlyArray<readonly [string, string]> = [
  ["empty config", `{}`],
  [
    "rows-form root (merges by row name)",
    `{ segments: { a: { template: 'a' } }, root: { rows: { extra: { h: ['a'] } } } }`,
  ],
  [
    "rows-form root with a bar-level when",
    `{ segments: { a: { template: 'a' } }, root: { rows: { extra: 'a' }, when: '{{ true }}' } }`,
  ],
  ["globals only", `{ globals: { palette: 'dracula', default_bg: 'surface' } }`],
  [
    "A-grammar multi-row layout (v-arm)",
    `{
      segments: { dir: { template: '{{ .cwd }}' }, git: { template: '{{ .git.branch }}' } },
      variables: { cwd: { kind: 'literal', value: '~' }, 'git.branch': { kind: 'literal', value: 'main' } },
      root: { v: [{ h: ['dir', 'git'] }, 'dir'] },
    }`,
  ],
  [
    "A-grammar conditional row (when on v children)",
    `{
      segments: { a: { template: 'a' }, b: { template: 'b' } },
      root: { v: [{ h: ['a', 'b'] }, { seg: 'a', when: '{{ true }}' }] },
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
      root: { h: ['t'] },
    }`,
  ],
  [
    "doctor actions (run, and fix naming its check)",
    `{
      segments: { t: { template: '{{ action "run" "🩺" }} {{ action "fix" "[fix]" }}' } },
      actions: { run: { doctor: 'run' }, fix: { doctor: 'fix', check: 'tmuxTruecolor' } },
      root: { h: ['t'] },
    }`,
  ],
  [
    "cycle action (2de.4 toggle form)",
    `{
      segments: { t: { template: '{{ action "toggle" "▸" "▾" }}' } },
      variables: { open: { kind: 'state', key: 'details-open', default: '0' } },
      actions: { toggle: { set: 'details-open', cycle: ['0', '1'] } },
      root: { h: ['t'] },
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

const BAD_STRUCTURAL: ReadonlyArray<readonly [string, string]> = [
  ["unknown top-level key", `{ segmnets: {} }`],
  ["bad doctor verb", `{ actions: { d: { doctor: 'bogus' } } }`],
  ["doctor run carrying a check", `{ actions: { d: { doctor: 'run', check: 'tmuxTruecolor' } } }`],
  ["non-identifier row name", `{ segments: { a: { template: 'a' } }, root: { rows: { 'a-b': 'a' } } }`],
  ["non-object rows", `{ root: { rows: 'a' } }`],
  ["non-string template", `{ segments: { a: { template: 42 } } }`],
  ["bad direction enum", `{ root: { kind: 'container', direction: 'diagonal', children: [] } }`],
  ["unknown variable kind", `{ variables: { x: { kind: 'bogus' } } }`],
  ["non-string palette", `{ globals: { palette: 5 } }`],
  ["removed layout key", `{ segments: { a: { template: 'a' } }, layout: [['a', 'b']] }`],
  // Required in the schema too, or an empty object passes all three arms.
  ["bare container node (missing direction/children)", `{ root: { kind: 'container' } }`],
  ["bare segment node (missing name)", `{ root: { kind: 'segment' } }`],
  // Schema-checkable cycle shape: type + minItems.
  [
    "one-member cycle",
    `{ segments: { t: { template: '{{ action "a" "x" }}' } }, actions: { a: { set: 'k', cycle: ['solo'] } }, root: { h: ['t'] } }`,
  ],
  [
    "non-array cycle",
    `{ segments: { t: { template: '{{ action "a" "x" }}' } }, actions: { a: { set: 'k', cycle: 'ab' } }, root: { h: ['t'] } }`,
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
  ["A-grammar both h and v present", `{ root: { h: [], v: [] } }`],
  ["A-grammar both seg and h present", `{ segments: { a: { template: 'a' } }, root: { seg: 'a', h: ['a'] } }`],
  ["A-grammar seg missing value (non-string)", `{ root: { seg: 42 } }`],
  ["A-grammar h with non-array value", `{ root: { h: 'not-an-array' } }`],
];

function schemaAccepts(source: string): boolean {
  return validate(JSON5.parse(source)) === true;
}

// loadConfig's body against a source string, so the corpus stays inline.
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

  // [LAW:single-enforcer] A cross-reference error is one no JSON Schema can catch.
  it("schema accepts but loader rejects a dangling reference", () => {
    const source = `{ segments: { a: { template: 'a' } }, root: { h: ['a', 'does-not-exist'] } }`;
    expect(schemaAccepts(source)).toBe(true);
    expect(loaderAccepts(source)).toBe(false);
  });
});
