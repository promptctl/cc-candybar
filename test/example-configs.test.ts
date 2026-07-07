// [LAW:verifiable-goals] Every shipped example config under examples/ must
// survive the full production pipeline: parse → merge-on-default → validate →
// register → render. A template parse error in an inline override, a dangling
// segment/action reference, or a palette name the registry can't resolve would
// otherwise rot silently until a user copies the file onto their bar.
//
// [LAW:behavior-not-structure] The assertion is the contract a user relies on —
// "this documented config loads and renders" — not any internal shape. The test
// discovers files by globbing the directory, so a new example is covered the
// moment it lands (no per-file edit).
//
// examples/legacy-parity.json5 is the migration-completeness capstone
// (brandon-config-aoi): this test is what keeps that proof honest over time.

import fs from "node:fs";
import path from "node:path";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import {
  listResolvablePaletteNames,
  effectiveThemeName,
} from "../src/themes/policy";
import { resolverForThemeName } from "../src/themes/palette-resolvers";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_WRAP,
} from "../src/render/strip";

const examplesDir = path.join(__dirname, "..", "examples");
const ALLOWED = new Set(listResolvablePaletteNames());

// One faked Claude Code hook event — the same minimal shape the demo uses. The
// `input` vars read out of it; absent data gates its segments off, which is a
// valid render, not a failure.
const payload = {
  hook_event_name: "Status",
  session_id: "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
  cwd: process.cwd(),
  model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
  workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
};

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

describe("shipped example configs (examples/*.json5)", () => {
  // Guard against the glob silently matching nothing (a moved directory would
  // make every it.each below vanish and the suite pass vacuously).
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
    "%s loads, validates, and renders on the production pipeline",
    (file) => {
      const filePath = path.join(examplesDir, file);
      const source = fs.readFileSync(filePath, "utf-8");

      // parse → merge on the REAL bundled default (examples declare only deltas
      // and reference bundled segments) → validate.
      const raw = parseDslConfig(filePath, source, ALLOWED);
      const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
      const config = validateConfig(merged, filePath, source, ALLOWED);

      // register + render — the step that surfaces template parse errors in
      // inline overrides (validateConfig alone does not compile templates).
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(config, registry, {
          cwd: process.cwd(),
        });
        const basePalette = resolverForThemeName(
          effectiveThemeName(null, config.globals.palette),
        );
        const line = renderDsl(
          config,
          compiled,
          store,
          registry,
          payload,
          basePalette,
          {
            style: "powerline",
            width: 200,
            colorCompatibility: DEFAULT_COLOR_COMPATIBILITY,
            wrap: DEFAULT_WRAP,
            padding: DEFAULT_PADDING,
            charset: DEFAULT_CHARSET,
          },
        );
        expect(typeof line).toBe("string");
        expect(line.length).toBeGreaterThan(0);
      } finally {
        registry.dispose();
      }
    },
  );
});
