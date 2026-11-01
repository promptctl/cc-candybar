// [LAW:verifiable-goals] candybar-settings-ui-aok.2's done-gate: `autoWrap` and
// `padding` gain the SessionState half `theme`/`style`/`style` already had, so a
// click changes the clicking session's bar and nobody else's.
//
// The resolution lives in the daemon's per-render globals pass
// (resolveEffectiveGlobals -> BuildLineOptions), OUTSIDE drawDsl —
// the exact twin of how an endcaps click reshapes (see dsl-endcaps-picker-reshape).
// This test replicates that resolution as src/daemon/draw-bar.ts performs it and
// drives the real click wire, so what it proves is the loop a user runs, not a
// function in isolation.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl, recordRender } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { resolveStyleSelection } from "../src/themes";
import { effectivePresetName } from "../src/config/presets";
import type { DslConfig, Globals, PresetDecl } from "../src/config/dsl-types";
import type { ThemeKey } from "@promptctl/rich-js";
import { PADDING_RANGE } from "../src/themes/policy";
import { floorOf } from "../src/config/globals-fields";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import type { EffectiveGlobals } from "../src/config/effective-globals";
import { globalsFor } from "./helpers/selection";
import { instantOf } from "../src/utils/instant";

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

// The globals a session renders a config with: `globals` the config file's,
// `picks` the session's, `staged` edit mode's fragment (in force while the
// session is arranging) — read through the one resolution the daemon uses.
function resolved(
  globals: Globals,
  picks: Readonly<Record<string, string>> = {},
  staged?: Globals,
): EffectiveGlobals {
  const config = parseAndValidate(
    "<resolved>",
    JSON.stringify({ globals, ...(staged && { editGlobals: staged }) }),
    ALLOWED,
  );
  const session: Record<string, string> = staged
    ? { ...picks, [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE }
    : { ...picks };
  return globalsFor(config, (key) => session[key] ?? null);
}

function buildRuntime(padding: number = CONFIG_PADDING) {
  const config = parseAndValidate("<session-globals>", src(padding), ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  // [LAW:one-source-of-truth] Resolve both fields per render exactly as
  // draw-bar.ts does — the session's clicked value over the config default over
  // the floor. Freezing either would pass here while the real daemon moved.
  const globals = (sid: string): EffectiveGlobals =>
    globalsFor(config, (key) => sessionState.get(sid, key));
  const render = (sid: string, width: number): Frame =>
    drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: sid },
      instantOf(new Date()),
      {
        endcaps: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: globals(sid).autoWrap,
        padding: globals(sid).padding,
        width,
      },
    ).frame;

  const dispose = (): void => {
    registry.dispose();
  };

  return { config, sessionState, render, dispose };
}

async function setState(
  config: DslConfig,
  sessionState: SessionState,
  sid: string,
  key: string,
  value: string,
): Promise<void> {
  // Drive the real wire end-to-end, the URL a rendered `{{ action }}` emits.
  // The dispatch gates the write by the config the clicking session renders,
  // so the session's render is recorded first.
  recordRender(sessionState, sid);
  await clickUrl(
    effectsUrl([{ verb: VERB_SET_STATE, args: [sid, key, value] }]),
    testVerbContext(sessionState, undefined, config),
  );
}

const WIDE = 200;
// Narrow enough that the row cannot fit on one line, so wrapping is observable
// as extra rendered rows.
const NARROW = 12;

describe("a padding click changes one session's bar", () => {
  it("renders what the same value in the config file would, for that session only", async () => {
    const clicked = buildRuntime();
    // The oracle: a second config whose FILE says 5. A session pick of 5 has
    // to produce those exact bytes, or the two halves resolve to different
    // renders and `.effective` means two things.
    const asIfConfigured = buildRuntime(5);
    try {
      const bystanderBefore = textOf(clicked.render("s-bystander", WIDE));

      await setState(
        clicked.config,
        clicked.sessionState,
        "s-clicker",
        "padding",
        "5",
      );

      expect(textOf(clicked.render("s-clicker", WIDE))).toBe(
        textOf(asIfConfigured.render("s-clicker", WIDE)),
      );
      // The bystander never clicked, so their bar is byte-identical to before.
      expect(textOf(clicked.render("s-bystander", WIDE))).toBe(
        bystanderBefore,
      );
    } finally {
      clicked.dispose();
      asIfConfigured.dispose();
    }
  });

  it("returns to the config default when the session value goes away", async () => {
    const { config, sessionState, render, dispose } = buildRuntime();
    try {
      const atConfigDefault = textOf(render("s-clear", WIDE));

      await setState(config, sessionState, "s-clear", "padding", "7");
      expect(textOf(render("s-clear", WIDE))).not.toBe(atConfigDefault);

      sessionState.clear("s-clear", "padding");
      expect(textOf(render("s-clear", WIDE))).toBe(atConfigDefault);
      // ...which is the config file's own value, not the built-in floor — so
      // this asserts the middle rung of the precedence chain, not just "some
      // default".
      expect(config.globals.padding).toBe(CONFIG_PADDING);
      expect(config.globals.padding).not.toBe(floorOf("padding"));
    } finally {
      dispose();
    }
  });
});

