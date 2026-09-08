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

// [LAW:no-ambient-temporal-coupling] STATE_VALIDATORS is a daemon-global,
// ref-counted registry; a failed test must not leak entries into later ones.
const openRuntimes: Array<{ dispose: () => void }> = [];
afterEach(() => {
  while (openRuntimes.length > 0) openRuntimes.pop()!.dispose();
});

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// [LAW:single-enforcer] The codebase's one display-width measure — counting
// code points would pass on a line of wide glyphs that visibly overflows.
const cols = (s: string): number => new RichText(s).cellLength;

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

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
  // [LAW:one-source-of-truth] The daemon's own globals resolution, as it calls it.
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

  // [LAW:behavior-not-structure] Triggers are found by what they RENDER.
  const helpKeys = new Set(
    Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name),
  );

  const clickWriting = (out: string, key: string, value: string): void => {
    const url = extractUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };

  // Not matched on the value written: a disclosure writes the SUCCESSOR of its state.
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

// The menu is closed again so what is measured is the edit-mode bar itself.
function enterEditMode(rt: ReturnType<typeof buildRuntime>): void {
  openSettingsMenu(rt);
  rt.clickWriting(rt.render(200), EDIT_MODE_KEY, EDIT_MODE_OPEN);
  rt.clickWriting(rt.render(200), SETTINGS_ANCHOR, "closed");
}

describe("in-bar help IS src/help-text.ts, not a second copy", () => {
  test("every synthesized help segment's template is an exported help line", () => {
    const { config } = buildRuntime();
    const helpTemplates = Object.entries(config.segments)
      .filter(([name]) => /\.help(\.|$)/.test(name) && /\.\d+$/.test(name))
      .map(([, seg]) => seg.template);

    for (const line of [...EDIT_MODE_HELP, ...PERSIST_HELP]) {
      expect(helpTemplates).toContain(line);
    }
    const corpus = new Set<string>([...EDIT_MODE_HELP, ...PERSIST_HELP]);
    for (const t of helpTemplates) expect(corpus.has(t)).toBe(true);
  });

  test("--help prints the same values the bar renders", () => {
    for (const line of [...EDIT_MODE_HELP, ...PERSIST_HELP]) {
      expect(HELP_TEXT).toContain(line);
    }
  });
});

describe("edit mode's (?)", () => {
  test("renders closed, opens on click, and closes again", () => {
    const rt = buildRuntime();
    enterEditMode(rt);

    const closed = stripAnsi(rt.render(200));
    expect(closed).toContain(HELP_GLYPH_CLOSED);
    for (const line of EDIT_MODE_HELP) expect(closed).not.toContain(line);

    rt.toggleHelp(rt.render(200));
    const open = stripAnsi(rt.render(200));
    // Asserted as the ABSENCE of "(?)": edit mode's insert chrome wears ✕ too.
    expect(open).not.toContain(HELP_GLYPH_CLOSED);
    expect(open).toContain(DISCLOSURE_GLYPH_CLOSE);
    for (const line of EDIT_MODE_HELP) expect(open).toContain(line);

    rt.toggleHelp(rt.render(200));
    const reclosed = stripAnsi(rt.render(200));
    for (const line of EDIT_MODE_HELP) expect(reclosed).not.toContain(line);
  });

  test("covers +, - and the ↺ customized banner", () => {
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
    const rt = buildRuntime();
    openSettingsMenu(rt);
    rt.toggleHelp(rt.render(200));
    expect(stripAnsi(rt.render(200))).toContain(PERSIST_HELP[0]);

    rt.clickWriting(rt.render(200), SETTINGS_ANCHOR, "closed");
    const out = stripAnsi(rt.render(200));
    for (const line of PERSIST_HELP) expect(out).not.toContain(line);
  });
});

describe("both (?) sites are the same declaration", () => {
  test("each mints a state var, a cycle action and a trigger segment", () => {
    const { config } = buildRuntime();
    const helpNames = Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name);
    expect(helpNames).toHaveLength(2);
    expect(helpNames.some((n) => n.startsWith("edit."))).toBe(true);
    expect(helpNames.some((n) => n.startsWith("settings."))).toBe(true);

    for (const name of helpNames) {
      expect(config.variables[name]).toMatchObject({ kind: "state" });
      expect(config.actions[name]).toMatchObject({ set: name });
      expect(config.segments[name]!.template).toContain(HELP_GLYPH_CLOSED);
      expect(config.segments[name]!.template).toContain(DISCLOSURE_GLYPH_CLOSE);
    }
  });

  test("a (?) toggle declares no new gate surface", () => {
    // [LAW:single-enforcer] It writes through the existing `cycle` arm, so
    // nothing bespoke reaches the wire gate.
    const { config } = buildRuntime();
    const helpKeys = Object.entries(config.segments)
      .filter(([, seg]) => seg.template.includes(HELP_GLYPH_CLOSED))
      .map(([name]) => name);
    const helpGates = deriveActionValidators(config).filter(({ key }) =>
      helpKeys.includes(key),
    );
    expect(helpGates).toHaveLength(2);
    for (const { spec } of helpGates) {
      expect(spec).toMatchObject({
        kind: "allow-list",
        allowed: ["closed", "open"],
      });
    }
  });
});

// [LAW:verifiable-goals] Padding rides the matrix because it multiplies across
// every cell; one step above the default is the bar this holds to.
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

  // The presence assertion is what makes the width assertion about help at all.
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

// [LAW:verifiable-goals] Stated as "never ALONE on its line" — a row count
// would need a no-help baseline production never renders.
// [LAW:behavior-not-structure] Measured wide: auto-wrap can strand the `(?)`.
const WIDE = 200;

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

// [LAW:behavior-not-structure] These are root SHAPES, not the walk's branches;
// a gated last row cannot host the trigger, so there it mints its own line.
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
