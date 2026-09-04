// [LAW:verifiable-goals] brandon-layout-edit-2gc.3 done-gates, driven through
// the real spine (mirroring dsl-layout-edit.test.ts's / dsl-undo-redo.test.ts's
// model one arm over):
//
//   1. The loader proves `insertSegmentFrom`'s ActionDecl shape: persist-only,
//      a from-shaped domain (name or inline array) + literal anchor/relation,
//      and it is a legal arm over a "presets.<name>.root" target alongside
//      removeSegment/insertSegment.
//   2. Edit mode is DEMAND-DRIVEN, not unconditional: a config that never
//      references `{{ action "edit.toggle" … }}` gets neither the toggle nor
//      any chrome — and critically, no new `session.id` requirement — so a
//      fully static, non-interactive bar is untouched by this feature's mere
//      existence.
//   3. A config that DOES reference the toggle gets `edit.mode`/`edit.toggle`
//      synthesized, PLUS per-segment `-`/`+` chrome spliced into every
//      preset's resolved root, gated behind the SAME session var — a splice,
//      never a render-walk branch.
//   4. Toggling edit mode on/off changes what renders (chrome appears/
//      disappears) without registerDslConfig running again — the compiled
//      tree is fixed; only which `when` predicates pass differs.
//   5. `-` (removeSegment) and `+` (insertSegmentFrom via `{{ menu }}`) click
//      through to the REAL daemon handler exactly like a hand-authored
//      layout-op action, rewriting the tree at "presets.<name>.root" IN THE
//      SESSION'S CONFIG FILE (candybar-config-dqe) — so undo/redo (2gc.2's
//      history of whole-file snapshots) covers an edit-mode click for free.
//   6. Remove, then add (picked from the menu), then undo twice returns the
//      file to its original bytes.
//   7. Edit chrome is ordinary segment/action data — it renders through the
//      SAME padding/charset/style pipeline as hand-authored segments, no
//      special-cased chrome path.

import { withoutSettingsLinks } from "./helpers/ambient-chrome";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { deriveActionValidators } from "../src/daemon/verbs/state-validators";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { registerStateValidator } from "../src/daemon/verbs/state-validators";
import { encodeLayoutOp } from "../src/config/layout-ops";
import {
  EDIT_MODE_KEY,
  EDIT_TOGGLE_ACTION,
  EDIT_NS,
} from "../src/config/loader/edit-mode";
import { walkNodes, type LayoutNode } from "../src/config/dsl-types";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return withoutSettingsLinks(urls);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function segmentNamesOf(root: LayoutNode): string[] {
  const out: string[] = [];
  for (const node of walkNodes(root)) {
    if (node.kind === "segment") out.push(node.name);
  }
  return out;
}

