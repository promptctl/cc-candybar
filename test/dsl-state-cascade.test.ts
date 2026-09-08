// [LAW:verifiable-goals] A click verb mutates SessionState and the next render
// reflects it. [LAW:single-enforcer] Through the daemon's own verb registry.

import { autorun } from "mobx";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { VERBS } from "../src/daemon/verbs";
import {
  effectiveThemeName,
  paletteForThemeName,
} from "../src/themes";
import { testVerbContext } from "./helpers/click";

const ALLOWED_PALETTES = new Set(["textual-dark"]);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// Minimal config: one input, one state var, one segment printing its value.
const CONFIG_SRC = `{
  globals: {},
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    theme: { kind: 'state', key: 'theme', default: '(unset)' },
  },
  segments: {
    themeSeg: {
      template: ' theme={{ .theme }} ',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  root: 'themeSeg',
}`;

// Strip ANSI so assertions pin on text alone; colour varies with the palette.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("DSL state cascade (vhi.1 acceptance)", () => {
  const SESSION_ID = "s-cascade";
  const HOOK_DATA = { session_id: SESSION_ID };

  function buildRuntime() {
    const config = parseAndValidate("<test>", CONFIG_SRC, ALLOWED_PALETTES);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = getThemePalette("textual-dark"!);
    const render = () =>
      stripAnsi(
        renderDsl(
          config,
          compiled,
          store,
          registry,
          HOOK_DATA,
          basePalette,
          OPTS,
        ),
      );
    return { config, store, registry, sessionState, render };
  }

  test("initial render shows default when SessionState has no entry", () => {
    const { render } = buildRuntime();
    expect(render()).toContain("theme=(unset)");
  });

  test("direct SessionState.set is visible on next render", () => {
    const { sessionState, render } = buildRuntime();
    expect(render()).toContain("theme=(unset)");
    sessionState.set(SESSION_ID, "theme", "ocean");
    expect(render()).toContain("theme=ocean");
  });

  test("set-state theme write changes the rendered COLORS on next render (k5a.4)", () => {
    // [LAW:verifiable-goals] globals.palette is SET: a config-default theme must
    // not freeze per-segment, or a session theme could never win.
    const config = parseAndValidate(
      "<test>",
      `{
        globals: { palette: 'textual-dark' },
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
        },
        segments: {
          seg: { template: ' x ', bg: 'primary', fg: 'foreground' },
        },
        root: 'seg',
      }`,
      ALLOWED_PALETTES,
    );
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const render = () =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        HOOK_DATA,
        paletteForThemeName(
          effectiveThemeName(undefined, 
            sessionState.get(SESSION_ID, "theme"),
            config.globals.palette,
          ),
        ),
        OPTS,
      );

    const before = render();
    const ctx = testVerbContext(sessionState);
    VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);
    const after = render();

    expect(stripAnsi(after)).toBe(stripAnsi(before));
    expect(after).not.toBe(before);
  });

  test("set-state click verb propagates to the next render", () => {
    const { sessionState, render } = buildRuntime();
    expect(render()).toContain("theme=(unset)");

    const ctx = testVerbContext(sessionState);
    VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);
    expect(render()).toContain("theme=nord");

    VERBS.get("set-state")!(`${SESSION_ID}/theme/dracula`, ctx);
    expect(render()).toContain("theme=dracula");
  });

  test("cascade triggers a reactive observer, not just a fresh render-time read", () => {
    // [LAW:behavior-not-structure] An autorun fires only when a tracked dep
    // invalidates: drop the atom notification and this stalls at one observation.
    const { store, registry, sessionState } = buildRuntime();
    registry.applyInput(HOOK_DATA);

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(String(store.read("theme")));
    });
    // [LAW:no-defensive-null-guards] RAII: a failing assertion must not leak a
    // live reaction into the global MobX scheduler.
    try {
      expect(observed).toEqual(["(unset)"]);

      const ctx = testVerbContext(sessionState);
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);

      expect(observed).toEqual(["(unset)", "nord"]);
    } finally {
      dispose();
    }
  });

  test("two state vars: mutation propagates only to its dependent observer", () => {
    // [LAW:behavior-not-structure] A write must reach readers of that key and
    // must not re-fire unrelated ones.
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          theme: { kind: 'state', key: 'theme', default: '(unset)' },
          expanded: { kind: 'state', key: 'toolbar-expanded', default: '' },
        },
        segments: {
          themeSeg: { template: '{{ .theme }}', bg: 'surface', fg: 'foreground' },
          tbSeg: { template: '{{ .expanded }}', bg: 'surface', fg: 'foreground' },
        },
        root: { h: ['themeSeg', 'tbSeg'] },
      }`,
      ALLOWED_PALETTES,
    );
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    registerDslConfig(config, registry);
    registry.applyInput(HOOK_DATA);

    const themeObs: string[] = [];
    const expandedObs: string[] = [];
    const disposeTheme = autorun(() => {
      themeObs.push(String(store.read("theme")));
    });
    const disposeExp = autorun(() => {
      expandedObs.push(String(store.read("expanded")));
    });
    try {
      expect(themeObs).toEqual(["(unset)"]);
      expect(expandedObs).toEqual([""]);

      const ctx = testVerbContext(sessionState);
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);

      expect(themeObs).toEqual(["(unset)", "nord"]);
      expect(expandedObs).toEqual([""]);

      sessionState.set(SESSION_ID, "toolbar-expanded", "1");
      expect(expandedObs).toEqual(["", "1"]);
      expect(themeObs).toEqual(["(unset)", "nord"]);
    } finally {
      disposeTheme();
      disposeExp();
    }
  });

  test("set-state rejects an unknown theme value (BadVerbArgs)", () => {
    // [LAW:no-silent-fallbacks] An unknown theme cannot quietly persist.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/not-a-theme`, ctx),
    ).toThrow(/unknown theme/);
  });

  test('set-state rejects the "custom" theme sentinel (not a renderable theme)', () => {
    // [LAW:one-source-of-truth] "custom" is a sentinel, not a resolvable name.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/custom`, ctx),
    ).toThrow(/unknown theme/);
  });

  test("set-state rejects an unknown key with the registered-key list", () => {
    // [LAW:no-silent-fallbacks] The rejection names the writable keys.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/not-a-real-key/whatever`, ctx),
    ).toThrow(/unknown state key "not-a-real-key" \(have: .*theme.*\)/);
  });

  test("set-state writes the style key when given a registered style", () => {
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    VERBS.get("set-state")!(`${SESSION_ID}/style/capsule`, ctx);
    expect(sessionState.get(SESSION_ID, "style")).toBe("capsule");
  });

  test("set-state rejects an unknown style value with the allowed-list", () => {
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/style/not-a-style`, ctx),
    ).toThrow(/unknown style "not-a-style" \(have: .*capsule.*\)/);
  });

  test("set-state normalizes boolean-ish toolbar-expanded values", () => {
    // [LAW:one-source-of-truth] The boolean validator owns the canonical forms.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);

    VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/true`, ctx);
    expect(sessionState.get(SESSION_ID, "toolbar-expanded")).toBe("1");

    VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/false`, ctx);
    expect(sessionState.get(SESSION_ID, "toolbar-expanded")).toBe("");

    VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/1`, ctx);
    expect(sessionState.get(SESSION_ID, "toolbar-expanded")).toBe("1");

    VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/0`, ctx);
    expect(sessionState.get(SESSION_ID, "toolbar-expanded")).toBe("");
  });

  test("set-state rejects non-boolean-ish toolbar-expanded values", () => {
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/maybe`, ctx),
    ).toThrow(/expected boolean-ish/);
  });

  test("set-state rejects malformed wire input (missing tail or odd count)", () => {
    // [LAW:types-are-the-program] Each structural defect gets its own diagnostic.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);

    expect(() => VERBS.get("set-state")!(`${SESSION_ID}`, ctx)).toThrow(
      /<key>\/<value> is required/,
    );
    expect(() => VERBS.get("set-state")!(`${SESSION_ID}/theme`, ctx)).toThrow(
      /expected even-count.*got 1 segment/,
    );
    expect(() => VERBS.get("set-state")!(`${SESSION_ID}//ocean`, ctx)).toThrow(
      /empty key at pair 1/,
    );
  });

  test("set-state rejects prototype-poison keys with a clean BAD_REQUEST", () => {
    // [LAW:types-are-the-program][LAW:behavior-not-structure] A ReadonlyMap makes
    // `__proto__` a non-member; the rejection is asserted, not the type.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    for (const poison of ["__proto__", "constructor", "toString"]) {
      expect(() =>
        VERBS.get("set-state")!(`${SESSION_ID}/${poison}/whatever`, ctx),
      ).toThrow(
        new RegExp(`unknown state key "${poison.replace(/\$/g, "\\$")}"`),
      );
    }
  });

  test("set-state writes a multi-pair batch atomically (Menu action contract)", () => {
    // [LAW:dataflow-not-control-flow] N=2 is the same dispatch path as N=1.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    VERBS.get("set-state")!(
      `${SESSION_ID}/theme/nord/toolbar-expanded/0`,
      ctx,
    );
    expect(sessionState.get(SESSION_ID, "theme")).toBe("nord");
    expect(sessionState.get(SESSION_ID, "toolbar-expanded")).toBe("");
  });

  test("multi-pair batch fires reactive observers exactly once", () => {
    // [LAW:single-enforcer] SessionState owns reactive atomicity: no observer
    // sees "first write applied, second pending".
    // [LAW:behavior-not-structure] One autorun tick per click is asserted.
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          theme: { kind: 'state', key: 'theme', default: '(unset)' },
          expanded: { kind: 'state', key: 'toolbar-expanded', default: '' },
        },
        segments: {
          s: { template: '{{ .theme }}', bg: 'surface', fg: 'foreground' },
        },
        root: 's',
      }`,
      ALLOWED_PALETTES,
    );
    const sessionState = new SessionState();
    sessionState.set(SESSION_ID, "toolbar-expanded", "1");
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    registerDslConfig(config, registry);
    registry.applyInput(HOOK_DATA);

    const snapshots: Array<{ theme: string; expanded: string }> = [];
    const dispose = autorun(() => {
      snapshots.push({
        theme: String(store.read("theme")),
        expanded: String(store.read("expanded")),
      });
    });
    try {
      expect(snapshots).toEqual([{ theme: "(unset)", expanded: "1" }]);

      const ctx = testVerbContext(sessionState);
      VERBS.get("set-state")!(
        `${SESSION_ID}/theme/nord/toolbar-expanded/0`,
        ctx,
      );

      expect(snapshots).toEqual([
        { theme: "(unset)", expanded: "1" },
        { theme: "nord", expanded: "" },
      ]);
    } finally {
      dispose();
    }
  });

  test("set-state rejects whole batch if any pair fails (no partial writes)", () => {
    // [LAW:no-silent-fallbacks] One transactional click: no half-applied batch.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    sessionState.set(SESSION_ID, "theme", "dracula");
    expect(() =>
      VERBS.get("set-state")!(
        `${SESSION_ID}/theme/nord/toolbar-expanded/maybe`,
        ctx,
      ),
    ).toThrow(/pair 2.*expected boolean-ish/);
    expect(sessionState.get(SESSION_ID, "theme")).toBe("dracula");
  });

  test("set-state rejects odd-count pair tail with a localizing diagnostic", () => {
    // [LAW:types-are-the-program] An odd count is structural, not a bad key.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord/leftover`, ctx),
    ).toThrow(/expected even-count.*got 3 segment/);
  });

  test("set-state names the failing pair index for batched diagnostics", () => {
    // [LAW:errors-context-in-errors] The diagnostic names WHICH pair failed.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(
        `${SESSION_ID}/theme/nord/nonsense-key/foo`,
        ctx,
      ),
    ).toThrow(/pair 2: unknown state key "nonsense-key"/);
  });

  test("set-state rejects an empty key at any pair position", () => {
    // [LAW:types-are-the-program] An empty key is a slash-count defect, not a typo.
    const { sessionState } = buildRuntime();
    const ctx = testVerbContext(sessionState);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}//nord`, ctx),
    ).toThrow(/empty key at pair 1/);
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord//1`, ctx),
    ).toThrow(/empty key at pair 2/);
  });

  test("parseDslConfig rejects a state-kind var with no session.id anchor", () => {
    // [LAW:verifiable-goals] State vars without session.id must fail at LOAD.
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          globals: {},
          variables: {
            theme: { kind: 'state', key: 'theme' },
          },
          segments: {
            s: { template: '{{ .theme }}', bg: 'surface', fg: 'foreground' },
          },
          root: 's',
        }`,
        ALLOWED_PALETTES,
      ),
    ).toThrow(/global "session\.id" variable/);
  });

  test("parseDslConfig requires session.id GLOBALLY (segment-local doesn't satisfy)", () => {
    // [LAW:types-are-the-program] A segment-local "session.id" is a different box.
    expect(() =>
      parseAndValidate(
        "<test>",
        `{
          globals: {},
          variables: {
            theme: { kind: 'state', key: 'theme' },
          },
          segments: {
            s: {
              template: '{{ .theme }}',
              bg: 'surface',
              fg: 'foreground',
              vars: {
                'session.id': { kind: 'input', path: 'session_id', default: '' },
              },
            },
          },
          root: 's',
        }`,
        ALLOWED_PALETTES,
      ),
    ).toThrow(/global "session\.id" variable/);
  });

  test("toolbar-toggle click verb cascades through state binding", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        globals: {},
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          expanded: { kind: 'state', key: 'toolbar-expanded', default: '' },
        },
        segments: {
          tb: { template: ' tb=[{{ .expanded }}] ', bg: 'surface', fg: 'foreground' },
        },
        root: 'tb',
      }`,
      ALLOWED_PALETTES,
    );
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = getThemePalette("textual-dark"!);
    const render = () =>
      stripAnsi(
        renderDsl(
          config,
          compiled,
          store,
          registry,
          HOOK_DATA,
          basePalette,
          OPTS,
        ),
      );
    const ctx = testVerbContext(sessionState);

    expect(render()).toContain("tb=[]");
    VERBS.get("toolbar-toggle")!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[1]");
    VERBS.get("toolbar-toggle")!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[]");
  });
});
