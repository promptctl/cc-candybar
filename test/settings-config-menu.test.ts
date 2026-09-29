// [LAW:verifiable-goals] Acceptance for the settings menu's config controls —
// ONE control per setting (candybar-settings-ui-aok.3), every one of them a
// session pick that stays a DRAFT until it is saved (brandon-save-undo-bwi.hpi)
// — measured from a user config whose `root` is a single row of two segments,
// the shape that broke every interactive surface in the first place.
//
//   1. `save` is a marker action: `{ save: true }` and nothing else.
//   2. Every control writes the SESSION key; the only durable links on the bar
//      are the ↺ resets.
//   3. A pick is a draft: `💾 save N` appears, counting them, while the config
//      file is untouched; a pick back to the saved value is no draft at all.
//   4. Save writes every draft to the file in ONE edit, releases the picks, and
//      the cell is gone; a refused save keeps every draft and the file.
//   5. The controls are REACHABLE from that two-segment root: the menu the
//      user cannot delete carries them.

import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError } from "../src/config/dsl-loader";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  effectiveAutoWrap,
  effectivePadding,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { resolveThemeSelection } from "../src/themes/palette-resolvers";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import { settingDrafts } from "../src/daemon/setting-drafts";
import { chmodSync } from "node:fs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { testVerbContext, effectsOf } from "./helpers/click";
import { stripAnsi } from "./helpers/daemon-e2e";
import { parseAndValidate } from "./helpers/parse-and-validate";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { linkUrls, links } from "./helpers/ansi";

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

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width,
  };
}

// [LAW:one-source-of-truth] One rig: parse the user file through the real
// cascade (merged on the bundled default, validated — which is where the
// settings menu is synthesized), install the derived gates the daemon
// installs, and expose render/click over the real handlers. Every assertion
// below reads the same bar a running daemon would produce.
// `durable`, when given, is the session's config file: the rig writes `source`
// there and records the render origin a durable click resolves it from — the
// same two facts a real render leaves behind for a real click.
function rig(
  source: string,
  durable?: DurableConfig,
  width: number = Number.POSITIVE_INFINITY,
): {
  config: ValidatedConfig;
  sessionState: SessionState;
  logs: string[];
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
  // A save compares the session against the config this rig renders with.
  const logs: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable?.historyFor(sessionState)),
    dlog: (_level, msg) => logs.push(msg),
    configFor: () => config,
  };
  return {
    config,
    sessionState,
    logs,
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
          // `theme`/`look` are absent on purpose: renderDsl publishes both
          // `.effective` values itself, so they ride in the SELECTION below and a
          // value here would be overwritten (brandon-themes-dzl).
          style: { effective: "powerline" },
          preset: { effective: "default" },
          autoWrap: {
            effective: effectiveAutoWrap(
              undefined,
              sessionState.get(SID, "autoWrap"),
              config.globals.autoWrap,
            ),
          },
          padding: {
            effective: effectivePadding(
              undefined,
              sessionState.get(SID, "padding"),
              config.globals.padding,
            ),
          },
          // The daemon derives this per render (server.ts) through the same
          // function the save verb writes from.
          unsaved: settingDrafts(config, (key) => sessionState.get(SID, key))
            .length,
        },
        opts(width),
        undefined,
        {
          theme: resolveThemeSelection(
            undefined,
            sessionState.get(SID, "theme"),
            config.globals.palette,
          ),
        },
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
  return linkUrls(rendered);
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

// ─── 1. The save marker ──────────────────────────────────────────────────────

