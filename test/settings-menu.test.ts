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

import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
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
import { addableSegmentDomains } from "../src/config/edit-chrome";
import {
  countAnchors,
  SETTINGS_ANCHOR,
  SETTINGS_NS,
} from "../src/config/settings-menu";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { VERBS } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import type { DslConfig, LayoutNode } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

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

function buildRuntime(src: string) {
  const config = parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const basePalette = getThemePalette("textual-dark"!);
  const render = (): string =>
    renderDsl(config, compiled, store, registry, PAYLOAD, basePalette, OPTS);
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
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, sessionState, render, click, clickWriting, dispose };
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
    // The user declared two segments; the bar shows three cells, and the third
    // is the door their `root` could not close.
    expect(stripAnsi(render())).toContain("☰ ▸");
    dispose();
  });

  test("the toggle opens a body carrying preset switching and edit mode", () => {
    const { render, clickWriting, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    const closed = stripAnsi(render());
    expect(closed).not.toContain("✎ edit");

    clickWriting(render(), SETTINGS_ANCHOR, "open");
    const opened = stripAnsi(render());
    expect(opened).toContain("☰ ▾");
    // The two things the ticket's acceptance names: enter edit mode, and switch
    // presets (the picker's own disclosure glyph, hosted by the preset entry).
    expect(opened).toContain("✎ edit");
    expect(opened).toContain("▦");
    dispose();
  });

  test("edit mode is genuinely reachable: the menu's ✎ writes edit.mode", () => {
    const { render, clickWriting, sessionState, dispose } = buildRuntime(
      userConfig(TWO_SEGMENT_ROW),
    );
    clickWriting(render(), SETTINGS_ANCHOR, "open");
    clickWriting(render(), EDIT_MODE_KEY, "open");
    expect(sessionState.get("s1", EDIT_MODE_KEY)).toBe("open");
    // Edit mode being ON is what makes the `+`/`-` chrome visible, so this is
    // the whole route the shadowed `toolbar` trigger used to be the only way
    // to. Asserted on the affordances' own verb, not on a bare "-" glyph that
    // any template could have produced.
    const editing = extractUrls(render()).filter((u) =>
      u.includes("apply-layout-op"),
    );
    expect(editing.length).toBeGreaterThan(0);
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
    const pickerUrl = extractUrls(render()).find((u) =>
      effectsOf(u).some((e) => e.args[1]?.startsWith("menus.settings_")),
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
    expect(defaultedLines[0]).toContain("☰ ▸");
    expect(placedLines[0]).not.toContain("☰ ▸");
    expect(placedLines[1]).toContain("☰ ▸");

    defaulted.dispose();
    placed.dispose();
  });

  test("a bare-segment root grows the menu beside it", () => {
    const { render, dispose } = buildRuntime(userConfig(`'directory'`));
    expect(stripAnsi(render())).toContain("☰ ▸");
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
    expect(gatesOver("directory")).toContain(GATE);
  });

  test.each([
    ["a bare-segment root", `{ seg: 'directory', when: '${GATE}' }`],
    ["a single-row root", `{ h: ['directory','model'], when: '${GATE}' }`],
  ])(
    "a `when` on %s is honored — there is no bar to host a menu on",
    (_label, root) => {
      // The exemption, asserted rather than left implicit: gating the ROOT is an
      // explicit statement that the whole bar is conditional, unlike a gate on
      // one inner row the default placement merely happened to land in. It is
      // also what keeps edit chrome's reset banner gated with the content it
      // describes (see dsl-layout-edit's banner tests, which read this `when`).
      const config = parseAndValidate(
        "<user>",
        withFlag(root),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
      expect(gatesOverAnchor(resolvedRoot(config))).toContain(GATE);
    },
  );

  test("an author who places the anchor inside a gated row keeps it there", () => {
    // Their placement is their answer — the pass honors the position, gate and
    // all. Only the DEFAULT placement is lifted out.
    const config = parseAndValidate(
      "<user>",
      withFlag(
        `{ v: [{ h: ['directory','${SETTINGS_ANCHOR}'], when: '${GATE}' }] }`,
      ),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    expect(gatesOverAnchor(resolvedRoot(config))).toContain(GATE);
    expect(countAnchors(resolvedRoot(config))).toBe(1);
  });
});

// ─── 4. The anchor's precondition is loud ────────────────────────────────────

// [LAW:one-source-of-truth] cross-ref accepts an authored `settings.menu` on the
// promise that synthesizeSettingsMenu will declare it. When the two read
// different facts, that promise breaks silently: the config loads clean, the
// anchor is never lowered, and the dangling reference reaches the render walk to
// throw at `lookupSegment` — a load-time mistake surfacing three layers away.
// These tests pin the two halves of the one predicate.
//
// The default here is the EMPTY one (parseAndValidate's default argument), which
// is the only way to reach a config with no `session.id`: production's cascade
// merges the bundled default, which declares it.
describe("placing the anchor where the menu cannot be synthesized", () => {
  const placing = (variables: string): string => `{
    globals: {},
    variables: { ${variables} },
    segments: { hello: { template: 'hi' } },
    root: { h: ['hello', '${SETTINGS_ANCHOR}'] },
  }`;

  test("without session.id, the load error names the unmet precondition", () => {
    try {
      parseAndValidate("<user>", placing(""), ALLOWED);
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain(SETTINGS_ANCHOR);
      expect(message).toContain("session.id");
      // Not the generic dangling-reference error: true, but it teaches the
      // author to hunt for a typo in a name they copied from the docs.
      expect(message).not.toContain("does not match any declared segment");
    }
  });

  test("with session.id, the anchor loads and lowers to a declared segment", () => {
    const config = parseAndValidate(
      "<user>",
      placing(
        `'session.id': { kind: 'input', path: 'session_id', default: '' }`,
      ),
      ALLOWED,
    );
    // The invariant whose violation used to throw at render: every segment the
    // resolved root names is a segment the config declares.
    for (const name of segmentNames(resolvedRoot(config))) {
      expect(Object.keys(config.segments)).toContain(name);
    }
    expect(segmentNames(resolvedRoot(config))).toContain(SETTINGS_ANCHOR);
  });
});

// ─── 5. Structural: edit mode cannot delete its own door ─────────────────────

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
    // The addable domain is "declared, non-exempt segments not already present".
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
    // field holds the domain's NAME (`addableDomainName` → `edit.addable.<p>`),
    // which is EDIT_NS-prefixed by construction, so checking it for a
    // SETTINGS_NS prefix passes however broken `isChromeExempt` gets.
    const domains = [...addableSegmentDomains(config).values()];
    // The non-emptiness is half the assertion: `every` over an empty list is
    // the same vacuous pass one indirection further out.
    expect(domains.length).toBeGreaterThan(0);
    for (const offered of domains) {
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.filter((n) => n.startsWith(SETTINGS_NS))).toEqual([]);
    }
  });
});