// The bundled base config every test starts from: a two-segment row plus a
// trigger segment referencing `edit.toggle` (the ONE thing that opts a
// config into edit mode). No `presets:` block — the floor preset ("default")
// carries the config's own root.
const BASE = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    // The insert chrome's \`{{ menu }}\` bodies paginate by term.cols
    // (paged=true is the default) — declared here exactly as every other
    // menu/picker test declares it (see dsl-menus.test.ts).
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
  },
  segments: {
    directory: { template: 'd', bg: 'surface', fg: 'foreground' },
    git: { template: 'g', bg: 'surface', fg: 'foreground' },
    gitPr: { template: 'p', bg: 'surface', fg: 'foreground' },
    trigger: { template: '{{ action "edit.toggle" "e" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { v: [ { h: ['directory', 'git'] }, 'trigger' ] },
  presets: {},
}`;

// [LAW:one-source-of-truth] The config FILE is the durable store a `-`/`+`
// click edits (candybar-config-dqe). One fixture for the whole file — every
// test gets a fresh temp config root, whether or not it clicks — so there is
// no per-describe "does this one need a file" decision to get wrong.
let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-editmode-");
});
afterEach(() => {
  durable.dispose();
});

// Full real-spine harness: real loader, real render, clicks dispatched
// through the real daemon verb handlers against BOTH derived gates (set for
// SessionState — the toggle, the menu's own disclosure — and persist for the
// config file — the remove/insert ops). The runtime parses `src` for the
// render AND writes the same text as the session's config file, so the tree
// a click edits is the tree the bar rendered — the daemon's own situation.
function buildEditRuntime(src: string, sessionId = "s1") {
  durable.write(src);
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  durable.seedOrigin(sessionState, sessionId);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(),
    );
  const stateDisposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const configDisposers = deriveConfigActionValidators(config).map(
    ({ key, spec }) => registerConfigValidator(key, spec),
  );
  const ctx: VerbContext = { sessionState, dlog: () => {} };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const dispose = (): void => {
    stateDisposers.forEach((d) => d());
    configDisposers.forEach((d) => d());
  };
  return { config, store, render, click, dispose, ctx };
}

// ─── loader: insertSegmentFrom's ActionDecl shape ─────────────────────────

describe("insertSegmentFrom loader shape", () => {
  const base = (actions: string, presets = "{}") => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: ${actions},
    segments: {
      directory: { template: 'd', bg: 'surface', fg: 'foreground' },
      git: { template: 'g', bg: 'surface', fg: 'foreground' },
    },
    root: { h: ['directory', 'git'] },
    presets: ${presets},
  }`;

  test("insertSegmentFrom + anchor + relation parses with a domain NAME", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ ins: { persist: 'presets.default.root', insertSegmentFrom: 'themes', anchor: 'git', relation: 'before' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.ins).toEqual({
      persist: "presets.default.root",
      insertSegmentFrom: "themes",
      anchor: "git",
      relation: "before",
    });
  });

  test("insertSegmentFrom accepts an INLINE array domain", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ ins: { persist: 'presets.default.root', insertSegmentFrom: ['gitPr'], anchor: 'git', relation: 'after' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.ins).toEqual({
      persist: "presets.default.root",
      insertSegmentFrom: ["gitPr"],
      anchor: "git",
      relation: "after",
    });
  });

  test("insertSegmentFrom without anchor is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.root', insertSegmentFrom: 'themes', relation: 'before' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a literal insertSegment and a domain-sourced insertSegmentFrom never both match one action", () => {
    // Both arms declared together is two value sources on one action — the
    // ordinary "exactly one" rejection, not a spurious double-match via the
    // anchor/relation fields the two arms share.
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.root', insertSegment: 'directory', insertSegmentFrom: 'themes', anchor: 'git', relation: 'before' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/declares exactly one value source/);
  });

  test("insertSegmentFrom's anchor naming an undeclared segment is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { persist: 'presets.default.root', insertSegmentFrom: 'themes', anchor: 'nope', relation: 'after' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/anchor "nope" is not a declared segment/);
  });

  test("insertSegmentFrom has no `set` counterpart — persist only", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ ins: { set: 'presets.default.root', insertSegmentFrom: 'themes', anchor: 'git', relation: 'before' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });
});

// ─── demand-driven synthesis ────────────────────────────────────────────────

describe("edit mode is demand-driven, not unconditional", () => {
  test("a config never referencing edit.toggle gets no toggle, no chrome, and needs no session.id", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        segments: { directory: { template: 'd', bg: 'surface', fg: 'foreground' } },
        root: 'directory',
        presets: {},
      }`,
      ALLOWED,
    );
    expect(config.actions[EDIT_TOGGLE_ACTION]).toBeUndefined();
    expect(config.variables[EDIT_MODE_KEY]).toBeUndefined();
    // No preset declares its own root and edit chrome never ran (it's a
    // no-op when `edit.toggle` never merged in), so `config.root` — the
    // config's own declared tree — is untouched, byte-for-byte.
    expect(segmentNamesOf(config.root)).toEqual(["directory"]);
  });

  test("a config referencing edit.toggle gets the toggle var + action synthesized", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    expect(config.actions[EDIT_TOGGLE_ACTION]).toEqual({
      set: EDIT_MODE_KEY,
      cycle: ["closed", "open"],
    });
    expect(config.variables[EDIT_MODE_KEY]).toEqual({
      kind: "state",
      key: EDIT_MODE_KEY,
      default: "closed",
    });
  });

  test("a user name under the reserved edit. namespace is a load error even when edit mode is unused", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          globals: {},
          segments: { 'edit.mine': { template: 'x', bg: 'surface', fg: 'foreground' } },
          root: 'edit.mine',
          presets: {},
        }`,
        ALLOWED,
      ),
    ).toThrow(/reserved "edit\." namespace/);
  });
});

