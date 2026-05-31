// [LAW:verifiable-goals] Epic k5a done-gate #1: clicking a theme picker option
// recolors the WHOLE bar live. The existing widget test (dsl-widgets.test.ts)
// proves the click writes SessionState and the active-marking moves, but it
// passes a STATIC basePalette into renderDsl — so it never exercises the
// recolor. The recolor lives in the daemon's PER-RENDER basePalette resolution
// (effectiveThemeName -> resolverForThemeName), OUTSIDE renderDsl. This test
// replicates that resolution exactly as src/daemon/server.ts does, so it proves
// the end-to-end loop: a set-state `theme` click changes the bytes a
// non-picker segment renders.
//
// [LAW:single-enforcer] Drives the real spine — registerDslConfig + renderDsl
// for rendering, parseHandlerUrl + VERBS for the click, and the same
// effectiveThemeName/resolverForThemeName the daemon calls. No parallel rig.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { effectsOf, clickUrl, boldUrls } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectiveThemeName, resolverForThemeName } from "../src/themes";

const SID = "s-recolor";
const BASE_THEME = "textual-dark";
const PICKED_THEME = "textual-light";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};

// This mirrors the user's live config slice (a colored text segment + a theme
// picker bound to the `theme` state key, defaulted to the config palette). No
// per-segment `palette:` override — both segments resolve against the live
// basePalette, so they follow the session pick.
const SRC = `{
  globals: { palette: '${BASE_THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    theme: { kind: 'state', key: 'theme', default: '${BASE_THEME}' },
    'hue.step': { kind: 'literal', value: 14 },
  },
  widgets: {
    themePicker: {
      kind: 'buttons',
      items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }],
    },
  },
  segments: {
    plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
    pickers: { template: '{{ widget "themePicker" }}', bg: 'surface', fg: 'foreground' },
  },
  layout: [['plain'], ['pickers']],
}`;

const ALLOWED = new Set([BASE_THEME, PICKED_THEME]);

function buildRuntime() {
  const config = parseAndValidate("<recolor>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });

  // [LAW:one-source-of-truth] Resolve basePalette per render the SAME way the
  // daemon does — the session's chosen theme over the config default. This is
  // the line that makes a click recolor the bar; freezing it would silently
  // pass while the real daemon recolors. (server.ts: basePalette =
  // resolverForThemeName(effectiveThemeName(sessionState.get(sid,'theme'),
  // globals.palette))).
  const render = (): string => {
    const basePalette = resolverForThemeName(
      effectiveThemeName(
        sessionState.get(SID, "theme"),
        config.globals.palette,
      ),
    );
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      basePalette,
      OPTS,
    );
  };
  return { sessionState, render };
}

// Every truecolor background SGR in a rendered line — `48;2;r;g;b`. The set of
// these is the bar's palette footprint; a recolor changes it.
function bgColors(rendered: string): Set<string> {
  const re = /48;2;(\d+;\d+;\d+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) out.add(m[1]!);
  return out;
}

function clickTheme(sessionState: SessionState, theme: string): void {
  // Drive the real wire end-to-end: emit the click URL the picker would, then
  // dispatch it exactly as the daemon does (parse → dispatch → set-state).
  const url = effectsUrl([
    { verb: VERB_SET_STATE, args: [SID, "theme", theme] },
  ]);
  clickUrl(url, { sessionState, dlog: () => {} });
}

describe("DSL theme picker — live recolor (epic k5a done-gate #1)", () => {
  test("clicking a theme repaints the whole bar's background colors", () => {
    const { sessionState, render } = buildRuntime();

    const before = render();
    const beforeBgs = bgColors(before);
    expect(beforeBgs.size).toBeGreaterThan(0);

    clickTheme(sessionState, PICKED_THEME);

    const after = render();
    const afterBgs = bgColors(after);

    // [LAW:verifiable-goals] The whole-bar recolor IS the contract: the set of
    // background colors the bar paints with must change. dark↔light themes
    // share no surface color, so the two footprints are disjoint.
    expect(afterBgs).not.toEqual(beforeBgs);
    for (const c of afterBgs) expect(beforeBgs.has(c)).toBe(false);
  });

  test("the non-picker `plain` segment itself recolors (not just the picker)", () => {
    const { sessionState, render } = buildRuntime();

    // Isolate the `plain` segment's bg by rendering ONLY its known glyph run.
    // It's the first row, so its bg SGR precedes the "◆ here" text.
    const bgOf = (rendered: string): string => {
      const m = rendered.match(/48;2;(\d+;\d+;\d+)[^]*?◆ here/);
      expect(m).not.toBeNull();
      return m![1]!;
    };

    const beforeBg = bgOf(render());
    clickTheme(sessionState, PICKED_THEME);
    const afterBg = bgOf(render());

    expect(afterBg).not.toBe(beforeBg);
  });

  test("active marking tracks the rendered theme: default marked, then the pick", () => {
    const { sessionState, render } = buildRuntime();

    // Before any click, the state var defaults to the config palette, so the
    // base theme option is the single bold (active) region.
    const before = render();
    expect(boldUrls(before).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: [SID, "theme", BASE_THEME] }],
    ]);

    clickTheme(sessionState, PICKED_THEME);

    const after = render();
    expect(boldUrls(after).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: [SID, "theme", PICKED_THEME] }],
    ]);
  });
});
