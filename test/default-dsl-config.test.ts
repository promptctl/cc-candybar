// [LAW:single-enforcer] The bundled default is the production statusline when no user file is present, so a loader/renderer disagreement about it crashes every new user's startup path.
// [LAW:types-are-the-program] A tightened constraint fails at compile time (the `satisfies`) AND at runtime here (parseDslConfig) — two boundaries, one truth.

import {
  DEFAULT_DSL_CONFIG,
  RAW_DEFAULT_DSL_CONFIG,
} from "../src/config/default-dsl-config";
import { walkNodes } from "../src/config/dsl-types";
import { rootNode } from "../src/config/root";
import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { getThemePalette, ColorRgba, contrastRatio } from "@promptctl/rich-js";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  effectiveThemeName,
  effectiveLookName,
  lookKeyByName,
  paletteForThemeName,
} from "../src/themes";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { presetNames } from "../src/config/presets";
import { EDIT_MODE_KEY, EDIT_MODE_OPEN } from "../src/config/loader/edit-mode";
import { narrowToSegment } from "./helpers/narrow-to-segment";
import { checkPayload } from "../src/check";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../src/daemon/render-payload";

// [LAW:one-source-of-truth] The AUTHORED literal, pre-synthesis: reparsing DEFAULT_DSL_CONFIG itself would trip the reserved-namespace guard on its own synthesized entries.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