// ─── chrome synthesis: what gets spliced in ────────────────────────────────

describe("edit chrome: what's spliced into the resolved preset root", () => {
  test("every ordinary segment gets a `-`, every gap gets a `+`", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const names = segmentNamesOf(config.presets.default!.root!);
    // Original content untouched:
    expect(names).toEqual(
      expect.arrayContaining(["directory", "git", "trigger"]),
    );
    // One `-` per content segment — directory, git, AND trigger: nothing
    // about hosting `{{ action "edit.toggle" }}` makes a segment special to
    // the SPLICE (it only excludes names under a reserved namespace, and
    // "trigger" is an ordinary user-chosen name).
    expect(
      names.filter((n) => n.startsWith("edit.default.removeSeg.")).sort(),
    ).toEqual([
      "edit.default.removeSeg.directory",
      "edit.default.removeSeg.git",
      "edit.default.removeSeg.trigger",
    ]);
    // N+1 `+` positions per row: 3 for the 2-segment row (before directory,
    // between directory/git, after git) + 2 for the single-segment trigger
    // row (before, after) = 5.
    const inserts = names.filter((n) =>
      n.startsWith("edit.default.insertSeg."),
    );
    expect(inserts).toHaveLength(5);
  });

  test("edit-mode's OWN synthesized chrome segments are exempt from further chrome", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const names = segmentNamesOf(config.presets.default!.root!);
    // None of the "edit.default.remove*"/"edit.default.insert*" segments
    // themselves get a nested "-"/"+" — the splice recurses into containers
    // only, and `isChromeExempt` excludes every "edit." name outright.
    for (const n of names) {
      if (!n.startsWith("edit.")) continue;
      expect(names).not.toContain(`edit.default.removeSeg.${n}`);
    }
  });

  test("gitPr (not yet in the tree) is offered by every `+`'s addable domain", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const inserts = Object.entries(config.actions).filter(
      (
        e,
      ): e is [
        string,
        Extract<
          (typeof config.actions)[string],
          { insertSegmentFrom: unknown }
        >,
      ] => "insertSegmentFrom" in e[1],
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const [, a] of inserts) {
      expect(a.insertSegmentFrom).toBe("edit.addable.default");
    }
  });

  test("chrome segments are gated behind edit.mode — absent from render when closed", () => {
    const { render, dispose } = buildEditRuntime(BASE);
    const out = stripAnsi(render());
    expect(out).not.toContain("-"); // no `-` glyph rendered while closed
    dispose();
  });

  test("no render-walk branch: renderDsl's own source never mentions edit mode", () => {
    // [LAW:dataflow-not-control-flow] The chrome is spliced tree nodes with
    // an ordinary `when`; renderDsl (the ONE render path, called verbatim by
    // the daemon and the demo alike) needed zero edits for this feature, and
    // this asserts that structurally rather than by promise.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(
      require.resolve("../src/dsl/render.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/edit\.mode|editMode|EDIT_MODE/);
  });
});

// ─── end-to-end: toggle, remove, insert-via-menu, undo twice ──────────────

