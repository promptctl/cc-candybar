// [LAW:single-enforcer] Drives the real seams; a test that restated the precedence
// chain would pass while the daemon diverged.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { paletteForThemeName } from "../src/themes";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError } from "../src/config/dsl-loader";
import { EDIT_MODE_KEY, EDIT_MODE_OPEN } from "../src/config/loader/edit-mode";
import type { ValidatedConfig } from "../src/config/dsl-types";

const SID = "s-edit-look";
const BASE_THEME = "textual-dark";
const ALLOWED = new Set([BASE_THEME]);

// Two cells so a joiner runs BETWEEN them; `session.id` is required of any config carrying state vars.
function src(extra = ""): string {
  return `{
  globals: { palette: '${BASE_THEME}', style: 'powerline' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
  },
  actions: {
    padTo: { set: 'padding', min: 0, max: 8, by: 1 },
    wrapToggle: { set: 'autoWrap', cycle: ['true', 'false'] },
    applyStyle: { set: 'style', from: 'styles' },
  },
  segments: {
    // The edit.toggle reference is what DEMANDS edit mode (loader/edit-mode.ts),
    // so this config gets the real toggle action, the real state key, and the
    // real +/- chrome, exactly as a user config does.
    a: { template: 'A{{ action "edit.toggle" "e" "d" }}', bg: 'surface', fg: 'foreground' },
    b: { template: 'B', bg: 'panel', fg: 'foreground' },
  },
  root: { h: ['a', 'b'] },
  ${extra}
}`;
}

function buildRuntime(source: string) {
  const config = parseAndValidate("<edit-look>", source, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  // [LAW:single-enforcer] Registering the real derived gate is what makes the set-state calls below travel a real click's road.
  liveDisposers.push(
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
  );

  const effectiveNow = () =>
    resolveEffectiveGlobals(
      config,
      (key) => sessionState.get(SID, key),
      () => false,
    );

  const render = (): string => {
    const effective = effectiveNow();
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      paletteForThemeName(effective.theme),
      {
        style: effective.style,
        separator: effective.separator,
        colorCompatibility: "truecolor" as const,
        wrap: effective.autoWrap,
        padding: effective.padding,
        charset: effective.charset,
        width: Number.POSITIVE_INFINITY,
      },
    );
  };

  return { config, sessionState, render, effectiveNow };
}

function setState(
  sessionState: SessionState,
  key: string,
  value: string,
): void {
  clickUrl(effectsUrl([{ verb: VERB_SET_STATE, args: [SID, key, value] }]), testVerbContext(sessionState));
}

// [LAW:single-enforcer] STATE_VALIDATORS is daemon-global and ref-counted: a leaked registration widens the gate for every following suite.
const liveDisposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of liveDisposers.splice(0)) dispose();
});

const enterEditMode = (s: SessionState) =>
  setState(s, EDIT_MODE_KEY, EDIT_MODE_OPEN);
const leaveEditMode = (s: SessionState) => setState(s, EDIT_MODE_KEY, "closed");

