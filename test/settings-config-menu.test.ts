// [LAW:verifiable-goals] Acceptance for candybar-settings-ui-aok.3 — ONE
// control per setting, with a `persist?` checkbox that chooses where the click
// lands — measured the way the epic demands: from a user config whose `root`
// is a single row of two segments, which is the shape that broke every
// interactive surface in the first place.
//
//   1. The loader proves the DUAL ActionDecl arm: both destination keys plus
//      the selector key, one shared value source, rejecting the sources that
//      have no second destination to choose between (`int`, the layout ops).
//   2. A dual derives EXACTLY the gates its two single-destination halves
//      would have derived — asserted by deriving both and comparing, so the
//      claim "this adds no gate surface" is checked against the real
//      derivations rather than restated.
//   3. The rendered click's DESTINATION follows the checkbox: unchecked ⇒
//      set-state on the session key and NO durable link anywhere in the bar;
//      checked ⇒ set-config on the config key and no session link. Same
//      config, same segments, same template — a value chose the store.
//   4. Nothing branches on the checkbox but the checkbox: the two renders are
//      identical text apart from the ☐/☑ glyph, so the layout the walk
//      produces is provably independent of persist state.
//   5. The controls are REACHABLE from that two-segment root: the menu the
//      user cannot delete carries them.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThemePalette } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError } from "../src/config/dsl-loader";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  effectiveAutoWrap,
  effectivePadding,
  effectiveThemeName,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { effectsOf } from "./helpers/click";
import { stripAnsi } from "./helpers/daemon-e2e";
import { parseAndValidate } from "./helpers/parse-and-validate";
import type { ValidatedConfig } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "settings-ui-aok-3";

// The config that motivated the whole epic: a `root` naming two segments and
// nothing else. It declares no actions, no menu, no drawer — every control
// this file asserts on arrives because the settings menu is synthesized into
// EVERY root, which is precisely the claim under test.
const TWO_SEGMENT_ROOT = `{
  globals: {},
  root: { h: ['directory', 'model'] },
}`;

function opts() {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width: Number.POSITIVE_INFINITY,
  };
}

// [LAW:one-source-of-truth] One rig: parse the user file through the real
// cascade (merged on the bundled default, validated — which is where the
// settings menu is synthesized), install the derived gates the daemon
// installs, and expose render/click over the real handlers. Every assertion
// below reads the same bar a running daemon would produce.
function rig(source: string): {
  config: ValidatedConfig;
  render: () => string;
  click: (url: string) => void;
  dispose: () => void;
} {
  const config = parseAndValidate(
    "<user>",
    source,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  const disposers = [
    ...deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    ),
    ...deriveConfigActionValidators(config).map(({ key, spec }) =>
      registerConfigValidator(key, spec),
    ),
  ];
  const ctx: VerbContext = { sessionState, dlog: () => {} };
  return {
    config,
    render: () =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        {
          hook_event_name: "Status",
          session_id: SID,
          cwd: "/tmp",
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: {
            current_dir: "/tmp",
            project_dir: "/tmp",
            added_dirs: [],
          },
          // [LAW:one-source-of-truth] The daemon resolves these per render
          // from SessionState over the config's globals (server.ts's
          // EffectiveGlobals); mirroring that here — through the same policy
          // functions, not a restated rule — is what lets an assertion read
          // the LABEL after a click instead of only the click's URL.
          theme: {
            effective: effectiveThemeName(
              sessionState.get(SID, "theme"),
              config.globals.palette,
            ),
          },
          look: { effective: "none" },
          style: { effective: "powerline" },
          preset: { effective: "default" },
          autoWrap: {
            effective: effectiveAutoWrap(
              sessionState.get(SID, "autoWrap"),
              config.globals.autoWrap,
            ),
          },
          padding: {
            effective: effectivePadding(
              sessionState.get(SID, "padding"),
              config.globals.padding,
            ),
          },
        },
        getThemePalette("tokyo-night"),
        opts(),
      ),
    click: (url: string) => {
      const { verb, value } = parseHandlerUrl(url);
      const effects =
        verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
      for (const e of effects) {
        const handler = VERBS.get(e.verb);
        if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
        handler(e.value, ctx);
      }
    },
    dispose: () => {
      for (const d of disposers) d();
      registry.dispose();
    },
  };
}

