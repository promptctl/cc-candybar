// [LAW:verifiable-goals] candybar-settings-ui-aok.2's done-gate: `autoWrap` and
// `padding` gain the SessionState half `theme`/`look`/`style` already had, so a
// click changes the clicking session's bar and nobody else's.
//
// The resolution lives in the daemon's per-render globals pass
// (effectiveAutoWrap/effectivePadding -> BuildLineOptions), OUTSIDE renderDsl —
// the exact twin of how a style click reshapes (see dsl-style-picker-reshape).
// This test replicates that resolution as src/daemon/server.ts performs it and
// drives the real click wire, so what it proves is the loop a user runs, not a
// function in isolation.
//
// `charset` and `colorCompatibility` deliberately have NO session half — they
// describe the terminal (glyph coverage, colour depth), not a per-session taste
// — so there is nothing here for them, and the comment on CHARSETS in
// themes/policy.ts is where that decision is recorded.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  effectiveAutoWrap,
  effectiveLookName,
  effectivePadding,
  effectiveStripStyle,
  paletteForThemeName,
} from "../src/themes";
import { effectivePresetName } from "../src/config/presets";
import type { PresetDecl } from "../src/config/dsl-types";
import type { ThemeKey } from "@promptctl/rich-js";
import {
  PADDING_RANGE,
  DEFAULT_PADDING,
  DEFAULT_WRAP,
} from "../src/themes/policy";

const BASE_THEME = "textual-dark";
const ALLOWED = new Set([BASE_THEME]);

// Two cells in one row. Padding is applied INSIDE each cell's background fill,
// so a padding change is visible as the rendered line's width.
const src = (padding: number): string => `{
  globals: { palette: '${BASE_THEME}', padding: ${padding}, autoWrap: true },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    sessionPadding: { kind: 'state', key: 'padding', default: '' },
    sessionWrap: { kind: 'state', key: 'autoWrap', default: '' },
  },
  actions: {
    padUp: { set: 'padding', min: ${PADDING_RANGE.min}, max: ${PADDING_RANGE.max}, by: 1 },
    toggleWrap: { set: 'autoWrap', cycle: ['true', 'false'] },
  },
  segments: {
    a: { template: 'AAAA', bg: 'surface', fg: 'foreground' },
    b: { template: 'BBBB', bg: 'panel', fg: 'foreground' },
  },
  root: { h: ['a', 'b'] },
}`;

const CONFIG_PADDING = 2;

function buildRuntime(padding: number = CONFIG_PADDING) {
  const config = parseAndValidate("<session-globals>", src(padding), ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = paletteForThemeName(BASE_THEME);
  // The click below goes through the real dispatch, which consults the
  // daemon-global validator registry — so the config's derived gate has to be
  // registered, exactly as the daemon registers it on load.
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );

  // [LAW:one-source-of-truth] Resolve both fields per render exactly as
  // server.ts does — the session's clicked value over the config default over
  // the floor. Freezing either would pass here while the real daemon moved.
  const render = (sid: string, width: number): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sid },
      basePalette,
      {
        style: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        charset: "unicode" as const,
        wrap: effectiveAutoWrap(
          sessionState.get(sid, "autoWrap"),
          config.globals.autoWrap,
        ),
        padding: effectivePadding(
          sessionState.get(sid, "padding"),
          config.globals.padding,
        ),
        width,
      },
    );

  const dispose = (): void => {
    for (const d of disposers) d();
    registry.dispose();
  };

  return { config, sessionState, render, dispose };
}

