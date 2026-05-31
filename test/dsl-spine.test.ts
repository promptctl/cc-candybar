// [LAW:single-enforcer] This is the integration test for the bzh.7 render
// spine. It drives registerDslConfig + renderDsl end-to-end with a REAL
// DslConfig (parsed from a committed fixture) and a REAL fixture payload —
// no hand-seeded stores, no single-segment shortcuts.
//
// [LAW:verifiable-goals] Success is a byte string that matches a committed
// snapshot. Any byte drift fails loudly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { walkNodes } from "../src/config/dsl-types";

// [LAW:single-enforcer] Inlined fixture values formerly served by
// `test/parity/fixtures.ts`. The parity infra was retired alongside the
// legacy renderer (bzh.2), so this test holds its own minimal fixture
// rather than importing from a module whose other consumers are gone.
const SESSION_ID = "0a1b2c3d-4e5f-6789-abcd-ef1234567890";

const HOOK_DATA = {
  hook_event_name: "Status",
  session_id: SESSION_ID,
  transcript_path: "/tmp/fake-transcript.jsonl",
  cwd: "/tmp/cwd",
  model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4" },
  workspace: {
    current_dir: "/tmp/cwd/src",
    project_dir: "/tmp/cwd",
    added_dirs: [],
  },
} as const;

// The two palette names used in the fixture. Injected into parseDslConfig so
// validation does not depend on the filesystem — only the bundled registry.
// [LAW:one-source-of-truth] Names are the source of truth; the resolver is
// derived from them at render time via getThemePalette.
const ALLOWED_PALETTES = new Set(["textual-dark", "gruvbox"]);

const FIXTURE_SOURCE = readFileSync(
  join(process.cwd(), "test", "fixtures", "steel-thread.json5"),
  "utf-8",
);

// Strip opts match the parity harness so bytes are comparable. Width is
// Infinity so the committed snapshot stays a single line — wrap behavior
// is tested in test/strip-flex.test.ts (the renderStripCells wrap path).
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
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
    const config = parseAndValidate("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES);
    const store = new VariableStore();
    const registry = new SourceRegistry(store);
    const compiled = registerDslConfig(config, registry, { cwd });
    return { config, compiled, store, registry };
  }

  test("parseDslConfig accepts the committed fixture", () => {
    // Validates the fixture is syntactically correct and cross-reference-clean.
    expect(() =>
      parseAndValidate("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES),
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

  test("renderDsl returns a non-empty ANSI string", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const result = renderDsl(
      config,
      compiled,
      store,
      registry,
      HOOK_DATA,
      basePalette,
      OPTS,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("renderDsl drives payload through applyInput (input vars reflect payload)", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);

    renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);

    // After the first render, input boxes must hold the payload values.
    expect(store.read("current_dir")).toBe(HOOK_DATA.workspace.current_dir);
    expect(store.read("project_dir")).toBe(HOOK_DATA.workspace.project_dir);
    expect(store.read("session.id")).toBe(SESSION_ID);
  });

  test("renderDsl produces byte-identical output on repeated calls with the same payload", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);

    const a = renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    const b = renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    expect(a).toBe(b);
  });

  test("perSegmentSink receives one RichText[] per rendered (non-hidden) segment, cleared on each call", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const sink = new Map<
      string,
      readonly import("@promptctl/rich-js").RichText[]
    >();
    // Pre-seed with a stale entry to verify renderDsl clears it.
    sink.set("doesNotExist", []);

    renderDsl(
      config,
      compiled,
      store,
      registry,
      HOOK_DATA,
      basePalette,
      OPTS,
      sink,
    );

    // Stale entry from a previous render must be gone.
    expect(sink.has("doesNotExist")).toBe(false);
    // Every layout entry that wasn't `when`-hidden appears in the sink.
    expect(sink.size).toBeGreaterThan(0);
    const allLayoutSegments = [...walkNodes(config.root)].flatMap((n) =>
      n.kind === "cells" ? n.segments : [],
    );
    for (const [name, cells] of sink) {
      expect(allLayoutSegments).toContain(name);
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  // [LAW:verifiable-goals] The exact bytes are committed as a snapshot.
  // Any byte drift — from template changes, palette changes, or render-path
  // changes — fails loudly here. This is the "assembled-line fixture" that
  // grows monotonically as more segments reach dsl-parity.
  test("renderDsl produces exact committed bytes (spine correctness)", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const result = renderDsl(
      config,
      compiled,
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
    const withGruvboxPalette = (() => {
      const { config, compiled, store, registry } = buildRuntime(
        HOOK_DATA.workspace.current_dir,
      );
      const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
      return renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

    // Override: same fixture but sessionId uses the base palette (textual-dark).
    const noSegmentPaletteSource = FIXTURE_SOURCE.replace(
      "palette: 'gruvbox',",
      "",
    );
    const withBasePaletteOnly = (() => {
      const config = parseAndValidate(
        "<test>",
        noSegmentPaletteSource,
        new Set(["textual-dark"]),
      );
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      const compiled = registerDslConfig(config, registry, {
        cwd: HOOK_DATA.workspace.current_dir,
      });
      const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
      return renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

    expect(withGruvboxPalette).not.toBe(withBasePaletteOnly);
  });
});
