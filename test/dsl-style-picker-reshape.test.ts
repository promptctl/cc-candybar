// [LAW:verifiable-goals] A style click reshapes the bar through the daemon's per-render strip-style resolution, outside renderDsl [LAW:single-enforcer].

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import {
  effectiveStripStyle,
  paletteForThemeName,
  STRIP_STYLES,
} from "../src/themes";

const SID = "s-reshape";
const BASE_THEME = "textual-dark";

const SRC = `{
  globals: { palette: '${BASE_THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    activeStyle: { kind: 'state', key: 'style', default: '' },
  },
  actions: {
    applyStyle: { set: 'style', from: 'styles' },
  },
  segments: {
    a: { template: ' A ', bg: 'surface', fg: 'foreground' },
    b: { template: ' B ', bg: 'panel', fg: 'foreground' },
  },
  root: { h: ['a', 'b'] },
}`;

const ALLOWED = new Set([BASE_THEME]);

function buildRuntime() {
  const config = parseAndValidate("<reshape>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = paletteForThemeName(BASE_THEME);

  // [LAW:one-source-of-truth] Resolve the strip style per render the SAME way the daemon does.
  const render = (): string =>
    renderDsl(config, compiled, store, registry, { session_id: SID }, basePalette, {
      style: effectiveStripStyle(undefined, 
        sessionState.get(SID, "style"),
        config.globals.style,
      ),
      colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    });

  return { sessionState, render };
}

function clickStyle(sessionState: SessionState, style: string): void {
  const url = effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "style", style] }]);
  clickUrl(url, testVerbContext(sessionState));
}

describe("DSL style picker — live reshape", () => {
  test("clicking a style changes the bytes the joiner emits between cells", () => {
    const { sessionState, render } = buildRuntime();

    const powerline = render();
    expect(powerline.length).toBeGreaterThan(0);

    clickStyle(sessionState, "capsule");
    const capsule = render();

    clickStyle(sessionState, "plain");
    const plain = render();

    // [LAW:verifiable-goals] The reshape IS the contract: all three footprints differ pairwise.
    expect(capsule).not.toBe(powerline);
    expect(plain).not.toBe(powerline);
    expect(plain).not.toBe(capsule);
  });

  test("every STRIP_STYLES member resolves to a renderable, distinct bar", () => {
    const { sessionState, render } = buildRuntime();
    const seen = new Map<string, string>();
    for (const style of STRIP_STYLES) {
      clickStyle(sessionState, style);
      const out = render();
      expect(out.length).toBeGreaterThan(0);
      seen.set(style, out);
    }
    expect(new Set(seen.values()).size).toBe(STRIP_STYLES.length);
  });
});

describe("effectiveStripStyle — session over config over floor", () => {
  test("session pick wins over config default and floor", () => {
    expect(effectiveStripStyle(undefined, "capsule", "plain")).toBe("capsule");
  });
  test("config default applies when the session is unset", () => {
    expect(effectiveStripStyle(undefined, null, "plain")).toBe("plain");
  });
  test("floor is powerline when neither session nor config is set", () => {
    expect(effectiveStripStyle(undefined, null, undefined)).toBe("powerline");
  });
  test("a stale out-of-domain session value collapses to the floor", () => {
    // A stale SessionState entry must not leak through as a StripStyle.
    // [LAW:no-silent-failure] / [LAW:types-are-the-program]
    expect(effectiveStripStyle(undefined, "muted", undefined)).toBe("powerline");
  });
});
