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
import { countAnchors, SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { menuStateKey, sharedMenuStateKey } from "../src/config/menu-keys";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import {
  DISCLOSURE_GLYPH_CLOSE,
  DOOR_GLYPH,
} from "../src/config/disclosure";
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
    // The user declared two segments; the bar shows three cells, and the first
    // is the door their `root` could not close.
    expect(stripAnsi(render())).toContain(DOOR_GLYPH);
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
    // One symbol per state: the open door is the ✕, and the ☰ is gone.
    expect(opened).toContain(DISCLOSURE_GLYPH_CLOSE);
    expect(opened).not.toContain(DOOR_GLYPH);
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

// [LAW:behavior-not-structure] brandon-menus-du8. The settings menu's four config
// pickers share the accordion key `settings.pickers`, and a shared key joining an
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

  // The three spellings `ident()` collapses to `settings_pickers` — the key the
  // settings menu's picker accordion mints. Only the first starts with the
  // authored prefix `"settings."`, which is why a check on the authored spelling
  // closes one case of three and the collapse has to be compared instead.
  for (const key of ["settings.pickers", "settings-pickers", "settings_pickers"]) {
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
        expect(message).toContain("menus.settings_pickers");
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
    for (const key of ["settings.pickers", "settings-pickers", "settings_pickers"]) {
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
