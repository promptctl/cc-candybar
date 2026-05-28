// [LAW:verifiable-goals] vhi.1 acceptance: a click verb mutates SessionState;
// the next DSL render reflects the change without re-reading disk. This test
// drives the cascade end-to-end through the bzh.7 spine — registerDslConfig
// + renderDslLine — so the verification matches the live render path the
// daemon uses, not a parallel test rig.
//
// [LAW:single-enforcer] The verb dispatch goes through the registry in
// src/daemon/verbs/index.ts directly. That is the same handler the daemon
// invokes for a wire-level click; no duplication.

import { autorun } from "mobx";
import { PaletteResolver } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
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
  width: Number.POSITIVE_INFINITY,
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
    const config = parseAndValidate("<test>", CONFIG_SRC, ALLOWED_PALETTES);
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

  test("set-state click verb propagates to the next render", () => {
    // The actual ticket verification: dispatch the verb through the same
    // registry the daemon uses; assert the next render reflects the change.
    const { sessionState, render } = buildRuntime();
    expect(render()).toContain("theme=(unset)");

    const ctx = { sessionState, dlog: () => {} };
    // set-state value shape: "<sessionId>/<key>/<value>" — key must be
    // a registered state key and value must satisfy its validator.
    VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);
    expect(render()).toContain("theme=nord");

    VERBS.get("set-state")!(`${SESSION_ID}/theme/dracula`, ctx);
    expect(render()).toContain("theme=dracula");
  });

  test("cascade triggers a reactive observer, not just a fresh render-time read", () => {
    // [LAW:behavior-not-structure] The "set-state click verb propagates"
    // test above asserts the rendered string carries the new value — true
    // whenever renderDslLine sees the new value at next read, which can
    // happen via two different mechanisms:
    //   (a) atom.reportChanged() invalidated the computed; the next read
    //       re-derives through the dep graph (the intended contract); or
    //   (b) the computed's keepAlive cache was bypassed for some other
    //       reason (e.g. an unobserved-computed re-derive on access).
    // Wrapping store.read("theme") in an `autorun` forces (a) to be the
    // only path that can produce a second observation: autoruns fire only
    // when a tracked dep invalidates. If SessionState.set ever stops
    // calling atom.reportChanged(), this test stalls at one observation.
    const { store, registry, sessionState } = buildRuntime();
    registry.applyInput(HOOK_DATA);

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(String(store.read("theme")));
    });
    // [LAW:no-defensive-null-guards] try/finally is not defensive — it is
    // the type-level guarantee that the autorun cannot outlive this test
    // even when the assertions throw (which is the *point* of a regression
    // test: when a fault is reintroduced, expectations fail here, and a
    // dangling reaction in the global MobX scheduler would then leak into
    // subsequent tests). Same shape as a using-block / RAII guard.
    try {
      expect(observed).toEqual(["(unset)"]);

      const ctx = { sessionState, dlog: () => {} };
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);

      // Exactly one additional fire — proves the dep graph propagated the
      // change rather than the autorun being scheduled for an unrelated
      // reason or the observation count drifting.
      expect(observed).toEqual(["(unset)", "nord"]);
    } finally {
      dispose();
    }
  });

  test("two state vars: mutation propagates only to its dependent observer", () => {
    // [LAW:behavior-not-structure] Pins both directions of the coarse-atom
    // trade-off documented in session-state.ts:
    //   - cascade reach: a mutation to one key must still reach computeds
    //     that read that key (the atom can't be too narrow).
    //   - memo suppression: a mutation to one key must NOT re-fire
    //     observers of unrelated computeds whose derived value is unchanged
    //     (MobX's value-equality comparer on computed results is what makes
    //     the coarse atom acceptable in the first place).
    // The single-segment / single-state-var fixture above can't separate
    // those: it has no second observer to misbehave. This test adds one.
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
        layout: ['themeSeg', 'tbSeg'],
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
    // [LAW:no-defensive-null-guards] try/finally is the type-level
    // guarantee that both autoruns are disposed even when the
    // assertions throw — see the same note on the test above.
    try {
      expect(themeObs).toEqual(["(unset)"]);
      expect(expandedObs).toEqual([""]);

      const ctx = { sessionState, dlog: () => {} };
      VERBS.get("set-state")!(`${SESSION_ID}/theme/nord`, ctx);

      // Watched key advanced — cascade reached the right computed.
      expect(themeObs).toEqual(["(unset)", "nord"]);
      // Unrelated key: the atom invalidated the `expanded` computed too
      // (coarse-grained reactivity), but it re-derived to the same fallback
      // "" — MobX's value comparer suppresses propagation to this observer.
      expect(expandedObs).toEqual([""]);

      // Sanity: a mutation to the OTHER state key fires the expanded
      // observer (cascade is not over-suppressed).
      sessionState.set(SESSION_ID, "toolbar-expanded", "1");
      expect(expandedObs).toEqual(["", "1"]);
      expect(themeObs).toEqual(["(unset)", "nord"]);
    } finally {
      disposeTheme();
      disposeExp();
    }
  });

  test("set-state rejects an unknown theme value (BadVerbArgs)", () => {
    // Pinning the [LAW:no-silent-fallbacks] contract on the verb itself.
    // An unknown theme cannot quietly persist — the daemon's dispatcher
    // converts BadVerbArgs into a BAD_REQUEST wire response.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/not-a-theme`, ctx),
    ).toThrow(/unknown theme/);
  });

  test('set-state rejects the "custom" theme sentinel (not a renderable theme)', () => {
    // [LAW:one-source-of-truth] The theme validator runs against
    // listResolvablePaletteNames — the set of names that actually resolve
    // to a Palette. "custom" is a sentinel that instructs the cascade to
    // read inline colors; persisting it as a session theme would render
    // empty/broken at the next refresh.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/custom`, ctx),
    ).toThrow(/unknown theme/);
  });

  test("set-state rejects an unknown key with the registered-key list", () => {
    // [LAW:no-silent-fallbacks] An unknown key is the registry telling the
    // operator "this is not a writable surface" — the BAD_REQUEST surfaces
    // exactly which keys ARE writable, so a typo or stale wire spec is
    // self-diagnosing.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/not-a-real-key/whatever`, ctx),
    ).toThrow(/unknown state key "not-a-real-key" \(have: .*theme.*\)/);
  });

  test("set-state writes the style key when given a registered style", () => {
    // The set-state verb covers every registered key; the style key was a
    // separate named verb before this epic.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    VERBS.get("set-state")!(`${SESSION_ID}/style/muted`, ctx);
    expect(sessionState.get(SESSION_ID, "style")).toBe("muted");
  });

  test("set-state rejects an unknown style value with the allowed-list", () => {
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/style/not-a-style`, ctx),
    ).toThrow(/unknown style "not-a-style" \(have: .*muted.*\)/);
  });

  test("set-state normalizes boolean-ish toolbar-expanded values", () => {
    // [LAW:one-source-of-truth] The canonical truthy/falsy strings are
    // owned by the boolean validator, not by each callsite. "1"/"true"
    // collapse to "1"; "0"/"false" collapse to "" — the same sentinel
    // the toolbar-toggle verb produces via clear() for the next render.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };

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
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/toolbar-expanded/maybe`, ctx),
    ).toThrow(/expected boolean-ish/);
  });

  test("set-state rejects malformed wire input (missing key or value)", () => {
    // [LAW:types-are-the-program] The wire shape <sid>/<key>/<value> has
    // three required pieces. Each missing piece is a structurally distinct
    // rejection so a malformed URL surfaces the right hint, not a generic
    // "bad input" — the operator sees which slash they forgot.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };

    // Just the session id (no key/value).
    expect(() => VERBS.get("set-state")!(`${SESSION_ID}`, ctx)).toThrow(
      /<key>\/<value> is required/,
    );
    // Key but no value separator.
    expect(() => VERBS.get("set-state")!(`${SESSION_ID}/theme`, ctx)).toThrow(
      /missing value after key "theme"/,
    );
    // Empty key (extra leading slash). Structurally distinct from the
    // unknown-key validator rejection — the operator's mistake was a
    // missing key segment, not a typo on the key name.
    expect(() => VERBS.get("set-state")!(`${SESSION_ID}//ocean`, ctx)).toThrow(
      /empty key \(expected <sessionId>\/<key>\/<value>\)/,
    );
  });

  test("set-state rejects prototype-poison keys with a clean BAD_REQUEST", () => {
    // [LAW:types-are-the-program] The registry is a ReadonlyMap, not a
    // plain object — so wire-level `__proto__` / `constructor` are
    // ordinary non-members, not truthy hits on Object.prototype. The
    // verb's "unknown state key" path catches them; the alternative
    // (registry as Record<string, T>) would let `validateStateWrite`
    // return Object.prototype as a truthy "validator", which then throws
    // a TypeError on invocation — RENDER_FAILED instead of BAD_REQUEST.
    // [LAW:behavior-not-structure] This test asserts the rejection
    // behavior, so a future revert from Map to a plain object regresses
    // here loudly even though the type alone makes the bad state
    // unrepresentable today.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    for (const poison of ["__proto__", "constructor", "toString"]) {
      expect(() =>
        VERBS.get("set-state")!(`${SESSION_ID}/${poison}/whatever`, ctx),
      ).toThrow(
        new RegExp(`unknown state key "${poison.replace(/\$/g, "\\$")}"`),
      );
    }
  });

  test("set-state preserves slashes inside the value (no further splitting)", () => {
    // [LAW:dataflow-not-control-flow] The verb splits exactly twice (sid,
    // key) — the remainder is the value verbatim. A future state key
    // whose values may legitimately contain `/` (paths, URLs) gets that
    // for free; the parser does not steal slashes from the value space.
    // We exercise this via a temporary registry of one key — the live
    // registry currently has no slash-bearing values, so we synthesize a
    // fixture key by piggybacking on theme: the validator rejects "a/b"
    // by content, but the verb must still SEE "a/b" as the value (not
    // "a"). The rejection message proves the verb passed "a/b" through.
    const { sessionState } = buildRuntime();
    const ctx = { sessionState, dlog: () => {} };
    expect(() =>
      VERBS.get("set-state")!(`${SESSION_ID}/theme/a/b/c`, ctx),
    ).toThrow(/unknown theme "a\/b\/c"/);
  });

  test("parseDslConfig rejects a state-kind var with no session.id anchor", () => {
    // [LAW:verifiable-goals] A config that uses state-kind vars without
    // declaring session.id has to fail at LOAD time. The runtime would
    // otherwise throw "Unknown variable session.id" on the next render —
    // which is observable only when a render lands, not when the file is
    // loaded — and that violates "machine-verifiable at the earliest point."
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
          layout: ['s'],
        }`,
        ALLOWED_PALETTES,
      ),
    ).toThrow(/global "session\.id" variable/);
  });

  test("toolbar-toggle click verb cascades through state binding", () => {
    // Same pattern with a different verb / key — exercises the toggle
    // semantics (set on first click, clear on second).
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
    VERBS.get("toolbar-toggle")!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[1]");
    VERBS.get("toolbar-toggle")!(SESSION_ID, ctx);
    expect(render()).toContain("tb=[]");
  });
});
