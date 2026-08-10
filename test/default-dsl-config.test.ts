// [LAW:single-enforcer] The bundled default DslConfig is the production
// statusline when no user file is present. The loader and the renderer must
// agree it is valid, otherwise the daemon's startup path crashes for every
// new user. This test pins that invariant.
//
// [LAW:types-are-the-program] If a future change to dsl-types tightens a
// constraint and DEFAULT_DSL_CONFIG no longer satisfies it, this test fails
// at compile time (via the `satisfies` on the constant) AND at runtime here
// (via parseDslConfig). Two boundaries, one truth.

import {
  DEFAULT_DSL_CONFIG,
  RAW_DEFAULT_DSL_CONFIG,
} from "../src/config/default-dsl-config";
import { walkNodes } from "../src/config/dsl-types";
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
import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  effectiveThemeName,
  effectiveLookName,
  lookKeyByName,
  resolverForThemeName,
} from "../src/themes";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";

// [LAW:one-source-of-truth] Reparse the AUTHORED literal (pre-synthesis) —
// mirrors what a user gets by copy-pasting the bundled default into their own
// file, driven through the real per-file parse (which freshly synthesizes
// `menus.*`). Reparsing DEFAULT_DSL_CONFIG itself (already-synthesized) would
// trip the reserved-namespace guard on its own synthesized entries.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

// A canonical one-leaf vertical root — narrows a spread config to a single
// segment so the rendered line is exactly that segment's text.
const oneSegmentRoot = (segment: string) =>
  ({
    kind: "container" as const,
    direction: "vertical" as const,
    children: [
      {
        kind: "container" as const,
        direction: "horizontal" as const,
        children: [{ kind: "segment" as const, name: segment }],
      },
    ],
  });

