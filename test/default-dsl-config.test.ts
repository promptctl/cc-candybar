// [LAW:single-enforcer] The bundled default DslConfig is the production
// statusline when no user file is present. The loader and the renderer must
// agree it is valid, otherwise the daemon's startup path crashes for every
// new user. This test pins that invariant.
//
// [LAW:types-are-the-program] If a future change to dsl-types tightens a
// constraint and DEFAULT_DSL_CONFIG no longer satisfies it, this test fails
// at compile time (via the `satisfies` on the constant) AND at runtime here
// (via parseDslConfig). Two boundaries, one truth.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseDslConfig } from "../src/config/dsl-loader";
import { registerDslConfig, renderDslLine } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { PaletteResolver } from "@promptctl/rich-js";
import { getThemePalette } from "../src/themes/palette-registry";

const SERIALIZED = JSON.stringify(DEFAULT_DSL_CONFIG, null, 2);

describe("DEFAULT_DSL_CONFIG", () => {
  test("loader round-trips the bundled default", () => {
    const parsed = parseDslConfig("<default>", SERIALIZED);
    expect(Object.keys(parsed.variables).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.segments).length).toBeGreaterThan(0);
    expect(parsed.layout.length).toBeGreaterThan(0);
  });

  test("every layout entry is a declared segment", () => {
    for (const segName of DEFAULT_DSL_CONFIG.layout) {
      expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty(segName);
    }
  });

  test("registerDslConfig + renderDslLine produce a non-empty line", () => {
    const parsed = parseDslConfig("<default>", SERIALIZED);
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    try {
      const compiled = registerDslConfig(parsed, registry, {
        cwd: process.cwd(),
      });
      const basePalette = new PaletteResolver(
        getThemePalette(parsed.globals.palette ?? "textual-dark")!,
      );
      const payload = {
        hook_event_name: "Status",
        session_id: "deadbeef-1234-5678-9abc-def012345678",
        cwd: "/tmp",
        model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
        workspace: {
          current_dir: "/tmp",
          project_dir: "/tmp",
          added_dirs: [],
        },
      };
      const line = renderDslLine(
        parsed,
        compiled,
        store,
        registry,
        payload,
        basePalette,
        { style: "powerline", colorCompatibility: "truecolor" },
      );
      // Hidden segments (no git repo, no usage data) drop out; the
      // directory and model segments remain, so the line is non-empty.
      expect(line.length).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
  });
});
