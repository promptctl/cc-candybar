// [LAW:verifiable-goals] candybar-settings-ui-aok.6 acceptance — the reusable
// `(?)`, driven through the real loader (parse → merge → validate), the real
// spine (registerDslConfig + renderDsl), the real click wire, and the daemon's
// own `resolveEffectiveGlobals`. No parallel rig: a test that restated any of
// those would pass while the bar diverged.
//
// The measuring stick is the epic's, unchanged: a USER config whose `root` is a
// single row of two segments. Both `(?)` use sites are reached from that shape,
// because a help affordance that only appears under the bundled default helps
// nobody who wrote a config.
//
//   1. Identity, not similarity — the strings the bar renders ARE the values
//      `src/help-text.ts` exports, and `--help` prints those same values.
//   2. Edit mode explains `+`, `-` and the `↺ customized` banner.
//   3. The config menu explains `persist?`.
//   4. Both are declared the same way: one `declareHelp` call, differing only
//      in the text and the position.
//   5. Width, mechanically, at 80 and 120 columns.

import { RichText } from "@promptctl/rich-js";
import { paletteForThemeName } from "../src/themes";
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
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { EDIT_MODE_KEY, EDIT_MODE_OPEN } from "../src/config/loader/edit-mode";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { HELP_GLYPH_CLOSED } from "../src/config/help";
import { DISCLOSURE_GLYPH_CLOSE } from "../src/config/disclosure";
import {
  EDIT_MODE_HELP,
  HELP_TEXT,
  PERSIST_HELP,
} from "../src/help-text";
import { testVerbContext, clickUrl, effectsOf } from "./helpers/click";
import type { DslConfig } from "../src/config/dsl-types";

const SID = "s-help";
const ALLOWED = new Set(listResolvablePaletteNames());

// [LAW:no-ambient-temporal-coupling] STATE_VALIDATORS is a daemon-GLOBAL,
// ref-counted registry, so a runtime that fails an assertion before disposing
// leaks its entries into every later test in the file. Cleanup is owned by the
// harness, not by each test remembering to call it.
const openRuntimes: Array<{ dispose: () => void }> = [];
afterEach(() => {
  while (openRuntimes.length > 0) openRuntimes.pop()!.dispose();
});

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// [LAW:single-enforcer] The codebase's one display-width measure, the same one
// `src/render/picker.ts` reserves its pagination seam with. Counting code
// points would pass on a line of wide glyphs that visibly overflows.
const cols = (s: string): number => new RichText(s).cellLength;

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// The acceptance shape, verbatim — a user file declaring its own `root` of one
// row of two segments, merged over the BUNDLED default (production's cascade).
const twoSegmentRoot = (padding = 1): string => `{
  globals: { padding: ${padding} },
  root: { h: ['directory', 'model'] },
}`;

const TWO_SEGMENT_ROOT = twoSegmentRoot();

const PAYLOAD = {
  session_id: SID,
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

function buildRuntime(src: string = TWO_SEGMENT_ROOT) {
  const config = parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );

  // [LAW:one-source-of-truth] The daemon's own globals resolution, called the
  // way the daemon calls it — so edit mode's staged look (plain joiner, " | "
  // separator) reaches this render exactly as it reaches the bar. A hand-built
  // opts literal would measure a width the user never sees.
  const render = (width: number): string => {
    const effective = resolveEffectiveGlobals(
      config,
      (key) => sessionState.get(SID, key),
      () => false,
    );
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      paletteForThemeName(effective.theme),
      {
        style: effective.style,
        separator: effective.separator,
        colorCompatibility: "truecolor" as const,
        wrap: effective.autoWrap,
        padding: effective.padding,
        charset: effective.charset,
        width,
      },
    );
  };

  const click = (url: string): void =>
    clickUrl(url, testVerbContext(sessionState));

  // [LAW:behavior-not-structure] Which segments are `(?)` triggers is read off
  // what they RENDER — the help glyph — so the assertions survive any renaming
  // of the reserved namespaces they happen to be minted under.
  const helpKeys = new Set(
    Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name),
  );

  // Click the affordance whose URL writes `value` to `key`, wherever it landed.
  const clickWriting = (out: string, key: string, value: string): void => {
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };

  // Toggle the `(?)`, whichever way it currently points. Deliberately NOT
  // matched on the value written: a disclosure trigger writes the SUCCESSOR of
  // its current state, so an open help offers "closed" and a closed one offers
  // "open". A helper that only found one of those would silently stop being
  // able to close what it opened.
  const toggleHelp = (out: string): void => {
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => helpKeys.has(e.args[1] ?? "")),
    );
    if (!url)
      throw new Error(
        "no (?) affordance rendered; effects were " +
          JSON.stringify(extractUrls(out).flatMap((u) => effectsOf(u))),
      );
    click(url);
  };

  const lines = (width: number): string[] =>
    stripAnsi(render(width)).split("\n");

  const dispose = (): void => disposers.forEach((d) => d());
  const rt = {
    config,
    sessionState,
    render,
    lines,
    click,
    clickWriting,
    toggleHelp,
    dispose,
  };
  openRuntimes.push(rt);
  return rt;
}