describe("DEFAULT_DSL_CONFIG", () => {
  test("loader round-trips the bundled default", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    expect(Object.keys(parsed.variables).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.segments).length).toBeGreaterThan(0);
    expect(parsed.root.kind).toBe("container");
  });

  test("every layout entry is a declared segment", () => {
    for (const node of walkNodes(DEFAULT_DSL_CONFIG.root)) {
      if (node.kind !== "segment") continue;
      // Array form: a synthesized group toggle's name (e.g. "groups.settings")
      // contains a literal dot, which toHaveProperty's default dotted-path
      // string form would otherwise misread as nested access.
      expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty([node.name]);
    }
  });

  // The bundled default is the maintainer's two always-visible rows — an
  // identity+actions row (directory, the verbose gitaculous line, the
  // quick-action tray: copy session id, open project / transcript in the
  // editor, and the settingsDrawer toggle) over a status row (model, context,
  // prompt-cache warmth, the 5h/7d rate-limit quotas) — plus the collapsed
  // settingsDrawer group (candybar-config-engine-71o.4), whose synthesized
  // toggle segment and gated body (theme/style/look/charset/colorCompatibility/
  // autoWrap/padding/directory-palette) are part of the static layout tree
  // regardless of the toggle's current open/closed value (walkNodes visits
  // unconditionally; only the render-time `when` hides the body while
  // closed). This pins the chosen segment set — which segments graduated
  // into the default bar and which stay declared-but-opt-in — so a future
  // layout edit is a deliberate, reviewed change rather than an accidental
  // drift. block/weekly are IN (their when-gates hide them when no
  // rate-limit window is active); toolbar is IN (the default's
  // interactivity); the settingsDrawer's eight controls are IN
  // (theme/style/look/charset/colorCompatibility/autoWrap/padding
  // discoverability, plus directoryPaletteControl — candybar-config-engine-
  // 71o.6's segment-scoped persist demo); the cost segments (session/today)
  // and the speed/sparkline/burnrate telemetry stay opt-in.
  test("default root renders exactly the two-row identity+status segment set plus the collapsed settingsDrawer", () => {
    const laidOut = new Set<string>();
    for (const node of walkNodes(DEFAULT_DSL_CONFIG.root)) {
      if (node.kind === "segment") laidOut.add(node.name);
    }
    expect([...laidOut].sort()).toEqual(
      [
        "directory",
        "gitaculous",
        "model",
        "context",
        "cacheTimer",
        "block",
        "weekly",
        "toolbar",
        "groups.settings",
        "themeControl",
        "lookControl",
        "styleControl",
        "charsetControl",
        "colorCompatControl",
        "wrapToggleControl",
        "paddingControl",
        "directoryPaletteControl",
      ].sort(),
    );
    // Declared-but-opt-in: present in `segments` for reference/user opt-in, but
    // deliberately absent from the default `root`.
    for (const optIn of ["git", "session", "today", "speed", "tokenSparkline", "burnrate", "gitPr"]) {
      expect(DEFAULT_DSL_CONFIG.segments).toHaveProperty([optIn]);
      expect(laidOut.has(optIn)).toBe(false);
    }
  });

  test("registerDslConfig + renderDsl produce a non-empty line", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const store = new VariableStore();
    // The default now carries `kind: "state"` vars (the style picker); a
    // SessionState is required to declare them, exactly as the daemon supplies.
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
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
        { style: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, charset: "unicode", width: Number.POSITIVE_INFINITY },
      );
      // Hidden segments (no git repo, no usage data) drop out; the
      // directory and model segments remain, so the line is non-empty.
      expect(line.length).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
  });

  // [LAW:verifiable-goals] brandon-theming-8uj.1 done-gate: the bundled default
  // ships a clickable theme/look picker, not just documentation describing how
  // to hand-author one. Drives the REAL click wire against DEFAULT_DSL_CONFIG's
  // own applyTheme/applyLook actions (deriveActionValidators →
  // registerStateValidator → clickUrl → VERBS, the same chain the daemon runs),
  // then re-renders with theme.effective/look.effective recomputed exactly as
  // server.ts does (effectiveThemeName/effectiveLookName over SessionState) —
  // mirroring the daemon's real click → next-render loop, not a synthetic rig.
  test("clicking a theme/look option changes theme.effective/look.effective on the next render", () => {
    const SID = "theming-8uj-1";
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
    // The daemon's cache installs the derived click gate at config load
    // (cache/render.ts); mirror it so the click below passes through the same
    // validator applyTheme/applyLook would in production.
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
        sessionState.get(SID, "theme"),
        parsed.globals.palette,
      );
      const look = effectiveLookName(
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
          workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
          theme: { effective: theme },
          look: { effective: look },
        },
        resolverForThemeName(theme),
        opts,
        undefined,
        lookKeyByName(parsed.looks, look),
      );
    };
    try {
      // themeControl/lookControl live inside the settingsDrawer group
      // (candybar-config-engine-71o.4), collapsed by default — open it first
      // (the same click a "⚙ settings ▸" tap would dispatch) so the pickers
      // this test exercises actually render.
      clickUrl(
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "groups.settings", "settings"] },
        ]),
        { sessionState, dlog: () => {} },
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
        effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "theme", targetTheme] }]),
        { sessionState, dlog: () => {} },
      );
      const afterTheme = render();
      expect(afterTheme).toContain(targetTheme);
      expect(afterTheme).not.toBe(before);

      const targetLook = Object.keys(parsed.looks).find(
        (name) => name !== "none",
      );
      if (targetLook === undefined) {
        throw new Error(
          "the merged config's looks block held only the \"none\" identity floor " +
            "— need at least one other declared look to exercise a look-switching click",
        );
      }
      clickUrl(
        effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "look", targetLook] }]),
        { sessionState, dlog: () => {} },
      );
      const afterLook = render();
      expect(afterLook).toContain(targetLook);
      expect(afterLook).not.toBe(afterTheme);
    } finally {
      disposers.forEach((dispose) => dispose());
      registry.dispose();
    }
  });

  // brandon-display-dam.2: templates author content; the intra-cell padding is
  // structural (globals.padding → BuildLineOptions.padding). With the bundled
  // default, padding 0 renders visibly tighter than 1, and 2 wider — the value
  // genuinely drives the chrome instead of spaces baked into templates.
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
      const registry = new SourceRegistry(store, "", undefined, new SessionState());
      try {
        const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
        const bp = new PaletteResolver(getThemePalette("textual-dark")!);
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
    // One space per visible segment per side: the deltas are equal and
    // positive — padding scales linearly, not incidentally.
    expect(w1 - w0).toBe(w2 - w1);
  });

  // [LAW:one-source-of-truth] Equivalence pin: the terse A-grammar spelling of the
  // default's two informational rows (identity row, status row) plus the
  // settingsDrawer group sugar must lower to a root producing byte-identical
  // ANSI to DEFAULT_DSL_CONFIG.root (the canonical container tree, hand-lowered
  // via `settingsDrawer`'s `kind: "group"` sugar — see its own comment for why
  // it can't be authored in canonical form). Spelling differs; render does not.
  test("A-grammar { v:[{ h:[...] }] } spelling is render-equivalent to DEFAULT_DSL_CONFIG.root", () => {
    const ALLOWED = new Set(listResolvablePaletteNames());
    const A_SRC = `{ root: { v: [
      { h: ["directory","gitaculous","toolbar", { kind: "group", name: "settings",
        label: "⚙ settings", direction: "horizontal", children: [
          "themeControl","lookControl","styleControl","charsetControl",
          "colorCompatControl","wrapToggleControl","paddingControl",
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
      colorCompatibility: "truecolor" as const, wrap: true, padding: 1, charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    };

    function render(cfg: typeof configA): string {
      const store = new VariableStore();
      const registry = new SourceRegistry(store, "", undefined, new SessionState());
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const bp = new PaletteResolver(getThemePalette(cfg.globals.palette ?? "textual-dark")!);
        return renderDsl(cfg, compiled, store, registry, payload, bp, opts);
      } finally {
        registry.dispose();
      }
    }

    expect(render(configA)).toBe(render(configDefault));
  });

  // [LAW:one-source-of-truth] Deep-nesting equivalence: { v: [{ h: [a, b] }, { h: [c, d] }] }
  // and { kind: 'container', direction: 'vertical', children: [...] } must render identically —
  // both are spellings of the same canonical tree.
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

    const payload = { hook_event_name: "Status", session_id: "x", cwd: "/tmp",
      model: { id: "x", display_name: "x" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] } };
    const opts = { style: "powerline" as const, colorCompatibility: "truecolor" as const, wrap: true, padding: 1, charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY };

    function render(cfg: typeof configA): string {
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const bp = new PaletteResolver(getThemePalette("textual-dark")!);
        return renderDsl(cfg, compiled, store, registry, payload, bp, opts);
      } finally {
        registry.dispose();
      }
    }

    expect(render(configA)).toBe(render(configVerbose));
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
      const dirOnly = { ...parsed, root: oneSegmentRoot("directory") };
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
          { style: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, charset: "unicode", width: Number.POSITIVE_INFINITY },
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

    test("subdir of project renders as project-relative path (fish-abbreviated)", () => {
      // brandon-directory-781: the project-relative collapse still holds; the
      // survivor is then fish-abbreviated (`src/foo` → `s/foo`), the leaf full.
      const visible = renderDirectoryText({
        home: "",
        project_dir: "/Users/alice/code/myproject",
        current_dir: "/Users/alice/code/myproject/src/foo",
      });
      expect(visible).toContain("s/foo");
      expect(visible).not.toContain("/Users/alice");
    });

    test("hasPrefix boundary safety: /home/al is NOT a prefix of /home/alice", () => {
      // If hasPrefix were used naively, `/home/alice/work` would falsely
      // match `/home/al` and try to render relative to it. The path falls
      // through to absolute, then fish-abbreviates to `/h/a/work` (leaf full) —
      // a relative match would have produced a different, non-slash-led string.
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

  // brandon-segments-3eo.1: the `git` and `gitaculous` segment templates each
  // render every git fact (branch, staged/unstaged/untracked/conflicts,
  // ahead/behind) in its own semantic palette color instead of one uniform
  // segment fg, p10k-style. Feeding a payload where every fact is nonzero and
  // counting DISTINCT truecolor foregrounds in the rendered line is the
  // acceptance check — a regression back to one uniform fg would collapse
  // the count to 1.
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

    // Distinct truecolor foregrounds (`38;2;r;g;b`) across the rendered
    // line — one per SGR-introduced run, deduped. A basic-code fg would also
    // count but every semantic palette function here resolves to truecolor.
    // Walks params sequentially (not `indexOf("38")`) and SKIPS a recognized
    // `48;2;r;g;b` background run's components before looking for `38` —
    // otherwise a bg color whose component happens to equal 38 could be
    // misread as the fg introducer, or (mirror bug) mask a real one that
    // follows it. Same class of collision test/segment-interior-color.test.ts's
    // skipTruecolorRun fixes.
    function distinctForegrounds(line: string): Set<string> {
      const fgs = new Set<string>();
      for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
        const params = (m[1] ?? "").split(";");
        for (let i = 0; i < params.length; i++) {
          if (params[i] === "38" && params[i + 1] === "2") {
            fgs.add(`${params[i + 2]};${params[i + 3]};${params[i + 4]}`);
            i += 4;
          } else if (params[i] === "48" && params[i + 1] === "2") {
            i += 4;
          }
        }
      }
      return fgs;
    }

    function renderSegment(segment: string): string {
      const parsed = parseAndValidate("<default>", SERIALIZED);
      const cfg = { ...parsed, root: oneSegmentRoot(segment) };
      const store = new VariableStore();
      const registry = new SourceRegistry(store);
      try {
        const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
        const basePalette = new PaletteResolver(
          getThemePalette(cfg.globals.palette ?? "textual-dark")!,
        );
        return renderDsl(cfg, compiled, store, registry, GIT_PAYLOAD, basePalette, {
          style: "powerline",
          colorCompatibility: "truecolor",
          wrap: true,
          padding: 1,
          charset: "unicode",
          width: Number.POSITIVE_INFINITY,
        });
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

    // GIT_WORKTREE's `$first` separator var is declared inside the outer
    // `{{ if or ... }}` gate, not at the template's top level like
    // DIR_TEMPLATE's `$dir` — a real structural difference a reviewer flagged.
    // Reassignment via `=` (not `:=`) still walks up to the declaring frame
    // regardless of nesting depth, so this asserts the actual observable
    // behavior (single-space-separated counts, never concatenated) rather
    // than trusting the analogy in the comment above GIT_WORKTREE.
    test("worktree counts render single-space-separated, never concatenated", () => {
      // eslint-disable-next-line no-control-regex
      const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\|[\u{E0B0}-\u{E0BC}]/gu;
      const visible = renderSegment("git").replace(ANSI, "");
      expect(visible).toContain("+2 ~3 ?4 !1");
      expect(visible).not.toMatch(/[+~?!]\d[+~?!]/);
    });

    // brandon-segments-3eo.1.1: `git` and `gitaculous` independently typed
    // the same fact's color and drifted (branch accent-vs-primary, stash
    // colored-vs-not) — caught by live testing, fixed by routing both
    // templates through the shared GIT_COLOR table. These assert the two
    // segments now agree, not just that gitaculous has "more than one color".
    //
    // The truecolor fg immediately preceding `text`'s first occurrence — every
    // colored token here is wrapped by exactly one palette function, which
    // opens its SGR run directly before the token, so the last escape before
    // the match IS that token's color.
    function fgBeforeText(line: string, text: string): string | undefined {
      const idx = line.indexOf(text);
      if (idx === -1) return undefined;
      const matches = [...line.slice(0, idx).matchAll(/\x1b\[([0-9;]*)m/g)];
      const params = (matches.at(-1)?.[1] ?? "").split(";");
      for (let i = 0; i < params.length; i++) {
        if (params[i] === "38" && params[i + 1] === "2") {
          return `${params[i + 2]};${params[i + 3]};${params[i + 4]}`;
        }
      }
      return undefined;
    }

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
      const plainFg = fgBeforeText(line, "abc1234"); // sha: never wrapped in a palette fn
      expect(stashFg).toBeDefined();
      expect(stashFg).not.toBe(plainFg);
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
      const metricsOnly = { ...parsed, root: oneSegmentRoot("metrics") };
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
          { style: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, charset: "unicode", width: Number.POSITIVE_INFINITY },
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
          root: oneSegmentRoot("block"),
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
            { style: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, charset: "unicode", width: Number.POSITIVE_INFINITY },
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

  // brandon-budget-kry: session-level budget warning — the session segment is
  // the second instance of the shared budgetStatus helper (today is the first).
  describe("session budget warning", () => {
    // Render ONLY the session segment, with optional user-file overrides
    // merged through the real mergeWithDefault path — the same cascade a
    // user's config file flows through.
    const renderSession = (
      payload: Record<string, unknown>,
      userSource?: string,
    ): string => {
      const merged = mergeWithDefault(
        parseDslConfig("<user>", userSource ?? "{}"),
        DEFAULT_DSL_CONFIG,
      );
      // [FRAMING:representation] `source` is the text validation errors quote
      // from — it must be the config actually being validated (`merged`), not
      // the bundled default's serialization.
      const config = validateConfig(merged, "<merged>", JSON.stringify(merged, null, 2));
      const sessionOnly = { ...config, root: oneSegmentRoot("session") };
      const store = new VariableStore();
      // The merged bundled default declares `activeStyle`/`stylePage` as state
      // vars; SessionState is required to declare them, exactly as the daemon
      // supplies (matching the other full-default render helpers above). Without
      // it those two vars silently fail to declare into loadWarnings — harmless
      // for the session segment here, but the fixture should exercise the
      // genuinely-complete default config, not a partially-registered one.
      const registry = new SourceRegistry(store, "", undefined, new SessionState());
      try {
        const compiled = registerDslConfig(sessionOnly, registry, {
          cwd: process.cwd(),
        });
        const basePalette = new PaletteResolver(
          getThemePalette(sessionOnly.globals.palette ?? "textual-dark")!,
        );
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
          { style: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, charset: "unicode", width: Number.POSITIVE_INFINITY },
        );
      } finally {
        registry.dispose();
      }
    };

    const PAYLOAD = { session: { cost: 8.5, tokens: 1000 } };

    test("absent session-budget config renders byte-identically to the pre-budget template", () => {
      // [LAW:dataflow-not-control-flow] The default amount is 0 — the
      // budgetStatus helper's non-displayable value — so the suffix
      // contributes zero bytes through the same unconditional template.
      // Oracle: the same segment with the retired (suffix-less) template.
      const preBudget = renderSession(PAYLOAD, JSON.stringify({
        segments: {
          session: {
            template:
              '§ {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }})',
            bg: "surface",
            fg: "foreground",
          },
        },
      }));
      expect(renderSession(PAYLOAD)).toEqual(preBudget);
    });

    test("user override of session.budget.amount surfaces the budgetStatus suffix", () => {
      // [LAW:one-source-of-truth] The knob lives in one variable declaration;
      // the user file's override flows through mergeWithDefault's
      // variables-by-name spread. cost 8.5 / amount 10 = 85% ≥ warn 80 → " !85%".
      const line = renderSession(PAYLOAD, JSON.stringify({
        variables: {
          "session.budget.amount": { kind: "literal", value: 10 },
        },
      }));
      expect(line).toContain("!85%");
    });

    test("user override of session.budget.warningThreshold reclassifies the suffix", () => {
      // cost 6 / amount 10 = 60%: below the default warn 80 → " +60%";
      // with warn 50 the same spend reads " !60%". Same cost, different
      // threshold → different bytes, proving the template reads the variable,
      // not a baked-in literal.
      const spend = { session: { cost: 6, tokens: 1000 } };
      const defaultWarn = renderSession(spend, JSON.stringify({
        variables: {
          "session.budget.amount": { kind: "literal", value: 10 },
        },
      }));
      const tightWarn = renderSession(spend, JSON.stringify({
        variables: {
          "session.budget.amount": { kind: "literal", value: 10 },
          "session.budget.warningThreshold": { kind: "literal", value: 50 },
        },
      }));
      expect(defaultWarn).toContain("+60%");
      expect(tightWarn).toContain("!60%");
    });
  });
});
