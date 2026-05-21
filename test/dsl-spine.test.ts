// [LAW:single-enforcer] This is the integration test for the bzh.7 render
// spine. It drives registerDslConfig + renderDslLine end-to-end with a REAL
// DslConfig (parsed from a committed fixture) and a REAL fixture payload —
// no hand-seeded stores, no single-segment shortcuts.
//
// [LAW:verifiable-goals] Success is a byte string that matches a committed
// snapshot. Any byte drift fails loudly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PaletteResolver } from "@promptctl/rich-js";

import { parseDslConfig } from "../src/config/dsl-loader";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { getThemePalette } from "../src/themes/palette-registry";
import { registerDslConfig, renderDslLine } from "../src/dsl/render";
import { HOOK_DATA, SESSION_ID } from "./parity/fixtures";

// The two palette names used in the fixture. Injected into parseDslConfig so
// validation does not depend on the filesystem — only the bundled registry.
// [LAW:one-source-of-truth] Names are the source of truth; the resolver is
// derived from them at render time via getThemePalette.
const ALLOWED_PALETTES = new Set(["textual-dark", "gruvbox"]);

const FIXTURE_SOURCE = readFileSync(
  join(process.cwd(), "test", "fixtures", "steel-thread.json5"),
  "utf-8",
);

// Strip opts match the parity harness so bytes are comparable.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
};

// HOME is controlled so the directory template's home-collapse branch is
// never taken — makes path rendering deterministic across machines.
// (declareEnv reads process.env.HOME at registerDslConfig call time.)
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env["HOME"];
  process.env["HOME"] = "";
});
afterEach(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  else delete process.env["HOME"];
});

describe("DSL render spine (bzh.7 steel thread)", () => {
  function buildRuntime(cwd: string) {
    const config = parseDslConfig("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES);
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    registerDslConfig(config, store, registry, { cwd });
    return { config, store, registry };
  }

  test("parseDslConfig accepts the committed fixture", () => {
    // Validates the fixture is syntactically correct and cross-reference-clean.
    expect(() =>
      parseDslConfig("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES),
    ).not.toThrow();
  });

  test("registerDslConfig populates the store with all declared variables", () => {
    const { store } = buildRuntime(HOOK_DATA.workspace.current_dir);
    // All four declared variables must be present.
    expect(store.has("current_dir")).toBe(true);
    expect(store.has("project_dir")).toBe(true);
    expect(store.has("home")).toBe(true);
    expect(store.has("session.id")).toBe(true);
  });

  test("renderDslLine returns a non-empty ANSI string", () => {
    const { config, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const result = renderDslLine(
      config,
      store,
      registry,
      HOOK_DATA,
      basePalette,
      OPTS,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("renderDslLine drives payload through applyInput (input vars reflect payload)", () => {
    const { config, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);

    renderDslLine(config, store, registry, HOOK_DATA, basePalette, OPTS);

    // After the first render, input boxes must hold the payload values.
    expect(store.read("current_dir")).toBe(HOOK_DATA.workspace.current_dir);
    expect(store.read("project_dir")).toBe(HOOK_DATA.workspace.project_dir);
    expect(store.read("session.id")).toBe(SESSION_ID);
  });

  test("renderDslLine produces byte-identical output on repeated calls with the same payload", () => {
    const { config, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);

    const a = renderDslLine(config, store, registry, HOOK_DATA, basePalette, OPTS);
    const b = renderDslLine(config, store, registry, HOOK_DATA, basePalette, OPTS);
    expect(a).toBe(b);
  });

  // [LAW:verifiable-goals] The exact bytes are committed as a snapshot.
  // Any byte drift — from template changes, palette changes, or render-path
  // changes — fails loudly here. This is the "assembled-line fixture" that
  // grows monotonically as more segments reach dsl-parity.
  test("renderDslLine produces exact committed bytes (spine correctness)", () => {
    const { config, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const result = renderDslLine(
      config,
      store,
      registry,
      HOOK_DATA,
      basePalette,
      OPTS,
    );
    expect(result).toMatchSnapshot();
  });

  test("per-segment palette (sessionId uses gruvbox): output differs from base-only render", () => {
    // Build two runtimes: one with the fixture (sessionId → gruvbox palette),
    // one with a modified fixture that inherits the base palette for sessionId.
    // Different palettes must produce different ANSI bytes.
    const withGroovePalette = (() => {
      const { config, store, registry } = buildRuntime(
        HOOK_DATA.workspace.current_dir,
      );
      const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
      return renderDslLine(config, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

    // Override: same fixture but sessionId uses the base palette (textual-dark).
    const noSegmentPaletteSource = FIXTURE_SOURCE.replace(
      "palette: 'gruvbox',",
      "",
    );
    const withBasePaletteOnly = (() => {
      const config = parseDslConfig(
        "<test>",
        noSegmentPaletteSource,
        new Set(["textual-dark"]),
      );
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      registerDslConfig(config, store, registry, {
        cwd: HOOK_DATA.workspace.current_dir,
      });
      const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
      return renderDslLine(config, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

    expect(withGroovePalette).not.toBe(withBasePaletteOnly);
  });
});