function openSettingsMenu(rt: ReturnType<typeof buildRuntime>): void {
  rt.clickWriting(rt.render(200), SETTINGS_ANCHOR, "open");
}

// The real route into edit mode from a minimal user config: the `✎ edit` control
// lives in the settings menu's body, which is the whole point of
// candybar-settings-ui-aok.1 — a user root deletes every other trigger. The menu
// is closed again afterwards so what is measured is the edit-mode bar itself,
// not the bar with a panel hanging open over it.
function enterEditMode(rt: ReturnType<typeof buildRuntime>): void {
  openSettingsMenu(rt);
  rt.clickWriting(rt.render(200), EDIT_MODE_KEY, EDIT_MODE_OPEN);
  rt.clickWriting(rt.render(200), SETTINGS_ANCHOR, "closed");
}

// ─── 1. Identity with the corpus, not similarity ─────────────────────────────

describe("in-bar help IS src/help-text.ts, not a second copy", () => {
  // The ticket's own words: "assert the in-bar help strings ARE the exported
  // values from src/help-text.ts — identity, not similarity. If the test needs
  // fuzzy string comparison, the derivation rule has been violated somewhere."
  test("every synthesized help segment's template is an exported help line", () => {
    const { config } = buildRuntime();
    const helpTemplates = Object.entries(config.segments)
      .filter(([name]) => /\.help(\.|$)/.test(name) && /\.\d+$/.test(name))
      .map(([, seg]) => seg.template);

    // Every bundled help line appears as some segment's WHOLE template.
    for (const line of [...EDIT_MODE_HELP, ...PERSIST_HELP]) {
      expect(helpTemplates).toContain(line);
    }
    // And nothing else does — no segment carries prose the corpus never saw.
    const corpus = new Set<string>([...EDIT_MODE_HELP, ...PERSIST_HELP]);
    for (const t of helpTemplates) expect(corpus.has(t)).toBe(true);
  });

  test("--help prints the same values the bar renders", () => {
    for (const line of [...EDIT_MODE_HELP, ...PERSIST_HELP]) {
      expect(HELP_TEXT).toContain(line);
    }
  });
});

// ─── 2. Edit mode explains itself ────────────────────────────────────────────

describe("edit mode's (?)", () => {
  test("renders closed, opens on click, and closes again", () => {
    const rt = buildRuntime();
    enterEditMode(rt);

    const closed = stripAnsi(rt.render(200));
    expect(closed).toContain(HELP_GLYPH_CLOSED);
    // Closed help costs no content: none of its lines are on the bar.
    for (const line of EDIT_MODE_HELP) expect(closed).not.toContain(line);

    rt.toggleHelp(rt.render(200));
    const open = stripAnsi(rt.render(200));
    // The trigger now wears ✕ instead of (?) — the open state is readable in
    // plain text, which matters to a colourless client (colorCompatibility
    // "none", `cc-candybar check`) that never sees the band's state colour.
    // Asserted as the ABSENCE of the unique "(?)": edit mode's insert chrome
    // wears ✕ too, so its presence alone identifies nothing.
    expect(open).not.toContain(HELP_GLYPH_CLOSED);
    expect(open).toContain(DISCLOSURE_GLYPH_CLOSE);
    for (const line of EDIT_MODE_HELP) expect(open).toContain(line);

    rt.toggleHelp(rt.render(200));
    const reclosed = stripAnsi(rt.render(200));
    for (const line of EDIT_MODE_HELP) expect(reclosed).not.toContain(line);
  });

  test("covers +, - and the ↺ customized banner", () => {
    // Coverage is the checkable criterion the ticket names: each affordance
    // edit mode shows gets a line naming what clicking it does.
    const glyphs = ["+", "-", "↺"];
    for (const g of glyphs) {
      expect(EDIT_MODE_HELP.some((l) => l.startsWith(g))).toBe(true);
    }
  });

  test("is absent entirely when edit mode is off", () => {
    const rt = buildRuntime();
    const out = stripAnsi(rt.render(200));
    expect(out).not.toContain(HELP_GLYPH_CLOSED);
  });
});

// ─── 3. The config menu explains persist? ────────────────────────────────────

