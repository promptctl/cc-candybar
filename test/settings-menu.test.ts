// [LAW:verifiable-goals] candybar-settings-ui-aok.1 acceptance — the global
// settings menu, driven through the real loader (parse → merge → validate), the
// real spine (registerDslConfig + renderDsl), and the real set-state gate.
//
// The measuring stick the ticket names: a USER config whose `root` is a whole
// tree of one row of two segments — a tree replaces the bundled rows, so the
// menu must be spliced into the user's own row. A change that only works from
// the bundled default has fixed nothing, so every case below starts from a
// user file merged over DEFAULT_DSL_CONFIG.
//
//   1. The menu renders from a minimal user root, and from it a user reaches
//      preset switching and edit mode.
//   2. Placement is a POSITION: placing the anchor moves the menu, removing it
//      puts it back at the default position, and the rendered content is the
//      same either way.
//   3. A second placement is a loud load error.
//   4. Every declared preset carries it — `compact` included, whose whole point
//      is being narrow.
//   5. It is chrome-exempt: edit mode offers no `-` that would delete the door
//      back into edit mode.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { POWERLINE_JOINER_GLYPHS } from "@promptctl/rich-js";
import type { RichText } from "@promptctl/rich-js";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { ConfigError } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames, presetRoot } from "../src/config/presets";
import {
  addableSegmentDomains,
  PRESET_CUSTOMIZED_VAR,
} from "../src/config/edit-chrome";
import {
  anchorUnderGate,
  BACK_GLYPH,
  countAnchors,
  SETTINGS_ANCHOR,
} from "../src/config/settings-menu";
import {
  isReservedName,
  SETTINGS_NS,
} from "../src/config/loader/reserved-namespace";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import { PAYLOAD_INPUTS } from "../src/config/payload-inputs";
import { menuStateKey, sharedMenuStateKey } from "../src/config/menu-keys";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  DOOR_CLOSE_GLYPH,
  DOOR_GLYPH,
} from "../src/config/disclosure";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import type { DslConfig, LayoutNode } from "../src/config/dsl-types";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import type { ActionDecl } from "../src/config/action";
import { SETTINGS, SETTING_PROJECTIONS } from "../src/config/setting-projections";
import { walkNodes } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());

// The lines an open menu stacks over the bar: its two door lines, then the
// body of the tab a fresh session opens it on (⚡ session: the quick actions,
// then the commands).
const MENU_LINES = 4;
const TAB_KEY = "candybar.tab";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};


// The acceptance shape, verbatim: a user file that declares its own `root` of
// one row of two segments, merged over the BUNDLED default (production's
// cascade), never over an empty one.
function userConfig(root: string): string {
  return `{
    globals: {},
    root: ${root},
  }`;
}

const TWO_SEGMENT_ROW = `{ h: ['directory', 'model'] }`;

function buildRuntime(src: string, dflt: DslConfig = DEFAULT_DSL_CONFIG) {
  const config = parseAndValidate("<user>", src, ALLOWED, dflt);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  // Each segment's cells from the last render, by name.
  const sink = new Map<string, readonly RichText[]>();
  const render = (): string => {
    sink.clear();
    return renderDsl(config, compiled, store, registry, PAYLOAD, OPTS, {
      perSegmentSink: sink,
    });
  };
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx: VerbContext = testVerbContext(sessionState);
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
  // Click the affordance whose URL writes `value` to `key`, wherever it landed.
  const clickWriting = (out: string, key: string, value: string): void => {
    const url = linkUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, sink, render, click, clickWriting, dispose };
}