function setState(
  sessionState: SessionState,
  sid: string,
  key: string,
  value: string,
): void {
  // Drive the real wire end-to-end, the URL a rendered `{{ action }}` emits.
  clickUrl(effectsUrl([{ verb: VERB_SET_STATE, args: [sid, key, value] }]), {
    sessionState,
    dlog: () => {},
  });
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

const WIDE = 200;
// Narrow enough that the row cannot fit on one line, so wrapping is observable
// as extra rendered rows.
const NARROW = 12;

describe("a padding click changes one session's bar", () => {
  it("renders what the same value in the config file would, for that session only", () => {
    const clicked = buildRuntime();
    // The oracle: a second config whose FILE says 5. A session pick of 5 has
    // to produce those exact bytes, or the two halves resolve to different
    // renders and `.effective` means two things.
    const asIfConfigured = buildRuntime(5);
    try {
      const bystanderBefore = stripAnsi(clicked.render("s-bystander", WIDE));

      setState(clicked.sessionState, "s-clicker", "padding", "5");

      expect(stripAnsi(clicked.render("s-clicker", WIDE))).toBe(
        stripAnsi(asIfConfigured.render("s-clicker", WIDE)),
      );
      // The bystander never clicked, so their bar is byte-identical to before.
      expect(stripAnsi(clicked.render("s-bystander", WIDE))).toBe(
        bystanderBefore,
      );
    } finally {
      clicked.dispose();
      asIfConfigured.dispose();
    }
  });

  it("returns to the config default when the session value goes away", () => {
    const { config, sessionState, render, dispose } = buildRuntime();
    try {
      const atConfigDefault = stripAnsi(render("s-clear", WIDE));

      setState(sessionState, "s-clear", "padding", "7");
      expect(stripAnsi(render("s-clear", WIDE))).not.toBe(atConfigDefault);

      sessionState.clear("s-clear", "padding");
      expect(stripAnsi(render("s-clear", WIDE))).toBe(atConfigDefault);
      // ...which is the config file's own value, not the built-in floor — so
      // this asserts the middle rung of the precedence chain, not just "some
      // default".
      expect(config.globals.padding).toBe(CONFIG_PADDING);
      expect(config.globals.padding).not.toBe(DEFAULT_PADDING);
    } finally {
      dispose();
    }
  });
});

describe("an autoWrap click changes one session's bar", () => {
  it("a session pick of false beats a config default of true", () => {
    const { config, sessionState, render, dispose } = buildRuntime();
    try {
      expect(config.globals.autoWrap).toBe(true);
      const wrappedRows = render("s-wrap", NARROW).split("\n").length;
      expect(wrappedRows).toBeGreaterThan(1);

      setState(sessionState, "s-wrap", "autoWrap", "false");

      // The regression this pins: a `false` session pick is a real answer, not
      // a missing one. Resolving with `||` instead of `??` would fall through
      // to the `true` config default and silently keep wrapping.
      expect(render("s-wrap", NARROW).split("\n")).toHaveLength(1);
      expect(render("s-other", NARROW).split("\n")).toHaveLength(wrappedRows);
    } finally {
      dispose();
    }
  });
});

describe("a session value outside the domain is not a session value", () => {
  // Every case here is a stale SessionState entry — written when the config's
  // range or vocabulary was wider, or by a hand-edited state file. The contract
  // is that it collapses to the CONFIG DEFAULT (what a session that never
  // clicked sees), never to the floor and never to a throw.
  it.each([
    ["above the range", String(PADDING_RANGE.max + 1)],
    ["below the range", "-1"],
    ["not an integer", "3.5"],
    ["empty", ""],
    ["padded digits", " 3 "],
    ["not a number", "wide"],
  ])("padding %s falls through to the config default", (_label, raw) => {
    expect(effectivePadding(raw, CONFIG_PADDING)).toBe(CONFIG_PADDING);
  });

  it.each([
    ["both ends of the range are admitted", PADDING_RANGE.min],
    ["and the top", PADDING_RANGE.max],
  ])("%s", (_label, value) => {
    expect(effectivePadding(String(value), CONFIG_PADDING)).toBe(value);
  });

  // `configured` is FALSE throughout, which is the whole point: `DEFAULT_WRAP`
  // is true, and so is what any mis-parse of these strings would produce, so a
  // table run against a `true` config default cannot tell "correctly fell
  // through" from "wrongly parsed `yes` as true" — it passes either way.
  it.each([["yes"], ["1"], [""], ["TRUE"], ["on"], ["False"]])(
    "autoWrap %s falls through to the config default",
    (raw) => {
      expect(effectiveAutoWrap(raw, false)).toBe(false);
    },
  );

  it.each([
    ["true", true],
    ["false", false],
  ])("autoWrap %s IS a session value, and wins", (raw, expected) => {
    // The other half of the same guard: the two real members must beat a
    // config default that disagrees, or "falls through" would be trivially
    // satisfied by a parse that never returns anything.
    expect(effectiveAutoWrap(raw, !expected)).toBe(expected);
  });

  it("with no config default either, both land on their floor", () => {
    expect(effectivePadding("nonsense", undefined)).toBe(DEFAULT_PADDING);
    expect(effectiveAutoWrap("nonsense", undefined)).toBe(DEFAULT_WRAP);
  });
});

// [LAW:behavior-not-structure] The precedence this PR's shared resolver
// applies to EVERY pickable global, pinned on the three fields that had their
// own spelling before it: a stale session pick is an ABSENT session pick, so it
// falls through to the config default and reaches the floor only when there is
// no config default either.
//
// This is a deliberate change. The old per-field spellings collapsed a stale
// pick straight to the floor, skipping the user's own declared default — so a
// config saying `style: "capsule"` rendered powerline the moment a session
// entry went stale. Every existing regression test passed `undefined` as the
// config default, where both rules agree, which is exactly why the change could
// land unnoticed; these cases are the ones that can tell them apart.
describe("a stale session pick falls to the config default, not the floor", () => {
  // Identity adaptations / empty fragments: these resolvers read only the KEYS
  // (is this name declared?), so the values need to typecheck and nothing more.
  const IDENTITY: ThemeKey = {
    hueShift: 0,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
  };
  const LOOKS: Record<string, ThemeKey> = {
    none: IDENTITY,
    vivid: IDENTITY,
    muted: IDENTITY,
  };
  const PRESETS: Record<string, PresetDecl> = { default: {}, compact: {} };

  it("strip style: a removed vocabulary member yields the configured style", () => {
    expect(effectiveStripStyle("no-such-style", "capsule")).toBe("capsule");
    expect(effectiveStripStyle("no-such-style", undefined)).toBe("powerline");
  });

  it("look: an orphaned name yields the configured look", () => {
    expect(effectiveLookName("deleted-look", "vivid", LOOKS)).toBe("vivid");
    expect(effectiveLookName("deleted-look", undefined, LOOKS)).toBe("none");
  });

  it("preset: an orphaned name yields the configured preset", () => {
    expect(effectivePresetName("deleted-preset", "compact", PRESETS)).toBe(
      "compact",
    );
    expect(effectivePresetName("deleted-preset", undefined, PRESETS)).toBe(
      "default",
    );
  });

  it("a config default that is ITSELF stale still reaches the floor", () => {
    // The per-config domains are the only ones where the loader cannot catch a
    // stale default, so both rungs have to be parsed, not just the session's.
    expect(effectiveLookName("deleted-look", "also-deleted", LOOKS)).toBe(
      "none",
    );
    expect(effectivePresetName(null, "also-deleted", PRESETS)).toBe("default");
  });
});

describe("padding's bound is one declaration, not three copies", () => {
  it("rejects a config-file value above the range at load", () => {
    expect(() =>
      parseAndValidate(
        "<over-range>",
        `{ globals: { padding: ${PADDING_RANGE.max + 1} } }`,
        ALLOWED,
      ),
    ).toThrow(new RegExp(String(PADDING_RANGE.max)));
  });

  it("admits the top of the range at load, through the same spec", () => {
    const config = parseAndValidate(
      "<at-range>",
      `{ globals: { padding: ${PADDING_RANGE.max} } }`,
      ALLOWED,
    );
    expect(config.globals.padding).toBe(PADDING_RANGE.max);
  });
});
