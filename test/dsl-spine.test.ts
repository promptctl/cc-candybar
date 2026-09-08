// [LAW:single-enforcer] Drives registerDslConfig + renderDsl end-to-end with a
// REAL config and payload. [LAW:verifiable-goals] Success is committed bytes.

import { SessionState } from "../src/daemon/session-state";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getThemePalette } from "@promptctl/rich-js";

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { walkNodes } from "../src/config/dsl-types";
import { presetRoot, PRESET_FLOOR } from "../src/config/presets";

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

// [LAW:one-source-of-truth] Injected so validation never touches the filesystem.
const ALLOWED_PALETTES = new Set(["textual-dark", "gruvbox"]);

const FIXTURE_SOURCE = readFileSync(
  join(process.cwd(), "test", "fixtures", "steel-thread.json5"),
  "utf-8",
);

// Width is Infinity so the committed snapshot stays a single line.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// HOME is controlled so the directory template's home-collapse is never taken.
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
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    const compiled = registerDslConfig(config, registry, { cwd });
    return { config, compiled, store, registry };
  }

  test("parseDslConfig accepts the committed fixture", () => {
    expect(() =>
      parseAndValidate("<test>", FIXTURE_SOURCE, ALLOWED_PALETTES),
    ).not.toThrow();
  });

  test("registerDslConfig populates the store with all declared variables", () => {
    const { store } = buildRuntime(HOOK_DATA.workspace.current_dir);
    expect(store.has("current_dir")).toBe(true);
    expect(store.has("project_dir")).toBe(true);
    expect(store.has("home")).toBe(true);
    expect(store.has("session.id")).toBe(true);
  });

  test("renderDsl returns a non-empty ANSI string", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = getThemePalette("textual-dark"!);
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
    const basePalette = getThemePalette("textual-dark"!);

    renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);

    expect(store.read("current_dir")).toBe(HOOK_DATA.workspace.current_dir);
    expect(store.read("project_dir")).toBe(HOOK_DATA.workspace.project_dir);
    expect(store.read("session.id")).toBe(SESSION_ID);
  });

  test("renderDsl produces byte-identical output on repeated calls with the same payload", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = getThemePalette("textual-dark"!);

    const a = renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    const b = renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    expect(a).toBe(b);
  });

  test("perSegmentSink receives one RichText[] per rendered (non-hidden) segment, cleared on each call", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = getThemePalette("textual-dark"!);
    const sink = new Map<
      string,
      readonly import("@promptctl/rich-js").RichText[]
    >();
    sink.set("doesNotExist", []);

    renderDsl(
      config,
      compiled,
      store,
      registry,
      HOOK_DATA,
      basePalette,
      OPTS,
      { perSegmentSink: sink },
    );

    expect(sink.has("doesNotExist")).toBe(false);
    expect(sink.size).toBeGreaterThan(0);
    // [LAW:one-source-of-truth] The walked tree is the active preset's root,
    // not `config.root`, which the synthesis passes leave as the author wrote.
    const allLayoutSegments = [
      ...walkNodes(presetRoot(config, PRESET_FLOOR).node),
    ].flatMap((n) => (n.kind === "segment" ? [n.name] : []));
    for (const [name, cells] of sink) {
      expect(allLayoutSegments).toContain(name);
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  test("renderDsl produces exact committed bytes (spine correctness)", () => {
    const { config, compiled, store, registry } = buildRuntime(
      HOOK_DATA.workspace.current_dir,
    );
    const basePalette = getThemePalette("textual-dark"!);
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
    // Different palettes must produce different ANSI bytes.
    const withGruvboxPalette = (() => {
      const { config, compiled, store, registry } = buildRuntime(
        HOOK_DATA.workspace.current_dir,
      );
      const basePalette = getThemePalette("textual-dark"!);
      return renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

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
      const registry = new SourceRegistry(store, "", undefined, new SessionState());
      const compiled = registerDslConfig(config, registry, {
        cwd: HOOK_DATA.workspace.current_dir,
      });
      const basePalette = getThemePalette("textual-dark"!);
      return renderDsl(config, compiled, store, registry, HOOK_DATA, basePalette, OPTS);
    })();

    expect(withGruvboxPalette).not.toBe(withBasePaletteOnly);
  });
});