const PAYLOAD = {
  session_id: "s1",
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

// The tree a render actually walks: the active preset's resolved root, which is
// what the synthesis passes rewrite. `config.root` stays as the author wrote it.
function resolvedRoot(config: DslConfig, preset = "default"): LayoutNode {
  return presetRoot(config, preset).node;
}

function segmentNames(node: LayoutNode): string[] {
  return node.kind === "segment"
    ? [node.name]
    : node.children.flatMap(segmentNames);
}

// ─── 1. Reachable from a minimal user root ───────────────────────────────────

describe("the global settings menu is reachable from a user config", () => {
  test("a user root of one row of two segments still renders the menu", () => {
    const { render, dispose } = buildRuntime(userConfig(TWO_SEGMENT_ROW));
    // The user declared two segments; the bar shows three cells, and the first
    // is the door their `root` could not close.
    expect(stripAnsi(render())).toContain(DOOR_GLYPH);
    dispose();
  });

  test("the toggle opens a body carrying preset switching and the tabs", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    const closed = stripAnsi(render());
    expect(closed).not.toContain("⚡ session");

    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = stripAnsi(render());
    // One symbol per state: the open door is the ❌, and the door glyph is gone.
    expect(opened).toContain(DOOR_CLOSE_GLYPH);
    expect(opened).not.toContain(DOOR_GLYPH);
    // Switch presets (the picker's own disclosure glyph, hosted by the preset
    // entry), and edit mode one tab away.
    expect(opened).toContain("▦");
    expect(opened).toContain("📐 layout");
    clickWriting(render(), TAB_KEY, "layout");
    expect(stripAnsi(render())).toContain("✎ arrange");
    dispose();
  });

  // brandon-menu-ia-q30.4oj: the menu opens ABOVE the bar and leaves the
  // bar's own rows as they were.
  test("the menu opens above the bar: two lines stacked over rows that do not change", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(`{ v: [${TWO_SEGMENT_ROW}, { h: ['context'] }] }`),
    );
    const closed = render().split("\n");
    expect(stripAnsi(closed[0]!)).toContain("Opus");
    expect(stripAnsi(closed.join("\n"))).not.toContain("⎘ id");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = render().split("\n");
    expect(opened).toHaveLength(closed.length + MENU_LINES);
    const [line1 = "", line2 = "", line3 = ""] = opened.map(stripAnsi);
    const bar = opened.slice(MENU_LINES).map(stripAnsi);
    // Line 1: the preset control. Line 2: the tabs. Then the open tab's body.
    expect(line1).toContain("▦");
    expect(line1).not.toContain("⎘ id");
    expect(line2.indexOf("⚡ session")).toBeLessThan(line2.indexOf("🧰 tools"));
    expect(line3).toContain("↗ proj");
    // The bar: the door wears ❌, every other byte of every other row is
    // what it was.
    expect(bar[0]!.replace(DOOR_CLOSE_GLYPH, DOOR_GLYPH)).toBe(stripAnsi(closed[0]!));
    expect(opened.slice(MENU_LINES + 1)).toEqual(closed.slice(1));
    dispose();
  });

  test("a door on a row of its own leaves every other row byte-identical", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(`{ v: ['${SETTINGS_ANCHOR}', ${TWO_SEGMENT_ROW}, { h: ['context'] }] }`),
    );
    const closed = render().split("\n");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = render().split("\n");
    expect(opened).toHaveLength(closed.length + MENU_LINES);
    expect(stripAnsi(opened[MENU_LINES]!)).toContain(DOOR_CLOSE_GLYPH);
    expect(opened.slice(MENU_LINES + 1)).toEqual(closed.slice(1));
    dispose();
  });

  test("an open sibling's body stays open under the open menu", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(
        `{ h: ['directory', { kind: 'group', name: 'g', label: 'more', children: ['model'] }] }`,
      ),
    );
    clickWriting(render(), "groups.g", "g");
    const before = stripAnsi(render()).split("\n");
    expect(before.join("\n")).toContain("Opus");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = stripAnsi(render()).split("\n");
    expect(opened.slice(MENU_LINES).map((l) => l.replace(DOOR_CLOSE_GLYPH, DOOR_GLYPH))).toEqual(before);
    dispose();
  });

  test("a door placed deep in the tree lifts its menu over the whole bar", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(
        `{ v: [{ h: ['context'] }, { h: [{ v: ['${SETTINGS_ANCHOR}', { h: ['directory'] }] }, 'model'] }] }`,
      ),
    );
    const closed = stripAnsi(render()).split("\n");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = stripAnsi(render()).split("\n");
    expect(opened[2]).toContain("⎘ id");
    expect(opened.slice(MENU_LINES).map((l) => l.replace(DOOR_CLOSE_GLYPH, DOOR_GLYPH))).toEqual(closed);
    dispose();
  });

  test("edit mode is genuinely reachable: the menu's ✎ writes edit.mode and closes the menu", () => {
    const { render, clickWriting, sessionState, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    clickWriting(render(), TAB_KEY, "layout");
    clickWriting(render(), EDIT_MODE_KEY, "arrange");
    expect(sessionState.get("s1", EDIT_MODE_KEY)).toBe("arrange");
    // The same click closed the menu, so the door's row is back — with its
    // edit chrome — and no close click is needed to reach it.
    expect(sessionState.get("s1", SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    // Edit mode being ON is what makes the `+`/`-` chrome visible. Asserted on the affordances' own verb, not on a bare "-" glyph that
    // any template could have produced.
    const editing = linkUrls(render()).filter((u) =>
      u.includes("apply-layout-op"),
    );
    expect(editing.length).toBeGreaterThan(0);
    // Leaving needs no trip back into the menu: edit mode's own `✎ done`,
    // top left, lands on the plain bar.
    clickWriting(render(), EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    expect(sessionState.get("s1", EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
    expect(sessionState.get("s1", SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    dispose();
  });

  test("the preset picker's click is admitted by the derived gate", () => {
    const { render, click, clickWriting, sessionState, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    // Open the picker's own disclosure, then pick `compact` from its options.
    // Both clicks go through the real verb handlers against the derived gate —
    // a menu the gate did not admit would throw here, not silently no-op.
    const pickerUrl = linkUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[1]?.startsWith("menus.candybar_")),
    );
    expect(pickerUrl).toBeDefined();
    click(pickerUrl!);
    clickWriting(render(), "preset", "compact");
    expect(sessionState.get("s1", "preset")).toBe("compact");
    dispose();
  });
});

// ─── 2. Placement is a position ──────────────────────────────────────────────

describe("placement is a position, not a mode", () => {
  test("placing the anchor moves the menu; the rendered content is the same", () => {
    const defaulted = buildRuntime(userConfig(TWO_SEGMENT_ROW));
    const placed = buildRuntime(
      userConfig(`{ v: [${TWO_SEGMENT_ROW}, '${SETTINGS_ANCHOR}'] }`),
    );

    const defaultedLines = stripAnsi(defaulted.render()).split("\n");
    const placedLines = stripAnsi(placed.render()).split("\n");

    // Defaulted: the menu joins the bar's first row. Placed: it is the row the
    // author put it on. Same cell, different position — one splice, two values.
    expect(defaultedLines[0]).toContain(DOOR_GLYPH);
    expect(placedLines[0]).not.toContain(DOOR_GLYPH);
    expect(placedLines[1]).toContain(DOOR_GLYPH);

    defaulted.dispose();
    placed.dispose();
  });

  test("a bare-segment root grows the menu beside it", () => {
    const { render, dispose } = buildRuntime(userConfig(`'directory'`));
    expect(stripAnsi(render())).toContain(DOOR_GLYPH);
    dispose();
  });

  test("the anchor appears exactly once in every resolved preset root", () => {
    const config = parseAndValidate(
      "<user>",
      userConfig(TWO_SEGMENT_ROW),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    // Including `compact`, whose whole point is being narrow, and `verbose`.
    expect(presetNames(config.presets)).toEqual(
      expect.arrayContaining(["default", "compact", "verbose"]),
    );
    for (const name of presetNames(config.presets)) {
      expect(countAnchors(resolvedRoot(config, name))).toBe(1);
    }
  });

  test("an author's placement is honored in the preset that declares it", () => {
    const config = parseAndValidate(
      "<user>",
      `{
        globals: {},
        root: { h: ['directory'] },
        presets: {
          alt: { root: { v: ['${SETTINGS_ANCHOR}', { h: ['model'] }] } },
        },
      }`,
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    // The alt preset put the menu FIRST; the splice left it there rather than
    // appending a second one.
    expect(countAnchors(resolvedRoot(config, "alt"))).toBe(1);
    const names = segmentNames(resolvedRoot(config, "alt")).filter((n) =>
      n.startsWith(SETTINGS_NS),
    );
    expect(names[0]).toBe(SETTINGS_ANCHOR);
  });
});

// ─── 3. A second placement is a loud load error ──────────────────────────────

describe("the anchor may be placed at most once", () => {
  test("two placements in one layout fail at load, naming the problem", () => {
    expect(() =>
      parseAndValidate(
        "<user>",
        userConfig(
          `{ v: [{ h: ['directory', '${SETTINGS_ANCHOR}'] }, '${SETTINGS_ANCHOR}'] }`,
        ),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(ConfigError);
  });

  test("the error names the anchor and the at-most-once rule", () => {
    try {
      parseAndValidate(
        "<user>",
        userConfig(`{ h: ['${SETTINGS_ANCHOR}', '${SETTINGS_ANCHOR}'] }`),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(SETTINGS_ANCHOR);
      expect((err as ConfigError).message).toContain("at most once");
    }
  });

  test("a preset's `{ rows }` fragment adding a second placement over the config's row fails, naming the preset", () => {
    try {
      parseAndValidate(
        "<user>",
        `{
          globals: {},
          root: { h: ['directory', '${SETTINGS_ANCHOR}'] },
          presets: { wide: { root: { rows: { extra: { h: ['${SETTINGS_ANCHOR}'] } } } } },
        }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("presets.wide.root");
      expect((err as ConfigError).message).toContain("at most once");
    }
  });

  test("a user declaration under the reserved namespace is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<user>",
        `{
          globals: {},
          segments: { '${SETTINGS_NS}mine': { template: 'x' } },
          root: { h: ['directory'] },
        }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/reserved/);
  });
});

// ─── 3b. A `when` the author wrote never reaches the menu ────────────────────

// The guarantee is "present in every bar, whatever the config says". A `when`
// on the row the default placement lands in used to defeat it silently: the
// anchor inherited the gate, so an author writing an ordinary conditional row
// (a git row shown only inside a repo) deleted the undeletable door by accident
// under exactly that condition. Asserted on the resolved tree rather than on a
// render, because it must hold for every value the predicate could take.
// ─── The tab strip (brandon-menu-tabs-wnu.qqz) ───────────────────────────────

describe("the menu's second line is five tabs, one open at a time", () => {
  const TABS = ["session", "look", "layout", "config", "tools"] as const;
  const tabSeg = (tab: string) => `${TAB_KEY}.${tab}`;
  const bgOf = (cells: readonly RichText[] | undefined): string | undefined => {
    const style = cells?.[0]?.style;
    return typeof style === "object" ? style.bgcolor?.value?.hex : undefined;
  };
  // The segments a node renders, a disclosure's body included.
  const deepNames = (node: LayoutNode): string[] =>
    [...walkNodes(node)].flatMap((n) => (n.kind === "segment" ? [n.name] : []));

  test("opening a tab closes the others, and the open one alone wears its state colour", () => {
    const { render, clickWriting, sink, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    // What each tab's click writes: the open one's closes it, every other
    // one's opens that tab.
    const writes = (rendered: string) =>
      linkUrls(rendered).flatMap((u) =>
        effectsOf(u).flatMap((e) => (e.args[1] === TAB_KEY ? [e.args[2]] : [])),
      );
    for (const open of TABS) {
      // A fresh session opens on ⚡ session, so only the others take a click.
      if (open !== "session") clickWriting(render(), TAB_KEY, open);
      const raw = render();
      const out = stripAnsi(raw);
      expect(writes(raw)).not.toContain(open);
      expect(writes(raw)).toContain(DISCLOSURE_CLOSED);
      // Every tab stays on the strip; one body hangs below it.
      for (const tab of TABS) expect(sink.has(tabSeg(tab))).toBe(true);
      const openBg = bgOf(sink.get(tabSeg(open)));
      const closedBgs = TABS.filter((t) => t !== open).map((t) => bgOf(sink.get(tabSeg(t))));
      expect(openBg).toBeDefined();
      expect(closedBgs).not.toContain(openBg);
      // The body is the open tab's: its first control, and no other tab's.
      const marker = { session: "⎘ id", look: "◐ ", layout: "✎ arrange", config: "🔣 ", tools: "🩺 doctor" };
      for (const tab of TABS) {
        expect([tab, out.includes(marker[tab])]).toEqual([tab, tab === open]);
      }
    }
    dispose();
  });

  test("closing the menu and reopening it returns to the last tab", () => {
    const { render, clickWriting, sessionState, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    // A fresh session opens on ⚡ session.
    expect(stripAnsi(render())).toContain("⎘ id");
    clickWriting(render(), TAB_KEY, "tools");
    clickWriting(render(), SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    expect(stripAnsi(render())).not.toContain("🩺 doctor");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    expect(sessionState.get("s1", TAB_KEY)).toBe("tools");
    expect(stripAnsi(render())).toContain("🩺 doctor");
    dispose();
  });

  test("every setting's control is in exactly one place: the door's first line or one tab", () => {
    const config = parseAndValidate("<user>", userConfig(TWO_SEGMENT_ROW), ALLOWED, DEFAULT_DSL_CONFIG);
    const door = [...walkNodes(resolvedRoot(config))].find(
      (n) => n.kind === "segment" && n.name === SETTINGS_ANCHOR,
    );
    if (door?.kind !== "segment" || door.opens === undefined) throw new Error("no door");
    const [line1, line2] = door.opens.body.children;
    if (line1 === undefined || line2?.kind !== "container") throw new Error("no door lines");
    // Where each name renders: the first line, or the tab whose body holds it.
    const places = new Map<string, string[]>();
    const note = (name: string, place: string) => places.set(name, [...(places.get(name) ?? []), place]);
    for (const name of deepNames(line1)) note(name, "door");
    expect(line2.children.map((n: LayoutNode) => (n.kind === "segment" ? n.name : "?"))).toEqual(TABS.map(tabSeg));
    for (const tab of line2.children) {
      if (tab.kind !== "segment" || tab.opens === undefined) throw new Error("a tab opens a body");
      for (const name of deepNames(tab.opens.body)) note(name, tab.name);
    }
    for (const name of Object.keys(SETTINGS)) {
      expect([name, places.get(`${SETTINGS_NS}${name}`)?.length]).toEqual([name, 1]);
    }
  });
});

describe("the default placement never inherits an author's gate", () => {
  // Every `when` on the path from the resolved root down to the anchor.
  function gatesOverAnchor(node: LayoutNode): string[] {
    const walk = (n: LayoutNode, above: string[]): string[] | null => {
      const here = n.when === undefined ? above : [...above, n.when];
      if (n.kind === "segment") return n.name === SETTINGS_ANCHOR ? here : null;
      for (const child of n.children) {
        const found = walk(child, here);
        if (found !== null) return found;
      }
      return null;
    };
    const gates = walk(node, []);
    if (gates === null) throw new Error("no anchor in the resolved root");
    return gates;
  }

  const GATE = `{{ .flag }}`;
  const withFlag = (root: string): string => `{
    globals: {},
    variables: { flag: { kind: 'literal', value: 'x' } },
    root: ${root},
  }`;

  test.each([
    [
      "a gated first row",
      `{ v: [{ h: ['directory','model'], when: '${GATE}' }, { h: ['context'] }] }`,
    ],
    [
      "a gated first row whose siblings are gated too",
      `{ v: [{ h: ['directory'], when: '${GATE}' }, { h: ['context'], when: '${GATE}' }] }`,
    ],
    [
      "a gated row nested a level down",
      `{ v: [{ v: [{ h: ['directory'], when: '${GATE}' }] }] }`,
    ],
    ["an ungated root (control)", `{ v: [{ h: ['directory','model'] }] }`],
  ])("%s leaves the menu ungated", (_label, root) => {
    const config = parseAndValidate(
      "<user>",
      withFlag(root),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    expect(gatesOverAnchor(resolvedRoot(config))).toEqual([]);
  });

  test("the author's own gate stays on the author's own content", () => {
    const config = parseAndValidate(
      "<user>",
      withFlag(
        `{ v: [{ h: ['directory','model'], when: '${GATE}' }, { h: ['context'] }] }`,
      ),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    // Lifting the menu out of the gate must not lift the row out of it too.
    const gatesOver = (target: string): string[] => {
      const walk = (n: LayoutNode, above: string[]): string[] | null => {
        const here = n.when === undefined ? above : [...above, n.when];
        if (n.kind === "segment") return n.name === target ? here : null;
        for (const child of n.children) {
          const found = walk(child, here);
          if (found !== null) return found;
        }
        return null;
      };
      return walk(resolvedRoot(config), []) ?? [];
    };
    // Edit mode's names view composes over it, and the author's gate decides
    // every other view verbatim.
    expect(gatesOver("directory").some((g) => g.includes(GATE))).toBe(true);
  });

  test.each([
    ["a bare-segment root", `{ seg: 'directory', when: '${GATE}' }`],
    ["a single-row root", `{ h: ['directory','model'], when: '${GATE}' }`],
    ["a vertical root", `{ v: [{ h: ['directory'] }], when: '${GATE}' }`],
  ])("a `when` on %s leaves the menu ungated", (_label, root) => {
    const config = parseAndValidate(
      "<user>",
      withFlag(root),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    expect(gatesOverAnchor(resolvedRoot(config))).toEqual([]);
  });

  test("a gated first row whose gate holds shares the door's line", () => {
    const { render, dispose } = buildRuntime(
      `{ globals: {}, root: { v: [{ h: ['directory','model'], when: '{{ eq "a" "a" }}' }] } }`,
    );
    const bar = stripAnsi(render());
    expect(bar.split("\n")).toHaveLength(1);
    expect(bar).toContain(DOOR_GLYPH);
    expect(bar).toContain("Opus");
    dispose();
  });

  test("a gated stack keeps its rows under the open menu", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      `{ globals: {}, root: { v: [{ v: [{ h: ['directory'] }, { h: ['model'] }], when: '{{ eq "a" "a" }}' }] } }`,
    );
    const closed = stripAnsi(render()).split("\n");
    expect(closed).toHaveLength(3);
    expect(closed[0]).toContain(DOOR_GLYPH);
    expect(closed[0]).not.toContain("proj");
    expect(closed[2]).toContain("Opus");
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = stripAnsi(render()).split("\n");
    expect(opened).toHaveLength(closed.length + MENU_LINES);
    // The `◁` slot leads the door's cell; this runtime records no back
    // history, so it holds the blank of the glyph's width.
    const backSlot = " ".repeat(BACK_GLYPH.length);
    expect(opened[MENU_LINES]!.startsWith(POWERLINE_JOINER_GLYPHS.lead + backSlot + DOOR_CLOSE_GLYPH)).toBe(true);
    expect(opened.slice(MENU_LINES + 1)).toEqual(closed.slice(1));
    dispose();
  });

  test("a bar gated away entirely still renders its door", () => {
    const { render, dispose } = buildRuntime(
      `{ globals: {}, root: { h: ['directory','model'], when: '{{ eq "a" "b" }}' } }`,
    );
    const bar = stripAnsi(render());
    expect(bar).toContain(DOOR_GLYPH);
    expect(bar).not.toContain("Opus");
    dispose();
  });

  test.each([
    [
      "inside a gated row",
      `{ v: [{ h: ['directory','${SETTINGS_ANCHOR}'], when: '${GATE}' }] }`,
    ],
    ["with its own gate", `{ h: ['directory', { seg: '${SETTINGS_ANCHOR}', when: '${GATE}' }] }`],
    [
      "inside a group body",
      `{ h: ['directory', { kind: 'group', name: 'g', label: 'g', children: ['${SETTINGS_ANCHOR}'] }] }`,
    ],
  ])("an author placement %s is a load error", (_label, root) => {
    expect(() =>
      parseAndValidate("<user>", withFlag(root), ALLOWED, DEFAULT_DSL_CONFIG),
    ).toThrow(/may not be gated/);
  });

  test("the gate census sees every gate over the anchor", () => {
    const anchor: LayoutNode = { kind: "segment", name: SETTINGS_ANCHOR };
    expect(anchorUnderGate(anchor)).toBe(false);
    expect(anchorUnderGate({ ...anchor, when: GATE })).toBe(true);
    expect(
      anchorUnderGate({
        kind: "container",
        direction: "horizontal",
        when: GATE,
        children: [anchor],
      }),
    ).toBe(true);
  });
});

// ─── 4. The menu needs nothing from the config ──────────────────────────────

// [LAW:verifiable-goals] brandon-settings-menu-d6f: "The settings menu should
// always be visible no matter what." The synthesis supplies every input its
// artifacts read, so a config that declares no variables at all — reachable
// only over the EMPTY default, since production merges the bundled one — still
// carries a door, and every disclosure behind it renders without a ⚠.
describe("the menu in a config that declares no variables", () => {
  const BARE = `{
    globals: {},
    segments: { hello: { template: 'hi' } },
    root: { h: ['hello'] },
  }`;

  // Every key the config holds in a disclosure state: a key some action
  // cycles out of the closed sentinel.
  const disclosureKeys = (config: DslConfig): Set<string> =>
    new Set(
      Object.values(config.actions).flatMap((a) =>
        "set" in a && "cycle" in a && a.cycle[0] === DISCLOSURE_CLOSED ? [a.set] : [],
      ),
    );

  test("loads, renders the door, and opens every disclosure without a ⚠", () => {
    const { config, render, click, dispose } = buildRuntime(BARE, EMPTY_DEFAULT);
    const keys = disclosureKeys(config);
    const first = stripAnsi(render());
    expect(first).toContain(DOOR_GLYPH);
    expect(first).not.toContain("⚠");
    // Click every affordance that opens a disclosure, until a render offers no
    // opening not already taken; every render on the way is checked.
    const opened = new Set<string>();
    for (let frontier = true; frontier; ) {
      frontier = false;
      for (const url of linkUrls(render())) {
        const opens = effectsOf(url).filter(
          (e) => keys.has(String(e.args[1])) && e.args[2] !== DISCLOSURE_CLOSED,
        );
        const id = opens.map((e) => `${e.args[1]}=${e.args[2]}`).join("&");
        if (opens.length === 0 || opened.has(id)) continue;
        opened.add(id);
        click(url);
        const out = stripAnsi(render());
        expect(out).not.toContain("⚠");
        frontier = true;
        break;
      }
    }
    // The walk reached the menu's own disclosures, not just the door.
    expect([...opened].some((id) => id.startsWith(SETTINGS_ANCHOR))).toBe(true);
    expect(opened.size).toBeGreaterThan(3);
    dispose();
  });

  test("an authored placement of the anchor loads", () => {
    const config = parseAndValidate(
      "<user>",
      `{
        globals: {},
        segments: { hello: { template: 'hi' } },
        root: { h: ['hello', '${SETTINGS_ANCHOR}'] },
      }`,
      ALLOWED,
    );
    const placed = segmentNames(resolvedRoot(config));
    for (const name of placed) {
      expect(Object.keys(config.segments)).toContain(name);
    }
    // The author's position holds: the door follows `hello`.
    expect(placed.indexOf(SETTINGS_ANCHOR)).toBeGreaterThan(placed.indexOf("hello"));
  });

  test("a config declaring nothing is given the payload inputs the chrome reads", () => {
    const bare = parseAndValidate("<user>", BARE, ALLOWED);
    const ensured = Object.keys(bare.variables).filter(
      (name) => !isReservedName(name),
    );
    // Each one is THE bundled declaration, and the reads that cross no
    // template text are among them: session.id (every click) and the
    // banner's `.preset.customized`.
    for (const name of ensured) {
      expect(bare.variables[name]).toEqual(PAYLOAD_INPUTS[name]);
    }
    expect(ensured).toEqual(
      expect.arrayContaining(["session.id", PRESET_CUSTOMIZED_VAR]),
    );
  });

  test("a user's own declaration of an ensured name is kept", () => {
    const own = {
      kind: "input",
      path: "workspace.somewhere_else",
      default: "mine",
    } as const;
    const config = parseAndValidate(
      "<user>",
      `{
        globals: {},
        variables: { project_dir: ${JSON.stringify(own)} },
        segments: { hello: { template: 'hi' } },
        root: { h: ['hello'] },
      }`,
      ALLOWED,
    );
    expect(config.variables.project_dir).toEqual(own);
  });
});

// ─── 5. Structural: edit mode cannot delete its own door ─────────────────────

// [LAW:behavior-not-structure] brandon-menus-du8. The settings menu's four config
// pickers share the accordion key `candybar.pickers`, and a shared key joining an
// accordion is the mechanism BY DESIGN — so a user menu that derives the same key
// joined that accordion, and opening the user's menu closed the settings picker
// with no error naming the cause. The pin is the BEHAVIOUR, over every spelling
// `ident()` collapses to the same identifier, not the one spelling the reviewer's
// proposed `isReservedName(key)` check would have caught.
describe("a user menu cannot join a synthesized accordion", () => {
  // A real declared action, so the only thing a case can fail on is the key.
  const withKey = (key: string): string => `{
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    actions: { pickTheme: { set: 'theme', from: 'themes' } },
    segments: {
      hello: { template: 'hi {{ menu "pickTheme" "▸" "▾" (dict "key" "${key}") }}' },
    },
    root: { h: ['hello'] },
  }`;

  // The three spellings `ident()` collapses to `candybar_pickers` — the key the
  // settings menu's picker accordion mints. Only the first starts with the
  // authored prefix `"candybar."`, which is why a check on the authored spelling
  // closes one case of three and the collapse has to be compared instead.
  for (const key of ["candybar.pickers", "candybar-pickers", "candybar_pickers"]) {
    test(`the key "${key}" is a load error naming the reserved namespace`, () => {
      try {
        parseAndValidate("<user>", withKey(key), ALLOWED);
        throw new Error(`expected a ConfigError for key "${key}"`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as ConfigError).message;
        expect(message).toContain(SETTINGS_NS);
        // It names the derived key, so the author sees WHY their spelling is the
        // reserved one — the collapse is the part they cannot see.
        expect(message).toContain("menus.candybar_pickers");
        expect(message).toContain("hello");
      }
    });
  }

  // Every namespace on the one reserved list, not just the one that mints an
  // accordion today: a later pass minting one under `groups.`/`edit.`/`menus.`
  // must not have to remember to extend a second list [LAW:carrying-cost].
  for (const key of ["groups.main", "edit.things", "menus.mine"]) {
    test(`the key "${key}" is refused too — the rule is the one namespace list`, () => {
      expect(() => parseAndValidate("<user>", withKey(key), ALLOWED)).toThrow(
        ConfigError,
      );
    });
  }

  // The rule is about the NAMESPACE, not about the word: the reserved prefixes
  // all carry a dot, so a bare name that merely looks like one is an ordinary
  // accordion key and keeps working.
  for (const key of ["settings", "pickers", "mysettings"]) {
    test(`the ordinary key "${key}" still loads and owns its own state key`, () => {
      const config = parseAndValidate("<user>", withKey(key), ALLOWED);
      const stateKey = sharedMenuStateKey(key);
      expect(Object.keys(config.variables)).toContain(stateKey);
      // …and it is not the settings pickers' key, which is what "does not share
      // state" means in this ticket's own words.
      expect(stateKey).not.toBe(sharedMenuStateKey(`${SETTINGS_NS}pickers`));
    });
  }

  test("the collision the gate exists for is real, as a value", () => {
    // Independent of the gate: these three spellings derive ONE state key, and it
    // is the settings pickers' key. If someone ever "simplifies" ident() so this
    // stops holding, the gate above becomes theatre and this test says so.
    const settingsPickers = sharedMenuStateKey(`${SETTINGS_NS}pickers`);
    for (const key of ["candybar.pickers", "candybar-pickers", "candybar_pickers"]) {
      expect(sharedMenuStateKey(key)).toBe(settingsPickers);
    }
  });

  test("a shared key and an independent key can never be the same key", () => {
    // The other half of why only the reserved case needed a gate: ident() emits
    // no dot, so a shared key holds none after the namespace and an independent
    // one holds exactly one. The two ranges are disjoint for ALL inputs, which is
    // why an authored independent menu needs no reservation of its own.
    const independent = menuStateKey("settings", "pickers", undefined);
    expect(independent).toBe("menus.settings.pickers");
    expect(sharedMenuStateKey("settings.pickers")).not.toBe(independent);
    for (const key of ["a", "a.b", "a-b-c", "settings.pickers"]) {
      expect(sharedMenuStateKey(key).slice("menus.".length)).not.toContain(".");
    }
  });

  test("the settings menu's own pickers still share one accordion", () => {
    // The gate runs at load over AUTHORED menus only; the settings menu
    // synthesizes its artifacts in validateConfig, after that pass, so its own
    // reserved key is never asked to pass its own gate. If that ordering ever
    // changed, this is the test that would say so.
    const config = parseAndValidate(
      "<user>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        segments: { hello: { template: 'hi' } },
        root: { h: ['hello'] },
      }`,
      ALLOWED,
    );
    const pickerStateKey = sharedMenuStateKey(`${SETTINGS_NS}pickers`);
    expect(Object.keys(config.variables)).toContain(pickerStateKey);
    // One key, and more than one menu's cycle action written onto it — that IS
    // the accordion.
    const cyclesOnIt = Object.keys(config.actions).filter((name) =>
      name.startsWith(`${pickerStateKey}.`),
    );
    expect(cyclesOnIt.length).toBeGreaterThan(1);
  });
});

describe("the menu is chrome-exempt", () => {
  test("no `-` affordance targets a settings segment", () => {
    const config = parseAndValidate(
      "<user>",
      userConfig(TWO_SEGMENT_ROW),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    const removals = Object.values(config.actions).flatMap((a) =>
      "removeSegment" in a && typeof a.removeSegment === "string"
        ? [a.removeSegment]
        : [],
    );
    expect(removals.length).toBeGreaterThan(0);
    for (const target of removals) {
      expect(target.startsWith(SETTINGS_NS)).toBe(false);
    }
  });

  test("no `+` picker offers a settings segment back", () => {
    const config = parseAndValidate(
      "<user>",
      userConfig(TWO_SEGMENT_ROW),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    // The addable domain is "declared, non-exempt segments".
    // A settings segment in it would mean `+` could insert a second copy of the
    // one node that must exist exactly once.
    const compiled = registerDslConfig(
      config,
      new SourceRegistry(
        new VariableStore(),
        "",
        undefined,
        new SessionState(),
      ),
      { cwd: "/tmp/proj" },
    );
    expect(compiled).toBeDefined();
    // Asserted on the domain's VALUES, never on `insertSegmentFrom` — that
    // field holds the domain's NAME (`ADDABLE_DOMAIN`, `edit.addable`),
    // which is EDIT_NS-prefixed by construction, so checking it for a
    // SETTINGS_NS prefix passes however broken `isChromeExempt` gets.
    const domains = [...addableSegmentDomains(config).values()];
    // The non-emptiness is half the assertion: `every` over an empty list is
    // the same vacuous pass one indirection further out.
    expect(domains.length).toBeGreaterThan(0);
    for (const { members } of domains) {
      expect(members.length).toBeGreaterThan(0);
      expect(members.filter((n) => n.startsWith(SETTINGS_NS))).toEqual([]);
    }
  });
});

describe("globals.menuGlyph", () => {
  test("a config's glyph is the closed door", () => {
    const { render, dispose } = buildRuntime(
      `{ globals: { menuGlyph: "🍬" }, root: ${TWO_SEGMENT_ROW} }`,
    );
    const out = stripAnsi(render());
    expect(out).toContain("🍬");
    expect(out).not.toContain(DOOR_GLYPH);
    dispose();
  });

  test("a glyph spelling template syntax is text", () => {
    const { render, dispose } = buildRuntime(
      `{ globals: { menuGlyph: "🍬 .x}}" }, root: ${TWO_SEGMENT_ROW} }`,
    );
    expect(stripAnsi(render())).toContain("🍬 .x}}");
    dispose();
  });

  test.each([
    ...[
      "",
      " ",
      "a\nb",
      DOOR_CLOSE_GLYPH,
      `${DOOR_CLOSE_GLYPH}\uFE0F`,
      DISCLOSURE_GLYPH_CLOSE,
    ].map((glyph) => [
      `{ globals: { menuGlyph: ${JSON.stringify(glyph)} } }`,
      "globals.menuGlyph: must be one line of visible text",
    ]),
    [
      `{ presets: { compact: { globals: { menuGlyph: "🍬" } } } }`,
      "a preset cannot change the settings menu glyph",
    ],
  ])("%s is a load error", (src, message) => {
    expect(() =>
      parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG),
    ).toThrow(message);
  });
});

// [LAW:one-source-of-truth] Every control the menu mints picks the session key
// of one SETTING_PROJECTIONS row, so the render knows how to read its current
// value back, through a variable the bundled default declares, and a save
// knows which config field the pick stands for. The menu spreads its keys from
// that table, so this holds by construction for the controls built from it.
describe("every settings control has a setting projection", () => {
  const config = parseAndValidate(
    "<user>",
    userConfig(TWO_SEGMENT_ROW),
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const controls = Object.entries(config.actions).filter(([name]) =>
    name.startsWith("candybar.apply."),
  );
  const sessionKey = (a: ActionDecl): string =>
    "set" in a ? a.set : `(not a set: ${JSON.stringify(a)})`;

  test("the menu mints a control for every setting in the table", () => {
    expect(new Set(controls.map(([, a]) => sessionKey(a)))).toEqual(
      new Set(SETTING_PROJECTIONS.map((p) => p.sessionKey)),
    );
  });

  test.each(controls)("%s picks the session key of one projection", (_name, a) => {
    expect(SETTING_PROJECTIONS).toContainEqual(
      expect.objectContaining({ sessionKey: sessionKey(a) }),
    );
  });

  test.each(SETTING_PROJECTIONS.map((p) => [p.effectiveVar]))(
    "%s is declared in the bundled default",
    (effectiveVar) => {
      expect(DEFAULT_DSL_CONFIG.variables[effectiveVar]).toBeDefined();
    },
  );
});
