// [LAW:verifiable-goals] brandon-layout-edit-2gc.3 done-gates, driven through
// the real spine (mirroring dsl-layout-edit.test.ts's / dsl-undo-redo.test.ts's
// model one arm over):
//
//   1. The loader proves `insertSegmentFrom`'s ActionDecl shape: persist-only,
//      a from-shaped domain (name or inline array) + literal anchor/relation,
//      and it is a legal arm over a "presets.<name>.root" target alongside
//      removeSegment/insertSegment.
//   2. Every config carries edit mode: the settings menu, synthesized into
//      every config, ensures the toggle and fires it from `✎ arrange`, so even a
//      config that never references `{{ action "edit.toggle" … }}` gets the
//      toggle and its chrome (brandon-settings-menu-d6f).
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
//      SAME padding/style pipeline as hand-authored segments, no
//      special-cased chrome path.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linkUrls, runUnder, truecolorOf } from "./helpers/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { withoutSettingsLinks } from "./helpers/ambient-chrome";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { encodeLayoutOp } from "../src/config/layout-ops";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
  EDIT_TOGGLE_ACTION,
} from "../src/config/loader/edit-mode";
import {
  ADDABLE_DOMAIN,
  EDIT_LIVE_KEY,
  arrangedSegment,
} from "../src/config/edit-chrome";
import { ADD_GLYPH, CONFIGURE_GLYPH, REMOVE_GLYPH } from "../src/config/edit-glyphs";
import { walkNodes, type RootFragment } from "../src/config/dsl-types";
import { fragmentNode } from "../src/config/root";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { contrastRatio } from "@promptctl/rich-js";
import { TEXT_MIN_CONTRAST } from "../src/themes/decor";
import { menuMember, menuStateKey } from "../src/config/menu-keys";
import { instantOf } from "../src/utils/instant";

// The colours drawn at `text`'s first character, as hex; either is undefined
// when none is (a cell drawn with no fill has no bg).
function paintAt(
  rendered: Frame,
  text: string,
): { fg: string | undefined; bg: string | undefined } {
  const run = runUnder(rendered, text);
  expect(run).toBeDefined();
  return { fg: run!.fg, bg: run!.bg };
}

function colorsAt(rendered: Frame, text: string): { fg: string; bg: string } {
  const { fg, bg } = paintAt(rendered, text);
  expect(fg).toBeDefined();
  expect(bg).toBeDefined();
  return { fg: fg!, bg: bg! };
}

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width = Number.POSITIVE_INFINITY) {
  return {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    width,
  };
}

function ownUrls(rendered: Frame): string[] {
  const urls = linkUrls(rendered);
  // The global settings menu and the edit toggle it reaches are on every bar;
  // this file's assertions are about the fixture's OWN clickable regions.
  return withoutSettingsLinks(urls);
}

function segmentNamesOf(root: RootFragment): string[] {
  const out: string[] = [];
  for (const node of walkNodes(fragmentNode(root))) {
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
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const basePalette = getThemePalette("textual-dark"!);
  // The daemon publishes the session's history depth into every render's
  // payload (`history.sinceEdit` is what edit mode's save cell counts).
  const history = durable.historyFor(sessionState);
  const render = (width?: number): Frame =>
    drawPayload(
      config,
      compiled,
      store,
      registry,
      {
        session_id: sessionId,
        project_dir: "/tmp/proj",
        history: history.depth(sessionId),
      },
      instantOf(new Date()),
      opts(width),
    ).frame;
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, history),
    // The config this bar rendered with, which gates every click and which an
    // insertion mints its id against — the daemon's own lookup.
    configFor: () => config,
  };
  const click = async (url: string): Promise<void> => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      await handler(e.value, ctx);
    }
  };
  return { config, store, render, click, ctx, history, sessionState };
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

