// [LAW:verifiable-goals] A theme click recolors the WHOLE bar. The recolor lives in the
// daemon's PER-RENDER basePalette resolution, outside renderDsl, so this replicates it.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, effectsOf, clickUrl, boldUrls } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectiveThemeName, paletteForThemeName } from "../src/themes";

const SID = "s-recolor";
const BASE_THEME = "textual-dark";
const PICKED_THEME = "textual-light";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

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

const ALLOWED = new Set([BASE_THEME, PICKED_THEME]);

function buildRuntime() {
  const config = parseAndValidate("<recolor>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);

  // [LAW:one-source-of-truth] Resolved per render the SAME way the daemon does; freezing it would pass while the real daemon recolors.
  const render = (): string => {
    const basePalette = paletteForThemeName(
      effectiveThemeName(undefined, 
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

// Every truecolor background SGR — the bar's palette footprint.
function bgColors(rendered: string): Set<string> {
  const re = /48;2;(\d+;\d+;\d+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) out.add(m[1]!);
  return out;
}

function clickTheme(sessionState: SessionState, theme: string): void {
  const url = effectsUrl([
    { verb: VERB_SET_STATE, args: [SID, "theme", theme] },
  ]);
  clickUrl(url, testVerbContext(sessionState));
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

    // [LAW:verifiable-goals] dark↔light share no surface colour, so the footprints are disjoint.
    expect(afterBgs).not.toEqual(beforeBgs);
    for (const c of afterBgs) expect(beforeBgs.has(c)).toBe(false);
  });

  test("the non-picker `plain` segment itself recolors (not just the picker)", () => {
    const { sessionState, render } = buildRuntime();

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
