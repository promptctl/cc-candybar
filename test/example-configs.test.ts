// [LAW:single-enforcer] The pipeline driven here IS `cc-candybar check`, so the
// examples, the check command and the daemon cannot disagree about what loads.
// [LAW:behavior-not-structure] Files are discovered by globbing, so a new example
// is covered the moment it lands.

import fs from "node:fs";
import path from "node:path";

import { checkConfig } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames } from "../src/config/presets";
import { checkText, expectClean, withTempConfig } from "./helpers/check-config";

const examplesDir = path.join(__dirname, "..", "examples");

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

async function renderExample(file: string): Promise<string> {
  return expectClean(file, await checkConfig(path.join(examplesDir, file)))
    .rendered;
}

// The OSC-8 introducer is terminated by EITHER ST or BEL per spec.
function visible(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
}

describe("shipped example configs (examples/*.json5)", () => {
  // Guard against the glob silently matching nothing and passing vacuously.
  test("at least the known examples are present", () => {
    expect(exampleFiles).toEqual(
      expect.arrayContaining([
        "legacy-parity.json5",
        "showcase.json5",
        "demo-actions.json5",
        "demo-variables.json5",
      ]),
    );
  });

  test.each(exampleFiles)(
    "%s is clean under `cc-candybar check` (exit 0) and renders",
    async (file) => {
      expectClean(file, await checkConfig(path.join(examplesDir, file)));
    },
  );

  // [LAW:behavior-not-structure] The branches must render their content, not
  // merely fail to throw.
  test("legacy-parity renders the full legacy information set", async () => {
    const out = visible(await renderExample("legacy-parity.json5"));
    expect(out).toContain("⎇ main");
    expect(out).toContain("◷ 13m");
    expect(out).toContain("~/c/c/src");
    expect(out).toContain("~/code/cc-candybar/src");
    expect(out).toContain("◆ 8");
    expect(out).toContain("+ 512");
    // [LAW:one-source-of-truth] Single-sourced from globals.palette via the
    // daemon-resolved `theme.effective` var.
    expect(out).toContain("🎨 catppuccin-mocha");
    expect(out).toContain("§ $0.39");
    expect(out).toContain("v1.15.0");
    expect(out).toContain("63%"); // block utilization
  });

  // [LAW:verifiable-goals] Proves the scan completed: the variable's `default`
  // is what a scan that never landed would render.
  test("demo-variables renders the json document's scanned fields, never its default", async () => {
    const out = visible(await renderExample("demo-variables.json5"));
    expect(out).toContain("📦 cc-candybar · 3 deps");
  });
});

// [LAW:verifiable-goals] The same guarantee for every name in the bundled presets
// library, on a real temp file through the actual CLI entry point.
describe("bundled preset library is clean under `cc-candybar check`", () => {
  const withPresetConfig = <T,>(
    preset: string,
    fn: (configPath: string) => Promise<T> | T,
  ): Promise<T> => withTempConfig(JSON.stringify({ globals: { preset } }), fn);

  // Guard against the domain silently shrinking to just the floor.
  test("the bundled library declares more than just the floor", () => {
    expect(presetNames(DEFAULT_DSL_CONFIG.presets).length).toBeGreaterThan(1);
  });

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    'a config picking preset "%s" is clean under check (exit 0) and renders',
    async (preset) => {
      await withPresetConfig(preset, async (p) =>
        expectClean(`preset "${preset}"`, await checkConfig(p)),
      );
    },
  );
});

// [LAW:verifiable-goals] One named row merges by name over the bundled rows.
describe("a `{ rows }` root merges by name over the bundled default", () => {
  test("declaring only the status row keeps the bundled identity row above it", async () => {
    const outcome = await checkText(
      "rows-merge",
      `{ root: { rows: { status: { h: ["model", "context"] } } } }`,
    );
    const [identity, status, ...rest] = visible(outcome.rendered).split("\n");
    expect(rest).toEqual([]);
    expect(identity).toContain("~/c/c/src");
    // The user's status row, without the bundled status row's other segments.
    expect(status).toContain("Opus 4.8");
    expect(status).not.toContain("21%");
  });
});