describe("edit mode is in every config", () => {
  test("a config never referencing edit.toggle still gets the toggle and its chrome", () => {
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
    expect(config.actions[EDIT_TOGGLE_ACTION]).toBeDefined();
    expect(config.variables[EDIT_MODE_KEY]).toBeDefined();
    // The chrome is spliced into the floor preset's root; `config.root` — the
    // config's own declared tree — is untouched, byte-for-byte.
    expect(segmentNamesOf(config.root)).toEqual(["directory"]);
    expect(
      segmentNamesOf(config.presets.default!.root!).some((n) =>
        n.startsWith("edit."),
      ),
    ).toBe(true);
  });

  test("a config referencing edit.toggle gets the toggle var + action synthesized", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    expect(config.actions[EDIT_TOGGLE_ACTION]).toEqual({
      set: EDIT_MODE_KEY,
      cycle: ["closed", EDIT_MODE_ARRANGE],
    });
    expect(config.actions["edit.unconfigure"]).toEqual({
      set: "edit.configure",
      to: "closed",
    });
    // Arranging lives inside the settings door: closing it leaves edit mode.
    expect(config.variables[EDIT_MODE_KEY]).toEqual({
      kind: "state",
      key: EDIT_MODE_KEY,
      default: "closed",
      within: [{ variable: "candybar.menu", key: "candybar.menu", member: "open" }],
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
    // One `-` and one name label per content segment — directory, git, AND
    // trigger: nothing about hosting `{{ action "edit.toggle" }}` makes a
    // segment special to the SPLICE (it only excludes names under a reserved
    // namespace, and "trigger" is an ordinary user-chosen name).
    const removes = Object.entries(config.actions)
      .filter(([, a]) => "removeSegment" in a)
      .map(([, a]) => (a as { removeSegment: string }).removeSegment)
      .sort();
    expect(removes).toEqual(["directory", "git", "trigger"]);
    const labelled = names
      .filter((n) => n.startsWith("edit."))
      .map(arrangedSegment)
      .filter((n) => n !== undefined);
    expect(labelled.sort()).toEqual(["directory", "git", "trigger"]);
    // N+1 `+` positions per row, each in its own cell (a segment's `-` is
    // drawn inside the segment's own cell): 3 for the 2-segment row (before
    // directory, after directory, after git) + 2 for the single-segment
    // trigger row (before, after) = 5.
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
      expect(names.map(arrangedSegment)).not.toContain(n);
    }
  });

  test("every `+` ranges the one addable domain", () => {
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
      expect(a.insertSegmentFrom).toBe(ADDABLE_DOMAIN);
    }
  });

  test("a segment's `-` is drawn inside its own cell, in both views", () => {
    // Inside the cell means on the segment's own node, as its lead — not a
    // sibling cell a joiner separates from it. Both the live content node and
    // the name label that stands in for it carry it.
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const leads = new Map<string, string>();
    for (const node of walkNodes(fragmentNode(config.presets.default!.root!))) {
      if (node.kind === "segment" && node.lead !== undefined) {
        leads.set(node.name, node.lead);
      }
    }
    const removal = (lead: string | undefined) =>
      /"(edit\.default\.remove\.[^"]+)"/.exec(lead ?? "")?.[1];
    for (const seg of ["directory", "git", "trigger"]) {
      const remove = removal(leads.get(seg));
      expect(config.actions[remove!]).toMatchObject({ removeSegment: seg });
      expect(removal(leads.get(`edit.label:${seg}:${seg}`))).toBe(remove);
    }
  });

  // A fill cell's pad is part of its content, so the `🔧` rides AFTER the pad,
  // against the cell's far edge — never stranded mid-cell with the pad beyond it
  // — and the `-` leads the content, outside its sizing.
  test("a fill segment's `-` leads and its `🔧` sits after the leftover width it absorbed", async () => {
    const src = BASE.replace(
      "directory: { template: 'd',",
      "directory: { width: 'fill', template: 'd',",
    );
    const { render, click } = buildEditRuntime(src);
    const open = (key: string, member: string) =>
      ownUrls(render()).find((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === member),
      )!;
    await click(open(EDIT_MODE_KEY, EDIT_MODE_ARRANGE));
    await click(open(EDIT_LIVE_KEY, "open"));
    const row = textOf(render(60))
      .split("\n")
      .find((line) => line.includes(`d`) && line.includes(REMOVE_GLYPH))!;
    expect(row).toMatch(
      new RegExp(`${REMOVE_GLYPH}d {4,}${CONFIGURE_GLYPH}`),
    );
  });

  test("a segment that fails to render keeps its `-` beside its ⚠", async () => {
    const src = BASE.replace("template: 'g',", `template: '{{ fail "boom" }}',`);
    const { render, click } = buildEditRuntime(src);
    const open = (key: string, member: string) =>
      ownUrls(render()).find((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === member),
      )!;
    await click(open(EDIT_MODE_KEY, EDIT_MODE_ARRANGE));
    await click(open(EDIT_LIVE_KEY, "open"));
    const out = render();
    expect(textOf(out)).toMatch(
      new RegExp(`${REMOVE_GLYPH}⚠ git: [^\n]*${CONFIGURE_GLYPH}`),
    );
    expect(ownUrls(out).some((u) => u.includes("remove%253Agit"))).toBe(true);
  });

  // The red `✖` is floored against the ground it is DRAWN on. A segment
  // with something open under it wears its band's state colour, not its
  // closed background, so the floor is measured against that.
  test("an open segment's `✖` stays legible on the state colour it wears", async () => {
    const src = BASE.replace(
      "segments: {",
      `actions: { pick: { set: 'pick', from: ['a', 'b'] } },
  segments: {
    picky: { template: '{{ menu "pick" "m" }}' },`,
    )
      .replace("{ h: ['directory', 'git'] }", "{ h: ['directory', 'picky', 'git'] }")
      .replace(
        "variables: {",
        "variables: {\n    pick: { kind: 'state', key: 'pick', default: 'a' },",
      );
    const { render, click } = buildEditRuntime(src);
    const open = (key: string, member: string) =>
      ownUrls(render()).find((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === member),
      )!;
    await click(open(EDIT_MODE_KEY, EDIT_MODE_ARRANGE));
    await click(open(EDIT_LIVE_KEY, "open"));
    await click(open(menuStateKey("picky", "pick", undefined), menuMember("pick")));
    const { fg, bg } = colorsAt(render(), `${REMOVE_GLYPH}m`);
    expect(contrastRatio(truecolorOf(fg), truecolorOf(bg))).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
  });

  // An insertion point is drawn on no fill: its `✚` is green text on the
  // terminal's own ground, where `✖` sits inside its placement's cell.
  test("`✚` is drawn on no fill, `✖` on its segment's own cell", async () => {
    const { render, click } = buildEditRuntime(BASE);
    const toggle = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    await click(toggle);
    const out = render();
    const add = paintAt(out, ADD_GLYPH);
    expect(add.fg).toBeDefined();
    expect(add.bg).toBeUndefined();
    expect(paintAt(out, REMOVE_GLYPH).bg).toBeDefined();
  });

  test("edit mode leads with ✓ done, top left, and it leaves edit mode", async () => {
    const { render, click } = buildEditRuntime(BASE);
    const toggle = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    await click(toggle);
    const [first] = textOf(render()).split("\n");
    expect(first).toContain("✓ done");
    expect(first).not.toMatch(/directory|git|trigger/);
    const done = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "closed",
      ),
    );
    expect(done).toBeDefined();
    await click(done!);
    expect(textOf(render())).not.toContain("✓ done");
  });

  test("chrome segments are gated behind edit.mode — absent from render when closed", () => {
    const { render } = buildEditRuntime(BASE);
    const out = textOf(render());
    expect(out).not.toContain(REMOVE_GLYPH); // no `-` rendered while closed
  });

  test("no render-walk branch: drawDsl's own source never mentions edit mode", () => {
    // [LAW:dataflow-not-control-flow] The chrome is spliced tree nodes with
    // an ordinary `when`; drawDsl (the ONE render path, called verbatim by
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

// ─── names view: every placed segment is manageable, rendering or not ──────

describe("edit mode shows the arrangement: each content cell reads as its name", () => {
  // `idle` hides itself by its own `when`, in a row and as a row of its own.
  const HIDDEN = BASE.replace(
    "gitPr: { template: 'p', bg: 'surface', fg: 'foreground' },",
    "gitPr: { template: 'p', bg: 'surface', fg: 'foreground' },\n    idle: { template: 'IDLE', when: '{{ false }}' },\n    alone: { template: 'ALONE', when: '{{ false }}' },\n    boxed: { template: 'BOXED' },",
  ).replace(
    "root: { v: [ { h: ['directory', 'git'] }, 'trigger' ] },",
    "root: { v: [ { h: ['directory', 'idle', 'git'] }, 'alone', { h: ['boxed'], when: '{{ false }}' }, 'trigger' ] },",
  );
  const removesOf = (rendered: Frame): string[] =>
    ownUrls(rendered).flatMap((u) =>
      effectsOf(u)
        .filter((e) => e.verb === "apply-layout-op")
        .map((e) => String(e.args[2])),
    );

  test("a segment its own `when` or its container's hides still shows its name and its `-`", async () => {
    const { render, click } = buildEditRuntime(HIDDEN);
    const closed = textOf(render());
    expect(closed).not.toMatch(/idle|alone|boxed|IDLE|ALONE|BOXED/);
    // A hidden segment that is a whole row leaves no blank line behind.
    expect(closed.split("\n").some((line) => line.trim() === "")).toBe(false);

    const toggle = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    await click(toggle);
    const names = render();
    expect(textOf(names)).toMatch(/directory.*idle.*git/);
    expect(textOf(names)).toContain("alone");
    expect(textOf(names)).toContain("boxed");
    expect(textOf(names)).not.toMatch(/IDLE|ALONE|BOXED|\bd\b|\bg\b/);
    expect(removesOf(names)).toEqual(
      expect.arrayContaining(
        ["idle", "alone", "boxed", "directory"].map((target) =>
          encodeLayoutOp({ op: "remove", target }),
        ),
      ),
    );

    // Live: the real output returns and the hidden segment stays hidden. Its
    // `-` goes with it, since the `-` is drawn inside the segment's own cell;
    // the names view above is where a hidden segment is removed.
    const live = ownUrls(names).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_LIVE_KEY && e.args[2] === "open",
      ),
    )!;
    await click(live);
    const shown = render();
    expect(textOf(shown)).not.toMatch(/idle|alone|boxed|IDLE|ALONE|BOXED/);
    expect(textOf(shown)).toMatch(/d.*g/);
    expect(removesOf(shown)).not.toContain(
      encodeLayoutOp({ op: "remove", target: "idle" }),
    );
  });

  // The settings menu's synthesis, not withTrailingCell, lifts a gated root
  // under an ungated wrapper row (the door's), so the tail lands outside the
  // gate; edit mode needs `session.id`, which always brings the menu.
  test("`☐ live` under a gated root cannot hide the toggle that brings the names view back", async () => {
    const { render, click, ctx } = buildEditRuntime(
      BASE.replace(
        "root: { v: [ { h: ['directory', 'git'] }, 'trigger' ] },",
        "root: { v: [ { h: ['directory', 'git'] }, 'trigger' ], when: '{{ false }}' },",
      ),
    );
    ctx.sessionState.set("s1", EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const liveToggle = (rendered: Frame, to: string): string | undefined =>
      ownUrls(rendered).find((u) =>
        effectsOf(u).some(
          (e) => e.args[1] === EDIT_LIVE_KEY && e.args[2] === to,
        ),
      );
    await click(liveToggle(render(), "open")!);
    const live = render();
    expect(textOf(live)).not.toMatch(/directory|\bd\b/);
    // The way back survives the root hiding.
    await click(liveToggle(live, "closed")!);
    expect(textOf(render())).toMatch(/directory.*git/);
  });

  test("only a name label stands for a segment in the arrangement, whatever the presets are called", () => {
    // A preset named "label" puts its own chrome under `edit.label.`.
    const config = parseAndValidate(
      "<test>",
      BASE.replace(
        "presets: {},",
        "presets: { label: { root: { v: [ { h: ['git', 'directory'] } ] } } },",
      ),
      ALLOWED,
    );
    const stands = Object.keys(config.segments)
      .filter((n) => n.startsWith("edit."))
      .map(arrangedSegment)
      .filter((n) => n !== undefined);
    expect(stands.sort()).toEqual(["directory", "git", "trigger"]);
  });
});

// ─── end-to-end: toggle, remove, insert-via-menu, undo twice ──────────────

describe("edit mode click flow: toggle → remove → insert (menu) → undo × 2", () => {
  test("toggling edit mode on makes the `-` chrome render; off hides it again", async () => {
    const { render, click } = buildEditRuntime(BASE);
    const before = textOf(render());
    expect(before).not.toContain(REMOVE_GLYPH);

    const toggleUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    expect(toggleUrl).toBeDefined();
    await click(toggleUrl);

    const opened = textOf(render());
    expect(opened).toContain(REMOVE_GLYPH);
    // Edit mode shows each content cell as its segment's name, so the
    // trigger reads "trigger" until `☐ live` puts the live output back.
    expect(opened).toContain("trigger");
    expect(opened).not.toContain(" e ");
    const liveUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_LIVE_KEY && e.args[2] === "open",
      ),
    )!;
    await click(liveUrl);

    const closeUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "closed",
      ),
    )!;
    await click(closeUrl);
    expect(textOf(render())).not.toContain("-");
  });

  test("remove → insert (picked via menu) → undo × 2 returns the file to its original bytes", async () => {
    const { render, click, ctx } = buildEditRuntime(BASE);
    const original = durable.text()!;

    // Open edit mode.
    const openUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    await click(openUrl);

    // Remove "directory" via its `-`.
    const removeUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === "apply-layout-op" &&
          e.args[2] === encodeLayoutOp({ op: "remove", target: "directory" }),
      ),
    )!;
    expect(removeUrl).toBeDefined();
    await click(removeUrl);
    // The file's own root is the edited tree, in the authoring grammar.
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "trigger"] });
    expect(durable.history().past).toHaveLength(1);

    // Open every `+` menu, then pick "gitPr" from the one anchored on "git".
    // [LAW:no-silent-failure] This harness compiles ONE tree and never
    // reloads it from the file, so the `+` beside "directory" is still
    // rendered though "directory" is gone from the file — clicking THAT one
    // is exactly the stale-bar case the store refuses loudly (see
    // dsl-layout-edit.test.ts). Anchor on a segment the file still holds.
    for (const menuOpenUrl of ownUrls(render()).filter((u) =>
      effectsOf(u).some(
        (e) => e.verb === "set-state" && String(e.args[1]).startsWith("menus."),
      ),
    )) {
      await click(menuOpenUrl);
    }

    const pickUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === "apply-layout-op" &&
          decodeURIComponent(String(e.args[2])).startsWith("insert:gitPr:git:"),
      ),
    )!;
    expect(pickUrl).toBeDefined();
    await click(pickUrl);
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
    await undo(encodeURIComponent("s1"), ctx);
    expect(durable.parsed().root).toEqual({ v: [{ h: ["git"] }, "trigger"] });
    await undo(encodeURIComponent("s1"), ctx);
    // Byte-identical: the file IS the layout, so "back to the original
    // layout" and "back to the original bytes" are one fact.
    expect(durable.text()).toBe(original);
  });
});

