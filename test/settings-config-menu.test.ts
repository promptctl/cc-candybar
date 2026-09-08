// [LAW:verifiable-goals] ONE control per setting; a `persist?` checkbox picks
// where the click lands.

import { durableConfig, type DurableConfig } from "./helpers/durable-config";
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
import { testVerbContext, effectsOf } from "./helpers/click";
import { stripAnsi } from "./helpers/daemon-e2e";
import { parseAndValidate } from "./helpers/parse-and-validate";
import type { ValidatedConfig } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "settings-ui-aok-3";

// Every control asserted on below arrives only because the settings menu is
// synthesized into EVERY root, including this bare two-segment one.
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

// [LAW:one-source-of-truth] One rig over the real cascade and click handlers.
function rig(
  source: string,
  durable?: DurableConfig,
): {
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
  durable?.write(source);
  durable?.seedOrigin(sessionState, SID);
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
  const ctx: VerbContext = testVerbContext(sessionState);
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
          // [LAW:one-source-of-truth] Through the daemon's own policy functions.
          theme: {
            effective: effectiveThemeName(undefined, 
              sessionState.get(SID, "theme"),
              config.globals.palette,
            ),
          },
          look: { effective: "none" },
          style: { effective: "powerline" },
          preset: { effective: "default" },
          autoWrap: {
            effective: effectiveAutoWrap(undefined, 
              sessionState.get(SID, "autoWrap"),
              config.globals.autoWrap,
            ),
          },
          padding: {
            effective: effectivePadding(undefined, 
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

// "Does any click in this bar write X", never "which link is at position N".
function writesTo(rendered: string, key: string): string[] {
  return urlsOf(rendered).filter((u) => {
    try {
      return effectsOf(u).some((e) => e.args[1] === key);
    } catch {
      return false;
    }
  });
}

// What a reader SEES: no assertion can pass on bytes hidden inside a URL.
function plain(rendered: string): string {
  return stripAnsi(rendered);
}

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
          `{ t: { set: 'x', persist: 'presets.default.root', persistWhen: 'persist', removeSegment: 'd' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
  });

  // [LAW:no-silent-failure] An unreadable selector parses as "session", so a typo
  // would silently pin every control to one destination forever.
  test("persistWhen naming an undeclared state key is a load error", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        base(
          `{ t: { set: 'theme', persist: 'palette', persistWhen: 'persistt', from: 'themes' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/is not a declared state key/);
  });

  // Segment `vars` count too: a global-only check would reject working configs.
  test("a segment-local state variable is a legal selector", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
        actions: { t: { set: 'theme', persist: 'palette', persistWhen: 'flag', from: 'themes' } },
        segments: {
          d: {
            template: 'd', bg: 'surface', fg: 'foreground',
            vars: { flag: { kind: 'state', key: 'flag', default: 'false' } },
          },
        },
        root: { h: ['d'] },
      }`,
      ALLOWED,
    );
    expect(config.actions.t).toMatchObject({ persistWhen: "flag" });
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

  // [LAW:single-enforcer] Comparing derivations makes "a dual widens no gate" a
  // checked fact rather than a claim.
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

describe("the config menu, reached from a user config whose root is one row", () => {
  let r: ReturnType<typeof rig>;
  let durable: DurableConfig;

  beforeEach(() => {
    durable = durableConfig("cc-candybar-settings-menu-");
    r = rig(TWO_SEGMENT_ROOT, durable);
    // Found in the rendered bytes, never constructed, so also REACHABLE.
    const menuToggle = writesTo(r.render(), "settings.menu")[0];
    expect(menuToggle).toBeDefined();
    r.click(menuToggle!);
    const configToggle = writesTo(r.render(), "settings.config")[0];
    expect(configToggle).toBeDefined();
    r.click(configToggle!);
  });
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  test("every setting the menu owns is one control, reachable from that root", () => {
    const out = plain(r.render());
    expect(out).toContain("▦ default");
    expect(out).toContain("🎨 tokyo-night");
    expect(out).toContain("◐ none");
    expect(out).toContain("✦ powerline");
    expect(out).toContain("wrap: on");
    expect(out).toContain("padding 1");
    expect(out).toContain("☐ persist?");
  });

  test("unchecked: the theme control writes the SESSION key and nothing durable", () => {
    const before = r.render();
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
    // The session key rides the durable write as its RELEASE segment only.
    const applyEffects = effectsOf(
      writesTo(open, "palette").find((u) => !isReset(u))!,
    );
    expect(
      applyEffects.some(
        (e) => e.verb === "set-config" && e.args[3] === "theme",
      ),
    ).toBe(true);
    expect(
      applyEffects.some((e) => e.verb === "set-state" && e.args[1] === "theme"),
    ).toBe(false);
  });

  // [LAW:verifiable-goals] The workflow the menu invites: try, tick, commit.
  test("try-then-commit leaves the control live and the bar showing the committed value", () => {
    const wrapUrl = (): string =>
      writesTo(r.render(), "autoWrap").find((u) => !isReset(u))!;
    expect(plain(r.render())).toContain("wrap: on");

    r.click(wrapUrl());
    expect(plain(r.render())).toContain("wrap: off");

    r.click(writesTo(r.render(), "settings.persist")[0]!);
    r.click(wrapUrl());
    const committed = r.render();
    expect(
      effectsOf(writesTo(committed, "autoWrap").find((u) => !isReset(u))!).some(
        (e) => e.verb === "set-config",
      ),
    ).toBe(true);

    // The label falls back to the config-resolved value; the reload itself is
    // covered by the real-daemon e2e.
    expect(plain(committed)).toContain("wrap: on");
    expect((durable.parsed().globals as { autoWrap?: boolean }).autoWrap).toBe(
      true,
    );
  });

  // A stepper emits a RELATIVE nudge and skips the readback the other arms do.
  test("the padding stepper follows the checkbox, and only one destination at a time", () => {
    const stepVerbs = (rendered: string): string[] =>
      writesTo(rendered, "padding")
        .flatMap((u) => effectsOf(u))
        .filter((e) => e.args[1] === "padding")
        .map((e) => e.verb);

    const unchecked = stepVerbs(r.render());
    expect(unchecked).toContain("step-state");
    expect(unchecked).not.toContain("step-config");

    r.click(writesTo(r.render(), "settings.persist")[0]!);

    const checked = stepVerbs(r.render());
    expect(checked).toContain("step-config");
    expect(checked).not.toContain("step-state");
  });

  // [LAW:dataflow-not-control-flow] No render-walk branch on persist state.
  test("checking persist? changes the checkbox glyph and nothing else on screen", () => {
    const unchecked = plain(r.render());
    r.click(writesTo(r.render(), "settings.persist")[0]!);
    const checked = plain(r.render());
    expect(checked).toContain("☑ persist?");
    expect(unchecked).toContain("☐ persist?");
    expect(checked.replace("☑ persist?", "☐ persist?")).toBe(unchecked);
  });
});

// A `↺` reset forgets a durable default rather than setting one.
function isReset(url: string): boolean {
  return effectsOf(url).every((e) => e.verb === "reset-config");
}