describe("the save action", () => {
  const withActions = (actions: string) => `{
    actions: ${actions},
    segments: { d: { template: 'd' } },
    root: { h: ['d'] },
  }`;

  test("{ save: true } parses as a save", () => {
    const config = parseAndValidate(
      "<test>",
      withActions(`{ s: { save: true } }`),
      ALLOWED,
    );
    expect(config.actions.s).toEqual({ save: true });
  });

  test("a save carries nothing: any other value or key is a load error", () => {
    expect(() =>
      parseAndValidate("<test>", withActions(`{ s: { save: 'theme' } }`), ALLOWED),
    ).toThrow(/save must be the literal true/);
    expect(() =>
      parseAndValidate(
        "<test>",
        withActions(`{ s: { save: true, key: 'theme' } }`),
        ALLOWED,
      ),
    ).toThrow(/Unknown key "key" on a save action/);
  });

  test("the removed persistWhen dual names save as its replacement", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        withActions(
          `{ s: { set: 'theme', persist: 'palette', persistWhen: 'p', from: 'themes' } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/persistWhen was removed: declare the `set` alone .*save: true/);
  });
});

// ─── 2–5. The menu, from a two-segment root ──────────────────────────────────

describe("the config menu, reached from a user config whose root is one row", () => {
  let r: ReturnType<typeof rig>;
  // A save edits the session's config file for real, so this suite hands the
  // rig a temp file (and a temp edit history) for the duration — never the
  // developer's own config.
  let durable: DurableConfig;

  beforeEach(() => {
    durable = durableConfig("cc-candybar-settings-menu-");
    r = rig(TWO_SEGMENT_ROOT, durable);
    // Open the menu and its config row — the two clicks a "🍫 ▸" then
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
    durable.dispose();
  });

  const wrapUrl = (): string =>
    writesTo(r.render(), "autoWrap").find((u) => !isReset(u))!;
  const paddingUp = (): string =>
    links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "▶" &&
        effectsOf(l.url).some((e) => e.args[1] === "padding"),
    )!.url;
  const saveUrl = (): string | undefined =>
    links(r.render()).find((l) =>
      effectsOf(l.url).some((e) => e.verb === "save"),
    )?.url;

  test("every setting the menu owns is one control, reachable from that root", () => {
    const out = plain(r.render());
    // One labelled control each, showing the value the bar actually rendered.
    expect(out).toContain("▦ default"); // preset
    expect(out).toContain("🎨 tokyo-night"); // theme
    expect(out).toContain("◐ none"); // look
    expect(out).toContain("✦ powerline"); // style
    expect(out).toContain("wrap: on"); // autoWrap
    expect(out).toContain("padding 1"); // padding
    // Nothing picked, nothing to save.
    expect(out).not.toContain("💾");
    expect(saveUrl()).toBeUndefined();
  });

  test("every control writes the session key; the only durable links are the ↺ resets", () => {
    // Open the theme ring so its option cells render too.
    const themeMenu = writesTo(r.render(), "menus.settings_pickers").find((u) =>
      effectsOf(u).some((e) => e.args[2] === "settings.apply.theme"),
    );
    r.click(themeMenu!);
    const open = r.render();
    expect(writesTo(open, "theme").length).toBeGreaterThan(0);
    for (const url of linkUrls(open)) {
      const durableWrites = effectsOf(url).filter((e) =>
        ["set-config", "step-config"].includes(e.verb),
      );
      expect(durableWrites).toEqual([]);
    }
    expect(writesTo(open, "palette").every(isReset)).toBe(true);
  });

  test("a pick is a draft: the bar follows it, 💾 save counts it, the file is untouched", () => {
    const before = durable.text();
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("wrap: off");
    expect(plain(r.render())).toContain("💾 save 1");
    r.click(paddingUp());
    expect(plain(r.render())).toContain("💾 save 2");
    expect(durable.text()).toBe(before);
  });

  test("a pick back to the saved value is no draft", () => {
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("💾 save 1");
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("wrap: on");
    expect(plain(r.render())).not.toContain("💾");
  });

  // What the next reload renders with: the file the save wrote, through the
  // same cascade the rig parsed the original with.
  const reloaded = (): ValidatedConfig =>
    parseAndValidate("<user>", durable.text()!, ALLOWED, DEFAULT_DSL_CONFIG);

  test("save writes every draft in one edit, and once it reloads nothing is left to save", () => {
    r.click(wrapUrl());
    r.click(paddingUp());
    r.click(saveUrl()!);
    const globals = durable.parsed().globals as Record<string, unknown>;
    expect(globals.autoWrap).toBe(false);
    expect(globals.padding).toBe(2);
    // The picks stay: the bar keeps showing them through the reload, and the
    // reloaded file resolves to them, so they are no longer drafts.
    expect(r.sessionState.get(SID, "autoWrap")).toBe("false");
    expect(r.sessionState.get(SID, "padding")).toBe("2");
    expect(
      settingDrafts(reloaded(), (key) => r.sessionState.get(SID, key)),
    ).toEqual([]);
    // The save's event names what it wrote and where.
    expect(r.logs).toContainEqual(
      `save: autoWrap=false padding=2 → ${durable.configPath} (session=${SID})`,
    );
    // ONE step in the history, and it is the file write alone.
    expect(durable.history(SID).past.at(-1)!).toEqual([
      expect.objectContaining({ kind: "file", file: durable.configPath }),
    ]);
  });

  test("a second save with nothing unsaved is a recorded no-op", () => {
    r.click(paddingUp());
    const url = saveUrl()!;
    r.click(url);
    // The bar the second click came from was drawn before the reload.
    const saved = durable.text();
    const depth = durable.history(SID).past.length;
    expect(
      settingDrafts(reloaded(), (key) => r.sessionState.get(SID, key)),
    ).toEqual([]);
    // Re-point the rig's config at the reloaded file, as the reload would.
    r.dispose();
    r = rig(saved!, durable);
    r.sessionState.set(SID, "padding", "2");
    expect(() => r.click(url)).not.toThrow();
    expect(durable.text()).toBe(saved);
    expect(durable.history(SID).past).toHaveLength(depth);
    expect(r.logs).toContainEqual(`save: nothing unsaved (session=${SID})`);
  });

  test("a refused write keeps every draft and leaves the file as it was", () => {
    r.click(wrapUrl());
    r.click(paddingUp());
    const before = durable.text();
    chmodSync(durable.projectDir, 0o500);
    try {
      expect(() => r.click(saveUrl()!)).toThrow(/config write failed/);
    } finally {
      chmodSync(durable.projectDir, 0o755);
    }
    expect(durable.text()).toBe(before);
    expect(r.sessionState.get(SID, "autoWrap")).toBe("false");
    expect(r.sessionState.get(SID, "padding")).toBe("2");
    expect(plain(r.render())).toContain("💾 save 2");
  });

  test("a pick the render ignores is no draft, and a save leaves it be", () => {
    r.click(paddingUp());
    r.sessionState.set(SID, "theme", "no-such-theme");
    expect(plain(r.render())).toContain("💾 save 1");
    r.click(saveUrl()!);
    const globals = durable.parsed().globals as Record<string, unknown>;
    expect(globals.padding).toBe(2);
    expect(globals).not.toHaveProperty("palette");
  });
});

// [LAW:verifiable-goals] brandon-theme-picker-bgw.etd: choosing a theme is
// trying several, so a pick must leave the picker open with the new pick
// current. Driven the way a user drives it: two clicks found in the rendered
// bytes and dispatched through the real verb handlers, at 80 columns. The theme control is a carousel
// (brandon-theme-picker-bgw.ef6): each rotation is a pick, so "stays open" is
// a claim about the ring after two of them.
describe("a pick leaves the picker open", () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig(TWO_SEGMENT_ROOT, undefined, 80);
    r.click(writesTo(r.render(), "settings.menu")[0]!);
    r.click(writesTo(r.render(), "settings.config")[0]!);
    r.click(
      writesTo(r.render(), "menus.settings_pickers").find((u) =>
        effectsOf(u).some((e) => e.args[2] === "settings.apply.theme"),
      )!,
    );
  });
  afterEach(() => r.dispose());

  // The theme control's carousel arrow `glyph`: the link that writes the
  // session theme and reads as that arrow.
  const arrow = (rendered: string, glyph: string): string =>
    links(rendered).find(
      (l) =>
        stripAnsi(l.text) === glyph &&
        effectsOf(l.url).some(
          (e) => e.verb === "set-state" && e.args[1] === "theme",
        ),
    )!.url;

  test("two picks in a row: still open, the ring centred on the second pick", () => {
    const opened = plain(r.render());
    r.click(arrow(r.render(), "▶"));
    const first = r.render();
    r.click(arrow(first, "▶"));
    const second = r.render();
    const theme = (rendered: string) =>
      /🎨 (\S+)/.exec(plain(rendered))![1]!;
    expect(theme(first)).not.toBe(theme(opened));
    expect(theme(second)).not.toBe(theme(first));
    // Still open after each pick, centred on what was picked.
    for (const rendered of [first, second]) {
      expect(plain(rendered)).toContain(`◀ ${theme(rendered)} ▶`);
    }
  });
});

// A `↺` reset link is the one legitimate durable write on an unchecked bar:
// it forgets a durable default rather than setting one, so it is not the
// control's own apply.
function isReset(url: string): boolean {
  return effectsOf(url).every((e) => e.verb === "reset-config");
}
