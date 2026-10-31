// [LAW:behavior-not-structure] What the projection fold says of a config, and
// what the store does with its answer: a projection is derived again by every
// read, at the draw in progress; anything else is cached.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { projectionsOf } from "../src/config/loader/projections";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { CLOCK_FUNCTIONS } from "../src/template-engine/engine";
import {
  compileInputOf,
  compileKey,
  declareDslVariables,
  EVERY_SCOPE,
} from "../src/dsl/render";
import { SourceRegistry, VariableStore } from "../src/var-system";
import { drawingAt } from "./helpers/test-engine";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFromDisk, pluginLoadLine } from "../src/daemon/cache/render";
import { SessionState } from "../src/daemon/session-state";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";

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

// The projections a config's own variables make: every config also has the
// draw's own facts (DRAW_PROJECTIONS — `today`, `feeds`, `drawing`) as
// projections, through the payload inputs its menu reads.
const DRAWN_REASON = /^reads the draw's "/;
const own = (projections: ReadonlyMap<string, string>): Map<string, string> =>
  new Map([...projections].filter(([, why]) => !DRAWN_REASON.test(why)));

test("every input at a path the draw answers is a projection", () => {
  const projections = projectionsOf(
    config(`{
      spent: { kind: "input", path: "today.cost" },
      rate: { kind: "input", path: "feeds.band.fps" },
      by: { kind: "input", path: "drawing.by" },
      sid: { kind: "input", path: "session_id" },
    }`),
  );
  expect(projections.has("sid")).toBe(false);
  for (const name of ["spent", "rate", "by"]) {
    expect([name, projections.get(name)]).toEqual([
      name,
      expect.stringMatching(DRAWN_REASON),
    ]);
  }
});

test("a date function of its arguments alone reads no clock", () => {
  const pure = [
    "date",
    "dateInZone",
    "dateModify",
    "htmlDate",
    "htmlDateInZone",
    "duration",
    "durationRound",
    "toDate",
    "unixEpoch",
  ];
  expect(pure.filter((name) => CLOCK_FUNCTIONS.has(name))).toEqual([]);
  const cfg = config(`{
    stamp: { kind: "literal", value: "1700000000" },
    took: { kind: "template", template: "{{ duration 90 }}" },
    day: { kind: "template", template: '{{ date "2006-01-02" (int .stamp) }}' },
  }`);
  expect([...own(projectionsOf(cfg)).keys()]).toEqual([]);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store);
  try {
    declareDslVariables(cfg, registry, process.cwd(), EVERY_SCOPE);
    // Read with no draw bound: neither reaches the clock.
    expect(store.read("took")).toBe("1m30s");
    expect(store.read("day")).toMatch(/^2023-11-1[45]$/);
  } finally {
    registry.dispose();
  }
});

test("a value reaching the instant by a name it does not spell is refused, never frozen", () => {
  const cfg = config(`{
    clock: { kind: "time", layout: "15:04:05" },
    hidden: { kind: "template", template: '{{ index . "clock" }}' },
  }`);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store);
  try {
    declareDslVariables(cfg, registry, process.cwd(), EVERY_SCOPE);
    // The fold cannot see the read, so `hidden` keeps its answer.
    expect(store.getNode("hidden").kind).toBe("computed");
    using _draw = drawingAt(new Date(2026, 0, 1, 9, 0, 0));
    expect(() => store.read("hidden")).toThrow(
      /clock was read by a value that keeps its answer/,
    );
  } finally {
    registry.dispose();
  }
});