describe("the config menu's (?)", () => {
  test("opens onto what persist? actually does", () => {
    const rt = buildRuntime();
    openSettingsMenu(rt);

    const closed = stripAnsi(rt.render(200));
    expect(closed).toContain("persist?");
    expect(closed).toContain(HELP_GLYPH_CLOSED);
    for (const line of PERSIST_HELP) expect(closed).not.toContain(line);

    rt.toggleHelp(rt.render(200));
    const open = stripAnsi(rt.render(200));
    for (const line of PERSIST_HELP) expect(open).toContain(line);
  });

  test("closing the menu takes the open help with it", () => {
    // A nested disclosure's body hangs on its trigger, and the trigger sits
    // inside the enclosing body, so an open `(?)` cannot outlive the panel it
    // explains.
    const rt = buildRuntime();
    openSettingsMenu(rt);
    rt.toggleHelp(rt.render(200));
    expect(stripAnsi(rt.render(200))).toContain(PERSIST_HELP[0]);

    rt.clickWriting(rt.render(200), SETTINGS_ANCHOR, "closed");
    const out = stripAnsi(rt.render(200));
    for (const line of PERSIST_HELP) expect(out).not.toContain(line);
  });
});

// ─── 4. One declaration shape, two sites ─────────────────────────────────────

describe("both (?) sites are the same declaration", () => {
  test("each mints a state var, a cycle action and a trigger segment", () => {
    const { config } = buildRuntime();
    const helpNames = Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name);
    // Two use sites, "unrelated" on any reading: different namespaces,
    // different synthesis passes, different tickets.
    expect(helpNames).toHaveLength(2);
    expect(helpNames.some((n) => n.startsWith("edit."))).toBe(true);
    expect(helpNames.some((n) => n.startsWith("settings."))).toBe(true);

    for (const name of helpNames) {
      expect(config.variables[name]).toMatchObject({ kind: "state" });
      expect(config.actions[name]).toMatchObject({ set: name });
      // The trigger binds its own text — the runtime appends no glyph.
      expect(config.segments[name]!.template).toContain(HELP_GLYPH_CLOSED);
      expect(config.segments[name]!.template).toContain(DISCLOSURE_GLYPH_CLOSE);
    }
  });

  test("a (?) toggle declares no new gate surface", () => {
    // [LAW:single-enforcer] It writes session state through the existing
    // `cycle` arm, so its validator is an ordinary allow-list of the two
    // members — nothing bespoke reaches the wire gate.
    const { config } = buildRuntime();
    const helpKeys = Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name);
    const helpGates = deriveActionValidators(config).filter(({ key }) =>
      helpKeys.includes(key),
    );
    expect(helpGates).toHaveLength(2);
    for (const { spec } of helpGates) {
      // The ordinary binary-cycle allow-list every disclosure toggle derives —
      // no bespoke spec kind reaches the wire gate.
      expect(spec).toMatchObject({
        kind: "allow-list",
        allowed: ["closed", "open"],
      });
    }
  });
});

// ─── 5. Width, mechanically ──────────────────────────────────────────────────

// [LAW:verifiable-goals] The ticket asks for 80 and 120 columns. Padding is in
// the matrix too because it is a USER setting (0-16) that multiplies across
// every cell, and the first draft of these sentences landed at EXACTLY 80
// columns at the default padding — passing the width assertion with zero margin
// and wrapping into a second row the moment anyone nudged padding to 2. One
// step above the default is the bar this holds to; beyond that the whole bar
// reflows and one row was never a promise worth making.
describe.each([
  [80, 1],
  [80, 2],
  [120, 1],
])("at %i columns, padding %i", (width, padding) => {
  test("edit mode's open help overflows no line and adds one row", () => {
    const rt = buildRuntime(twoSegmentRoot(padding));
    enterEditMode(rt);
    const before = rt.lines(width);
    rt.toggleHelp(rt.render(width));
    const after = rt.lines(width);

    for (const line of after) expect(cols(line)).toBeLessThanOrEqual(width);
    expect(after.length - before.length).toBe(1);
  });

  test("the config menu's open help overflows no line and adds one row", () => {
    const rt = buildRuntime(twoSegmentRoot(padding));
    openSettingsMenu(rt);
    const before = rt.lines(width);
    rt.toggleHelp(rt.render(width));
    const after = rt.lines(width);

    for (const line of after) expect(cols(line)).toBeLessThanOrEqual(width);
    expect(after.length - before.length).toBe(1);
  });

  // "Help must not widen the bar while closed." The earlier version of this
  // test opened neither surface, so no `(?)` was on the bar at all and it
  // passed identically with `src/config/help.ts` deleted — hence the presence
  // assertion, which is what makes the width one about help.
  test.each([
    ["edit mode", enterEditMode],
    ["the config menu", openSettingsMenu],
  ])("closed help in %s overflows no line", (_name, open) => {
    const rt = buildRuntime(twoSegmentRoot(padding));
    open(rt);
    const shown = rt.lines(width);

    expect(shown.some((l) => l.includes(HELP_GLYPH_CLOSED))).toBe(true);
    for (const line of shown) expect(cols(line)).toBeLessThanOrEqual(width);
  });
});