describe("edit mode click flow: toggle → remove → insert (menu) → undo × 2", () => {
  test("toggling edit mode on makes the `-` chrome render; off hides it again", () => {
    const { render, click, dispose } = buildEditRuntime(BASE);
    const before = stripAnsi(render());
    expect(before).not.toContain("-");

    const toggleUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "open",
      ),
    )!;
    expect(toggleUrl).toBeDefined();
    click(toggleUrl);

    const opened = stripAnsi(render());
    expect(opened).toContain("-");

    const closeUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "closed",
      ),
    )!;
    click(closeUrl);
    expect(stripAnsi(render())).not.toContain("-");
    dispose();
  });

  test("remove → insert (picked via menu) → undo × 2 returns the file to its original bytes", () => {
    const { render, click, dispose, ctx } = buildEditRuntime(BASE);
    const original = durable.text()!;

    // Open edit mode.
    const openUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "open",
      ),
    )!;
    click(openUrl);

    // Remove "directory" via its `-`.
    const removeUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === "apply-layout-op" &&
          e.args[2] === encodeLayoutOp({ op: "remove", target: "directory" }),
      ),
    )!;
    expect(removeUrl).toBeDefined();
    click(removeUrl);
    // The file's own root is the edited tree, in the authoring grammar.
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "trigger"] });
    expect(durable.history().past).toHaveLength(1);

    // Open every `+` menu, then pick "gitPr" from the one anchored on "git".
    // [LAW:no-silent-failure] This harness compiles ONE tree and never
    // reloads it from the file, so the `+` beside "directory" is still
    // rendered though "directory" is gone from the file — clicking THAT one
    // is exactly the stale-bar case the store refuses loudly (see
    // dsl-layout-edit.test.ts). Anchor on a segment the file still holds.
    for (const menuOpenUrl of extractUrls(render()).filter((u) =>
      effectsOf(u).some(
        (e) => e.verb === "set-state" && String(e.args[1]).startsWith("menus."),
      ),
    )) {
      click(menuOpenUrl);
    }

    const pickUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === "apply-layout-op" &&
          decodeURIComponent(String(e.args[2])).startsWith("insert:gitPr:git:"),
      ),
    )!;
    expect(pickUrl).toBeDefined();
    click(pickUrl);
    // The insert composed onto the tree the remove left behind.
    const afterInsert = JSON.stringify(durable.parsed().root);
    expect(afterInsert).toContain('"gitPr"');
    expect(afterInsert).not.toContain('"directory"');
    expect(durable.history().past).toHaveLength(2);

    // Undo the insert, undo the remove — two clicks through the REAL undo
    // verb handler (2gc.2's history of whole-file snapshots, entirely unaware
    // either write came from edit-mode chrome). `undo`/`redo` need no
    // declared action to invoke — per the epic's own premise correction, edit
    // mode wires ONE static undo/redo pair rather than synthesizing one per
    // position, so BASE deliberately declares neither; drive the verb
    // directly, exactly as dsl-undo-redo.test.ts does.
    const undo = VERBS.get("undo")!;
    undo(encodeURIComponent("s1"), ctx);
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "trigger"] });
    undo(encodeURIComponent("s1"), ctx);
    // Byte-identical: the file IS the layout, so "back to the original
    // layout" and "back to the original bytes" are one fact.
    expect(durable.text()).toBe(original);
    dispose();
  });
});

// ─── chrome respects globals like any other segment ───────────────────────

describe("edit chrome is ordinary segment data — no special-cased render path", () => {
  test("padding applies to a chrome segment exactly like a hand-authored one", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = getThemePalette("textual-dark"!);
    sessionState.set("s1", EDIT_MODE_KEY, "open");
    const renderWith = (padding: number): string =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: "s1", project_dir: "/tmp/proj" },
        basePalette,
        { ...opts(), padding },
      );
    const padded0 = stripAnsi(renderWith(0));
    const padded2 = stripAnsi(renderWith(2));
    // Same content, more surrounding whitespace at padding=2 — the chrome
    // segment's `-`/`+` cells widen by the same 2×padding every other
    // segment's cells do, since applySegmentLayout pads BEFORE sizing with
    // no knowledge of which segments are "chrome".
    expect(padded2.length).toBeGreaterThan(padded0.length);
  });
});

// ─── the bundled default's own trigger — brandon-layout-edit-2gc.4 ────────