describe("DEFAULT_DSL_CONFIG", () => {
  test("loader round-trips the bundled default", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    expect(Object.keys(parsed.variables).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.segments).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.root.rows)).toEqual(["identity", "status"]);
  });

  test("every layout entry is a declared segment", () => {
    for (const node of walkNodes(rootNode(DEFAULT_DSL_CONFIG.root))) {
      if (node.kind !== "segment") continue;
      // Array form: a synthesized toggle's name contains a literal dot, which toHaveProperty's string form would read as nested access.
      expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty([node.name]);
    }
  });

  // Pins which segments graduated into the default bar and which stay declared-but-opt-in, so a layout edit is a reviewed change rather than drift. The drawer's gated body is part of the static tree whatever the toggle holds.
  // `settings.*` is absent because this walks the AUTHORED tree, and validateConfig splices the menu in later.
  test("default root renders exactly the two-row identity+status segment set plus the collapsed settingsDrawer", () => {
    const laidOut = new Set<string>();
    for (const node of walkNodes(rootNode(DEFAULT_DSL_CONFIG.root))) {
      if (node.kind === "segment") laidOut.add(node.name);
    }
    expect([...laidOut].sort()).toEqual(
      [
        "host",
        "directory",
        "gitaculous",
        "model",
        "context",
        "cacheTimer",
        "block",
        "weekly",
        "toolbar",
        "groups.settings",
        "charsetControl",
        "colorCompatControl",
        "directoryPaletteControl",
      ].sort(),
    );
    for (const optIn of [
      "git",
      "session",
      "today",
      "speed",
      "tokenSparkline",
      "burnrate",
      "gitPr",
    ]) {
      expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty([optIn]);
      expect(laidOut.has(optIn)).toBe(false);
    }
  });

  test("registerDslConfig + renderDsl produce a non-empty line", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const store = new VariableStore();
    // The default carries `kind: "state"` vars, which need a SessionState to declare, exactly as the daemon supplies.
    const registry = new SourceRegistry(
      store,
      "",
      undefined,
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(parsed, registry, {
        cwd: process.cwd(),
      });
      const basePalette = getThemePalette(
        parsed.globals.palette ?? "textual-dark",
      )!;
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
        {
          style: "powerline",
          colorCompatibility: "truecolor",
          wrap: true,
          padding: 1,
          charset: "unicode",
          width: Number.POSITIVE_INFINITY,
        },
      );
      expect(line.length).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
  });

  // [LAW:verifiable-goals] Drives the REAL click wire against the default's own applyTheme/applyLook, then re-renders with the effective names recomputed exactly as server.ts does — the daemon's click → next-render loop, not a synthetic rig.
  test("clicking a theme/look option changes theme.effective/look.effective on the next render", () => {
    const SID = "theming-8uj-1";
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
    // The daemon's cache installs the derived click gate at config load; mirror it so the click passes the same validator it would in production.
    const disposers = deriveActionValidators(parsed).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    const opts = {
      style: "powerline" as const,
      colorCompatibility: "truecolor" as const,
      wrap: true,
      padding: 1,
      charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    };
    const render = (): string => {
      const theme = effectiveThemeName(
        undefined,
        sessionState.get(SID, "theme"),
        parsed.globals.palette,
      );
      const look = effectiveLookName(
        undefined,
        sessionState.get(SID, "look"),
        parsed.globals.look,
        parsed.looks,
      );
      return renderDsl(
        parsed,
        compiled,
        store,
        registry,
        {
          hook_event_name: "Status",
          session_id: SID,
          cwd: "/tmp",
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: {
            current_dir: "/tmp",
            project_dir: "/tmp",
            added_dirs: [],
          },
          theme: { effective: theme },
          look: { effective: look },
        },
        paletteForThemeName(theme),
        opts,
        undefined,
        { look: lookKeyByName(parsed.looks, look) },
      );
    };
    try {
      // The controls sit behind two nested disclosures; open both with the same clicks a "☰ ▸" then "⚙ config ▸" tap would dispatch.
      clickUrl(
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [SID, "settings.config", "open"] },
        ]),
        testVerbContext(sessionState),
      );

      const targetTheme = listResolvablePaletteNames().find(
        (name) => name !== parsed.globals.palette,
      );
      if (targetTheme === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned only the bundled default's own " +
            `palette (${JSON.stringify(parsed.globals.palette)}) — need at least ` +
            "one other resolvable theme to exercise a theme-switching click",
        );
      }
      const before = render();
      expect(before).not.toContain(targetTheme);

      clickUrl(
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "theme", targetTheme] },
        ]),
        testVerbContext(sessionState),
      );
      const afterTheme = render();
      expect(afterTheme).toContain(targetTheme);
      expect(afterTheme).not.toBe(before);

      const targetLook = Object.keys(parsed.looks).find(
        (name) => name !== "none",
      );
      if (targetLook === undefined) {
        throw new Error(
          'the merged config\'s looks block held only the "none" identity floor ' +
            "— need at least one other declared look to exercise a look-switching click",
        );
      }
      clickUrl(
        effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "look", targetLook] }]),
        testVerbContext(sessionState),
      );
      const afterLook = render();
      expect(afterLook).toContain(targetLook);
      expect(afterLook).not.toBe(afterTheme);
    } finally {
      disposers.forEach((dispose) => dispose());
      registry.dispose();
    }
  });

  // Templates author content; the intra-cell padding is structural, so the value drives the chrome rather than spaces baked into templates.
  test("padding 0 / 1 / 2 render strictly increasing visible widths", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const payload = {
      hook_event_name: "Status",
      session_id: "pad-derivation-test",
      cwd: "/tmp",
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    };
    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
    const render = (padding: number): string => {
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
        const bp = getThemePalette("textual-dark"!)!;
        return renderDsl(parsed, compiled, store, registry, payload, bp, {
          style: "powerline",
          colorCompatibility: "truecolor",
          wrap: true,
          padding,
          charset: "unicode",
          width: Number.POSITIVE_INFINITY,
        }).replace(ANSI, "");
      } finally {
        registry.dispose();
      }
    };
    const [w0, w1, w2] = [render(0).length, render(1).length, render(2).length];
    expect(w0).toBeLessThan(w1);
    expect(w1).toBeLessThan(w2);
    expect(w1 - w0).toBe(w2 - w1);
  });

  // [LAW:one-source-of-truth] The terse A-grammar spelling must lower to a root producing byte-identical ANSI: spelling differs, render does not.
  test("A-grammar { v:[{ h:[...] }] } spelling is render-equivalent to DEFAULT_DSL_CONFIG.root", () => {
    const ALLOWED = new Set(listResolvablePaletteNames());
    const A_SRC = `{ root: { v: [
      { h: ["host","directory","gitaculous","toolbar", { kind: "group", name: "settings",
        label: "⚙ terminal", direction: "horizontal", children: [
          "charsetControl","colorCompatControl",
          "directoryPaletteControl"
        ] } ] },
      { h: ["model","context","cacheTimer","block","weekly"] }
    ] } }`;
    const rawA = parseDslConfig("<test>", A_SRC, ALLOWED);
    const mergedA = mergeWithDefault(rawA, DEFAULT_DSL_CONFIG);
    const configA = validateConfig(mergedA, "<test>", A_SRC, ALLOWED);

    const configDefault = parseAndValidate("<default>", SERIALIZED, ALLOWED);

    const payload = {
      hook_event_name: "Status",
      session_id: "equiv-pin-test",
      cwd: "/tmp",
      model: { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    };
    const opts = {
      style: "powerline" as const,
      colorCompatibility: "truecolor" as const,
      wrap: true,
      padding: 1,
      charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    };

    function render(cfg: typeof configA): string {
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const bp = getThemePalette(cfg.globals.palette ?? "textual-dark"!)!;
        return renderDsl(cfg, compiled, store, registry, payload, bp, opts);
      } finally {
        registry.dispose();
      }
    }

    expect(render(configA)).toBe(render(configDefault));
  });

  test("A-grammar terse form { v:[{ h:[...] }] } is render-equivalent to verbose kind+direction form", () => {
    const ALLOWED = new Set(listResolvablePaletteNames());
    const SEGMENTS = `{
      sa: { template: ' A ', bg: 'surface', fg: 'foreground' },
      sb: { template: ' B ', bg: 'surface', fg: 'foreground' },
      sc: { template: ' C ', bg: 'surface', fg: 'foreground' },
      sd: { template: ' D ', bg: 'surface', fg: 'foreground' },
    }`;
    const srcA = `{ segments: ${SEGMENTS}, root: { v: [{ h: ['sa','sb'] }, { h: ['sc','sd'] }] } }`;
    const srcVerbose = `{ segments: ${SEGMENTS}, root: {
      kind: 'container', direction: 'vertical',
      children: [
        { kind: 'container', direction: 'horizontal',
          children: [{ kind: 'segment', name: 'sa' }, { kind: 'segment', name: 'sb' }] },
        { kind: 'container', direction: 'horizontal',
          children: [{ kind: 'segment', name: 'sc' }, { kind: 'segment', name: 'sd' }] },
      ],
    } }`;
    const configA = parseAndValidate("<test>", srcA, ALLOWED);
    const configVerbose = parseAndValidate("<test>", srcVerbose, ALLOWED);

    const payload = {
      hook_event_name: "Status",
      session_id: "x",
      cwd: "/tmp",
      model: { id: "x", display_name: "x" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    };
    const opts = {
      style: "powerline" as const,
      colorCompatibility: "truecolor" as const,
      wrap: true,
      padding: 1,
      charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    };

    function render(cfg: typeof configA): string {
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const bp = getThemePalette("textual-dark"!)!;
        return renderDsl(cfg, compiled, store, registry, payload, bp, opts);
      } finally {
        registry.dispose();
      }
    }

    expect(render(configA)).toBe(render(configVerbose));
  });

  // The daemon transposes the remote into an https URL before the template, so `↗ repo` is a plain `{{ link }}` the terminal owns — gated on the VALUE, so no browsable remote means no glyph.
  describe("toolbar repo link", () => {
    function renderToolbar(git: Record<string, unknown>): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      const toolbarOnly = narrowToSegment(parsed, "toolbar");
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(toolbarOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = getThemePalette(
          toolbarOnly.globals.palette ?? "textual-dark",
        )!;
        return renderDsl(
          toolbarOnly,
          compiled,
          store,
          registry,
          {
            hook_event_name: "Status",
            session_id: "sess-1",
            transcript_path: "/tmp/t.jsonl",
            cwd: "/tmp",
            model: { id: "x", display_name: "x" },
            workspace: {
              current_dir: "/tmp",
              project_dir: "/tmp",
              added_dirs: [],
            },
            git,
          },
          basePalette,
          {
            style: "powerline",
            colorCompatibility: "truecolor",
            wrap: true,
            padding: 1,
            charset: "unicode",
            width: Number.POSITIVE_INFINITY,
          },
        );
      } finally {
        registry.dispose();
      }
    }

    test("a browsable repo gets an OSC-8 link carrying its web URL", () => {
      const line = renderToolbar({
        branch: "main",
        repoUrl: "https://github.com/promptctl/cc-candybar",
      });
      expect(line).toContain("↗ repo");
      expect(line).toContain(
        "\x1b]8;;https://github.com/promptctl/cc-candybar\x1b\\",
      );
    });

    test("a repo with no browsable remote renders the tray without the glyph", () => {
      const line = renderToolbar({ branch: "main" });
      expect(line).toContain("↗ proj");
      expect(line).toContain("↗ log");
      expect(line).not.toContain("↗ repo");
    });
  });

  describe("DIR_TEMPLATE", () => {
    function renderDirectoryText(opts: {
      home: string;
      project_dir: string;
      current_dir: string;
    }): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      const dirOnly = narrowToSegment(parsed, "directory");
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(dirOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = getThemePalette(
          dirOnly.globals.palette ?? "textual-dark",
        )!;
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
          {
            style: "powerline",
            colorCompatibility: "truecolor",
            wrap: true,
            padding: 1,
            charset: "unicode",
            width: Number.POSITIVE_INFINITY,
          },
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

    test("project root (current_dir === project_dir) renders as project basename", () => {
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/Users/alice/code/myproject",
        current_dir: "/Users/alice/code/myproject",
      });
      expect(visible).toContain("myproject");
      expect(visible).not.toContain("/Users/alice/code");
    });

    test("subdir of project renders as project-relative path (fish-abbreviated)", () => {
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/Users/alice/code/myproject",
        current_dir: "/Users/alice/code/myproject/src/foo",
      });
      expect(visible).toContain("s/foo");
      expect(visible).not.toContain("/Users/alice");
    });

    test("hasPrefix boundary safety: /home/al is NOT a prefix of /home/alice", () => {
      // A naive hasPrefix would match `/home/alice/work` against `/home/al` and render relative to it; the path must fall through to absolute instead.
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/home/al",
        current_dir: "/home/alice/work",
      });
      expect(visible).toContain("/h/a/work");
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

  // Every git fact renders in its own semantic palette colour, so counting DISTINCT truecolor foregrounds is the acceptance check: one uniform fg collapses the count to 1.
  describe("git segment per-fact coloring", () => {
    const GIT_PAYLOAD = {
      hook_event_name: "Status",
      session_id: "x",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      model: { id: "x", display_name: "x" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
      git: {
        branch: "main",
        repoName: "repo",
        sha: "abc1234",
        staged: 2,
        unstaged: 3,
        untracked: 4,
        conflicts: 1,
        ahead: 1,
        behind: 1,
        upstream: "origin/main",
        operation: "",
        stash: 2,
        status: "conflicts",
        timeSinceCommit: 0,
      },
    };

    // [LAW:one-source-of-truth] The ONE SGR parser every helper below builds on. It walks params
    // sequentially and SKIPS a `48;2;r;g;b` run's components, so a bg component equal to 38 is never misread as the fg introducer.
    interface SgrRun {
      offset: number;
      fg?: string;
      bg?: string;
    }
    function sgrRuns(line: string): SgrRun[] {
      const runs: SgrRun[] = [];
      for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
        const params = (m[1] ?? "").split(";");
        let fg: string | undefined;
        let bg: string | undefined;
        for (let i = 0; i < params.length; i++) {
          const triplet = `${params[i + 2]};${params[i + 3]};${params[i + 4]}`;
          if (params[i] === "38" && params[i + 1] === "2") {
            fg = triplet;
            i += 4;
          } else if (params[i] === "48" && params[i + 1] === "2") {
            bg = triplet;
            i += 4;
          }
        }
        runs.push({ offset: m.index ?? 0, fg, bg });
      }
      return runs;
    }

    function sgrToRgba(triplet: string): ColorRgba {
      const [r, g, b] = triplet.split(";").map(Number);
      return new ColorRgba(r!, g!, b!);
    }

    function distinctForegrounds(line: string): Set<string> {
      const fgs = new Set<string>();
      for (const r of sgrRuns(line)) if (r.fg !== undefined) fgs.add(r.fg);
      return fgs;
    }

    function renderSegment(segment: string, theme?: string): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      const cfg = narrowToSegment(parsed, segment);
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const basePalette = paletteForThemeName(
          theme ?? cfg.globals.palette ?? "textual-dark",
        );
        return renderDsl(
          cfg,
          compiled,
          store,
          registry,
          GIT_PAYLOAD,
          basePalette,
          {
            style: "powerline",
            colorCompatibility: "truecolor",
            wrap: true,
            padding: 1,
            charset: "unicode",
            width: Number.POSITIVE_INFINITY,
          },
        );
      } finally {
        registry.dispose();
      }
    }

    test("git segment renders more than one distinct color across staged/unstaged/untracked/conflicts/ahead/behind", () => {
      const distinct = distinctForegrounds(renderSegment("git"));
      expect(distinct.size).toBeGreaterThan(1);
    });

    test("gitaculous segment renders more than one distinct color across the same facts", () => {
      const distinct = distinctForegrounds(renderSegment("gitaculous"));
      expect(distinct.size).toBeGreaterThan(1);
    });

    // GIT_WORKTREE declares its `$first` separator inside a gate, not at top level; `=` reassignment still walks up to the declaring frame, and this asserts that observably.
    test("worktree counts render single-space-separated, never concatenated", () => {
      const ANSI =
        /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\|[\u{E0B0}-\u{E0BC}]/gu;
      const visible = renderSegment("git").replace(ANSI, "");
      expect(visible).toContain("+2 ~3 ?4 !1");
      expect(visible).not.toMatch(/[+~?!]\d[+~?!]/);
    });

    // Every coloured token is wrapped by exactly one palette function, which opens its SGR run directly before the token, so the last run starting before the match IS that token's colour.
    // [LAW:one-source-of-truth] fg and bg are one lookup over one parser; the slot is a parameter, not a second copy of the walk.
    function colorBeforeText(
      line: string,
      text: string,
      slot: "fg" | "bg",
    ): string | undefined {
      const idx = line.indexOf(text);
      if (idx === -1) return undefined;
      return sgrRuns(line)
        .filter((r) => r.offset < idx && r[slot] !== undefined)
        .at(-1)?.[slot];
    }
    const fgBeforeText = (line: string, text: string) =>
      colorBeforeText(line, text, "fg");
    const bgBeforeText = (line: string, text: string) =>
      colorBeforeText(line, text, "bg");

    test("gitaculous colors unstaged and untracked distinctly, not merged into one indicator", () => {
      const line = renderSegment("gitaculous");
      const unstagedFg = fgBeforeText(line, "U");
      const untrackedFg = fgBeforeText(line, "?");
      expect(unstagedFg).toBeDefined();
      expect(untrackedFg).toBeDefined();
      expect(unstagedFg).not.toBe(untrackedFg);
    });

    test("gitaculous colors the branch the same as git does", () => {
      const gitFg = fgBeforeText(renderSegment("git"), "main");
      const gitaculousFg = fgBeforeText(renderSegment("gitaculous"), "main");
      expect(gitFg).toBeDefined();
      expect(gitFg).toBe(gitaculousFg);
    });

    test("gitaculous colors the stash count instead of leaving it plain", () => {
      const line = renderSegment("gitaculous");
      const stashFg = fgBeforeText(line, "(2 stashed)");
      const plainFg = fgBeforeText(line, "abc1234"); // sha: structural, never painted
      expect(stashFg).toBeDefined();
      expect(stashFg).not.toBe(plainFg);
    });

    // The segments' computed `fg:` makes quiet the DEFAULT, so only operative facts name a colour; these pin both halves of that as observable output.
    describe("structural text recedes behind the operative facts", () => {
      const STRUCTURAL = ["abc1234", "origin/main"];

      test.each(["git", "gitaculous"])(
        "%s: every painted fact differs from the structural color",
        (segment) => {
          const line = renderSegment(segment);
          const quiet = fgBeforeText(line, STRUCTURAL[0]!);
          expect(quiet).toBeDefined();
          for (const text of STRUCTURAL.slice(1)) {
            expect(fgBeforeText(line, text)).toBe(quiet);
          }
          const distinct = distinctForegrounds(line);
          expect(distinct.size).toBeGreaterThan(2);
          expect(distinct.has(quiet!)).toBe(true);
        },
      );

      // [LAW:verifiable-goals] The quiet colour is a computed blend, so its legibility is a property of each theme's foreground/surface distance; this asserts GIT_QUIET_FG's `readableOn` floor holds on every one.
      test.each(listResolvablePaletteNames())(
        "quiet structural text clears WCAG large-text contrast under theme %s",
        (theme) => {
          const line = renderSegment("gitaculous", theme);
          const quiet = fgBeforeText(line, "abc1234");
          expect(quiet).toBeDefined();
          const bg = bgBeforeText(line, "abc1234");
          expect(bg).toBeDefined();
          // 2.99 not 3: ensureContrast bisects to the threshold, and 8-bit quantization can land a hair under it.
          expect(
            contrastRatio(sgrToRgba(quiet!), sgrToRgba(bg!)),
          ).toBeGreaterThan(2.99);
        },
      );
    });
  });

  // [LAW:dataflow-not-control-flow] An absent metric resolves through the var-system fallback to 0, so its part hides with no per-field show-flag plumbing.
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
      const metricsOnly = narrowToSegment(parsed, "metrics");
      const store = new VariableStore();
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(metricsOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = getThemePalette(
          metricsOnly.globals.palette ?? "textual-dark",
        )!;
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
          metrics,
        };
        const line = renderDsl(
          metricsOnly,
          compiled,
          store,
          registry,
          payload,
          basePalette,
          {
            style: "powerline",
            colorCompatibility: "truecolor",
            wrap: true,
            padding: 1,
            charset: "unicode",
            width: Number.POSITIVE_INFINITY,
          },
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
      // [LAW:one-source-of-truth] The threshold lives in the variable declaration alone: were the template reading a literal 80, these two renders would be byte-identical.
      const renderBlock = (warningThreshold: number, util: number): string => {
        const parsed = parseAndValidate("<default>", SERIALIZED);
        const blockOnly = {
          ...narrowToSegment(parsed, "block"),
          variables: {
            ...parsed.variables,
            "block.budget.warningThreshold": {
              kind: "literal" as const,
              value: warningThreshold,
            },
          },
        };
        const store = new VariableStore();
        const registry = new SourceRegistry(
          store,
          "",
          undefined,
          new SessionState(),
        );
        try {
          const compiled = registerDslConfig(blockOnly, registry, {
            cwd: process.cwd(),
          });
          const basePalette = getThemePalette(
            blockOnly.globals.palette ?? "textual-dark",
          )!;
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
            {
              style: "powerline",
              colorCompatibility: "truecolor",
              wrap: true,
              padding: 1,
              charset: "unicode",
              width: Number.POSITIVE_INFINITY,
            },
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
      expect(visible).not.toContain("Δ");
      expect(visible).not.toContain("◆");
    });
  });

  // The session segment is the second instance of the shared budgetStatus helper.
  describe("session budget warning", () => {
    // Overrides merge through the real mergeWithDefault path — the same cascade a user's config file flows through.
    const renderSession = (
      payload: Record<string, unknown>,
      userSource?: string,
    ): string => {
      const merged = mergeWithDefault(
        parseDslConfig("<user>", userSource ?? "{}"),
        DEFAULT_DSL_CONFIG,
      );
      // [FRAMING:representation] `source` is what validation errors quote from, so it must be the config being validated, not the default's serialization.
      const config = validateConfig(
        merged,
        "<merged>",
        JSON.stringify(merged, null, 2),
      );
      const sessionOnly = narrowToSegment(config, "session");
      const store = new VariableStore();
      // Without a SessionState the merged default's `state` vars fail to declare into loadWarnings, leaving the fixture partially registered.
      const registry = new SourceRegistry(
        store,
        "",
        undefined,
        new SessionState(),
      );
      try {
        const compiled = registerDslConfig(sessionOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = getThemePalette(
          sessionOnly.globals.palette ?? "textual-dark",
        )!;
        return renderDsl(
          sessionOnly,
          compiled,
          store,
          registry,
          {
            hook_event_name: "Status",
            session_id: "x",
            cwd: "/tmp",
            model: { id: "x", display_name: "x" },
            workspace: {
              current_dir: "/tmp",
              project_dir: "/tmp",
              added_dirs: [],
            },
            ...payload,
          },
          basePalette,
          {
            style: "powerline",
            colorCompatibility: "truecolor",
            wrap: true,
            padding: 1,
            charset: "unicode",
            width: Number.POSITIVE_INFINITY,
          },
        );
      } finally {
        registry.dispose();
      }
    };

    const PAYLOAD = { session: { cost: 8.5, tokens: 1000 } };

    test("absent session-budget config renders byte-identically to the pre-budget template", () => {
      // [LAW:dataflow-not-control-flow] The default amount 0 is budgetStatus's non-displayable value, so the suffix contributes zero bytes through the same unconditional template.
      const preBudget = renderSession(
        PAYLOAD,
        JSON.stringify({
          segments: {
            session: {
              template:
                '§ {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }})',
              fg: "foreground",
            },
          },
        }),
      );
      expect(renderSession(PAYLOAD)).toEqual(preBudget);
    });

    test("user override of session.budget.amount surfaces the budgetStatus suffix", () => {
      // [LAW:one-source-of-truth] One variable declaration holds the knob: cost 8.5 / amount 10 = 85% ≥ warn 80 → " !85%".
      const line = renderSession(
        PAYLOAD,
        JSON.stringify({
          variables: {
            "session.budget.amount": { kind: "literal", value: 10 },
          },
        }),
      );
      expect(line).toContain("!85%");
    });

    test("user override of session.budget.warningThreshold reclassifies the suffix", () => {
      // cost 6 / amount 10 = 60% reads " +60%" under the default warn 80 and " !60%" under warn 50 — same cost, different bytes.
      const spend = { session: { cost: 6, tokens: 1000 } };
      const defaultWarn = renderSession(
        spend,
        JSON.stringify({
          variables: {
            "session.budget.amount": { kind: "literal", value: 10 },
          },
        }),
      );
      const tightWarn = renderSession(
        spend,
        JSON.stringify({
          variables: {
            "session.budget.amount": { kind: "literal", value: 10 },
            "session.budget.warningThreshold": { kind: "literal", value: 50 },
          },
        }),
      );
      expect(defaultWarn).toContain("+60%");
      expect(tightWarn).toContain("!60%");
    });
  });
});