// ─── chrome respects globals like any other segment ───────────────────────

describe("a segment row's chrome rides its row", () => {
  test("a bare-string row (`'trigger'` under the vertical root) renders as ONE line in edit mode, not four", async () => {
    const { render, click } = buildEditRuntime(BASE);
    const closed = textOf(render()).split("\n");
    const toggleUrl = ownUrls(render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    )!;
    await click(toggleUrl);
    const opened = textOf(render()).split("\n");
    expect(opened.some((line) => line.includes(REMOVE_GLYPH))).toBe(true);
    // One more line than the closed bar: edit mode's own top row, with
    // `✎ done`. The chrome itself adds none.
    expect(opened.length).toBe(closed.length + 1);
  });
});

describe("edit chrome is ordinary segment data — no special-cased render path", () => {
  test("padding applies to a chrome segment exactly like a hand-authored one", () => {
    const config = parseAndValidate("<test>", BASE, ALLOWED);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store, "", sessionState);
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
    const basePalette = getThemePalette("textual-dark"!);
    sessionState.set("s1", EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const renderWith = (padding: number): Frame =>
      drawPayload(
        config,
        compiled,
        store,
        registry,
        { session_id: "s1", project_dir: "/tmp/proj" },
        instantOf(new Date()),
        { ...opts(), padding },
      ).frame;
    const padded0 = textOf(renderWith(0));
    const padded2 = textOf(renderWith(2));
    // Same content, more surrounding whitespace at padding=2 — the chrome
    // segment's `-`/`+` cells widen by the same 2×padding every other
    // segment's cells do, since applySegmentLayout pads BEFORE sizing with
    // no knowledge of which segments are "chrome".
    expect(padded2.length).toBeGreaterThan(padded0.length);
  });
});