describe("an autoWrap click changes one session's bar", () => {
  it("a session pick of false beats a config default of true", async () => {
    const { config, sessionState, render, dispose } = buildRuntime();
    try {
      expect(config.globals.autoWrap).toBe(true);
      const wrappedRows = textOf(render("s-wrap", NARROW)).split("\n").length;
      expect(wrappedRows).toBeGreaterThan(1);

      await setState(config, sessionState, "s-wrap", "autoWrap", "false");

      // The regression this pins: a `false` session pick is a real answer, not
      // a missing one. Resolving with `||` instead of `??` would fall through
      // to the `true` config default and silently keep wrapping.
      expect(textOf(render("s-wrap", NARROW)).split("\n")).toHaveLength(1);
      expect(textOf(render("s-other", NARROW)).split("\n")).toHaveLength(wrappedRows);
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
    expect(resolved({ padding: CONFIG_PADDING }, { padding: raw }).padding).toBe(
      CONFIG_PADDING,
    );
  });

  it.each([
    ["both ends of the range are admitted", PADDING_RANGE.min],
    ["and the top", PADDING_RANGE.max],
  ])("%s", (_label, value) => {
    expect(
      resolved({ padding: CONFIG_PADDING }, { padding: String(value) }).padding,
    ).toBe(value);
  });

  // `configured` is FALSE throughout, which is the whole point: the autoWrap
  // floor is true, and so is what any mis-parse of these strings would produce, so a
  // table run against a `true` config default cannot tell "correctly fell
  // through" from "wrongly parsed `yes` as true" — it passes either way.
  it.each([["yes"], ["1"], [""], ["TRUE"], ["on"], ["False"]])(
    "autoWrap %s falls through to the config default",
    (raw) => {
      expect(resolved({ autoWrap: false }, { autoWrap: raw }).autoWrap).toBe(
        false,
      );
    },
  );

  it.each([
    ["true", true],
    ["false", false],
  ])("autoWrap %s IS a session value, and wins", (raw, expected) => {
    // The other half of the same guard: the two real members must beat a
    // config default that disagrees, or "falls through" would be trivially
    // satisfied by a parse that never returns anything.
    expect(resolved({ autoWrap: !expected }, { autoWrap: raw }).autoWrap).toBe(
      expected,
    );
  });

  it("with no config default either, both land on their floor", () => {
    const stale = resolved({}, { padding: "nonsense", autoWrap: "nonsense" });
    expect(stale.padding).toBe(floorOf("padding"));
    expect(stale.autoWrap).toBe(floorOf("autoWrap"));
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
// config saying `endcaps: "capsule"` rendered powerline the moment a session
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
  const STYLES: Record<string, ThemeKey> = {
    none: IDENTITY,
    vivid: IDENTITY,
    muted: IDENTITY,
  };
  const PRESETS: Record<string, PresetDecl> = { default: {}, compact: {} };

  it("variation: the session pick over the configured one, a stale pick falling through", () => {
    expect(resolved({ variation: "duo" }, { variation: "mono" }).variation).toBe(
      "mono",
    );
    expect(
      resolved({ variation: "duo" }, { variation: "accent-primary" }).variation,
    ).toBe("duo");
    expect(resolved({}, { variation: "accent-primary" }).variation).toBe(
      "accent",
    );
    expect(
      resolved({}, { variation: "duo" }, { variation: "mono" }).variation,
    ).toBe("mono");
  });

  it("shade: the session pick over the configured one, a stale pick falling through", () => {
    expect(resolved({ shade: "deepest" }, { shade: "muted" }).shade).toBe(
      "muted",
    );
    expect(resolved({ shade: "deepest" }, { shade: "darkest" }).shade).toBe(
      "deepest",
    );
    expect(resolved({}, { shade: "darkest" }).shade).toBe("middle");
    expect(resolved({}, { shade: "muted" }, { shade: "brighter" }).shade).toBe(
      "brighter",
    );
  });

  it("strip style: a removed vocabulary member yields the configured style", () => {
    expect(
      resolved({ endcaps: "capsule" }, { endcaps: "no-such-style" }).endcaps,
    ).toBe("capsule");
    expect(resolved({}, { endcaps: "no-such-style" }).endcaps).toBe(
      "powerline",
    );
  });

  it("style: an orphaned name yields the configured style", () => {
    expect(
      resolveStyleSelection(undefined, "deleted-look", "vivid", STYLES),
    ).toMatchObject({ kind: "decided", name: "vivid" });
    expect(
      resolveStyleSelection(undefined, "deleted-look", undefined, STYLES),
    ).toMatchObject({ kind: "decided", name: "none" });
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
    expect(
      resolveStyleSelection(undefined, "deleted-look", "also-deleted", STYLES),
    ).toMatchObject({ kind: "decided", name: "none" });
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

// brandon-menu-ia-q30.5y4: colour depth is set in the config file only, so a
// session write to its key — a stale entry from when it had a session half, or
// an author's `set` — moves nothing.
describe("colour depth has no session half", () => {
  it("the config file's value renders whatever the session holds", () => {
    const config = parseAndValidate(
      "<no-session-half>",
      `{ globals: { palette: '${BASE_THEME}', colorCompatibility: '256' } }`,
      ALLOWED,
    );
    const picks: Record<string, string> = {
      colorCompatibility: "none",
    };
    expect(
      globalsFor(config, (key) => picks[key] ?? null).colorCompatibility,
    ).toBe("256");
  });

  it.each(["colorCompatibility"])(
    "an authored `set` on %s is a load error naming persist",
    (key) => {
      expect(() =>
        parseAndValidate(
          "<set-config-only>",
          `{ globals: { palette: '${BASE_THEME}' }, actions: { pick: { set: '${key}', to: 'x' } } }`,
          ALLOWED,
        ),
      ).toThrow(
        new RegExp(
          `actions\\.pick sets "${key}", which has no session pick.*persist: "${key}"`,
        ),
      );
    },
  );

  it("a `persist` on the same key still loads", () => {
    expect(() =>
      parseAndValidate(
        "<persist-config-only>",
        `{ globals: { palette: '${BASE_THEME}' }, actions: { pick: { persist: 'colorCompatibility', from: 'colorCompatibilities' } } }`,
        ALLOWED,
      ),
    ).not.toThrow();
  });
});
