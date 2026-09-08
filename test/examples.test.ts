// [LAW:verifiable-goals] Every shipped example runs the real cascade and the
// real spine, so drift fails CI rather than a user's status line.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getThemePalette } from "@promptctl/rich-js";
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

// Real content, since empty strings would mask a broken template.
const PAYLOAD = {
  session_id: "sess-abc123",
  transcript_path: "/tmp/proj/transcript.jsonl",
  workspace: { current_dir: "/tmp/proj/src", project_dir: "/tmp/proj" },
  model: { display_name: "Claude" },
};

describe("shipped examples load and render through the real cascade", () => {
  test("there are example files to check", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  test.each(exampleFiles)("%s validates and renders without errors", (file) => {
    const path = join(EXAMPLES_DIR, file);
    const source = readFileSync(path, "utf8");

    const raw = parseDslConfig(path, source, ALLOWED);
    const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
    const config = validateConfig(merged, path, source, ALLOWED);

    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    expect(compiled.loadWarnings).toEqual([]);

    const basePalette = getThemePalette("textual-dark"!);
    const rendered = renderDsl(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      basePalette,
      {
        style: "powerline",
        colorCompatibility: "truecolor", wrap: true, padding: 0, charset: "unicode" as const,
        width: 200,
      },
    );

    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("⚠");
  });
});