function urlsOf(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// The affordances that write `key`, whatever verb carries them — the question
// every assertion here asks is "does any click in this bar write X", never
// "which link is at position N".
function writesTo(rendered: string, key: string): string[] {
  return urlsOf(rendered).filter((u) => {
    try {
      return effectsOf(u).some((e) => e.args[1] === key);
    } catch {
      return false;
    }
  });
}

// What a reader SEES: the styling and the OSC-8 link envelopes removed, so an
// assertion about the panel's text cannot pass on bytes hidden inside a URL.
function plain(rendered: string): string {
  return stripAnsi(rendered);
}

// ─── 1. The dual ActionDecl arm ──────────────────────────────────────────────

describe("the dual-destination action arm", () => {
  const base = (actions: string) => `{
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      persist: { kind: 'state', key: 'persist', default: 'false' },
    },
    actions: ${actions},
    segments: { d: { template: 'd', bg: 'surface', fg: 'foreground' } },
    root: { h: ['d'] },
  }`;

  test("set + persist + persistWhen + from parses as one declaration", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{ t: { set: 'theme', persist: 'palette', persistWhen: 'persist', from: 'themes' } }`,
      ),
      ALLOWED,
    );
    expect(config.actions.t).toEqual({
      set: "theme",
      persist: "palette",
      persistWhen: "persist",
      from: "themes",
    });
  });

  test("cycle and bounded value sources parse too — both destinations share them", () => {
    const config = parseAndValidate(
      "<test>",
      base(
        `{
          w: { set: 'autoWrap', persist: 'autoWrap', persistWhen: 'persist', cycle: ['true','false'] },
          p: { set: 'padding', persist: 'padding', persistWhen: 'persist', min: 0, max: 16, by: 1 },
        }`,
      ),
      ALLOWED,
    );
    expect(config.actions.w).toMatchObject({ cycle: ["true", "false"] });
    expect(config.actions.p).toMatchObject({ min: 0, max: 16, by: 1 });
  });

  test("persistWhen without both destinations is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(`{ t: { set: 'theme', persistWhen: 'persist', from: 'themes' } }`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("`int` has no dual form — a page cursor has no durable meaning", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ t: { set: 'page', persist: 'padding', persistWhen: 'persist', int: true } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("a structural layout op has no dual form — it is durable by nature", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ t: { set: 'x', persist: 'presets.default.rootOps', persistWhen: 'persist', removeSegment: 'd' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  test("two value sources at once is a load error, as it is for set/persist", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ t: { set: 'theme', persist: 'palette', persistWhen: 'persist', from: 'themes', to: 'nord' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });
});

// ─── 2. The derived gate is the union of the two halves ──────────────────────

describe("a dual derives exactly what its two halves derive", () => {
  const withActions = (actions: string) =>
    parseAndValidate(
      "<test>",
      `{
        variables: {
          'session.id': { kind: 'input', path: 'session_id', default: '' },
          persist: { kind: 'state', key: 'persist', default: 'false' },
        },
        actions: ${actions},
        segments: { d: { template: 'd', bg: 'surface', fg: 'foreground' } },
        root: { h: ['d'] },
      }`,
      ALLOWED,
    );

  // [LAW:single-enforcer] The claim is that a dual widens nothing: the pair of
  // specs it derives is the pair two ordinary actions would derive. Comparing
  // the two derivations directly is what makes that a checked fact rather than
  // a comment — a dual that smuggled a wider allow-list would fail here.
  test("session and config gates match the equivalent single-destination pair", () => {
    const dual = withActions(
      `{ t: { set: 'look', persist: 'look', persistWhen: 'persist', from: 'looks' } }`,
    );
    const split = withActions(
      `{
        s: { set: 'look', from: 'looks' },
        p: { persist: 'look', from: 'looks' },
      }`,
    );
    expect(deriveActionValidators(dual)).toEqual(deriveActionValidators(split));
    expect(deriveConfigActionValidators(dual)).toEqual(
      deriveConfigActionValidators(split),
    );
  });

  test("a bounded dual derives the same range on both keys", () => {
    const dual = withActions(
      `{ p: { set: 'padding', persist: 'padding', persistWhen: 'persist', min: 0, max: 16, by: 1 } }`,
    );
    const state = deriveActionValidators(dual).find((c) => c.key === "padding");
    const config = deriveConfigActionValidators(dual).find(
      (c) => c.key === "padding",
    );
    expect(state?.spec).toMatchObject({ kind: "range", min: 0, max: 16 });
    expect(config?.spec).toMatchObject({ kind: "range", min: 0, max: 16 });
  });
});

// ─── 3–5. The menu, from a two-segment root ──────────────────────────────────

describe("the config menu, reached from a user config whose root is one row", () => {
  let r: ReturnType<typeof rig>;
  // A durable click writes configOverridesPath() for real, so point the state
  // dir at a temp directory for the duration — otherwise this suite would edit
  // the developer's own persisted defaults.
  let savedXdgState: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    savedXdgState = process.env.XDG_STATE_HOME;
    stateDir = mkdtempSync(join(tmpdir(), "cc-candybar-settings-menu-state-"));
    process.env.XDG_STATE_HOME = stateDir;
    r = rig(TWO_SEGMENT_ROOT);
    // Open the menu and its config row — the two clicks a "☰ ▸" then
    // "⚙ config ▸" tap dispatches. Both affordances are found in the rendered
    // bytes, never constructed, so this also proves they are REACHABLE.
    const menuToggle = writesTo(r.render(), "settings.menu")[0];
    expect(menuToggle).toBeDefined();
    r.click(menuToggle!);
    const configToggle = writesTo(r.render(), "settings.config")[0];
    expect(configToggle).toBeDefined();
    r.click(configToggle!);
  });
  afterEach(() => {
    r.dispose();
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("every setting the menu owns is one control, reachable from that root", () => {
    const out = plain(r.render());
    // One labelled control each, showing the value the bar actually rendered.
    expect(out).toContain("▦ default"); // preset
    expect(out).toContain("🎨 tokyo-night"); // theme
    expect(out).toContain("◐ none"); // look
    expect(out).toContain("✦ powerline"); // style
    expect(out).toContain("wrap: on"); // autoWrap
    expect(out).toContain("padding 1"); // padding
    expect(out).toContain("☐ persist?"); // the destination selector
  });

  test("unchecked: the theme control writes the SESSION key and nothing durable", () => {
    const before = r.render();
    // Open the theme picker so its option cells render.
    const themeMenu = writesTo(before, "menus.settings_pickers").find((u) =>
      effectsOf(u).some((e) => e.args[2] === "settings.apply.theme"),
    );
    expect(themeMenu).toBeDefined();
    r.click(themeMenu!);

    const open = r.render();
    expect(writesTo(open, "theme").length).toBeGreaterThan(0);
    expect(writesTo(open, "palette").every(isReset)).toBe(true);
  });

  test("checked: the SAME control writes the durable key and nothing session-scoped", () => {
    const persistToggle = writesTo(r.render(), "settings.persist")[0];
    expect(persistToggle).toBeDefined();
    r.click(persistToggle!);
    expect(plain(r.render())).toContain("☑ persist?");

    const themeMenu = writesTo(r.render(), "menus.settings_pickers").find((u) =>
      effectsOf(u).some((e) => e.args[2] === "settings.apply.theme"),
    );
    r.click(themeMenu!);

    const open = r.render();
    expect(writesTo(open, "palette").some((u) => !isReset(u))).toBe(true);
    // The session key is touched, but only to be CLEARED — never given a
    // value. That clear is what keeps a durable write visible to the session
    // that made it: a session pick outranks a durable default, so committing
    // "what I'm looking at" has to stop overriding it here, and an absence is
    // the only thing that means that.
    const themeWrites = writesTo(open, "theme").flatMap((u) => effectsOf(u));
    expect(themeWrites.length).toBeGreaterThan(0);
    expect(
      themeWrites.filter((e) => e.args[1] === "theme").map((e) => e.verb),
    ).toEqual(themeWrites.filter((e) => e.args[1] === "theme").map(() => "clear-state"));
  });

  // [LAW:verifiable-goals] The workflow this menu invites, end to end: try a
  // value in the session, tick persist?, commit it. Before the session clear
  // rode along with the durable write, this sequence left the durable default
  // invisible and the control dead — every further click recomputed the same
  // successor and changed nothing on screen.
  test("try-then-commit leaves the control live and the bar showing the committed value", () => {
    const wrapUrl = (): string =>
      writesTo(r.render(), "autoWrap").find((u) => !isReset(u))!;
    expect(plain(r.render())).toContain("wrap: on");

    // Try it: session-only, the bar follows.
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("wrap: off");

    // Commit it: the durable write lands AND the session override is dropped,
    // so the bar keeps showing what was committed rather than freezing on the
    // session value that would otherwise outrank it.
    r.click(writesTo(r.render(), "settings.persist")[0]!);
    r.click(wrapUrl());
    const committed = r.render();
    expect(
      effectsOf(writesTo(committed, "autoWrap").find((u) => !isReset(u))!).some(
        (e) => e.verb === "set-config",
      ),
    ).toBe(true);

    // …and the session override is GONE, which is the half of the fix this rig
    // can see: the label falls back to the value the config resolves, the slot
    // the durable write now fills. (That the durable value then shows through
    // needs the overrides layer this rig has no RenderCache to load — the
    // real-daemon e2e covers it, with a cold restart on top.)
    expect(plain(committed)).toContain("wrap: on");
  });

  test("the padding stepper follows the checkbox too", () => {
    const stepVerb = (rendered: string): string[] =>
      writesTo(rendered, "padding")
        .flatMap((u) => effectsOf(u))
        .filter((e) => e.args[1] === "padding")
        .map((e) => e.verb);

    expect(stepVerb(r.render())).toContain("step-state");
    r.click(writesTo(r.render(), "settings.persist")[0]!);
    expect(stepVerb(r.render())).toContain("step-config");
  });

  // [LAW:dataflow-not-control-flow] The epic's own guardrail, as a test: no
  // render-walk branch on persist state. If the walk branched — a different
  // segment, a different row, a hidden control — the two renders would differ
  // by more than the glyph the checkbox itself owns. They differ by exactly
  // that one character, so the destination is carried by the click, not by a
  // different bar being drawn.
  test("checking persist? changes the checkbox glyph and nothing else on screen", () => {
    const unchecked = plain(r.render());
    r.click(writesTo(r.render(), "settings.persist")[0]!);
    const checked = plain(r.render());
    // Every visible cell is byte-identical but the checkbox itself: same
    // segments, same order, same labels, same values. The destination moved;
    // the bar did not.
    expect(checked).toContain("☑ persist?");
    expect(unchecked).toContain("☐ persist?");
    expect(checked.replace("☑ persist?", "☐ persist?")).toBe(unchecked);
  });
});

// A `↺` reset link is the one legitimate durable write on an unchecked bar:
// it forgets a durable default rather than setting one, so it is not the
// control's own apply.
function isReset(url: string): boolean {
  return effectsOf(url).every((e) => e.verb === "reset-config");
}
