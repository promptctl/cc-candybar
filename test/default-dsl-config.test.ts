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
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { PaletteResolver } from "@promptctl/rich-js";
import { getThemePalette } from "../src/themes/palette-registry";

const SERIALIZED = JSON.stringify(DEFAULT_DSL_CONFIG, null, 2);

describe("DEFAULT_DSL_CONFIG", () => {
  test("loader round-trips the bundled default", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    expect(Object.keys(parsed.variables).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.segments).length).toBeGreaterThan(0);
    expect(parsed.layout.length).toBeGreaterThan(0);
  });

  test("every layout entry is a declared segment", () => {
    for (const row of DEFAULT_DSL_CONFIG.layout) {
      for (const segName of row) {
        expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty(segName);
      }
    }
  });

  test("registerDslConfig + renderDsl produce a non-empty line", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
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
      const line = renderDsl(
        parsed,
        compiled,
        store,
        registry,
        payload,
        basePalette,
        { style: "powerline", colorCompatibility: "truecolor", width: Number.POSITIVE_INFINITY },
      );
      // Hidden segments (no git repo, no usage data) drop out; the
      // directory and model segments remain, so the line is non-empty.
      expect(line.length).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
  });

  // [LAW:verifiable-goals] The directory segment's template has boundary
  // cases that round-9 fixed: project root collapse, subdir relative path,
  // home boundary safety. Each case sets up a focused single-segment
  // runtime, renders, and strips ANSI for assertion against visible text.
  describe("DIR_TEMPLATE", () => {
    function renderDirectoryText(opts: {
      home: string;
      project_dir: string;
      current_dir: string;
    }): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      // Narrow the layout to `directory` so the rendered line is exactly
      // that segment's text. `home` flows through the augmented payload
      // (kind: "input", path: "home" in DEFAULT_DSL_CONFIG) — we set it
      // on the payload object directly; no env-var mutation needed.
      const dirOnly = { ...parsed, layout: [["directory"]] };
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      try {
        const compiled = registerDslConfig(dirOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = new PaletteResolver(
          getThemePalette(dirOnly.globals.palette ?? "textual-dark")!,
        );
        const payload = {
          hook_event_name: "Status",
          session_id: "x",
          transcript_path: "/tmp/t.jsonl",
          cwd: opts.current_dir,
          model: { id: "x", display_name: "x" },
          workspace: {
            current_dir: opts.current_dir,
            project_dir: opts.project_dir,
            added_dirs: [],
          },
          home: opts.home,
        };
        const line = renderDsl(
          dirOnly,
          compiled,
          store,
          registry,
          payload,
          basePalette,
          { style: "powerline", colorCompatibility: "truecolor", width: Number.POSITIVE_INFINITY },
        );
        // Strip ANSI escapes AND the Powerline joiner glyphs
        // (U+E0B0..U+E0BC range) so assertions can probe visible
        // segment text only.
        return line.replace(
          // eslint-disable-next-line no-control-regex
          /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\|[\u{E0B0}-\u{E0BC}]/gu,
          "",
        );
      } finally {
        registry.dispose();
      }
    }

    test("project root (current_dir === project_dir) renders as project basename", () => {
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/Users/alice/code/myproject",
        current_dir: "/Users/alice/code/myproject",
      });
      expect(visible).toContain("myproject");
      expect(visible).not.toContain("/Users/alice/code");
    });

    test("subdir of project renders as project-relative path", () => {
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/Users/alice/code/myproject",
        current_dir: "/Users/alice/code/myproject/src/foo",
      });
      expect(visible).toContain("src/foo");
      expect(visible).not.toContain("/Users/alice");
    });

    test("hasPrefix boundary safety: /home/al is NOT a prefix of /home/alice", () => {
      // If hasPrefix were used naively, `/home/alice/work` would falsely
      // match `/home/al` and try to render relative to it.
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/home/al",
        current_dir: "/home/alice/work",
      });
      expect(visible).toContain("/home/alice/work");
    });

    test("home === current_dir renders as just ~", () => {
      const visible = renderDirectoryText({
        home: "/Users/alice",
        project_dir: "/whatever",
        current_dir: "/Users/alice",
      });
      expect(visible).toMatch(/^\s*~\s*$/);
    });

    test("home prefix boundary: /Users/al is NOT a prefix of /Users/alice", () => {
      const visible = renderDirectoryText({
        home: "/Users/al",
        project_dir: "/Users/alice/proj",
        current_dir: "/Users/alice/work",
      });
      expect(visible).not.toContain("~");
    });
  });

  // [LAW:dataflow-not-control-flow] The metrics segment renders parts
  // independently — each `if .metrics.<field>` guard fires off its own
  // value. Absent fields project through pickNonNull as missing keys and
  // resolve via the var-system fallback to 0 (falsy), so the part is
  // hidden without any per-field show-flag plumbing. The segment-level
  // `when` is a weak any-present check that suppresses the whole cell
  // when no metric has data.
  describe("metrics per-part gating", () => {
    function renderMetricsText(metrics: {
      lastResponseTime?: number;
      responseTime?: number;
      sessionDuration?: number;
      messageCount?: number;
      linesAdded?: number;
      linesRemoved?: number;
    }): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      const metricsOnly = { ...parsed, layout: [["metrics"]] };
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      try {
        const compiled = registerDslConfig(metricsOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = new PaletteResolver(
          getThemePalette(metricsOnly.globals.palette ?? "textual-dark")!,
        );
        const payload = {
          hook_event_name: "Status",
          session_id: "x",
          cwd: "/tmp",
          model: { id: "x", display_name: "x" },
          workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
          metrics,
        };
        const line = renderDsl(
          metricsOnly,
          compiled,
          store,
          registry,
          payload,
          basePalette,
          { style: "powerline", colorCompatibility: "truecolor", width: Number.POSITIVE_INFINITY },
        );
        return line.replace(
          // eslint-disable-next-line no-control-regex
          /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\|[\u{E0B0}-\u{E0BC}]/gu,
          "",
        );
      } finally {
        registry.dispose();
      }
    }

    test("subset of fields renders only their parts", () => {
      const visible = renderMetricsText({
        lastResponseTime: 1.5,
        messageCount: 3,
      });
      expect(visible).toContain("Δ");
      expect(visible).toContain("1.5s");
      expect(visible).toContain("◆");
      expect(visible).toContain("3");
      // Absent dimensions: their part glyphs must NOT appear.
      expect(visible).not.toContain("⧖");
      expect(visible).not.toContain("⧗");
      expect(visible).not.toContain("+");
      expect(visible).not.toContain("-");
    });

    test("all fields present renders every part", () => {
      const visible = renderMetricsText({
        lastResponseTime: 1.5,
        responseTime: 2,
        sessionDuration: 90,
        messageCount: 5,
        linesAdded: 10,
        linesRemoved: 4,
      });
      expect(visible).toContain("Δ");
      expect(visible).toContain("⧖");
      expect(visible).toContain("⧗");
      expect(visible).toContain("◆");
      expect(visible).toContain("+");
      expect(visible).toContain("-");
    });

    test("config override of block.budget.warningThreshold flows through to bg classification", () => {
      // [LAW:one-source-of-truth] The threshold lives in one place — the
      // variable declaration — and a user file's override flows through
      // mergeWithDefault's variables-by-name spread. Same percentage,
      // different threshold → different bg classification → different
      // ANSI bytes. If the template were still reading a literal 80
      // these two renders would be byte-identical.
      const renderBlock = (warningThreshold: number, util: number): string => {
        const parsed = parseAndValidate("<default>", SERIALIZED);
        const blockOnly = {
          ...parsed,
          layout: [["block"]],
          variables: {
            ...parsed.variables,
            "block.budget.warningThreshold": {
              kind: "literal" as const,
              value: warningThreshold,
            },
          },
        };
        const store = new VariableStore();
        const registry = new SourceRegistry(store);
        try {
          const compiled = registerDslConfig(blockOnly, registry, {
            cwd: process.cwd(),
          });
          const basePalette = new PaletteResolver(
            getThemePalette(blockOnly.globals.palette ?? "textual-dark")!,
          );
          const payload = {
            hook_event_name: "Status",
            session_id: "x",
            cwd: "/tmp",
            model: { id: "x", display_name: "x" },
            workspace: {
              current_dir: "/tmp",
              project_dir: "/tmp",
              added_dirs: [],
            },
            block: {
              nativeUtilization: util,
              // resetsAt must be > 0 for the segment's `when` to fire.
              resetsAt: Math.floor(Date.now() / 1000) + 600,
            },
          };
          return renderDsl(
            blockOnly,
            compiled,
            store,
            registry,
            payload,
            basePalette,
            { style: "powerline", colorCompatibility: "truecolor", width: Number.POSITIVE_INFINITY },
          );
        } finally {
          registry.dispose();
        }
      };

      const defaultThresh = renderBlock(80, 70); // 70 < 80 → warning
      const tightThresh = renderBlock(50, 70); // 70 ≥ 50 → error
      expect(defaultThresh).not.toEqual(tightThresh);
    });

    test("no metrics fields renders no cell", () => {
      const visible = renderMetricsText({});
      // Empty when-suppressed segment → line is empty (no glyphs, no labels).
      expect(visible).not.toContain("Δ");
      expect(visible).not.toContain("◆");
    });
  });
});
