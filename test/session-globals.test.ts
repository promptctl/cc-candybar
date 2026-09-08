// [LAW:verifiable-goals] `autoWrap` and `padding` gain the SessionState half
// `theme`/`look`/`style` already had, resolved outside renderDsl as server.ts does.

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

// Padding is applied INSIDE each cell's background fill, so it shows as line width.
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
  // The real dispatch consults the daemon-global validator registry, so the derived gate must be registered.
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );

  // [LAW:one-source-of-truth] Resolved per render exactly as server.ts does; freezing either would pass here while the daemon moved.
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
        wrap: effectiveAutoWrap(undefined, 
          sessionState.get(sid, "autoWrap"),
          config.globals.autoWrap,
        ),
        padding: effectivePadding(undefined, 
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
  clickUrl(effectsUrl([{ verb: VERB_SET_STATE, args: [sid, key, value] }]), testVerbContext(sessionState));
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

const WIDE = 200;
const NARROW = 12;

describe("a padding click changes one session's bar", () => {
  it("renders what the same value in the config file would, for that session only", () => {
    const clicked = buildRuntime();
    // The oracle: a config whose FILE says 5 must render those exact bytes.
    const asIfConfigured = buildRuntime(5);
    try {
      const bystanderBefore = stripAnsi(clicked.render("s-bystander", WIDE));

      setState(clicked.sessionState, "s-clicker", "padding", "5");

      expect(stripAnsi(clicked.render("s-clicker", WIDE))).toBe(
        stripAnsi(asIfConfigured.render("s-clicker", WIDE)),
      );
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

      // A `false` session pick is a real answer: `||` would fall through to the config default.
      expect(render("s-wrap", NARROW).split("\n")).toHaveLength(1);
      expect(render("s-other", NARROW).split("\n")).toHaveLength(wrappedRows);
    } finally {
      dispose();
    }
  });
});

describe("a session value outside the domain is not a session value", () => {
  // A stale entry collapses to the CONFIG DEFAULT, never to the floor and never a throw.
  it.each([
    ["above the range", String(PADDING_RANGE.max + 1)],
    ["below the range", "-1"],
    ["not an integer", "3.5"],
    ["empty", ""],
    ["padded digits", " 3 "],
    ["not a number", "wide"],
  ])("padding %s falls through to the config default", (_label, raw) => {
    expect(effectivePadding(undefined, raw, CONFIG_PADDING)).toBe(CONFIG_PADDING);
  });

  it.each([
    ["both ends of the range are admitted", PADDING_RANGE.min],
    ["and the top", PADDING_RANGE.max],
  ])("%s", (_label, value) => {
    expect(effectivePadding(undefined, String(value), CONFIG_PADDING)).toBe(value);
  });

  // `configured` is FALSE throughout: against a `true` default the table would pass either way.
  it.each([["yes"], ["1"], [""], ["TRUE"], ["on"], ["False"]])(
    "autoWrap %s falls through to the config default",
    (raw) => {
      expect(effectiveAutoWrap(undefined, raw, false)).toBe(false);
    },
  );

  it.each([
    ["true", true],
    ["false", false],
  ])("autoWrap %s IS a session value, and wins", (raw, expected) => {
    expect(effectiveAutoWrap(undefined, raw, !expected)).toBe(expected);
  });

  it("with no config default either, both land on their floor", () => {
    expect(effectivePadding(undefined, "nonsense", undefined)).toBe(DEFAULT_PADDING);
    expect(effectiveAutoWrap(undefined, "nonsense", undefined)).toBe(DEFAULT_WRAP);
  });
});

// [LAW:behavior-not-structure] A stale session pick is an ABSENT pick: it falls to the config default and reaches the floor only when there is none.
describe("a stale session pick falls to the config default, not the floor", () => {
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
    expect(effectiveStripStyle(undefined, "no-such-style", "capsule")).toBe("capsule");
    expect(effectiveStripStyle(undefined, "no-such-style", undefined)).toBe("powerline");
  });

  it("look: an orphaned name yields the configured look", () => {
    expect(effectiveLookName(undefined, "deleted-look", "vivid", LOOKS)).toBe("vivid");
    expect(effectiveLookName(undefined, "deleted-look", undefined, LOOKS)).toBe("none");
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
    // Per-config domains are the only ones the loader cannot catch, so both rungs are parsed.
    expect(effectiveLookName(undefined, "deleted-look", "also-deleted", LOOKS)).toBe(
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