describe("edit mode's look — a staged globals fragment", () => {
  test("entering restyles the bar and leaving restores the previous bytes exactly", () => {
    const { sessionState, render } = buildRuntime(
      src(`editGlobals: { style: 'plain', default_separator: ' | ' },`),
    );

    const before = render();
    enterEditMode(sessionState);
    const editing = render();
    leaveEditMode(sessionState);
    const after = render();

    expect(editing).not.toBe(before);
    expect(editing).toContain(" | ");
    // [LAW:dataflow-not-control-flow] Nothing saved the previous style; it was only out-ranked, and byte equality proves it.
    expect(after).toBe(before);
  });

  test("the staged fragment outranks a session pick, which governs again on exit", () => {
    const { sessionState, render, effectiveNow } = buildRuntime(
      src(`editGlobals: { style: 'plain', default_separator: ' | ' },`),
    );

    setState(sessionState, "style", "capsule");
    const capsule = render();
    expect(effectiveNow().style).toBe("capsule");

    enterEditMode(sessionState);
    expect(effectiveNow().style).toBe("plain");
    expect(render()).not.toBe(capsule);

    leaveEditMode(sessionState);
    expect(effectiveNow().style).toBe("capsule");
    expect(render()).toBe(capsule);
  });

  test("the look is authored: two configs differing only in editGlobals render differently", () => {
    const bundled = buildRuntime(
      src(`editGlobals: { style: 'plain', default_separator: ' | ' },`),
    );
    const retuned = buildRuntime(
      src(`editGlobals: { style: 'plain', default_separator: ' ~~ ' },`),
    );

    enterEditMode(bundled.sessionState);
    enterEditMode(retuned.sessionState);

    expect(bundled.render()).toContain(" | ");
    expect(retuned.render()).toContain(" ~~ ");
    expect(retuned.render()).not.toBe(bundled.render());
  });

  test("a config declaring no editGlobals gets no restyling from edit mode", () => {
    // [LAW:dataflow-not-control-flow] Asserted on resolved globals, not bytes: edit mode also splices +/- chrome, a different feature.
    const { sessionState, effectiveNow } = buildRuntime(src());
    const before = effectiveNow();
    enterEditMode(sessionState);
    expect(effectiveNow()).toEqual(before);
  });

  test("every staged field outranks its session pick, not just style", () => {
    const { sessionState, effectiveNow } = buildRuntime(
      src(`editGlobals: { padding: 3, autoWrap: false },`),
    );
    setState(sessionState, "padding", "1");
    setState(sessionState, "autoWrap", "true");
    expect(effectiveNow().padding).toBe(1);
    expect(effectiveNow().autoWrap).toBe(true);

    enterEditMode(sessionState);
    expect(effectiveNow().padding).toBe(3);
    expect(effectiveNow().autoWrap).toBe(false);
  });

  test("an unstaged field still resolves through its own session pick while editing", () => {
    // The fragment is a DELTA: staging `style` says nothing about `padding`.
    const { sessionState, effectiveNow } = buildRuntime(
      src(`editGlobals: { style: 'plain' },`),
    );
    setState(sessionState, "padding", "4");
    enterEditMode(sessionState);
    expect(effectiveNow().style).toBe("plain");
    expect(effectiveNow().padding).toBe(4);
  });
});

describe("editGlobals — the loader's contract", () => {
  test("the fragment cannot select a preset, and the error says why", () => {
    expect(() =>
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { preset: 'compact' },`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
    try {
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { preset: 'compact' },`),
        ALLOWED,
      );
    } catch (err) {
      expect(String(err)).toContain(
        "the editGlobals fragment cannot select a preset",
      );
    }
  });

  test("an unknown key inside the fragment is rejected by the globals field table", () => {
    expect(() =>
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { stripStyle: 'plain' },`),
        ALLOWED,
      ),
    ).toThrow(/editGlobals key/);
  });

  test("a user fragment merges FIELD by field over the bundled one", () => {
    // [LAW:one-source-of-truth] Retuning the separator must not silently drop the bundled `plain`.
    const config: ValidatedConfig = parseAndValidate(
      "<edit-look>",
      `{ editGlobals: { default_separator: ' ~ ' } }`,
      undefined,
      DEFAULT_DSL_CONFIG,
    );
    expect(config.editGlobals.default_separator).toBe(" ~ ");
    expect(config.editGlobals.style).toBe(DEFAULT_DSL_CONFIG.editGlobals.style);
  });
});

describe("the bundled default's edit look", () => {
  test("ships plain joiners with a charset-safe separator", () => {
    // Not a box-drawing glyph: the fragment layers over globals that may declare `charset: "ascii"`.
    expect(DEFAULT_DSL_CONFIG.editGlobals.style).toBe("plain");
    expect(DEFAULT_DSL_CONFIG.editGlobals.default_separator).toBe(" | ");
    expect(DEFAULT_DSL_CONFIG.editGlobals.default_separator).toMatch(
      /^[\x20-\x7e]*$/,
    );
  });
});