// [LAW:verifiable-goals] .4's done-gate: the bundled default's `toolbar`
// segment hosts `edit.toggle` (docs/interaction-authoring.md's "The bundled
// default ships this on"), which resolves a self-lockout tension .3's own
// handoff flagged — removing the trigger's own host segment via edit mode's
// `-` doesn't strand a user OUTSIDE edit mode (recoverable via any other
// `+`) and doesn't strand them INSIDE it either (edit.mode is untouched
// SessionState, so the rest of the chrome stays visible). Proves the claim
// against the REAL RAW_DEFAULT_DSL_CONFIG source, not a synthetic fixture.
describe("bundled default: toolbar hosts edit.toggle — brandon-layout-edit-2gc.4", () => {
  const DEFAULT_SOURCE = JSON.stringify(RAW_DEFAULT_DSL_CONFIG);

  test("referencing edit.toggle from toolbar synthesizes the toggle for the whole bundled default", () => {
    const config = parseAndValidate("<default>", DEFAULT_SOURCE, ALLOWED);
    expect(config.actions).toHaveProperty([EDIT_TOGGLE_ACTION]);
    expect(config.variables).toHaveProperty([EDIT_MODE_KEY]);
    expect(config.segments.toolbar!.template).toContain(EDIT_TOGGLE_ACTION);
  });

  test("removing the toolbar (the trigger's own host) via `-` doesn't strand edit mode: every other segment's chrome stays live", () => {
    // [LAW:one-source-of-truth] This lightweight harness compiles ONE tree
    // from the source and never reloads it from the file a click edits (only
    // the real daemon's RenderCache does — see test/dsl-layout-edit.test.ts's
    // "toolbar removed via edit mode is offered back by every remaining `+`,
    // and a real reload restores it" for the full round trip including the
    // `+` picker's domain, which is recomputed fresh on EVERY reload and so
    // cannot be proven against a tree compiled once). What this harness CAN
    // prove directly: the click edits the file's tree, and removing the
    // trigger's own host does not also close `edit.mode` — the rest of the
    // bar's chrome stays live.
    const { config, render, click, dispose } = buildEditRuntime(DEFAULT_SOURCE);
    const originalNames = segmentNamesOf(config.presets.default!.root!).filter(
      (n) => !n.startsWith(EDIT_NS),
    );
    expect(originalNames).toContain("toolbar");

    // Open edit mode via toolbar's own trigger — a plain SessionState `set`,
    // so render() reflects it immediately (unlike the layout-op write
    // below, which lands in the config file this harness never reloads into
    // its own compiled tree).
    const openUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "open",
      ),
    )!;
    expect(openUrl).toBeDefined();
    click(openUrl);
    expect(stripAnsi(render())).toContain("✎ done");

    // Remove "toolbar" via its own `-` — the trigger removes itself along
    // with the rest of the tray. The write edits the SAME
    // "presets.default.root" tree removeSegment/insertSegment always target
    // (2gc.1) — the file a real daemon restart reads.
    expect(JSON.stringify(durable.parsed().root)).toContain('"toolbar"');
    const removeUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === "apply-layout-op" &&
          e.args[2] === encodeLayoutOp({ op: "remove", target: "toolbar" }),
      ),
    )!;
    expect(removeUrl).toBeDefined();
    click(removeUrl);
    expect(JSON.stringify(durable.parsed().root)).not.toContain('"toolbar"');
    expect(durable.history().past).toHaveLength(1);

    // `edit.mode` is untouched SessionState (a `-` click never writes it),
    // so every OTHER segment's chrome is still compiled and gated open —
    // there is still a `+` to click, proving the bar isn't stuck with no
    // way to reach edit mode's own affordances again.
    const stillOpen = stripAnsi(render());
    expect(stillOpen).toContain("-");
    expect(
      extractUrls(render()).some((u) =>
        effectsOf(u).some(
          (e) =>
            e.verb === "set-state" && String(e.args[1]).startsWith("menus."),
        ),
      ),
    ).toBe(true);
    dispose();
  });
});