test("a value that keeps its answer is told why, drawn or not", () => {
  const cfg = config(`{
    clock: { kind: "time", layout: "15:04:05" },
    hidden: { kind: "template", template: '{{ index . "clock" }}' },
  }`);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store);
  try {
    declareDslVariables(cfg, registry, process.cwd(), EVERY_SCOPE);
    expect(() => store.read("hidden")).toThrow(
      /clock was read by a value that keeps its answer/,
    );
    // Nothing keeps the time variable's answer: outside a draw is the reason.
    expect(() => store.read("clock")).toThrow(/outside a draw/);
  } finally {
    registry.dispose();
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
  expect(Object.fromEntries(own(projections))).toEqual({
    clock: "is a time variable",
    viaVar: 'reads "clock", which is a time variable',
    viaHelper: 'calls "now"',
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
  const registry = new SourceRegistry(processLauncher, store);
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

// [LAW:verifiable-goals] Each load says which variables it derives at every
// draw, so a variable evaluated per frame is named in the daemon's log.
test("the config load line names the load's projections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-projections-"));
  const line = (variables: string, segments = "{}"): string => {
    const file = path.join(dir, "config.json5");
    fs.writeFileSync(file, `{ variables: ${variables}, segments: ${segments} }`);
    const loaded = loadFromDisk(dir, dir, file, { launcher: processLauncher, storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
      sessionState: new SessionState(),
    });
    expect(loaded.error).toBeNull();
    loaded.state!.registry.dispose();
    return pluginLoadLine(loaded.layers, loaded.state!, loaded.ms);
  };
  // The projections the line names, less the draw's own facts every config
  // has (DRAW_PROJECTIONS).
  const named = (text: string): string[] =>
    /: projections=(\S+) /
      .exec(text)![1]!
      .split(",")
      .filter((name) => !/^(today|feeds|drawing)\./.test(name));
  try {
    expect(
      named(
        line(`{
        clock: { kind: "time", layout: "15:04" },
        shown: { kind: "template", template: "{{ .clock }}" },
      }`),
      ),
    ).toEqual([
      // The settings door's indicator reads the draw's diagnostics.
      "diagnostics.label",
      "diagnostics.fg",
      "diagnostics.bg",
      "diagnostics.open",
      "clock",
      "git.timeSinceCommit",
      "block.etaMinutes",
      "weekly.etaMinutes",
      "shown",
    ]);
    // The bundled default's: what its stored instants say relative to now
    // (brandon-unfiled-3248.8ro6 step 3).
    expect(named(line("{}"))).toEqual([
      "diagnostics.label",
      "diagnostics.fg",
      "diagnostics.bg",
      "diagnostics.open",
      "git.timeSinceCommit",
      "block.etaMinutes",
      "weekly.etaMinutes",
    ]);
    expect(line("{}")).toMatch(/ projections=\S*today\.cost\b/);
    // brandon-unfiled-3248.8ro6 step 6: and which segments it draws at every
    // frame, the bundled default's among them.
    const segments = (text: string): string[] =>
      / instantSegments=(\S+) /.exec(text)![1]!.split(",");
    const stamped = segments(
      line("{}", `{ stamp: { template: "{{ unixEpoch now }}" } }`),
    );
    expect(stamped).toContain("stamp");
    expect(stamped).toContain("cacheTimer");
    expect(segments(line("{}"))).not.toContain("stamp");
    // And how many templates it draws so, whatever holds them: a segment's
    // own one more.
    const templates = (text: string): number =>
      Number(/ instantTemplates=(\d+) /.exec(text)![1]);
    expect(
      templates(line("{}", `{ stamp: { template: "{{ unixEpoch now }}" } }`)),
    ).toBe(templates(line("{}")) + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A compile reads of the variables only the projections, so configs declaring
// other variables differently share one.
test("a compile is keyed on the projections alone", () => {
  const key = (variables: string, read = ".clock") =>
    compileKey(
      compileInputOf(
        parseAndValidate(
          "/tmp/test.json5",
          `{ variables: ${variables}, segments: { s: { template: "{{ ${read} }}" } }, root: { h: ["s"] } }`,
        ),
      ),
    );
  const clock = `clock: { kind: "time", layout: "15:04" }`;
  expect(key(`{ ${clock}, a: { kind: "literal", value: "1" } }`)).toBe(
    key(`{ ${clock}, b: { kind: "literal", value: "2" } }`),
  );
  // No name is declared under another, so none can change where a read of a
  // projection lands.
  const nested = `"clock.at": { kind: "literal", value: "1" }`;
  expect(() => key(`{ ${clock}, ${nested} }`)).toThrow(
    /"clock\.at" is declared under the variable "clock"/,
  );
});