// ─── save and cancel (brandon-menu-ia-q30.3y8) ──────────────────────────────
//
// Every layout click is already written and already one step of the session's
// settings history, so edit mode's cancel is that history stepped back to where
// edit mode opened, and its save is only leaving. Driven through the real verb
// table: the clicks are the rendered links, and the assertions are on the file
// the clicks wrote.

describe("edit mode's save and cancel", () => {
  const find = (
    rt: ReturnType<typeof buildEditRuntime>,
    pick: (e: ReturnType<typeof effectsOf>[number]) => boolean,
  ): string => ownUrls(rt.render()).find((u) => effectsOf(u).some(pick))!;
  const open = async (rt: ReturnType<typeof buildEditRuntime>): Promise<void> =>
    await rt.click(
      find(
        rt,
        (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === EDIT_MODE_ARRANGE,
      ),
    );
  const removeGit = async (rt: ReturnType<typeof buildEditRuntime>): Promise<void> =>
    await rt.click(ownUrls(rt.render()).find((u) => u.includes("remove%253Agit"))!);
  const cancel = async (rt: ReturnType<typeof buildEditRuntime>): Promise<void> =>
    await rt.click(find(rt, (e) => e.verb === "rewind"));
  const done = async (rt: ReturnType<typeof buildEditRuntime>): Promise<void> =>
    await rt.click(
      ownUrls(rt.render()).find((u) => {
        const effects = effectsOf(u);
        return (
          !effects.some((e) => e.verb === "rewind") &&
          effects.some(
            (e) => e.args[1] === EDIT_MODE_KEY && e.args[2] === "closed",
          )
        );
      })!,
    );
  const topRow = (rt: ReturnType<typeof buildEditRuntime>): string =>
    textOf(rt.render()).split("\n")[0]!;

  test("the row reads ✓ done with nothing changed, and ✓ save ↩ cancel after a change", async () => {
    const rt = buildEditRuntime(BASE);
    await open(rt);
    expect(topRow(rt)).toContain("✓ done");
    expect(topRow(rt)).not.toContain("cancel");
    expect(topRow(rt)).toContain("☐ live");
    await removeGit(rt);
    expect(topRow(rt)).toContain("✓ save");
    expect(topRow(rt)).toContain("↩ cancel");
    // The live toggle left the bar's last row for the edit row, so the `(?)`
    // is alone after the content.
    const rows = textOf(rt.render()).split("\n");
    expect(rows.at(-1)).toContain("(?)");
    expect(rows.at(-1)).not.toContain("live");
  });

  test("cancel restores the file byte for byte, leaves edit mode, and leaves nothing to redo", async () => {
    const rt = buildEditRuntime(BASE);
    const original = durable.text();
    await open(rt);
    await removeGit(rt);
    expect(durable.text()).not.toBe(original);
    await cancel(rt);
    expect(durable.text()).toBe(original);
    expect(rt.sessionState.get("s1", EDIT_MODE_KEY)).not.toBe(
      EDIT_MODE_ARRANGE,
    );
    expect(rt.history.depth("s1")).toEqual({
      undo: 0,
      redo: 0,
      sinceEdit: 0,
    });
    expect(textOf(rt.render())).not.toContain("✓ done");
  });

  test("save keeps the change; the next time edit mode opens it counts from there", async () => {
    const rt = buildEditRuntime(BASE);
    const original = durable.text();
    await open(rt);
    await removeGit(rt);
    const edited = durable.text();
    await done(rt);
    expect(durable.text()).toBe(edited);
    expect(edited).not.toBe(original);
    expect(rt.history.depth("s1")).toEqual({
      undo: 1,
      redo: 0,
      sinceEdit: 0,
    });
    await open(rt);
    expect(topRow(rt)).toContain("✓ done");
  });

  test("cancel takes back only what edit mode did, and undoing afterwards does not resurrect it", async () => {
    const rt = buildEditRuntime(BASE);
    const original = durable.text();
    // A step from before edit mode opened.
    const earlier = rt.history.begin();
    earlier.sessionState.set("s1", "theme", "nord");
    earlier.commit();
    await open(rt);
    await removeGit(rt);
    await cancel(rt);
    expect(rt.history.depth("s1")).toEqual({
      undo: 1,
      redo: 0,
      sinceEdit: 0,
    });
    expect(rt.sessionState.get("s1", "theme")).toBe("nord");
    await VERBS.get("undo")!("s1", rt.ctx);
    expect(rt.sessionState.get("s1", "theme")).toBeNull();
    expect(durable.text()).toBe(original);
    expect(rt.history.depth("s1")).toEqual({
      undo: 0,
      redo: 1,
      sinceEdit: 0,
    });
  });

  test("rewind says what it put back, and a session with no savepoint is refused loudly", async () => {
    const rt = buildEditRuntime(BASE);
    await expect(VERBS.get("rewind")!("s1", rt.ctx)).rejects.toThrow(/no savepoint/);
    await open(rt);
    await removeGit(rt);
    const logs: string[] = [];
    await VERBS.get("rewind")!("s1", {
      ...rt.ctx,
      log: (_level, message) => logs.push(message),
    });
    expect(logs.join("\n")).toMatch(
      /rewind: put back .* as edit mode found it \(session=s1\)/,
    );
  });
});