// ─── 6. A closed trigger costs no row ────────────────────────────────────────

// "Help must not add a row on its own." The `(?)` cell is the asked-for cost;
// its BODY is free until clicked.
//
// [LAW:verifiable-goals] Stated as the criterion itself — a closed trigger is
// never ALONE on its line — rather than as a line count, because a count would
// need a no-help baseline that production never renders. Strip the glyph from
// the line it landed on: a trigger riding a row leaves that row's other cells
// behind, a trigger that minted its own row leaves whitespace.
//
// [LAW:behavior-not-structure] Measured wide, deliberately. This asserts a fact
// about the LAYOUT TREE, and FlexStrip's width-based auto-wrap is a separate
// mechanism that can push any trailing cell onto its own visual line — at 80
// columns and padding 2 it does exactly that to a correctly-placed `(?)`. A
// width narrow enough to wrap would make this test fail for a reason that has
// nothing to do with what it is measuring; the overflow behaviour has its own
// tests above.
const WIDE = 200;

// The one line of every assertion below: where did the closed `(?)` land?
const triggerLines = (rt: ReturnType<typeof buildRuntime>): string[] =>
  rt.lines(WIDE).filter((l) => l.includes(HELP_GLYPH_CLOSED));

describe("a closed (?) rides a row rather than adding one", () => {
  test.each([
    ["edit mode", enterEditMode],
    ["the config menu", openSettingsMenu],
  ])("in %s", (_name, open) => {
    const rt = buildRuntime();
    open(rt);
    const hosts = triggerLines(rt);

    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.replaceAll(HELP_GLYPH_CLOSED, "").trim()).not.toBe("");
  });
});

// ─── 7. The placement walk, over root SHAPES ─────────────────────────────────

// [LAW:behavior-not-structure] Edit mode's trigger is placed by a walk that has
// to find the last row of whatever root the user wrote, and every fixture above
// bottoms out in ONE horizontal row — so the walk's other cases had no coverage
// at all, and a version of it that tunnelled into a `kind: "group"` body shipped
// through a full round of review. These are the shapes, not the branches: a
// rewrite that finds the last row some other way must still pass.
//
// The group case is the regression test: its body hangs on the toggle, not in
// the children list, so the `(?)` pairs beside the toggle and never lands in a
// body most groups default closed. The gated-row case pins the priority the walk
// encodes — a trigger you can see, in a config where riding the last row would
// gate it, beats a trigger that costs no line.
describe("edit mode's (?) survives any root shape", () => {
  const shapes: Array<[string, string, boolean]> = [
    ["one row", `{ root: { h: ['directory', 'model'] } }`, true],
    [
      "a stack of rows",
      `{ root: { v: [{ h: ['directory', 'model'] }, { h: ['context', 'cacheTimer'] }] } }`,
      true,
    ],
    ["a bare segment", `{ root: 'directory' }`, true],
    [
      "a row then a nested stack",
      `{ root: { v: [{ h: ['directory'] }, { v: [{ h: ['model', 'context'] }] }] } }`,
      true,
    ],
    [
      "a row then a closed group",
      `{ root: { v: [
         { h: ['directory', 'model'] },
         { kind: 'group', name: 'extra', label: 'extra', children: ['context'] },
       ] } }`,
      true,
    ],
    [
      "a row then a gated row",
      `{ root: { v: [
         { h: ['directory', 'model'] },
         { h: ['context'], when: '{{ false }}' },
       ] } }`,
      false,
    ],
  ];

  test.each(shapes)("%s: the trigger renders", (_name, src) => {
    const rt = buildRuntime(src);
    enterEditMode(rt);

    expect(triggerLines(rt)).toHaveLength(1);
  });

  test.each(shapes)("%s: and rides a row (%p)", (_name, src, rides) => {
    const rt = buildRuntime(src);
    enterEditMode(rt);
    const [host] = triggerLines(rt);

    expect(host!.replaceAll(HELP_GLYPH_CLOSED, "").trim() !== "").toBe(rides);
  });
});

// A type-only anchor so a rename of DslConfig surfaces here too.
const _configShape: (c: DslConfig) => number = (c) =>
  Object.keys(c.segments).length;
void _configShape;
