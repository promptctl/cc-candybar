// [LAW:single-enforcer] This is the integration test for the bzh.7 render
// spine. It drives registerDslConfig + drawDsl end-to-end with a REAL
// DslConfig (parsed from a committed fixture) and a REAL fixture payload —
// no hand-seeded stores, no single-segment shortcuts.
//
// [LAW:verifiable-goals] Success is a byte string that matches a committed
// snapshot. Any byte drift fails loudly.

import { ansiOf, textOf } from "../src/render/frame";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAndValidate } from "./helpers/parse-and-validate";
import { walkNodes } from "../src/config/dsl-types";
import { presetRoot, PRESET_FLOOR } from "../src/config/presets";
import type { RenderObservers } from "../src/dsl/render";
import { buildRig } from "./helpers/rig";

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

// HOME is controlled so the directory template's home-collapse branch is
// never taken — makes path rendering deterministic across machines. (An `env`
// source reads the registry's environment at registerDslConfig call time.)
const ENV = { HOME: "" };

describe("DSL render spine (bzh.7 steel thread)", () => {
  // Strip opts are the rig's own (powerline, truecolor, wrap, padding 0, width
  // Infinity) so the committed snapshot stays a single line — wrap behavior is
  // tested in test/strip-flex.test.ts (the renderStripCells wrap path).
  function spineBar(
    cwd: string,
    source: string = FIXTURE_SOURCE,
    palettes: ReadonlySet<string> = ALLOWED_PALETTES,
  ) {
    const rig = buildRig({ source, palettes, cwd, env: ENV });
    return { ...rig, drawHook: (observers?: RenderObservers) => rig.draw({ payload: HOOK_DATA, observers }).frame };
  }

  test("parseDslConfig accepts the committed fixture", () => {
    // Validates the fixture is syntactically correct and cross-reference-clean.
    expect(() =>
      parseAndValidate("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES),
    ).not.toThrow();
  });

  test("registerDslConfig populates the store with all declared variables", () => {
    const { store } = spineBar(HOOK_DATA.workspace.current_dir);
    // All four declared variables must be present.
    expect(store.has("current_dir")).toBe(true);
    expect(store.has("project_dir")).toBe(true);
    expect(store.has("home")).toBe(true);
    expect(store.has("session.id")).toBe(true);
  });

  test("drawDsl draws a non-empty frame", () => {
    const { drawHook } = spineBar(HOOK_DATA.workspace.current_dir);
    const result = drawHook();
    expect(result.rows.length).toBeGreaterThan(0);
    expect(textOf(result).length).toBeGreaterThan(0);
  });

  test("drawDsl reads its input vars from the payload it binds", () => {
    const { store, drawHook } = spineBar(HOOK_DATA.workspace.current_dir);

    drawHook();

    // After the first render, input boxes must hold the payload values.
    expect(store.read("current_dir")).toBe(HOOK_DATA.workspace.current_dir);
    expect(store.read("project_dir")).toBe(HOOK_DATA.workspace.project_dir);
    expect(store.read("session.id")).toBe(SESSION_ID);
  });

  test("drawDsl produces byte-identical output on repeated calls with the same payload", () => {
    const { drawHook } = spineBar(HOOK_DATA.workspace.current_dir);

    const a = drawHook();
    const b = drawHook();
    expect(a.rows).toEqual(b.rows);
  });

  test("perSegmentSink receives one RichText[] per rendered (non-hidden) segment, cleared on each call", () => {
    const { config, drawHook } = spineBar(HOOK_DATA.workspace.current_dir);
    const sink = new Map<
      string,
      readonly import("@promptctl/rich-js").RichText[]
    >();
    // Pre-seed with a stale entry to verify drawDsl clears it.
    sink.set("doesNotExist", []);

    drawHook({ perSegmentSink: sink });

    // Stale entry from a previous render must be gone.
    expect(sink.has("doesNotExist")).toBe(false);
    // Every layout entry that wasn't `when`-hidden appears in the sink.
    expect(sink.size).toBeGreaterThan(0);
    // [LAW:one-source-of-truth] The tree the render WALKED is the active
    // preset's resolved root, not `config.root` — the synthesis passes
    // (settings menu, edit chrome) write `presets[name].root` and leave
    // `config.root` as the author wrote it. Reading the same tree drawDsl
    // reads is what makes this assertion about the render.
    const allLayoutSegments = [
      ...walkNodes(presetRoot(config, PRESET_FLOOR).node),
    ].flatMap((n) => (n.kind === "segment" ? [n.name] : []));
    for (const [name, cells] of sink) {
      expect(allLayoutSegments).toContain(name);
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  // [LAW:verifiable-goals] The exact bytes are committed as a snapshot.
  // Any byte drift — from template changes, palette changes, or render-path
  // changes — fails loudly here. This is the "assembled-line fixture" that
  // grows monotonically as more segments reach dsl-parity.
  test("drawDsl produces exact committed bytes (spine correctness)", () => {
    const { drawHook } = spineBar(HOOK_DATA.workspace.current_dir);
    const result = ansiOf(drawHook());
    expect(result).toMatchSnapshot();
  });

  test("per-segment palette (sessionId uses gruvbox): output differs from base-only render", () => {
    // Build two runtimes: one with the fixture (sessionId → gruvbox palette),
    // one with a modified fixture that inherits the base palette for sessionId.
    // Different palettes must draw different rows.
    const withGruvboxPalette = spineBar(HOOK_DATA.workspace.current_dir).drawHook();

    // Override: same fixture but sessionId uses the base palette (textual-dark).
    const noSegmentPaletteSource = FIXTURE_SOURCE.replace(
      "palette: 'gruvbox',",
      "",
    );
    const withBasePaletteOnly = spineBar(
      HOOK_DATA.workspace.current_dir,
      noSegmentPaletteSource,
      new Set(["textual-dark"]),
    ).drawHook();

    expect(withGruvboxPalette.rows).not.toEqual(withBasePaletteOnly.rows);
  });
});
