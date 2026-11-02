// [LAW:verifiable-goals] candybar-templates-zh8b.53s acceptance: a segment's
// `template` may be an array of strings joined with no separator, and a
// segment may declare `partials` — named sub-templates scoped to it, chained
// onto the config's shared `helpers` so a partial may call a helper, but
// never reachable from another segment's templates. The dynamic `partial`
// function (a computed name) is a separate, upstream-blocked follow-up
// (candybar-templates-zh8b.ph5) and is not exercised here.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { SessionState } from "../src/daemon/session-state";

import { validateConfig } from "./helpers/parse-and-validate";
import {
  parseDslConfig,
  mergeWithDefault,
  inheritableSegmentNames,
} from "../src/config/dsl-loader";
import type { DslConfig, ValidatedConfig } from "../src/config/dsl-types";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const EMPTY_DEFAULT: DslConfig = {
  globals: {},
  variables: {},
  segments: {},
  root: { rows: {} },
  actions: {},
  styles: {},
  presets: {},
  helpers: {},
  editGlobals: {},
  themeDefaults: {},
};

function build(source: string, dflt: DslConfig = EMPTY_DEFAULT) {
  const raw = parseDslConfig(
    "<test>",
    source,
    undefined,
    inheritableSegmentNames(dflt),
  );
  const config = validateConfig(
    { config: mergeWithDefault(raw, dflt), raw, source: source },
    "<test>",
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(
    processLauncher,
    store,
    "",
    new SessionState(),
  );
  const compiled = registerDslConfig(config, registry, {
    signer: TEST_SIGNER,
    cwd: "/tmp",
  });
  return { config, compiled, store, registry };
}

function render(source: string, payload: unknown, dflt?: DslConfig): Frame {
  const { config, compiled, store, registry } = build(source, dflt);
  return drawPayload(
    config,
    compiled,
    store,
    registry,
    payload,
    instantOf(new Date()),
    OPTS,
  ).frame;
}

const issuesOf = (source: string): string => {
  try {
    build(source);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("candybar-templates-zh8b.53s — array template bodies", () => {
  test("an array template joins with no separator", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { s: { template: ["a={{ ", ".x", " }}b"] } },
      root: "s",
    }`;
    expect(textOf(render(source, { x: 3 }))).toContain("a=3b");
  });

  test("a non-string array element is a per-position load error", () => {
    const source = `{
      segments: { s: { template: ["ok", 5] } },
      root: "s",
    }`;
    expect(() => build(source)).toThrow(/segments\.s\.template\[1\]/);
  });

  test("a delta over a bundled segment may also supply an array template", () => {
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      segments: { s: { template: "DFLT" } },
    };
    const source = `{
      segments: { s: { template: ["US", "ER"] } },
      root: "s",
    }`;
    expect(textOf(render(source, {}, dflt))).toContain("USER");
  });
});

describe("candybar-templates-zh8b.53s — segment-scoped partials", () => {
  test("a partial renders via the static {{ template }} builtin", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: {
        s: {
          template: '{{ template "double" .x }}',
          partials: { double: "{{ mul . 2 }}" },
        },
      },
      root: "s",
    }`;
    expect(textOf(render(source, { x: 21 }))).toContain("42");
  });

  test("an array partial body joins with no separator", () => {
    const source = `{
      segments: {
        s: {
          template: '{{ template "greet" . }}',
          partials: { greet: ["hel", "lo"] },
        },
      },
      root: "s",
    }`;
    expect(textOf(render(source, {}))).toContain("hello");
  });

  test("a partial may call a global helper", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      helpers: { money: '\${{ printf "%.2f" . }}' },
      segments: {
        s: {
          template: '{{ template "cost" .x }}',
          partials: { cost: 'cost={{ template "money" . }}' },
        },
      },
      root: "s",
    }`;
    expect(textOf(render(source, { x: 2 }))).toContain("cost=$2.00");
  });

  test("two segments may declare a partial under the SAME name with no collision", () => {
    const source = `{
      variables: {
        a: { kind: "input", path: "a", type: "number" },
        b: { kind: "input", path: "b", type: "number" },
      },
      segments: {
        s1: {
          template: '{{ template "label" .a }}',
          partials: { label: "one={{ . }}" },
        },
        s2: {
          template: '{{ template "label" .b }}',
          partials: { label: "two={{ . }}" },
        },
      },
      root: { h: ["s1", "s2"] },
    }`;
    const out = textOf(render(source, { a: 1, b: 2 }));
    expect(out).toContain("one=1");
    expect(out).toContain("two=2");
  });

  test("a segment's partial is NOT reachable from another segment's template", () => {
    const source = `{
      segments: {
        s1: { template: "x", partials: { onlyHere: "nope" } },
        s2: { template: '{{ template "onlyHere" . }}' },
      },
      root: { h: ["s1", "s2"] },
    }`;
    // Go's own `{{ template "name" }}` on an undefined name is a render-time
    // failure (rendering.md: "Failures draw; they don't throw"), not a load
    // error — so this proves scoping by observing s2 falls back to its slot's
    // floor rather than somehow seeing s1's partial.
    const frame = render(source, {});
    expect(textOf(frame)).not.toContain("nope");
  });

  test("an unknown action inside a partial is a load error naming the partial", () => {
    const message = issuesOf(`{
      segments: {
        s: {
          template: '{{ template "btn" . }}',
          partials: { btn: '{{ action "nosuch" "x" }}' },
        },
      },
      root: "s",
    }`);
    expect(message).toMatch(
      /segments\.s\.partials\.btn[^\n]*unknown action "nosuch"/,
    );
  });

  test("a malformed partial body fails loudly, attributed to the partial by name", () => {
    const source = `{
      segments: {
        s: {
          template: "x",
          partials: { broken: '{{ printf "%.2f" }' },
        },
      },
      root: "s",
    }`;
    expect(() => build(source)).toThrow(/segments\.s\.partials\.broken/);
  });

  test("absent partials ≡ no-op: merges to undefined, renders unaffected", () => {
    const source = `{
      variables: { x: { kind: "input", path: "x", type: "number" } },
      segments: { plain: { template: "x={{ .x }}" } },
      root: "plain",
    }`;
    const { config } = build(source);
    expect(config.segments.plain?.partials).toBeUndefined();
    expect(textOf(render(source, { x: 42 }))).toContain("x=42");
  });

  test("a partial reusing a global helper's name is a load error, not an uncaught compile throw", () => {
    // Without this check, validation reports no issues and `registerDslConfig`
    // throws an uncaught "redefinition of template" error instead — the two
    // layers must agree the name is taken.
    const message = issuesOf(`{
      helpers: { money: '\${{ . }}' },
      segments: {
        s: {
          template: '{{ template "money" . }}',
          partials: { money: "shadow" },
        },
      },
      root: "s",
    }`);
    expect(message).toMatch(
      /segments\.s\.partials\.money[^\n]*reuses the name of a global helper/,
    );
  });

  test("{{ menu }} inside a partial is a load error, same rule as a helper", () => {
    const message = issuesOf(`{
      segments: {
        s: {
          template: '{{ template "m" . }}',
          partials: { m: '{{ menu "pick" "▸" "▾" }}' },
        },
      },
      actions: { pick: { set: "k", from: ["a", "b"] } },
      variables: { k: { kind: "state", key: "k", default: "a" } },
      root: "s",
    }`);
    expect(message).toMatch(/segments\.s\.partials\.m[^\n]*\{\{ menu \}\}/);
  });

  test("a helper called only from inside a partial is NOT flagged unused", () => {
    const { config } = build(`{
      helpers: { money: '\${{ . }}' },
      segments: {
        s: {
          template: '{{ template "cost" . }}',
          partials: { cost: 'cost={{ template "money" . }}' },
        },
      },
      root: "s",
    }`);
    expect(config.helpers.money).toBeDefined();
  });

  test("a delta's partials merge by name over a bundled base's, like settings", () => {
    const dflt: DslConfig = {
      ...EMPTY_DEFAULT,
      segments: {
        s: {
          template: '{{ template "a" . }}{{ template "b" . }}',
          partials: { a: "A-BASE", b: "B-BASE" },
        },
      },
    };
    const source = `{
      segments: { s: { partials: { a: "A-USER" } } },
      root: "s",
    }`;
    const out = textOf(render(source, {}, dflt));
    expect(out).toContain("A-USER");
    expect(out).toContain("B-BASE"); // retained, not dropped by the delta
  });
});
