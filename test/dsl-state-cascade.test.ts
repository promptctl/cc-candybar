// [LAW:verifiable-goals] vhi.1 acceptance: a click verb mutates SessionState;
// the next DSL render reflects the change without re-reading disk. This test
// drives the cascade end-to-end through the bzh.7 spine — registerDslConfig
// + renderDslLine — so the verification matches the live render path the
// daemon uses, not a parallel test rig.
//
// [LAW:single-enforcer] The verb dispatch goes through the registry in
// src/daemon/verbs/index.ts directly. That is the same handler the daemon
// invokes for a wire-level click; no duplication.

import { PaletteResolver } from "@promptctl/rich-js";
import { parseDslConfig } from "../src/config/dsl-loader";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { getThemePalette } from "../src/themes/palette-registry";
import { registerDslConfig, renderDslLine } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { VERBS } from "../src/daemon/verbs";

const ALLOWED_PALETTES = new Set(["textual-dark"]);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
};

// Minimal config — one input (session.id), one state-kind var bound to
// SessionState's "theme" key, one segment that prints the state value.
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
  layout: ['themeSeg'],
}`;

// Strip ANSI so assertions can pin on the rendered text alone — color codes
// vary with palette and would obscure the dataflow assertion we care about.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("DSL state cascade (vhi.1 acceptance)", () => {
  const SESSION_ID = "s-cascade";
  const HOOK_DATA = { session_id: SESSION_ID };

  function buildRuntime() {
    const config = parseDslConfig("<test>", CONFIG_SRC, ALLOWED_PALETTES);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const render = () =>
      stripAnsi(
        renderDslLine(
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

  test("set-theme click verb propagates to the next render", () => {
    // The actual ticket verification: dispatch the verb through the same
    // registry the daemon uses; assert the next render reflects the change.
    const { sessionState, render } = buildRuntime();
    expect(render()).toContain("theme=(unset)");

    const ctx = { sessionState, dlog: () => {} };
    // set-theme value shape: "<sessionId>/<themeName>" — themeName must
    // exist in the live theme registry (verbs validate against it).
    VERBS["set-theme"]!(`${SESSION_ID}/nord`, ctx);
    expect(render()).toContain("theme=nord");

    VERBS["set-theme"]!(`${SESSION_ID}/dracula`, ctx);
    expect(render()).toContain("theme=dracula");
  });

  test("set-theme rejects an unknown theme name (BadVerbArgs)", () => {
    // Pinning the [LAW:no-silent-fallbacks] contract on the verb itself.
    // An unknown theme cannot quietly persist — the daemon's dispatcher
    // converts BadVerbArgs into a BAD_REQUEST wire response.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() => VERBS["set-theme"]!(`${SESSION_ID}/not-a-theme`, ctx)).toThrow(
      /unknown theme/,
    );
  });

  test('set-theme rejects the "custom" sentinel (not a renderable theme)', () => {
    // [LAW:one-source-of-truth] The verb validates against
    // listResolvablePaletteNames — the set of names that actually resolve
    // to a Palette. "custom" is a sentinel that instructs the cascade to
    // read inline colors; persisting it as a session theme would render
    // empty/broken at the next refresh.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() => VERBS["set-theme"]!(`${SESSION_ID}/custom`, ctx)).toThrow(
      /unknown theme/,
    );
  });

  test("parseDslConfig rejects a state-kind var with no session.id anchor", () => {
    // [LAW:verifiable-goals] A config that uses state-kind vars without
    // declaring session.id has to fail at LOAD time. The runtime would
    // otherwise throw "Unknown variable session.id" on the next render —
    // which is observable only when a render lands, not when the file is
    // loaded — and that violates "machine-verifiable at the earliest point."
    expect(() =>
      parseDslConfig(
        "<test>",
        `{
          globals: {},
          variables: {
            theme: { kind: 'state', key: 'theme' },
          },
          segments: {
            s: { template: '{{ .theme }}', bg: 'surface', fg: 'foreground' },
          },
          layout: ['s'],
        }`,
        ALLOWED_PALETTES,
      ),
    ).toThrow(/global "session\.id" variable/);
  });

  test("parseDslConfig requires session.id GLOBALLY (segment-local doesn't satisfy)", () => {
    // [LAW:types-are-the-program] declareState reads the global session.id
    // box at runtime. A segment-local declaration named "session.id"
    // registers as "<seg>.session.id" — same string, different box. The
    // load-time check must reject this case, not silently accept it.
    expect(() =>
      parseDslConfig(
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
          layout: ['s'],
        }`,
        ALLOWED_PALETTES,
      ),
    ).toThrow(/global "session\.id" variable/);
  });

  test("toolbar-toggle click verb cascades through state binding", () => {
    // Same pattern with a different verb / key — exercises the toggle
    // semantics (set on first click, clear on second).
    const config = parseDslConfig(
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
        layout: ['tb'],
      }`,
      ALLOWED_PALETTES,
    );
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry);
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const render = () =>
      stripAnsi(
        renderDslLine(
          config,
          compiled,
          store,
          registry,
          HOOK_DATA,
          basePalette,
          OPTS,
        ),
      );
    const ctx = { sessionState, dlog: () => {} };

    expect(render()).toContain("tb=[]");
    VERBS["toolbar-toggle"]!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[1]");
    VERBS["toolbar-toggle"]!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[]");
  });
});
