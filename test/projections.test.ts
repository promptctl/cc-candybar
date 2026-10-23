// [LAW:behavior-not-structure] What the projection fold says of a config, and
// what the store does with its answer: a projection is derived again by every
// read, at the draw in progress; anything else is cached.

import { projectionsOf } from "../src/config/loader/projections";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { CLOCK_FUNCTIONS } from "../src/template-engine/engine";
import { declareDslVariables, EVERY_SCOPE } from "../src/dsl/render";
import { SourceRegistry, VariableStore } from "../src/var-system";
import { drawingAt } from "./helpers/test-engine";

const config = (variables: string, helpers = "{}") =>
  parseAndValidate(
    "/tmp/test.json5",
    `{ helpers: ${helpers}, variables: ${variables} }`,
  );

test("every name a clock factory returns makes a template calling it a projection", () => {
  expect(CLOCK_FUNCTIONS.size).toBeGreaterThan(0);
  for (const name of CLOCK_FUNCTIONS) {
    const projections = projectionsOf(
      config(`{ t: { kind: "template", template: "{{ ${name} }}" } }`),
    );
    expect([name, projections.get("t")]).toEqual([name, `calls "${name}"`]);
  }
});

test("the set is closed upward: whatever reads a projection is one", () => {
  const projections = projectionsOf(
    config(
      `{
        sid: { kind: "input", path: "session_id" },
        clock: { kind: "time", layout: "15:04" },
        viaVar: { kind: "template", template: "{{ .clock }}" },
        viaHelper: { kind: "template", template: '{{ template "stamp" . }}' },
        twoDeep: { kind: "template", template: "{{ .viaVar }}!" },
        plain: { kind: "template", template: "{{ .sid }}" },
        named: { kind: "template", template: '{{ .sid }}{{ "now" }}' },
      }`,
      `{ stamp: "{{ unixEpoch now }}" }`,
    ),
  );
  expect(Object.fromEntries(projections)).toEqual({
    clock: "is a time variable",
    viaVar: 'reads "clock", which is a time variable',
    viaHelper: 'calls "unixEpoch"',
    twoDeep: 'reads "viaVar", which reads "clock", which is a time variable',
  });
});

test("a projection is derived at each draw; a derived template is cached", () => {
  const cfg = config(`{
    clock: { kind: "template", template: "{{ unixEpoch now }}" },
    label: { kind: "literal", value: "x" },
    shown: { kind: "template", template: "{{ .label }}" },
  }`);
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  try {
    // The synthesized menu's `state` variables need a SessionState this
    // registry has not got; this test's own variables declare.
    const failed = declareDslVariables(
      cfg,
      registry,
      process.cwd(),
      EVERY_SCOPE,
    );
    expect(failed.filter((w) => /"(clock|label|shown)"/.test(w))).toEqual([]);
    expect(store.getNode("clock").kind).toBe("projection");
    expect(store.getNode("shown").kind).toBe("computed");
    const at = (s: number) => new Date(s * 1000);
    {
      using _draw = drawingAt(at(1000));
      expect(store.read("clock")).toBe("1000");
    }
    using _draw = drawingAt(at(2000));
    expect(store.read("clock")).toBe("2000");
  } finally {
    registry.dispose();
  }
});
