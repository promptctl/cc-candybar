// A ramp's palette-NAME stops resolve through the same live palette an authored
// `bg:` does, so a theme or look click recolours it with no config change.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  effectiveLookName,
  effectiveThemeName,
  lookKeyByName,
  paletteForThemeName,
} from "../src/themes";

const SID = "s-ramp-recolor";
const BASE_THEME = "textual-dark";
// textual-light shares warning and error with textual-dark, so a click between those two shows nothing.
const PICKED_THEME = "catppuccin-latte";
const PICKED_LOOK = "vivid";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

const SRC = `{
  globals: { palette: '${BASE_THEME}' },
  looks: { none: {}, ${PICKED_LOOK}: { chromaScale: 1.6, lightnessShift: 0.08 } },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    theme: { kind: 'state', key: 'theme', default: '${BASE_THEME}' },
    look: { kind: 'state', key: 'look', default: 'none' },
    pct: { kind: 'input', path: 'pct', type: 'number', default: 0 },
    stop: { kind: 'input', path: 'stop', default: 'panel' },
  },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    applyLook: { set: 'look', from: 'looks' },
  },
  segments: {
    viaRamp: { template: ' R ', bg: '{{ ramp .pct "step" 0 "panel" 50 "warning" 80 "error" }}', fg: 'foreground' },
    viaName: { template: ' N ', bg: '{{ .stop }}', fg: 'foreground' },
  },
  root: { v: ['viaRamp', 'viaName'] },
}`;

const ALLOWED = new Set([BASE_THEME, PICKED_THEME]);

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function buildRuntime() {
  const config = parseAndValidate("<ramp-recolor>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  disposers.push(
    () => registry.dispose(),
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
  );

  const render = (payload: { pct: number; stop: string }): string => {
    const basePalette = paletteForThemeName(
      effectiveThemeName(
        undefined,
        sessionState.get(SID, "theme"),
        config.globals.palette,
      ),
    );
    const look = lookKeyByName(
      config.looks,
      effectiveLookName(
        undefined,
        sessionState.get(SID, "look"),
        config.globals.look,
        config.looks,
      ),
    );
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID, ...payload },
      basePalette,
      OPTS,
      undefined,
      { look },
    );
  };
  const click = (key: "theme" | "look", value: string): void =>
    clickUrl(
      effectsUrl([{ verb: VERB_SET_STATE, args: [SID, key, value] }]),
      testVerbContext(sessionState),
    );
  return { render, click };
}

// The bg SGR that paints a cell's text — the `48;2;r;g;b` run before it.
function bgOf(rendered: string, text: string): string {
  const m = rendered.match(new RegExp(`48;2;(\\d+;\\d+;\\d+)[^\\x1b]*?${text}`));
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("ramp over palette-name stops follows the live theme", () => {
  test.each([
    [10, "panel"],
    [70, "warning"],
    [95, "error"],
  ])(
    "at %i the ramp paints `%s` — equal to the named cell under the base theme, a theme click, and a look click",
    (pct, stop) => {
      const { render, click } = buildRuntime();
      const agree = (): string => {
        const line = render({ pct, stop });
        const ramp = bgOf(line, " R ");
        expect(ramp).toBe(bgOf(line, " N "));
        return ramp;
      };

      const base = agree();
      click("theme", PICKED_THEME);
      const themed = agree();
      click("look", PICKED_LOOK);
      const looked = agree();

      expect(new Set([base, themed, looked]).size).toBe(3);
    },
  );
});
