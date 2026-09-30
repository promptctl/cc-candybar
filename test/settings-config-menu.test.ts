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
//   5b. Under a preset that pins a setting, a save lands in that preset's own
//      globals, so the bar the file alone renders draws the saved value.

import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError, loadConfigSource } from "../src/config/dsl-loader";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  effectiveInputs,
  renderOptionsOf,
  renderSelectionOf,
  resolveEffectiveGlobals,
} from "../src/daemon/render-payload";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../src/daemon/verbs/config-validators";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import {
  fileHeldSettings,
  settingCounts,
} from "../src/daemon/setting-drafts";
import { chmodSync } from "node:fs";
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
  readonly config: ValidatedConfig;
  sessionState: SessionState;
  logs: string[];
  // One entry per reload, holding the file text and the session's picks at the
  // moment it ran — so a test can pin how many reloads a click cost and that
  // the picks were still held while the file reloaded.
  reloads: { text: string; picks: Record<string, string | null> }[];
  render: () => string;
  click: (url: string) => void;
  dispose: () => void;
} {
  const sessionState = new SessionState();
  durable?.write(source);
  durable?.seedOrigin(sessionState, SID);
  // Everything the daemon's cache entry holds for one config — rebuilt whole
  // on a reload, the old registry and gates disposed first, exactly as
  // RenderCache.reloadInto swaps an entry's state.
  const load = (text: string) => {
    const config = parseAndValidate(
      "<user>",
      text,
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
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
      () => registry.dispose(),
    ];
    // What the render cache reads off the file's raw parse (render.ts).
    const fileHeld = fileHeldSettings(
      loadConfigSource("<user>", text, DEFAULT_DSL_CONFIG, ALLOWED).raw,
    );
    return { config, store, registry, compiled, disposers, fileHeld };
  };
  let entry = load(source);
  const logs: string[] = [];
  const reloads: { text: string; picks: Record<string, string | null> }[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable?.historyFor(sessionState)),
    dlog: (_level, msg) => logs.push(msg),
    configFor: () => entry.config,
    reloadConfig: () => {
      reloads.push({
        text: durable!.text()!,
        picks: Object.fromEntries(
          ["theme", "look", "padding"].map((k) => [k, sessionState.get(SID, k)]),
        ),
      });
      const next = load(durable!.text()!);
      entry.disposers.forEach((d) => d());
      entry = next;
    },
  };
  return {
    get config() {
      return entry.config;
    },
    sessionState,
    logs,
    reloads,
    render: () => {
      const { config, compiled, store, registry } = entry;
      // [LAW:one-source-of-truth] The daemon's own projection (server.ts): one
      // `resolveEffectiveGlobals` over the session's picks feeds the payload's
      // `.effective` labels, the render options and the selection, through the
      // same `effectiveInputs`/`renderOptionsOf`/`renderSelectionOf`, so a preset
      // that pins a global reaches this bar exactly as it reaches the daemon's.
      // `.preset.customized` is the one fact not mirrored: the daemon reads it
      // off the render cache's raw parse, which this rig does not keep, and no
      // assertion here reads it.
      const sessionPick = (key: string): string | null =>
        sessionState.get(SID, key);
      const effective = resolveEffectiveGlobals(config, sessionPick, () => false);
      return renderDsl(
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
          ...effectiveInputs(effective),
          // The daemon derives these per render (server.ts) through the same
          // function.
          ...settingCounts(config, entry.fileHeld, sessionPick),
          // What the daemon publishes from the session's settings history.
          history: {
            undo: durable?.history(SID).past.length ?? 0,
            redo: durable?.history(SID).future.length ?? 0,
          },
        },
        renderOptionsOf(effective, width),
        undefined,
        renderSelectionOf(effective),
      );
    },
    // The daemon's own path: the URL's verb — `dispatch` for a compound
    // click — looked up in the one table, so a click is one history step.
    click: (url: string) => {
      const { verb, value } = parseHandlerUrl(url);
      const handler = VERBS.get(verb);
      if (!handler) throw new Error(`no handler for verb "${verb}"`);
      handler(value, ctx);
    },
    dispose: () => entry.disposers.forEach((d) => d()),
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
      parseAndValidate(
        "<test>",
        withActions(`{ s: { save: 'theme' } }`),
        ALLOWED,
      ),
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
    const menuToggle = writesTo(r.render(), "candybar.menu")[0];
    expect(menuToggle).toBeDefined();
    r.click(menuToggle!);
    const configToggle = writesTo(r.render(), "candybar.config")[0];
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
    expect(out).toContain("☑ wrap"); // autoWrap
    expect(out).toContain("padding 1"); // padding
    expect(out).toContain("☑ update notice"); // updateNotice
    // Nothing picked, nothing to save.
    expect(out).not.toContain("💾");
    expect(saveUrl()).toBeUndefined();
  });

  test("every control writes the session key; the only durable links are the ↺ resets", () => {
    // Open the theme ring so its option cells render too.
    const themeMenu = writesTo(r.render(), "menus.candybar_pickers").find((u) =>
      effectsOf(u).some((e) => e.args[2] === "candybar.apply.theme"),
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
    expect(plain(r.render())).toContain("☐ wrap");
    expect(plain(r.render())).toContain("💾 save 1");
    r.click(paddingUp());
    expect(plain(r.render())).toContain("💾 save 2");
    expect(durable.text()).toBe(before);
  });

  // brandon-save-undo-bwi.bcn: the bundled compact preset pins padding 0, so
  // the stepper starts from the 0 the bar shows, never top-level globals' 1.
  test("an unpicked padding steps from the value the session's preset shows", () => {
    r.sessionState.set(SID, "preset", "compact");
    expect(plain(r.render())).toContain("padding 0");
    r.click(paddingUp());
    expect(r.sessionState.get(SID, "padding")).toBe("1");
    expect(plain(r.render())).toContain("padding 1");
    expect(r.logs).toContainEqual(
      `step-state: padding 0→1 (by 1, session=${SID})`,
    );
  });

  test("a pick back to the saved value is no draft", () => {
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("💾 save 1");
    r.click(wrapUrl());
    expect(plain(r.render())).toContain("☑ wrap");
    expect(plain(r.render())).not.toContain("💾");
  });

  test("save writes every draft in one edit, reloads, releases the picks, and the cell is gone", () => {
    r.click(wrapUrl());
    r.click(paddingUp());
    r.click(saveUrl()!);
    const globals = durable.parsed().globals as Record<string, unknown>;
    expect(globals.autoWrap).toBe(false);
    expect(globals.padding).toBe(2);
    expect(r.sessionState.get(SID, "autoWrap")).toBeNull();
    expect(r.sessionState.get(SID, "padding")).toBeNull();
    // The very next render reads the reloaded file: the saved values, and
    // nothing left to save — no frame of the old file without the picks.
    const after = plain(r.render());
    expect(after).toContain("☐ wrap");
    expect(after).toContain("padding 2");
    expect(after).not.toContain("💾");
    // The save's event names what it wrote and where.
    expect(r.logs).toContainEqual(
      `save: autoWrap=false padding=2 → ${durable.configPath} (session=${SID})`,
    );
    // ONE step in the history: the save's file write and its release together.
    const step = durable.history(SID).past.at(-1)!;
    expect(step.filter((c) => c.kind === "file")).toEqual([
      expect.objectContaining({ file: durable.configPath }),
    ]);
    expect(step.filter((c) => c.kind === "session")).toEqual(
      expect.arrayContaining([
        { kind: "session", key: "autoWrap", before: "false", after: null },
        { kind: "session", key: "padding", before: "2", after: null },
      ]),
    );
  });

  test("a second click on a bar drawn before the save is a recorded no-op", () => {
    r.click(paddingUp());
    const url = saveUrl()!;
    r.click(url);
    const saved = durable.text();
    const depth = durable.history(SID).past.length;
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

// ─── 5b. Save under a preset that pins the setting (brandon-menu-ia-zyf) ────
//
// A user preset pinning a display global shadows the file's top-level value,
// so a save written there would change nothing the bar shows: the carousel
// would re-centre on the pin and every further save repeat the same no-op.
// Both ways the preset becomes active are driven — the file names it, or the
// session picks it and the save writes that pick too — and each asserts the
// bar DRAWS the saved style, not only that its label says so: the plain
// joiner's default separator " | " sits between cells, which no capsule row
// carries.
const PINNING_PRESET = `{
  presets: { narrow: { globals: { style: 'capsule' } } },
  root: { h: ['directory', 'model'] },
}`;
const PINNING_PRESET_NAMED = `{
  globals: { preset: 'narrow' },
  presets: { narrow: { globals: { style: 'capsule' } } },
  root: { h: ['directory', 'model'] },
}`;
const PLAIN_SEAM = " | ";

describe("save under a preset that pins the setting", () => {
  let durable: DurableConfig;
  beforeEach(() => {
    durable = durableConfig("cc-candybar-settings-pin-");
  });
  afterEach(() => durable.dispose());

  // Pick `plain` from the style carousel, save, and return the bar after the
  // save released the pick — what the file alone renders.
  const pickPlainAndSave = (r: ReturnType<typeof rig>): string => {
    r.click(writesTo(r.render(), "candybar.config")[0]!);
    r.click(
      writesTo(r.render(), "menus.candybar_pickers").find((u) =>
        effectsOf(u).some((e) => e.args[2] === "candybar.apply.style"),
      )!,
    );
    const capsule = plain(r.render());
    expect(capsule).toContain("✦ capsule");
    expect(capsule).not.toContain(PLAIN_SEAM);
    const pickPlain = writesTo(r.render(), "style").find((u) =>
      effectsOf(u).some((e) => e.args[1] === "style" && e.args[2] === "plain"),
    );
    r.click(pickPlain!);
    const save = links(r.render()).find((l) =>
      effectsOf(l.url).some((e) => e.verb === "save"),
    )!.url;
    r.click(save);
    expect(r.sessionState.get(SID, "style")).toBeNull();
    return plain(r.render());
  };

  test("the file names the preset: the save lands in its globals and the bar draws it", () => {
    const r = rig(PINNING_PRESET_NAMED, durable);
    try {
      r.click(writesTo(r.render(), "candybar.menu")[0]!);
      const after = pickPlainAndSave(r);

      const parsed = durable.parsed() as {
        globals: Record<string, unknown>;
        presets: { narrow: { globals: Record<string, unknown> } };
      };
      expect(parsed.presets.narrow.globals.style).toBe("plain");
      expect(parsed.globals).not.toHaveProperty("style");
      expect(after).toContain("✦ plain");
      expect(after).toContain(PLAIN_SEAM);
      expect(after).not.toContain("💾");
      expect(r.logs).toContainEqual(
        `save: presets.narrow.globals.style=plain → ${durable.configPath} (session=${SID})`,
      );
    } finally {
      r.dispose();
    }
  });

  test("the session picks the preset: the save writes both, the style into the preset", () => {
    const r = rig(PINNING_PRESET, durable);
    try {
      r.click(writesTo(r.render(), "candybar.menu")[0]!);
      r.click(
        writesTo(r.render(), "menus.candybar_pickers").find((u) =>
          effectsOf(u).some((e) => e.args[2] === "candybar.apply.preset"),
        )!,
      );
      r.click(
        writesTo(r.render(), "preset").find((u) =>
          effectsOf(u).some(
            (e) => e.args[1] === "preset" && e.args[2] === "narrow",
          ),
        )!,
      );
      const after = pickPlainAndSave(r);

      const parsed = durable.parsed() as {
        globals: Record<string, unknown>;
        presets: { narrow: { globals: Record<string, unknown> } };
      };
      expect(parsed.globals).toEqual({ preset: "narrow" });
      expect(parsed.presets.narrow.globals.style).toBe("plain");
      expect(r.sessionState.get(SID, "preset")).toBeNull();
      expect(after).toContain("✦ plain");
      expect(after).toContain(PLAIN_SEAM);
      expect(after).not.toContain("💾");
    } finally {
      r.dispose();
    }
  });
});

// ─── 6. Reset (brandon-save-undo-bwi.wt5) ────────────────────────────────────
//
// A user file carrying settings at BOTH layers a save writes — top-level
// globals and a bundled preset's own fragment — beside content the user
// authored that no reset may touch: a segment, the root, and a preset of their
// own whose pin is part of what they wrote.
const CUSTOMIZED = `{
  // the user's own words
  globals: { palette: 'nord', padding: 2, style: 'capsule' },
  segments: { mine: { template: 'mine' } },
  presets: {
    compact: { globals: { padding: 3 } },
    narrow: { globals: { style: 'plain' } },
  },
  root: { h: ['directory', 'mine'] },
}`;

describe("reset returns settings to the bundled default", () => {
  let r: ReturnType<typeof rig>;
  let durable: DurableConfig;

  beforeEach(() => {
    durable = durableConfig("cc-candybar-settings-reset-");
    r = rig(CUSTOMIZED, durable);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    r.click(writesTo(r.render(), "candybar.config")[0]!);
  });
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  // The ↺ beside one setting: the link whose only reset names `configKey`.
  const resetOf = (configKey: string): string =>
    links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "↺" &&
        effectsOf(l.url).some(
          (e) => e.verb === "reset-config" && e.args[1] === configKey,
        ),
    )!.url;
  const labelled = (text: string): string | undefined =>
    links(r.render()).find((l) => stripAnsi(l.text) === text)?.url;
  const userContent = () => {
    const { segments, root, presets } = durable.parsed() as {
      segments: unknown;
      root: unknown;
      presets: Record<string, unknown>;
    };
    return { segments, root, narrow: presets.narrow };
  };
  const USER_CONTENT = {
    segments: { mine: { template: "mine" } },
    root: { h: ["directory", "mine"] },
    narrow: { globals: { style: "plain" } },
  };

  test("↺ clears the session's pick and the saved value, and the bar shows the default", () => {
    r.sessionState.set(SID, "theme", "dracula");
    expect(plain(r.render())).toContain("🎨 dracula");
    r.click(resetOf("palette"));
    expect(r.reloads).toEqual([
      { text: durable.text(), picks: { theme: "dracula", look: null, padding: null } },
    ]);
    expect(r.sessionState.get(SID, "theme")).toBeNull();
    expect(durable.parsed().globals).not.toHaveProperty("palette");
    const theme = DEFAULT_DSL_CONFIG.globals.palette as string;
    expect(plain(r.render())).toContain(`🎨 ${theme}`);
    expect(plain(r.render())).not.toContain("💾");
    expect(userContent()).toEqual(USER_CONTENT);
  });

  test("↺ clears a value saved into a bundled preset's fragment, never a user preset's pin", () => {
    r.click(resetOf("padding"));
    const parsed = durable.parsed() as {
      globals: Record<string, unknown>;
      presets: Record<string, unknown>;
    };
    expect(parsed.globals).not.toHaveProperty("padding");
    // compact's fragment held nothing else, so the file stops naming it and
    // the bundled compact (padding 0) shows through again.
    expect(parsed.presets).not.toHaveProperty("compact");
    expect(userContent()).toEqual(USER_CONTENT);

    r.click(resetOf("style"));
    expect(durable.parsed().globals).not.toHaveProperty("style");
    expect(userContent()).toEqual(USER_CONTENT);
    expect(r.logs).toContainEqual(
      `reset-config: style ${Object.keys(DEFAULT_DSL_CONFIG.presets)
        .map((name) => `presets.${name}.globals.style`)
        .join(" ")} session:style ← ${durable.configPath} (session=${SID})`,
    );
  });

  test("reset all takes two clicks in one open menu, and the door disarms it", () => {
    const before = durable.text();
    r.click(labelled("⟲")!);
    expect(durable.text()).toBe(before);
    expect(labelled("⟲")).toBeUndefined();
    expect(labelled("⟲ reset all?")).toBeDefined();
    // Close and reopen the menu: the arm does not survive it.
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    expect(labelled("⟲ reset all?")).toBeUndefined();
    expect(labelled("⟲")).toBeDefined();
    expect(durable.text()).toBe(before);
  });

  test("the armed reset all offers a ✕ that disarms it without resetting", () => {
    const before = durable.text();
    r.click(labelled("⟲")!);
    const cancel = links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "✕" &&
        effectsOf(l.url).some((e) => e.args.includes("candybar.resetAll")),
    )!.url;
    r.click(cancel);
    expect(labelled("⟲ reset all?")).toBeUndefined();
    expect(labelled("⟲")).toBeDefined();
    expect(durable.text()).toBe(before);
  });

  // brandon-menu-ia-q30.4oj: `⟲` shows whenever a reset would change
  // something — here the file's own values, with no draft to save.
  test("⟲ shows beside the preset with no drafts while the file holds a resettable value", () => {
    const [line1 = ""] = plain(r.render()).split("\n");
    expect(line1).toContain("▦");
    expect(line1).toContain("⟲");
    expect(line1).not.toContain("💾");
  });

  test("reset all clears every setting at every layer as one step, and undo restores the exact bytes", () => {
    const before = durable.text();
    r.sessionState.set(SID, "padding", "5");
    r.sessionState.set(SID, "look", "dim");
    const depth = durable.history(SID).past.length;
    r.click(labelled("⟲")!);
    r.click(labelled("⟲ reset all?")!);

    // Every setting's reset in one click is ONE write and ONE reload, made
    // while the session still held its picks — released only after.
    expect(r.reloads).toEqual([
      { text: durable.text(), picks: { theme: null, look: "dim", padding: "5" } },
    ]);

    const parsed = durable.parsed() as {
      globals?: Record<string, unknown>;
      presets: Record<string, unknown>;
    };
    expect(parsed.globals ?? {}).toEqual({});
    expect(parsed.presets).not.toHaveProperty("compact");
    expect(userContent()).toEqual(USER_CONTENT);
    expect(r.sessionState.get(SID, "padding")).toBeNull();
    expect(r.sessionState.get(SID, "look")).toBeNull();
    // Nothing is left for a reset to change, so `⟲` is gone.
    expect(labelled("⟲")).toBeUndefined();
    const out = plain(r.render());
    expect(out).toContain("padding 1");
    expect(out).toContain("◐ none");
    expect(out).not.toContain("💾");

    // One click, one step — undone by the ↶ on the bar.
    expect(durable.history(SID).past).toHaveLength(depth + 1);
    r.click(labelled("↶")!);
    expect(durable.text()).toBe(before);
    expect(r.sessionState.get(SID, "padding")).toBe("5");
    expect(r.sessionState.get(SID, "look")).toBe("dim");
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
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    r.click(writesTo(r.render(), "candybar.config")[0]!);
    r.click(
      writesTo(r.render(), "menus.candybar_pickers").find((u) =>
        effectsOf(u).some((e) => e.args[2] === "candybar.apply.theme"),
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
    const theme = (rendered: string) => /🎨 (\S+)/.exec(plain(rendered))![1]!;
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
  return effectsOf(url).some((e) => e.verb === "reset-config");
}

// [LAW:verifiable-goals] brandon-save-undo-bwi.o6u: save as preset. Every
// click is found in the rendered bar and dispatched through the real verb
// table, and every assertion on the file is on its exact bytes.
const USER_PRESETS = `{
  globals: { palette: 'nord', padding: 2 },
  segments: { mine: { template: 'mine' } },
  presets: {
    narrow: {
      root: { h: [
        'mine', // mine leads
        'directory',
      ] },
    },
  },
  root: { h: ['directory', 'mine'] },
}`;

// USER_PRESETS once the session in `narrow`, wearing dracula and dim, saved
// its bar: narrow's root copied with its comment, and only the two settings
// that differ from the file's own globals.
const SAVED_CUSTOM_1 = `{
  globals: { palette: 'nord', padding: 2 },
  segments: { mine: { template: 'mine' } },
  presets: {
    narrow: {
      root: { h: [
        'mine', // mine leads
        'directory',
      ] },
    },
    "custom-1": {
      root: { h: [
        'mine', // mine leads
        'directory',
      ] },
      globals: {
        palette: "dracula",
        look: "dim",
      },
    },
  },
  root: { h: ['directory', 'mine'] },
}`;

describe("save as preset", () => {
  let r: ReturnType<typeof rig>;
  let durable: DurableConfig;

  const link = (text: string): string | undefined =>
    links(r.render()).find((l) => stripAnsi(l.text) === text)?.url;
  const effective = () =>
    resolveEffectiveGlobals(
      r.config,
      (key) => r.sessionState.get(SID, key),
      () => false,
    );
  // The door, then the preset control's ▸: the ring and the rows beneath it.
  const openPresets = () => {
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    r.click(
      links(r.render()).find((l) =>
        effectsOf(l.url).some((e) => e.args[2] === "candybar.apply.preset"),
      )!.url,
    );
  };

  function start(source: string, picks: Record<string, string> = {}): void {
    durable = durableConfig("cc-candybar-save-preset-");
    r = rig(source, durable);
    for (const [k, v] of Object.entries(picks)) r.sessionState.set(SID, k, v);
    openPresets();
  }
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  test("keeps the bar as custom-1 — the arrangement and only what differs — and switches to it", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", look: "dim", padding: "2" });
    r.click(link("⊕ save as preset")!);

    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    // Reloaded once, while the session still held its picks.
    expect(r.reloads).toEqual([
      { text: SAVED_CUSTOM_1, picks: { theme: "dracula", look: "dim", padding: "2" } },
    ]);
    // The preset renders what the picks did, so they are released.
    for (const key of ["theme", "look", "padding"]) {
      expect(r.sessionState.get(SID, key)).toBeNull();
    }
    expect(r.sessionState.get(SID, "preset")).toBe("custom-1");
    const e = effective();
    expect([e.preset, e.theme.kind === "decided" && e.theme.name, e.padding]).toEqual([
      "custom-1",
      "dracula",
      2,
    ]);
    // The ring is on the new preset, and the one draft left is the switch.
    const out = plain(r.render());
    expect(out).toContain("◀ custom-1 ▶");
    expect(out).toContain("💾 save 1");
    expect(r.logs).toContainEqual(
      `save-preset: custom-1 from=narrow palette=dracula look=dim → ${durable.configPath} (session=${SID})`,
    );
  });

  test("switching away and back changes no byte, and the preset still renders what was saved", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", look: "dim" });
    r.click(link("⊕ save as preset")!);
    r.click(link("default")!);
    expect(effective().preset).toBe("default");
    expect(effective().theme).toMatchObject({ name: "nord" });
    r.click(link("custom-1")!);
    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    expect(effective().theme).toMatchObject({ name: "dracula" });
    expect(effective().look).toMatchObject({ name: "dim" });
  });

  test("a second save takes the next free name", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", look: "dim" });
    r.click(link("⊕ save as preset")!);
    r.click(link("⊕ save as preset")!);
    const presets = durable.parsed().presets as Record<string, unknown>;
    expect(Object.keys(presets)).toEqual(["narrow", "custom-1", "custom-2"]);
    // Saved from custom-1 with nothing picked: its arrangement and its pins.
    expect(presets["custom-2"]).toEqual(presets["custom-1"]);
    expect(effective().preset).toBe("custom-2");
  });

  test("🗑 deletes the preset it names, returning the file byte for byte, and only a user preset offers it", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", look: "dim" });
    expect(plain(r.render())).toContain("🗑 delete narrow");
    r.click(link("⊕ save as preset")!);
    r.click(link("🗑 delete custom-1")!);

    expect(durable.text()).toBe(USER_PRESETS);
    expect(r.sessionState.get(SID, "preset")).toBeNull();
    expect(effective().preset).toBe("default");
    // `default` is bundled: nothing to delete.
    expect(plain(r.render())).not.toContain("🗑");
    expect(r.logs).toContainEqual(
      `delete-preset: custom-1 ← ${durable.configPath} (session=${SID})`,
    );
  });

  test("save and delete are one undo step each, restoring the exact bytes and picks", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", look: "dim" });
    r.click(link("⊕ save as preset")!);
    r.click(link("🗑 delete custom-1")!);

    r.click(link("↶")!);
    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    expect(r.sessionState.get(SID, "preset")).toBe("custom-1");

    r.click(link("↶")!);
    expect(durable.text()).toBe(USER_PRESETS);
    expect(
      ["preset", "theme", "look"].map((k) => r.sessionState.get(SID, k)),
    ).toEqual(["narrow", "dracula", "dim"]);
  });

  test("a bundled preset is never deleted, even one the file pins a setting on", () => {
    const source = `{
  presets: { compact: { globals: { padding: 3 } } },
}`;
    start(source, { preset: "compact" });
    expect(plain(r.render())).not.toContain("🗑");
    // The click a stale or hand-built URL could still carry.
    expect(() =>
      r.click(`cc-candybar://delete-preset/${SID}/compact`),
    ).toThrow('cannot delete preset "compact": it is bundled');
    expect(durable.text()).toBe(source);
  });

  test("deleting the preset the file selects removes the selection too, so the file still loads", () => {
    const source = `{
  globals: { preset: 'mine' },
  presets: { mine: { globals: { padding: 4 } } },
}`;
    start(source);
    expect(effective().preset).toBe("mine");
    r.click(link("🗑 delete mine")!);
    expect(durable.parsed()).toEqual({});
    expect(effective().preset).toBe("default");
  });

  // [LAW:single-enforcer] Every write is proved to load before it lands, so a
  // click that would break the file changes nothing — not the file, not the
  // session's picks.
  test("a preset holding a group cannot be copied — group names are config-wide — and nothing changes", () => {
    const source = `{
  segments: { mine: { template: 'mine' } },
  presets: {
    grouped: { root: { h: [{ kind: 'group', name: 'extra', label: 'x', children: ['mine'] }] } },
  },
}`;
    start(source, { preset: "grouped", theme: "dracula" });
    expect(() => r.click(link("⊕ save as preset")!)).toThrow(
      /would not load after this click[\s\S]*extra/,
    );
    expect(durable.text()).toBe(source);
    expect(["preset", "theme"].map((k) => r.sessionState.get(SID, k))).toEqual([
      "grouped",
      "dracula",
    ]);
  });

  test("a preset an action targets is not deleted out from under it", () => {
    const source = `{
  actions: { resetMine: { reset: 'presets.mine.root' } },
  presets: { mine: { globals: { padding: 4 } } },
}`;
    start(source, { preset: "mine" });
    expect(() => r.click(link("🗑 delete mine")!)).toThrow(
      /would not load after this click[\s\S]*resetMine/,
    );
    expect(durable.text()).toBe(source);
    expect(r.sessionState.get(SID, "preset")).toBe("mine");
  });

  test("the name skips one the file holds under the loader's identifier collapse", () => {
    const source = `{
  presets: { custom_1: {} },
}`;
    start(source, { preset: "custom_1", theme: "dracula" });
    r.click(link("⊕ save as preset")!);
    expect(Object.keys(durable.parsed().presets as object)).toEqual([
      "custom_1",
      "custom-2",
    ]);
    expect(effective().preset).toBe("custom-2");
  });

  test("the copy keeps the preset's own globals — those no picker spells too — under the picks", () => {
    const source = `{
  presets: { spaced: { globals: { palette: 'nord', default_separator: ' | ' } } },
}`;
    start(source, { preset: "spaced", look: "dim" });
    r.click(link("⊕ save as preset")!);
    const presets = durable.parsed().presets as Record<string, unknown>;
    expect(presets["custom-1"]).toEqual({
      globals: { palette: "nord", default_separator: " | ", look: "dim" },
    });
  });
});

describe("the preset action", () => {
  test.each([
    [{ preset: "rename" }, 'preset must be "save" or "delete", got "rename"'],
    [{ preset: "delete" }, "actions.a.name must be a string"],
    [{ preset: "save", name: "x" }, 'Unknown key "name" on a preset action. Expected only: preset'],
  ])("%j is refused at load", (action, message) => {
    expect(() =>
      parseAndValidate(
        "<user>",
        JSON.stringify({ actions: { a: action } }),
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(message);
  });
});