// [LAW:verifiable-goals] Every bundled preset must render without error cells at 80/120/200 columns, through the exact pipeline the daemon and `check` drive, against the SAME rich fixture payload — a minimal one would let a typo in a gated branch slip through.
// [LAW:single-enforcer] Resolved through resolveEffectiveGlobals, the one function server.ts and check.ts both call, so this cannot diverge from a real render.
describe("bundled preset library renders clean at every width — brandon-presets-0yk.3", () => {
  const WIDTHS = [80, 120, 200];
  // [LAW:single-enforcer] The `ValidatedConfig` brand every production caller passes through; DEFAULT_DSL_CONFIG is validated but not re-branded.
  const VALIDATED = validateConfig(DEFAULT_DSL_CONFIG);

  const freshSession = (key: string, preset: string): string | null =>
    key === "preset" ? preset : null;
  const editingSession = (key: string, preset: string): string | null =>
    key === EDIT_MODE_KEY ? EDIT_MODE_OPEN : freshSession(key, preset);

  function renderPreset(
    name: string,
    width: number,
    // A transform over checkPayload's fixture, so a test needing gated content need not mutate the shared fixture other suites assert literal values against.
    withPayload: (base: Record<string, unknown>) => Record<string, unknown> = (
      base,
    ) => base,
    sessionPick: (key: string, preset: string) => string | null = freshSession,
  ): { rendered: string; segmentErrors: string[] } {
    // [LAW:one-source-of-truth] THE daemon's resolution; restating the chain here as a struct literal is what would let this harness drift.
    const effective: EffectiveGlobals = resolveEffectiveGlobals(
      DEFAULT_DSL_CONFIG,
      (key) => sessionPick(key, name),
      () => false,
    );
    const store = new VariableStore();
    // [LAW:one-source-of-truth] The registry's session reader IS sessionPick, so the `state` vars and the globals above answer from one session.
    const registry = new SourceRegistry(store, "", undefined, {
      get: (_sessionId, key) => sessionPick(key, name),
    });
    try {
      const compiled = registerDslConfig(VALIDATED, registry, {
        cwd: "/tmp",
      });
      const segmentErrors: string[] = [];
      const rendered = renderDsl(
        VALIDATED,
        compiled,
        store,
        registry,
        withPayload(checkPayload(effective)),
        paletteForThemeName(effective.theme),
        {
          style: effective.style,
          separator: effective.separator,
          width,
          colorCompatibility: effective.colorCompatibility,
          wrap: effective.autoWrap,
          padding: effective.padding,
          charset: effective.charset,
        },
        {
          onSegmentError: (segName, message) =>
            segmentErrors.push(`segment "${segName}": ${message}`),
        },
        {
          look: lookKeyByName(DEFAULT_DSL_CONFIG.looks, effective.look),
          preset: effective.preset,
        },
      );
      return { rendered, segmentErrors };
    } finally {
      registry.dispose();
    }
  }

  // A preset this suite never iterates would be a preset never render-tested.
  test("the bundled library declares more than just the floor", () => {
    expect(presetNames(DEFAULT_DSL_CONFIG.presets).length).toBeGreaterThan(1);
  });

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    'preset "%s" renders with zero error cells at 80/120/200 columns',
    (name) => {
      for (const width of WIDTHS) {
        const { rendered, segmentErrors } = renderPreset(name, width);
        expect(segmentErrors).toEqual([]);
        expect(rendered.length).toBeGreaterThan(0);
      }
    },
  );

  // [LAW:verifiable-goals] Edit mode restyles the whole bar, and the picker reserves its pagination seam from that style — a staged style that missed the reserve would give wrong page widths exactly where menus are most used.
  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    'preset "%s" renders clean at 80/120/200 columns with edit mode open',
    (name) => {
      for (const width of WIDTHS) {
        const { rendered, segmentErrors } = renderPreset(
          name,
          width,
          undefined,
          editingSession,
        );
        expect(segmentErrors).toEqual([]);
        expect(rendered.length).toBeGreaterThan(0);
      }
    },
  );

  test("edit mode stages its separator over every preset's own style", () => {
    for (const name of presetNames(DEFAULT_DSL_CONFIG.presets)) {
      const editing = renderPreset(name, 120, undefined, editingSession);
      expect(editing.segmentErrors).toEqual([]);
      expect(editing.rendered).toContain(
        DEFAULT_DSL_CONFIG.editGlobals.default_separator,
      );
    }
  });

  // [LAW:carrying-cost] compact exists to fit where the default doesn't, so pin that it renders NARROWER, not merely that it renders.
  test("compact renders a shorter visible line than the default floor", () => {
    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
    const visible = (s: string): string => s.replace(ANSI, "");
    const compactLine = visible(renderPreset("compact", 200).rendered);
    const defaultLine = visible(renderPreset("default", 200).rendered);
    expect(compactLine.length).toBeLessThan(defaultLine.length);
  });

  // [LAW:carrying-cost] verbose exists to surface the opt-in segments, so pin that each one's content appears; gitPr and tokenSparkline gate on data the shared fixture doesn't carry, supplied here via `withPayload`.
  test("verbose surfaces every opt-in segment's own content", () => {
    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
    const line = renderPreset("verbose", 200, (base) => ({
      ...base,
      git: {
        ...(base.git as object),
        prUrl: "https://example.com/pr/181",
        prNumber: 181,
      },
      speed: { history: "10,25,15,30,20" },
    })).rendered.replace(ANSI, "");
    expect(line).toContain("⇆ #181"); // gitPr
    expect(line).toContain("to 5h"); // burnrate
    expect(line).toContain("⇅ out"); // speed
    expect(line).toMatch(/[▁▂▃▄▅▆▇█]/); // tokenSparkline's own block glyphs
  });

  // [LAW:dataflow-not-control-flow] The reset banner is spliced unconditionally and is edit chrome, so it shows only with edit mode open AND the preset customized — pinned here at both terms true and each term alone.
  test("customized preset shows the reset banner in edit mode; not outside it, nor when clean", () => {
    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
    const withCustomized = (base: Record<string, unknown>) => ({
      ...base,
      preset: { effective: "default", customized: true },
    });
    const editing = renderPreset(
      "default",
      200,
      withCustomized,
      editingSession,
    ).rendered.replace(ANSI, "");
    expect(editing).toContain("↺ default customized");

    // A hand-authored root is "customized" from its first render, which outside edit mode must not put a one-click reset on the bar.
    const viewing = renderPreset(
      "default",
      200,
      withCustomized,
    ).rendered.replace(ANSI, "");
    expect(viewing).not.toContain("↺");

    const clean = renderPreset(
      "default",
      200,
      undefined,
      editingSession,
    ).rendered.replace(ANSI, "");
    expect(clean).not.toContain("↺");
  });
});
