import type { Frame } from "../src/render/frame";
import { WORLD } from "./helpers/host";
// [LAW:verifiable-goals] Every shipped example config under examples/ must
// survive the full production pipeline: parse → merge-on-default → validate →
// register → render. A template parse error in an inline override, a dangling
// segment/action reference, or a palette name the registry can't resolve would
// otherwise rot silently until a user copies the file onto their bar.
//
// [LAW:behavior-not-structure] Discover the shipped files and draw each preset they expose.

import { textOf } from "../src/render/frame";
import fs from "node:fs";
import path from "node:path";

import { instantOf } from "../src/utils/instant";
import { prepareSnapshot, renderEffective } from "./helpers/prepared-config";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames } from "../src/config/presets";
import {
  checkText,
  discoverFixture,
  expectClean,
  renderConfig,
  withTempConfig,
} from "./helpers/config-fixture";

const examplesDir = path.join(__dirname, "..", "examples");

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

// Draw a fresh session for assertions about a shipped example's contents.
async function renderExample(file: string): Promise<Frame> {
  return expectClean(
    file,
    await renderConfig(WORLD, path.join(examplesDir, file)),
  ).rendered;
}

describe("shipped example configs (examples/*.json5)", () => {
  // Guard against the glob silently matching nothing (a moved directory would
  // make every it.each below vanish and the suite pass vacuously).
  test("at least the known examples are present", () => {
    expect(exampleFiles).toEqual(
      expect.arrayContaining([
        "showcase.json5",
        "demo-actions.json5",
        "demo-variables.json5",
      ]),
    );
  });

  test.each(exampleFiles)("%s renders every preset it ships", async (file) => {
    const cwd = process.cwd();
    const { snapshot, warnings } = discoverFixture(
      WORLD,
      path.join(examplesDir, file),
      cwd,
    );
    using prepared = prepareSnapshot(WORLD, snapshot, cwd, warnings);
    expect(prepared.droppedPlugins).toEqual([]);
    const at = instantOf(new Date(WORLD.clock.now()));
    for (const preset of presetNames(prepared.config.presets)) {
      const effective = prepared.effective((key) =>
        key === "preset" ? preset : null,
      );
      const { rendered, failures, pending } = await renderEffective(
        prepared,
        effective,
        200,
        at,
      );
      expect({ preset, failures, pending }).toEqual({
        preset,
        failures: [],
        pending: [],
      });
      expect(textOf(rendered).length).toBeGreaterThan(0);
    }
  });

  test("a missing example cannot pass by drawing the bundled default", () => {
    const absent = path.join(examplesDir, "absent-example.json5");
    expect(() => discoverFixture(WORLD, absent, examplesDir)).toThrow(absent);
  });

  test("an action error in an alternate preset belongs to the draw that selected it", async () => {
    await withTempConfig(
      `{
      globals: { preset: 'a' },
      presets: { a: {}, b: { root: { h: ['sample', 'broken'] } } },
      actions: { mode: { set: 'work-mode', cycle: ['focus', 'review', 'debug'] } },
      segments: {
        sample: { template: 'sample' },
        broken: { template: '{{ action "mode" "focus" "review" }}' },
      },
      root: { h: ['sample'] },
    }`,
      async (file) => {
        const cwd = path.dirname(file);
        const { snapshot, warnings } = discoverFixture(WORLD, file, cwd);
        using prepared = prepareSnapshot(WORLD, snapshot, cwd, warnings);
        const draw = (preset: string | null) =>
          renderEffective(
            prepared,
            prepared.effective((key) => (key === "preset" ? preset : null)),
            200,
            instantOf(new Date(WORLD.clock.now())),
          );
        expect((await draw(null)).failures).toEqual([]);
        expect((await draw("b")).failures).toEqual([
          expect.stringContaining("mode"),
        ]);
      },
    );
  });

  // [LAW:verifiable-goals] The shipped demonstration of `parse: { json: true }`
  // must prove the scan completed: `demoPkg` reads the document's fields by
  // dotted path, and its `default` (`? · 0 deps`) is what a scan that never
  // landed would render.
  test("demo-variables renders the json document's scanned fields, never its default", async () => {
    const out = textOf(await renderExample("demo-variables.json5"));
    expect(out).toContain("📦 cc-candybar · 3 deps");
  });
});

// [LAW:verifiable-goals] Each bundled preset is selected as a user would choose it.
describe("the bundled preset library", () => {
  const withPresetConfig = <T>(
    preset: string,
    fn: (configPath: string) => Promise<T> | T,
  ): Promise<T> => withTempConfig(JSON.stringify({ globals: { preset } }), fn);

  // Guard against the domain silently shrinking to just the floor — a preset
  // this suite never iterates would be a preset never drawn.
  test("the bundled library declares more than just the floor", () => {
    expect(presetNames(DEFAULT_DSL_CONFIG.presets).length).toBeGreaterThan(1);
  });

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    'a config picking preset "%s" loads and renders',
    async (preset) => {
      await withPresetConfig(preset, async (p) =>
        expectClean(`preset "${preset}"`, await renderConfig(WORLD, p)),
      );
    },
  );
});

// [LAW:verifiable-goals] brandon-config-merge-uk3's done-when: a user file
// declaring ONLY one named row merges that row by name over the bundled
// default's rows, so the bundled identity row renders unchanged above it —
// through the same merge and render path as the shipped examples.
describe("a `{ rows }` root merges by name over the bundled default", () => {
  test("declaring only the status row keeps the bundled identity row above it", async () => {
    const outcome = await checkText(
      "rows-merge",
      `{ root: { rows: { status: { h: ["model", "context"] } } } }`,
    );
    const [identity, status, ...rest] = textOf(outcome.rendered).split("\n");
    expect(rest).toEqual([]);
    // The bundled identity row, untouched: the directory, its checkout named
    // in full and the rest fish-abbreviated.
    expect(identity).toContain("~/c/cc-candybar/src");
    // The user's status row: model and context, and none of the bundled
    // status row's other segments (block/weekly quota).
    expect(status).toContain("Opus 4.8");
    expect(status).not.toContain("21%");
  });
});
