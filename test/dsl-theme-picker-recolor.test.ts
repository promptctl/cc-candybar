// [LAW:verifiable-goals] Epic k5a done-gate #1: clicking a theme picker option
// recolors the WHOLE bar live. The action-surface tests (dsl-actions/dsl-picker)
// prove the click writes SessionState and the active-marking moves, but they
// omit the theme selection entirely — so they render the floor theme every time
// and never exercise the recolor. The recolor lives in the daemon's PER-RENDER
// theme resolution (resolveThemeSelection), OUTSIDE renderDsl. This test
// replicates that resolution exactly as src/daemon/server.ts does, so it proves
// the end-to-end loop: a set-state `theme` click changes the bytes a
// non-picker segment renders.
//
// [LAW:single-enforcer] Drives the real spine — registerDslConfig + renderDsl
// for rendering, parseHandlerUrl + VERBS for the click, and the same
// resolveThemeSelection the daemon calls. No parallel rig.
//
// [LAW:behavior-not-structure] A cell's colour is read BY SEGMENT NAME, off the
// `perSegmentSink` the daemon itself renders with, never by position in the
// byte string. Position is a fact about the layout, not about the recolor: a
// regex that measures "the first background SGR" measures whichever cell
// happens to lead the row, and silently starts measuring a different segment
// the day a cell is added ahead of it.

import type { RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import {
  testVerbContext,
  effectsOf,
  clickUrl,
  boldUrls,
} from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { resolveThemeSelection } from "../src/themes";

const SID = "s-recolor";
const BASE_THEME = "textual-dark";
const PICKED_THEME = "textual-light";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
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
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
  },
  segments: {
    plain: { template: ' ◆ here ', bg: 'surface', fg: 'foreground' },
    pickers: { template: '{{ range themes }}{{ action "applyTheme" . }}{{ end }}', bg: 'surface', fg: 'foreground' },
  },
  root: { v: ['plain', 'pickers'] },
}`;

// The cells SRC above declares — the ones whose repaint IS the mechanism under
// test. The rendered bar carries more than these: settings-menu synthesizes the
// global door into every config, and that cell states its own colour.
const DECLARED = ["plain", "pickers"] as const;

const ALLOWED = new Set([BASE_THEME, PICKED_THEME]);

/** One render: the bytes, and the background each named segment painted. */
interface Painted {
  readonly bar: string;
  readonly bgOf: (segment: string) => string;
}

function buildRuntime() {
  const config = parseAndValidate("<recolor>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const sink = new Map<string, readonly RichText[]>();

  // [LAW:one-source-of-truth] Resolve the theme per render the SAME way the
  // daemon does — the session's chosen theme over the config default. This is
  // the line that makes a click recolor the bar; freezing it would silently
  // pass while the real daemon recolors. (server.ts hands renderDsl
  // `theme: resolveThemeSelection(staged, sessionState.get(sid,'theme'),
  // globals.palette)`, and the SELECTION carries the palette, so there is no
  // separate base palette here to fall out of step with the name.)
  const render = (): Painted => {
    const bar = renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      OPTS,
      { perSegmentSink: sink },
      {
        theme: resolveThemeSelection(
          undefined,
          sessionState.get(SID, "theme"),
          config.globals.palette,
        ),
      },
    );
    // [LAW:no-ambient-temporal-coupling] Snapshot the sink HERE. renderDsl
    // clears it at the top of the next call, so a colour read deferred past
    // that call would measure a render this Painted never described.
    const bgs = new Map(
      [...sink].map(([name, cells]) => [
        name,
        cells[0]?.style?.bgcolor?.value?.hex,
      ]),
    );
    const bgOf = (segment: string): string => {
      const hex = bgs.get(segment);
      // [LAW:no-silent-failure] A segment that did not render, or rendered with
      // no resolved background, is a broken rig — never a value that compares
      // unequal to the previous render and passes as a repaint.
      if (hex === undefined)
        throw new Error(`segment "${segment}" painted no background`);
      return hex;
    };
    return { bar, bgOf };
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
  clickUrl(url, testVerbContext(sessionState));
}

describe("DSL theme picker — live recolor (epic k5a done-gate #1)", () => {
  test("clicking a theme repaints the whole bar's background colors", () => {
    const { sessionState, render } = buildRuntime();

    const beforeBgs = bgColors(render().bar);
    expect(beforeBgs.size).toBeGreaterThan(0);

    clickTheme(sessionState, PICKED_THEME);

    // [LAW:verifiable-goals] The coarse whole-bar claim: the set of backgrounds
    // the bar paints with must change. Blanket DISJOINTNESS is deliberately NOT
    // the claim. "No colour survives the pick" is a property of the two
    // PALETTES — that they agree on nothing anywhere — not of the recolor
    // mechanism, and a correct cell naming a role both palettes share fails it.
    // The synthesized settings door states `accent`, and textual-dark and
    // textual-light hold the identical `accent`, so one colour legitimately
    // survives. WHICH cells must repaint is the next test's claim, by name.
    expect(bgColors(render().bar)).not.toEqual(beforeBgs);
  });

  test("every cell the config declares repaints — the non-picker `plain` too", () => {
    const { sessionState, render } = buildRuntime();

    const bgsOf = (painted: Painted): Record<string, string> =>
      Object.fromEntries(DECLARED.map((name) => [name, painted.bgOf(name)]));

    const before = bgsOf(render());
    clickTheme(sessionState, PICKED_THEME);
    const after = bgsOf(render());

    const unchanged = DECLARED.filter((name) => after[name] === before[name]);
    expect(unchanged).toEqual([]);
  });

  test("active marking tracks the rendered theme: default marked, then the pick", () => {
    const { sessionState, render } = buildRuntime();

    // Before any click, the state var defaults to the config palette, so the
    // base theme option is the single bold (active) region.
    expect(boldUrls(render().bar).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: [SID, "theme", BASE_THEME] }],
    ]);

    clickTheme(sessionState, PICKED_THEME);

    expect(boldUrls(render().bar).map(effectsOf)).toEqual([
      [{ verb: "set-state", args: [SID, "theme", PICKED_THEME] }],
    ]);
  });
});
