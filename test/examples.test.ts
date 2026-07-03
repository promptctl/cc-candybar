// [LAW:verifiable-goals] The shipped example configs are a documented promise:
// "copy this into ~/.config/cc-candybar/config.json5 and it works". Until now
// nothing checked that promise, so examples drifted (stale `layout:` row sugar,
// the old split-form pickers) and only got caught by hand. This test loads EVERY
// example through the real production cascade (parse → merge over
// DEFAULT_DSL_CONFIG → validate) and RENDERS it through the real spine, asserting
// no validation error and no error cell (⚠) in the output — so any future drift
// fails CI, not a user's status line.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";

const ALLOWED = new Set(listResolvablePaletteNames());
const EXAMPLES_DIR = join(__dirname, "..", "examples");

const exampleFiles = readdirSync(EXAMPLES_DIR).filter((f) =>
  f.endsWith(".json5"),
);

// A representative hook payload so segments that read native fields render real
// content rather than empty strings (which would mask a broken template).
const PAYLOAD = {
  session_id: "sess-abc123",
  transcript_path: "/tmp/proj/transcript.jsonl",
  workspace: { current_dir: "/tmp/proj/src", project_dir: "/tmp/proj" },
  model: { display_name: "Claude" },
};

describe("shipped examples load and render through the real cascade", () => {
  // Guard against an empty glob silently passing the whole suite.
  test("there are example files to check", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  test.each(exampleFiles)("%s validates and renders without errors", (file) => {
    const path = join(EXAMPLES_DIR, file);
    const source = readFileSync(path, "utf8");

    // Production cascade: user file merges ON TOP of the bundled default.
    const raw = parseDslConfig(path, source, ALLOWED);
    const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
    const config = validateConfig(merged, path, source, ALLOWED);

    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    // [LAW:no-silent-failure] A variable that fails to declare is collected, not
    // thrown — surface it here so a broken example var fails the test loudly.
    expect(compiled.loadWarnings).toEqual([]);

    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const rendered = renderDsl(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      basePalette,
      {
        style: "powerline",
        colorCompatibility: "truecolor", wrap: true, padding: 0,
        width: 200,
      },
    );

    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
    // The render-time error cell prefix — its presence means a segment threw
    // (missing var, bad template) and degraded to a visible warning.
    expect(rendered).not.toContain("⚠");
  });
});
