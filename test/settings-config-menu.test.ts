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

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { POLLED, PRESET_DELETE_GLYPH } from "../src/config/settings-menu";
import {
  ConfigError,
  loadConfigSource,
  NO_PROJECT,
} from "../src/config/dsl-loader";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  effectiveInputs,
  renderOptionsOf,
} from "../src/daemon/render-payload";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import {
  SESSION_CLIENT_HINTS_KEY,
  VERBS,
  type VerbContext,
} from "../src/daemon/verbs";
import {
  fileHeldSettings,
  settingCounts,
} from "../src/daemon/setting-drafts";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parseHandlerUrl } from "../src/install/index";
import { testVerbContext, effectsOf, recordRender } from "./helpers/click";
import { stripAnsi } from "./helpers/daemon-e2e";
import { parseAndValidate } from "./helpers/parse-and-validate";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { linkUrls, links } from "./helpers/ansi";
import { instantOf, type Instant } from "../src/utils/instant";
import {
  LANES,
  TOGGLED_LANES,
  MOVING_FPS,
  UNFOLLOWED_FEEDS,
  type Drawing,
  type Lane,
  type LaneFeeds,
} from "../src/config/lanes";
import { LANE_HELP } from "../src/help-text";
import { settingMenuPath } from "../src/config/menu-places";
import { DOOR_GLYPH } from "../src/config/disclosure";

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
// settings menu is synthesized), and expose render/click over the real
// handlers, each click gated by the config the rig currently holds. Every
// assertion below reads the same bar a running daemon would produce.
// `durable`, when given, is the session's config file: the rig writes `source`
// there and records the render origin a durable click resolves it from — the
// same two facts a real render leaves behind for a real click. Without one the
// rig records a plain render origin, since every click resolves its config
// from the session's last render.
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
  render: (feeds?: LaneFeeds, at?: Instant, drawing?: Drawing) => string;
  click: (url: string) => void;
  dispose: () => void;
  // The tmux pane the session's client reports it runs in, "" outside tmux —
  // the `tmux.pane` input every render's payload carries.
  tmuxPane: string;
} {
  const sessionState = new SessionState();
  durable?.write(source);
  if (durable === undefined) recordRender(sessionState, SID);
  else durable.seedOrigin(sessionState, SID);
  // What a render records of the session's client: here, not in tmux.
  sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux: null }));
  // Everything the daemon's cache entry holds for one config — rebuilt whole
  // on a reload, the old registry disposed once the new one is built.
  const load = (text: string) => {
    const config = parseAndValidate(
      "<user>",
      text,
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store, "", sessionState);
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    // What the render cache reads off the file's raw parse (render.ts).
    const fileHeld = fileHeldSettings(
      loadConfigSource("<user>", text, DEFAULT_DSL_CONFIG, NO_PROJECT, ALLOWED).raw,
    );
    return { config, store, registry, compiled, fileHeld };
  };
  let entry = load(source);
  let tmuxPane = "";
  const logs: string[] = [];
  const reloads: { text: string; picks: Record<string, string | null> }[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable?.historyFor(sessionState)),
    log: (_level, msg) => logs.push(msg),
    configFor: () => entry.config,
    reloadConfig: () => {
      reloads.push({
        text: durable!.text()!,
        picks: Object.fromEntries(
          ["theme", "style", "padding"].map((k) => [k, sessionState.get(SID, k)]),
        ),
      });
      const next = load(durable!.text()!);
      entry.registry.dispose();
      entry = next;
    },
  };
  return {
    get config() {
      return entry.config;
    },
    get tmuxPane() {
      return tmuxPane;
    },
    set tmuxPane(pane: string) {
      tmuxPane = pane;
    },
    sessionState,
    logs,
    reloads,
    render: (
      feeds = UNFOLLOWED_FEEDS,
      at = instantOf(new Date()),
      drawing: Drawing = { by: "request" },
    ) => {
      const { config, compiled, store, registry } = entry;
      // [LAW:one-source-of-truth] The daemon's own projection (draw-bar.ts): one
      // `resolveEffectiveGlobals` over the session's picks feeds the payload's
      // `.effective` labels, the render options and the selection, through the
      // same `effectiveInputs`/`renderOptionsOf` and the resolution itself, so a preset
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
          // The daemon derives these per render (draw-bar.ts) through the same
          // function.
          ...settingCounts(config, entry.fileHeld, sessionPick),
          // What the daemon publishes from the session's settings history.
          history: {
            undo: durable?.history(SID).past.length ?? 0,
            redo: durable?.history(SID).future.length ?? 0,
          },
          feeds,
          tmux: { pane: tmuxPane },
          // What the daemon sets beside the payload (draw-bar.ts).
          drawing,
        },
        at,
        renderOptionsOf(effective, width),
        undefined,
        effective,
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
    dispose: () => entry.registry.dispose(),
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

// The menu's tabs are one accordion key; a control is reachable only while its
// tab is open. Opens `tab` — found in the rendered bytes, never constructed —
// unless it already is.
const TAB_KEY = "candybar.tab";
function showTab(
  r: { render: () => string; click: (url: string) => void; sessionState: SessionState },
  tab: string,
): void {
  if (r.sessionState.get(SID, TAB_KEY) === tab) return;
  const url = urlsOf(r.render()).find((u) =>
    effectsOf(u).some((e) => e.args[1] === TAB_KEY && e.args[2] === tab),
  );
  if (url === undefined) throw new Error(`no tab writes ${TAB_KEY}=${tab}`);
  r.click(url);
}

// The theme picker's gear (brandon-theme-swatch-8v9r): the style, variation
// and shade controls are behind it, beside the theme on the door's first line.
function showGear(
  r: { render: () => string; click: (url: string) => void; sessionState: SessionState },
): void {
  if (r.sessionState.get(SID, PICKERS_KEY) === "gear") return;
  const url = urlsOf(r.render()).find((u) =>
    effectsOf(u).some((e) => e.args[1] === PICKERS_KEY && e.args[2] === "gear"),
  );
  if (url === undefined) throw new Error("no link opens the theme picker's gear");
  r.click(url);
}
// The theme picker, open: its label shows the theme in force beside its swatch.
function showThemePicker(
  r: { render: () => string; click: (url: string) => void; sessionState: SessionState },
): void {
  if (r.sessionState.get(SID, PICKERS_KEY) === "candybar.apply.theme") return;
  const url = urlsOf(r.render()).find((u) =>
    effectsOf(u).some(
      (e) => e.args[1] === PICKERS_KEY && e.args[2] === "candybar.apply.theme",
    ),
  );
  if (url === undefined) throw new Error("no link opens the theme picker");
  r.click(url);
}
const PICKERS_KEY = "menus.candybar_pickers";

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
    // Open the menu — the click a "🍫" tap dispatches, found in the rendered
    // bytes, never constructed, so this also proves it is REACHABLE.
    const menuToggle = writesTo(r.render(), "candybar.menu")[0];
    expect(menuToggle).toBeDefined();
    r.click(menuToggle!);
  });
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  const wrapUrl = (): string => {
    showTab(r, "config");
    return writesTo(r.render(), "autoWrap").find((u) => !isReset(u))!;
  };
  const paddingUp = (): string => {
    showTab(r, "config");
    return links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "▶" &&
        effectsOf(l.url).some((e) => e.args[1] === "padding"),
    )!.url;
  };
  const saveUrl = (): string | undefined =>
    links(r.render()).find((l) =>
      effectsOf(l.url).some((e) => e.verb === "save"),
    )?.url;

  test("every setting the menu owns is one control, reachable from that root", () => {
    const out = [
      ...["look", "layout", "config"].map((tab) => {
        showTab(r, tab);
        return plain(r.render());
      }),
      (showGear(r), plain(r.render())),
      (showThemePicker(r), plain(r.render())),
    ].join("\n");
    // One labelled control each, named for what it sets.
    expect(out).toContain("◀ ▦ preset ▶"); // preset
    expect(out).toContain("🎨 theme ▀▀▀"); // theme, closed: its swatch
    expect(out).toContain("tokyo-night ▀▀▀"); // theme, open: its name too
    expect(out).toContain("◀ ◐ style ▀▀▀ ▶"); // style, behind the gear, with its swatch
    expect(out).toContain("◀ ✦ endcaps ▶"); // style
    expect(out).toContain("☑ wrap"); // autoWrap
    expect(out).toContain("padding 1"); // padding
    expect(out).toContain("☑ update notice"); // updateNotice
    // Nothing picked, nothing to save.
    expect(out).not.toContain("💾");
    expect(saveUrl()).toBeUndefined();
  });

  // brandon-menus-sjhy.ek7: "Make theme and arrange top-level menus, next to
  // preset. Move padding and wrap from the layout menu to config."
  test("theme and arrange sit beside preset on the first line; wrap and padding are in ⚙ config", () => {
    const firstLine = plain(r.render()).split("\n")[0]!;
    for (const cell of ["🎨 theme ▀▀▀", "⚙", "◀ ▦ preset ▶", "✎ arrange"]) {
      expect(firstLine).toContain(cell);
    }
    const tab = (name: string): string => (showTab(r, name), plain(r.render()));
    expect(tab("config")).toMatch(/☑ wrap[\s\S]*padding 1/);
    for (const name of ["look", "layout"]) {
      const body = tab(name).split("\n").slice(2).join("\n");
      for (const moved of ["🎨 theme", "✎ arrange", "wrap", "padding"]) {
        expect(body).not.toContain(moved);
      }
    }
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
    showTab(r, "config");
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
    chmodSync(dirname(durable.configPath), 0o500);
    try {
      expect(() => r.click(saveUrl()!)).toThrow(/config write failed/);
    } finally {
      chmodSync(dirname(durable.configPath), 0o755);
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
  presets: { narrow: { globals: { endcaps: 'capsule' } } },
  root: { h: ['directory', 'model'] },
}`;
const PINNING_PRESET_NAMED = `{
  globals: { preset: 'narrow' },
  presets: { narrow: { globals: { endcaps: 'capsule' } } },
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
    showTab(r, "look");
    r.click(
      writesTo(r.render(), "menus.candybar_pickers").find((u) =>
        effectsOf(u).some((e) => e.args[2] === "candybar.apply.endcaps"),
      )!,
    );
    const capsule = plain(r.render());
    expect(capsule).toContain("◀ ✦ endcaps ▶");
    expect(capsule).not.toContain(PLAIN_SEAM);
    const pickPlain = writesTo(r.render(), "endcaps").find((u) =>
      effectsOf(u).some((e) => e.args[1] === "endcaps" && e.args[2] === "plain"),
    );
    r.click(pickPlain!);
    const save = links(r.render()).find((l) =>
      effectsOf(l.url).some((e) => e.verb === "save"),
    )!.url;
    r.click(save);
    expect(r.sessionState.get(SID, "endcaps")).toBeNull();
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
      expect(parsed.presets.narrow.globals.endcaps).toBe("plain");
      expect(parsed.globals).not.toHaveProperty("endcaps");
      expect(after).toContain(PLAIN_SEAM);
      expect(after).not.toContain("💾");
      expect(r.logs).toContainEqual(
        `save: presets.narrow.globals.endcaps=plain → ${durable.configPath} (session=${SID})`,
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
      expect(parsed.presets.narrow.globals.endcaps).toBe("plain");
      expect(r.sessionState.get(SID, "preset")).toBeNull();
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
  globals: { palette: 'nord', padding: 2, endcaps: 'capsule' },
  segments: { mine: { template: 'mine' } },
  presets: {
    compact: { globals: { padding: 3 } },
    narrow: { globals: { endcaps: 'plain' } },
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
    showTab(r, "look");
  });
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  // The ↺ beside one setting: the link whose only reset names `configKey`,
  // in whichever tab holds that setting's control.
  const TAB_OF: Record<string, string> = { padding: "config" };
  const resetOf = (configKey: string): string => {
    showTab(r, TAB_OF[configKey] ?? "look");
    return links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "↺" &&
        effectsOf(l.url).some(
          (e) => e.verb === "reset-config" && e.args[1] === configKey,
        ),
    )!.url;
  };
  const labelled = (text: string): string | undefined =>
    links(r.render()).find((l) => stripAnsi(l.text) === text)?.url;
  // The confirm's own ✕: it disarms and leaves the menu open — the risen
  // door is a ✕ that disarms too, but it closes the menu.
  const cancelResetAll = (): string =>
    links(r.render()).find((l) => {
      const args = effectsOf(l.url).flatMap((e) => e.args);
      return (
        stripAnsi(l.text) === "✕" &&
        args.includes("candybar.resetAll.armed") &&
        !args.includes("candybar.menu")
      );
    })!.url;
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
    narrow: { globals: { endcaps: "plain" } },
  };

  test("↺ clears the session's pick and the saved value, and the bar shows the default", () => {
    r.sessionState.set(SID, "theme", "dracula");
    showThemePicker(r);
    expect(plain(r.render())).toContain("dracula ▀▀▀");
    r.click(resetOf("palette"));
    expect(r.reloads).toEqual([
      { text: durable.text(), picks: { theme: "dracula", style: null, padding: null } },
    ]);
    expect(r.sessionState.get(SID, "theme")).toBeNull();
    expect(durable.parsed().globals).not.toHaveProperty("palette");
    const theme = DEFAULT_DSL_CONFIG.globals.palette as string;
    expect(plain(r.render())).toContain(`${theme} ▀▀▀`);
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

    r.click(resetOf("endcaps"));
    expect(durable.parsed().globals).not.toHaveProperty("endcaps");
    expect(userContent()).toEqual(USER_CONTENT);
    expect(r.logs).toContainEqual(
      `reset-config: endcaps ${Object.keys(DEFAULT_DSL_CONFIG.presets)
        .map((name) => `presets.${name}.globals.endcaps`)
        .join(" ")} session:endcaps ← ${durable.configPath} (session=${SID})`,
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
    r.click(cancelResetAll());
    expect(labelled("⟲ reset all?")).toBeUndefined();
    expect(labelled("⟲")).toBeDefined();
    expect(durable.text()).toBe(before);
  });

  test("an armed reset all stays in view when nothing is left to reset, so it never returns already armed", () => {
    r.click(labelled("⟲")!);
    r.click(labelled("⟲ reset all?")!);
    expect(labelled("⟲")).toBeUndefined();

    // A draft brings `⟲` back; arming it, then losing the draft (an undo),
    // leaves nothing to reset — but the armed confirm and its ✕ stay.
    r.sessionState.set(SID, "padding", "5");
    r.click(labelled("⟲")!);
    r.sessionState.clear(SID, "padding");
    expect(labelled("⟲ reset all?")).toBeDefined();
    r.click(cancelResetAll());
    expect(labelled("⟲ reset all?")).toBeUndefined();
    expect(labelled("⟲")).toBeUndefined();
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
    r.sessionState.set(SID, "style", "dim");
    const depth = durable.history(SID).past.length;
    r.click(labelled("⟲")!);
    r.click(labelled("⟲ reset all?")!);

    // Every setting's reset in one click is ONE write and ONE reload, made
    // while the session still held its picks — released only after.
    expect(r.reloads).toEqual([
      { text: durable.text(), picks: { theme: null, style: "dim", padding: "5" } },
    ]);

    const parsed = durable.parsed() as {
      globals?: Record<string, unknown>;
      presets: Record<string, unknown>;
    };
    expect(parsed.globals ?? {}).toEqual({});
    expect(parsed.presets).not.toHaveProperty("compact");
    expect(userContent()).toEqual(USER_CONTENT);
    expect(r.sessionState.get(SID, "padding")).toBeNull();
    expect(r.sessionState.get(SID, "style")).toBeNull();
    // Nothing is left for a reset to change, so `⟲` is gone.
    expect(labelled("⟲")).toBeUndefined();
    showGear(r);
    expect(plain(r.render())).toContain("◀ ◐ style ▀▀▀ ▶");
    expect(plain(r.render())).not.toContain("💾");
    showTab(r, "config");
    expect(plain(r.render())).toContain("padding 1");

    // One click, one step — undone by the ↶ on the bar.
    expect(durable.history(SID).past).toHaveLength(depth + 1);
    r.click(labelled("↶")!);
    expect(durable.text()).toBe(before);
    expect(r.sessionState.get(SID, "padding")).toBe("5");
    expect(r.sessionState.get(SID, "style")).toBe("dim");
  });
});

// [LAW:verifiable-goals] brandon-menu-ia-q30.nk8: the drift marker is the
// reset. A control shows `↺` only while its reset would change something — a
// session draft or a value the config file holds — and a tab holding such a
// control reads `•`. A value the active preset pins is neither.
describe("the drift marker", () => {
  let durable: DurableConfig;
  beforeEach(() => {
    durable = durableConfig("cc-candybar-settings-drift-");
  });
  afterEach(() => durable.dispose());

  // Every setting whose ↺ the bar draws, read tab by tab (a control renders
  // only while its tab is open; the preset's sits on the door's own line).
  const marked = (r: ReturnType<typeof rig>): string[] =>
    [
      ...new Set(
        ["look", "layout", "config"].flatMap((tab) => {
          showTab(r, tab);
          return links(r.render())
            .filter((l) => stripAnsi(l.text) === "↺")
            .flatMap((l) => effectsOf(l.url))
            .filter((e) => e.verb === "reset-config")
            .map((e) => e.args[1]!);
        }),
      ),
    ].sort();
  // The tabs the strip marks, read off what a reader sees.
  const markedTabs = (r: ReturnType<typeof rig>): string[] =>
    ["session", "look", "layout", "config", "tools"].filter((tab) =>
      new RegExp(`${tab} •`).test(plain(r.render())),
    );
  const open = (source: string): ReturnType<typeof rig> => {
    const r = rig(source, durable);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    return r;
  };

  test("nothing picked and nothing in the file: no ↺, no tab marked, no ⟲", () => {
    const r = open(TWO_SEGMENT_ROOT);
    try {
      expect(marked(r)).toEqual([]);
      expect(markedTabs(r)).toEqual([]);
      expect(plain(r.render())).not.toContain("⟲");
    } finally {
      r.dispose();
    }
  });

  test("a draft marks its own control and its tab, and nothing else", () => {
    const r = open(TWO_SEGMENT_ROOT);
    try {
      r.sessionState.set(SID, "padding", "5");
      expect(marked(r)).toEqual(["padding"]);
      expect(markedTabs(r)).toEqual(["config"]);
      expect(plain(r.render())).toContain("⟲");
      // The open tab keeps its mark beside the open glyph.
      showTab(r, "config");
      expect(plain(r.render())).toContain("▾ ⚙ config •");
    } finally {
      r.dispose();
    }
  });

  // brandon-menus-sjhy.ek7: the ⚙ gear sits on the door's first line, which
  // no tab encloses, so the gear's own trigger carries the mark.
  test("a gear setting's draft marks the closed ⚙ gear and no tab", () => {
    const r = open(TWO_SEGMENT_ROOT);
    try {
      expect(plain(r.render())).not.toContain("⚙ •");
      r.sessionState.set(SID, "shade", "deepest");
      expect(plain(r.render())).toContain("⚙ •");
      expect(markedTabs(r)).toEqual([]);
    } finally {
      r.dispose();
    }
  });

  // brandon-menus-sjhy.5zy: a control inside a submenu still marks its tab,
  // with the submenu closed.
  test("a lane toggle's draft marks ⚙ config while 🧪 toggles is closed", () => {
    const r = open(TWO_SEGMENT_ROOT);
    try {
      r.sessionState.set(SID, "experimentalPane", "true");
      expect(markedTabs(r)).toEqual(["config"]);
      showTab(r, "config");
      expect(plain(r.render())).toContain("🧪 toggles");
      expect(plain(r.render())).not.toContain("tmux pane (C)");
    } finally {
      r.dispose();
    }
  });

  test("a value the file holds is marked with no draft", () => {
    const r = open(CUSTOMIZED);
    try {
      // padding is held twice (globals and compact's fragment), endcaps once;
      // narrow's pin is the user's own preset, which a reset leaves alone.
      expect(marked(r)).toEqual(["endcaps", "padding", "palette"]);
      expect(markedTabs(r)).toEqual(["look", "config"]);
    } finally {
      r.dispose();
    }
  });

  test("a value the active preset pins is not marked: a reset could not move it", () => {
    // The user's preset pins endcaps; the file's own preset pick is marked.
    const pinned = open(PINNING_PRESET_NAMED);
    try {
      expect(marked(pinned)).toEqual(["preset"]);
      expect(markedTabs(pinned)).toEqual([]);
    } finally {
      pinned.dispose();
    }
  });

  test("a bundled preset's pin is not marked either; picking the preset is", () => {
    const r = open(TWO_SEGMENT_ROOT);
    try {
      r.sessionState.set(SID, "preset", "compact");
      showTab(r, "config");
      expect(plain(r.render())).toContain("padding 0");
      expect(marked(r)).toEqual(["preset"]);
      expect(markedTabs(r)).toEqual([]);
    } finally {
      r.dispose();
    }
  });
});

// [LAW:verifiable-goals] brandon-theme-picker-bgw.etd: choosing a theme is
// trying several, so a pick must leave the picker open with the new pick
// current. Driven the way a user drives it: clicks found in the rendered
// bytes and dispatched through the real verb handlers, at 80 columns. The theme
// control is the theme picker (brandon-theme-swatch-8v9r): its label opens a
// row of swatches, so "stays open" is a claim about that row after two picks
// from it.
describe("a pick leaves the picker open", () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig(TWO_SEGMENT_ROOT, undefined, 80);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    r.click(
      writesTo(r.render(), "menus.candybar_pickers").find((u) =>
        effectsOf(u).some((e) => e.args[2] === "candybar.apply.theme"),
      )!,
    );
  });
  afterEach(() => r.dispose());

  // A swatch of the open row other than the one in force (`[▀▀▀]`), and the
  // theme it writes.
  const option = (rendered: string) => {
    const hit = links(rendered).find(
      (l) =>
        stripAnsi(l.text) === " ▀▀▀ " &&
        effectsOf(l.url).some((e) => e.verb === "set-state" && e.args[1] === "theme"),
    )!;
    const write = effectsOf(hit.url).find((e) => e.args[1] === "theme")!;
    return { url: hit.url, theme: write.args[2]! };
  };
  // The open picker names the theme in force beside its swatch.
  const theme = (rendered: string) => /(\S+) ▀▀▀/u.exec(plain(rendered))![1]!;

  test("two picks in a row from the swatches: still open, the control naming the second pick", () => {
    const pickOne = option(r.render());
    r.click(pickOne.url);
    const first = r.render();
    expect(theme(first)).toBe(pickOne.theme);
    const pickTwo = option(first);
    r.click(pickTwo.url);
    const second = r.render();
    expect(theme(second)).toBe(pickTwo.theme);
    // Still open after each pick: the row's swatches are still drawn.
    expect(option(second)).toBeDefined();
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
        style: "dim",
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
  // `+ preset`, in the 📐 layout tab.
  const savePreset = (): string => {
    showTab(r, "layout");
    return link("+ preset")!;
  };
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
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", style: "dim", padding: "2" });
    r.click(savePreset());

    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    // Reloaded once, while the session still held its picks.
    expect(r.reloads).toEqual([
      { text: SAVED_CUSTOM_1, picks: { theme: "dracula", style: "dim", padding: "2" } },
    ]);
    // The preset renders what the picks did, so they are released.
    for (const key of ["theme", "style", "padding"]) {
      expect(r.sessionState.get(SID, key)).toBeNull();
    }
    expect(r.sessionState.get(SID, "preset")).toBe("custom-1");
    const e = effective();
    expect([e.preset, e.theme.kind === "decided" && e.theme.name, e.padding]).toEqual([
      "custom-1",
      "dracula",
      2,
    ]);
    // The one draft left is the switch.
    const out = plain(r.render());
    expect(out).toContain("💾 save 1");
    expect(r.logs).toContainEqual(
      `save-preset: custom-1 from=narrow palette=dracula style=dim → ${durable.configPath} (session=${SID})`,
    );
  });

  test("switching away and back changes no byte, and the preset still renders what was saved", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", style: "dim" });
    r.click(savePreset());
    r.click(link("default")!);
    expect(effective().preset).toBe("default");
    expect(effective().theme).toMatchObject({ name: "nord" });
    r.click(link("custom-1")!);
    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    expect(effective().theme).toMatchObject({ name: "dracula" });
    expect(effective().style).toMatchObject({ name: "dim" });
  });

  test("a second save takes the next free name", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", style: "dim" });
    r.click(savePreset());
    r.click(savePreset());
    const presets = durable.parsed().presets as Record<string, unknown>;
    expect(Object.keys(presets)).toEqual(["narrow", "custom-1", "custom-2"]);
    // Saved from custom-1 with nothing picked: its arrangement and its pins.
    expect(presets["custom-2"]).toEqual(presets["custom-1"]);
    expect(effective().preset).toBe("custom-2");
  });

  test(`${PRESET_DELETE_GLYPH} deletes the preset it names, returning the file byte for byte, and only a user preset offers it`, () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", style: "dim" });
    expect(plain(r.render())).toContain(`${PRESET_DELETE_GLYPH} delete narrow`);
    r.click(savePreset());
    r.click(link(`${PRESET_DELETE_GLYPH} delete custom-1`)!);

    expect(durable.text()).toBe(USER_PRESETS);
    expect(r.sessionState.get(SID, "preset")).toBeNull();
    expect(effective().preset).toBe("default");
    // `default` is bundled: nothing to delete.
    expect(plain(r.render())).not.toContain(PRESET_DELETE_GLYPH);
    expect(r.logs).toContainEqual(
      `delete-preset: custom-1 ← ${durable.configPath} (session=${SID})`,
    );
  });

  test("save and delete are one undo step each, restoring the exact bytes and picks", () => {
    start(USER_PRESETS, { preset: "narrow", theme: "dracula", style: "dim" });
    r.click(savePreset());
    r.click(link(`${PRESET_DELETE_GLYPH} delete custom-1`)!);

    r.click(link("↶")!);
    expect(durable.text()).toBe(SAVED_CUSTOM_1);
    expect(r.sessionState.get(SID, "preset")).toBe("custom-1");

    r.click(link("↶")!);
    expect(durable.text()).toBe(USER_PRESETS);
    expect(
      ["preset", "theme", "style"].map((k) => r.sessionState.get(SID, k)),
    ).toEqual(["narrow", "dracula", "dim"]);
  });

  test("a bundled preset is never deleted, even one the file pins a setting on", () => {
    const source = `{
  presets: { compact: { globals: { padding: 3 } } },
}`;
    start(source, { preset: "compact" });
    expect(plain(r.render())).not.toContain(PRESET_DELETE_GLYPH);
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
    r.click(link(`${PRESET_DELETE_GLYPH} delete mine`)!);
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
    expect(() => r.click(savePreset())).toThrow(
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
    expect(() => r.click(link(`${PRESET_DELETE_GLYPH} delete mine`)!)).toThrow(
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
    r.click(savePreset());
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
    start(source, { preset: "spaced", style: "dim" });
    r.click(savePreset());
    const presets = durable.parsed().presets as Record<string, unknown>;
    expect(presets["custom-1"]).toEqual({
      globals: { palette: "nord", default_separator: " | ", style: "dim" },
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

// [LAW:verifiable-goals] candybar-theme-colours-6fq5.ix8: `⤓ default for
// <theme>` behind the theme's ⚙ saves the look the session draws as the active
// theme's default. Found in the rendered bar and dispatched through the real
// verb table; every assertion on the file is on its exact bytes.
const THEMED = `{
  globals: { palette: 'nord' },
  themeDefaults: {
    nord: { variation: 'duo' },
    dracula: { shade: 'brightest' },
  },
}`;

const THEMED_SAVED = `{
  globals: { palette: 'nord' },
  themeDefaults: {
    nord: {
      style: "dim",
      variation: "duo",
      shade: "deepest",
    },
    dracula: { shade: 'brightest' },
  },
}`;

describe("a theme's default look, set from the bar", () => {
  let r: ReturnType<typeof rig>;
  let durable: DurableConfig;

  const SAVE_LABEL = "⤓ default for nord";
  const link = (text: string): string | undefined =>
    links(r.render()).find((l) => stripAnsi(l.text) === text)?.url;
  const pick = (picks: Record<string, string>): void => {
    for (const [k, v] of Object.entries(picks)) r.sessionState.set(SID, k, v);
  };
  const look = () => {
    const e = resolveEffectiveGlobals(
      r.config,
      (key) => r.sessionState.get(SID, key),
      () => false,
    );
    return [e.shade, e.variation, e.style.kind === "decided" ? e.style.name : "(rule)"];
  };
  // The door, then the theme's ⚙ gear, where the cell sits beside the
  // settings it saves.
  function start(source: string): void {
    durable = durableConfig("cc-candybar-theme-default-");
    r = rig(source, durable);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    showGear(r);
  }
  afterEach(() => {
    r.dispose();
    durable.dispose();
  });

  test("a pick equal to the theme's default is no draft, and picking a theme drafts only the theme", () => {
    start(THEMED);
    pick({ variation: "duo" });
    expect(plain(r.render())).not.toContain("💾 save");
    // dracula's own default shade comes with it: the theme is the one draft.
    r.sessionState.clear(SID, "variation");
    pick({ theme: "dracula" });
    expect(plain(r.render())).toContain("💾 save 1");
    pick({ shade: "brightest" });
    expect(plain(r.render())).toContain("💾 save 1");
    pick({ shade: "deepest" });
    expect(plain(r.render())).toContain("💾 save 2");
  });

  test("the control shows exactly while the look differs from the theme's default", () => {
    start(THEMED);
    expect(plain(r.render())).not.toContain("⤓ default");
    pick({ variation: "duo" });
    expect(plain(r.render())).not.toContain("⤓ default");
    pick({ shade: "deepest" });
    // The theme's name carries its swatch, as every theme name the bar shows
    // does (brandon-theme-swatch-8v9r).
    expect(plain(r.render())).toContain(`${SAVE_LABEL} ▀▀▀`);
    // Named after the theme the bar wears.
    pick({ theme: "dracula" });
    expect(plain(r.render())).toContain("⤓ default for dracula ▀▀▀");
  });

  test("the click writes the look into themeDefaults.<theme>, reloads, then releases the picks", () => {
    start(THEMED);
    pick({ shade: "deepest", style: "dim" });
    r.click(link(SAVE_LABEL)!);

    expect(durable.text()).toBe(THEMED_SAVED);
    // Reloaded once, while the session still held its picks.
    expect(r.reloads).toEqual([
      { text: THEMED_SAVED, picks: { theme: null, style: "dim", padding: null } },
    ]);
    for (const key of ["shade", "variation", "style"]) {
      expect(r.sessionState.get(SID, key)).toBeNull();
    }
    // The theme's default now draws what the picks did, and nothing is left
    // to save or to set as the default.
    expect(look()).toEqual(["deepest", "duo", "dim"]);
    const out = plain(r.render());
    expect(out).not.toContain("⤓ default");
    expect(out).not.toContain("💾 save");
    expect(r.logs).toContainEqual(
      `save-theme-default: nord style=dim variation=duo shade=deepest → ${durable.configPath} (session=${SID})`,
    );
  });

  test("a field the user's own globals declare is not the theme's to save", () => {
    const source = `{
  globals: { palette: 'nord', shade: 'brighter' },
}`;
    start(source);
    // globals.shade outranks the theme's default, so it is no difference the
    // theme's default could hold — with or without a pick over it.
    expect(plain(r.render())).not.toContain("⤓ default");
    pick({ shade: "deepest" });
    expect(plain(r.render())).not.toContain("⤓ default");
    pick({ variation: "duo" });
    r.click(link(SAVE_LABEL)!);
    // The entry keeps the theme's own shade; the variation is saved.
    expect(durable.parsed().themeDefaults).toEqual({
      nord: { shade: "middle", variation: "duo", style: "none" },
    });
    // The shade pick is still a draft, and still held, so the bar does not
    // move; the variation the file now draws is released.
    expect(r.sessionState.get(SID, "shade")).toBe("deepest");
    expect(r.sessionState.get(SID, "variation")).toBeNull();
    expect(look()).toEqual(["deepest", "duo", "none"]);
    expect(plain(r.render())).toContain("💾 save 1");
  });

  test("a field the active preset pins does not leak into the theme's default", () => {
    // The bundled zen preset pins style "dim".
    expect(DEFAULT_DSL_CONFIG.presets.zen!.globals?.style).toBe("dim");
    start(`{
  globals: { palette: 'nord' },
}`);
    pick({ preset: "zen" });
    expect(look()[2]).toBe("dim");
    expect(plain(r.render())).not.toContain("⤓ default");
    pick({ shade: "deepest" });
    r.click(link(SAVE_LABEL)!);
    expect(durable.parsed().themeDefaults).toEqual({
      nord: { shade: "deepest", variation: "accent", style: "none" },
    });
  });

  test("↺ clears the theme's default with the rest, so the bar shows the bundled default", () => {
    start(THEMED);
    pick({ shade: "deepest" });
    r.click(link(SAVE_LABEL)!);
    expect(durable.parsed().themeDefaults).toMatchObject({
      nord: { shade: "deepest" },
    });
    showGear(r);
    const reset = links(r.render()).find(
      (l) =>
        stripAnsi(l.text) === "↺" &&
        effectsOf(l.url).some(
          (e) => e.verb === "reset-config" && e.args[1] === "shade",
        ),
    );
    expect(reset).toBeDefined();
    r.click(reset!.url);
    const saved = durable.parsed().themeDefaults as Record<string, object>;
    expect(saved.nord).not.toHaveProperty("shade");
    // Every other theme's entry loses its shade too; its other fields stay.
    expect(saved.dracula).toBeUndefined();
    expect(look()[0]).toBe("middle");
  });

  test("the click is one undo step, restoring the exact bytes and picks", () => {
    start(THEMED);
    pick({ shade: "deepest", style: "dim" });
    r.click(link(SAVE_LABEL)!);
    r.click(link("↶")!);
    expect(durable.text()).toBe(THEMED);
    expect(
      ["shade", "variation", "style"].map((k) => r.sessionState.get(SID, k)),
    ).toEqual(["deepest", null, "dim"]);
  });

  test("under a theme chosen by a rule there is no name to save: no control, and the click refuses", () => {
    const source = `{
  globals: { palette: '{{ if true }}nord{{ end }}' },
}`;
    start(source);
    pick({ shade: "deepest" });
    expect(plain(r.render())).not.toContain("⤓ default");
    // The click a stale or hand-built URL could still carry.
    expect(() => r.click(`cc-candybar://save-theme-default/${SID}`)).toThrow(
      "save-theme-default: the theme is chosen by a rule (globals.palette), so there is no name to save as a theme's default",
    );
    expect(durable.text()).toBe(source);
    expect(r.sessionState.get(SID, "shade")).toBe("deepest");
  });
});

describe("the themeDefault action", () => {
  test.each([
    [{ themeDefault: "load" }, 'themeDefault must be "save"'],
    [
      { themeDefault: "save", theme: "nord" },
      'Unknown key "theme" on a themeDefault action. Expected only: themeDefault',
    ],
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

// brandon-menus-sjhy.amf — Brandon: "Each toggle should explain what it does.
// Each toggle also needs to do all of the work needed to turn its lane on, not
// just part of it."
describe("the animation lanes' toggles", () => {
  // The settings menu open on ⚙ config with 🧪 toggles open.
  const openToggles = () => {
    const r = rig(TWO_SEGMENT_ROOT);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    showTab(r, "config");
    const url = urlsOf(r.render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === PICKERS_KEY && e.args[2] === "toggles",
      ),
    );
    if (url === undefined) throw new Error("no link opens 🧪 toggles");
    r.click(url);
    return { r };
  };

  // What the lane runs follows the switch the session renders by, whatever
  // moved it (test/lane-setup.test.ts, "LaneSetups"), so the toggle is its
  // setting's write and nothing else.
  test.each(TOGGLED_LANES)(
    "%s: the toggle's click is its switch's write alone",
    (lane) => {
      const { r } = openToggles();
      try {
        const [url, ...others] = writesTo(r.render(), LANES[lane].switch.setting);
        expect(others).toEqual([]);
        expect(effectsOf(url!).map((e) => [e.verb, ...e.args])).toEqual([
          ["set-state", SID, LANES[lane].switch.setting, "true"],
        ]);
        r.click(url!);
        expect(plain(r.render())).toContain(`☑ ${LANES[lane].label}`);
      } finally {
        r.dispose();
      }
    },
  );

  test.each(TOGGLED_LANES)(
    "%s: the (?) beside the toggle says what the lane does",
    (lane) => {
      const { r } = openToggles();
      try {
        for (const line of LANE_HELP[lane])
          expect(plain(r.render())).not.toContain(line);
        const key = `candybar.help.${LANES[lane].switch.setting}`;
        const url = urlsOf(r.render()).find((u) => {
          const effects = effectsOf(u);
          return effects.length === 1 && effects[0]!.args[1] === key;
        });
        if (url === undefined) throw new Error(`no (?) writes ${key}`);
        r.click(url);
        for (const line of LANE_HELP[lane])
          expect(plain(r.render())).toContain(line);
      } finally {
        r.dispose();
      }
    },
  );
});

// [LAW:verifiable-goals] candybar-animation-wbxz.a4h: a lane toggle says what
// its frames are doing, so whether a lane works can be seen from the bar.

// candybar-plugins-vf6g.qzx — the tmux status line is a renderer: a menu in ⚙
// config with `claude` and `tmux`, offered to a session inside tmux.
describe("the renderer menu", () => {
  const RENDERER_APPLY = "candybar.apply.renderer";
  // The settings menu open on ⚙ config, the session in tmux pane %7 or in no
  // pane at all.
  const openConfig = (pane: string, source = TWO_SEGMENT_ROOT, durable?: DurableConfig) => {
    const r = rig(source, durable);
    r.tmuxPane = pane;
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    showTab(r, "config");
    return r;
  };
  const rendererLine = (rendered: string): string | undefined =>
    plain(rendered)
      .split("\n")
      .find((l) => l.includes("◀ renderer ▶"));
  const openList = (r: ReturnType<typeof rig>): void => {
    const url = urlsOf(r.render()).find((u) =>
      effectsOf(u).some((e) => e.args[2] === RENDERER_APPLY),
    );
    if (url === undefined) throw new Error("no link opens the renderer list");
    r.click(url);
  };

  test("inside tmux, ⚙ config holds `◀ renderer ▶`, and its closed list takes no row", () => {
    const r = openConfig("%7");
    try {
      expect(rendererLine(r.render())).toBeDefined();
      expect(plain(r.render())).not.toContain("Claude Code's status line");
    } finally {
      r.dispose();
    }
  });

  test("opened, it lays one aligned row per renderer, as the add-segment menu lays its library", () => {
    const r = openConfig("%7");
    try {
      openList(r);
      const lines = plain(r.render()).split("\n");
      expect(lines.some((l) => l.includes("draw the bar in"))).toBe(true);
      const claude = lines.find((l) => l.includes("Claude Code's status line"))!;
      const tmux = lines.find((l) => l.includes("the tmux status line, while"))!;
      expect(claude).toMatch(/claude\s+Claude Code's status line/u);
      expect(tmux).toMatch(/tmux\s+the tmux status line/u);
      expect(claude.indexOf("Claude Code's")).toBe(tmux.indexOf("the tmux"));
    } finally {
      r.dispose();
    }
  });

  test("its arrow switches the value, as a draft the save cell counts", () => {
    const r = openConfig("%7");
    try {
      const arrow = links(r.render()).find(
        (l) =>
          stripAnsi(l.text) === "▶" &&
          effectsOf(l.url).some(
            (e) => e.args[1] === "renderer" && e.args[2] === "tmux",
          ),
      );
      expect(arrow).toBeDefined();
      r.click(arrow!.url);
      expect(r.sessionState.get(SID, "renderer")).toBe("tmux");
      expect(plain(r.render())).toContain("💾 save 1");
    } finally {
      r.dispose();
    }
  });

  test("outside tmux there is no renderer menu, and a file's tmux marks nothing", () => {
    const source = `{
  globals: { renderer: "tmux" },
  segments: { a: { template: 'a' } },
  root: { h: ['a'] },
}`;
    const inside = openConfig("%7", source);
    const outside = openConfig("", source);
    try {
      expect(rendererLine(inside.render())).toBeDefined();
      expect(rendererLine(outside.render())).toBeUndefined();
      expect(plain(outside.render())).not.toContain("the tmux status line");
      // The tab's drift mark counts the renderer only where it is drawn.
      expect(plain(inside.render())).toContain("config •");
      expect(plain(outside.render())).not.toContain("config •");
      expect(plain(outside.render())).not.toContain("⟲");
    } finally {
      inside.dispose();
      outside.dispose();
    }
  });

  test("the tmux status line is no longer one of the 🧪 toggles", () => {
    const r = openConfig("%7");
    try {
      const url = urlsOf(r.render()).find((u) =>
        effectsOf(u).some(
          (e) => e.args[1] === PICKERS_KEY && e.args[2] === "toggles",
        ),
      );
      r.click(url!);
      const rendered = plain(r.render());
      for (const lane of TOGGLED_LANES)
        expect(rendered).toContain(`☐ ${LANES[lane].label}`);
      expect(rendered).not.toMatch(/☐ .*tmux status line/u);
      expect(settingMenuPath("renderer")).toBe(settingMenuPath("padding"));
    } finally {
      r.dispose();
    }
  });

  // [LAW:no-silent-failure] The setting is shared by every session the config
  // renders: a reset-all clicked where the renderer is not drawn leaves it.
  test("a reset-all outside tmux leaves the shared renderer as the file holds it", () => {
    const durable = durableConfig("cc-candybar-renderer-reset-");
    const r = openConfig(
      "",
      `{
  globals: { renderer: "tmux", padding: 3 },
  segments: { a: { template: 'a' } },
  root: { h: ['a'] },
}`,
      durable,
    );
    try {
      const labelled = (text: string): string =>
        links(r.render()).find((l) => stripAnsi(l.text) === text)!.url;
      r.click(labelled("⟲"));
      r.click(labelled("⟲ reset all?"));
      const globals = durable.parsed().globals as Record<string, unknown>;
      expect(globals).not.toHaveProperty("padding");
      expect(globals.renderer).toBe("tmux");
    } finally {
      r.dispose();
      durable.dispose();
    }
  });

  // [LAW:single-enforcer] The `•` and the `⟲` count a control by one gate:
  // where the renderer is drawn, a reset-all is offered for it and resets it.
  test("inside tmux, a renderer alone off its default offers ⟲, and the reset-all resets it", () => {
    const durable = durableConfig("cc-candybar-renderer-reset-in-");
    const r = openConfig(
      "%7",
      `{
  globals: { renderer: "tmux" },
  segments: { a: { template: 'a' } },
  root: { h: ['a'] },
}`,
      durable,
    );
    try {
      const labelled = (text: string): string =>
        links(r.render()).find((l) => stripAnsi(l.text) === text)!.url;
      r.click(labelled("⟲"));
      r.click(labelled("⟲ reset all?"));
      const globals = durable.parsed().globals as
        | Record<string, unknown>
        | undefined;
      expect(globals?.renderer).toBeUndefined();
    } finally {
      r.dispose();
      durable.dispose();
    }
  });
});

describe("a lane toggle's readout", () => {
  const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
  // The 🧪 toggles submenu open in the ⚙ config tab, statusline (B) on.
  const showToggles = (): ReturnType<typeof rig> => {
    const r = rig(TWO_SEGMENT_ROOT);
    r.click(writesTo(r.render(), "candybar.menu")[0]!);
    showTab(r, "config");
    const url = urlsOf(r.render()).find((u) =>
      effectsOf(u).some(
        (e) => e.args[1] === PICKERS_KEY && e.args[2] === "toggles",
      ),
    );
    if (url === undefined) throw new Error("no link opens 🧪 toggles");
    r.click(url);
    r.sessionState.set(SID, "experimentalStatusline", "true");
    return r;
  };
  const lineOf = (rendered: string): string =>
    plain(rendered)
      .split("\n")
      .find((l) => l.includes("statusline (B)"))!;
  const following = (feed: Partial<LaneFeeds["statusline"]>): LaneFeeds => ({
    ...UNFOLLOWED_FEEDS,
    statusline: { subscribers: 1, fps: MOVING_FPS, shown: true, ...feed },
  });

  test("off, the toggle says nothing more", () => {
    const r = showToggles();
    try {
      r.sessionState.set(SID, "experimentalStatusline", "false");
      const line = lineOf(r.render(following({})));
      expect(line).not.toMatch(/fps|no subscriber/u);
      expect(line).not.toMatch(SPINNER);
    } finally {
      r.dispose();
    }
  });

  test("on with nobody following, it says so, and nothing turns", () => {
    const r = showToggles();
    try {
      const line = lineOf(r.render());
      expect(line).toContain("statusline (B) no subscriber");
      expect(line).not.toMatch(SPINNER);
    } finally {
      r.dispose();
    }
  });

  test("followed, it counts the frames pushed and its spinner turns every frame", () => {
    const r = showToggles();
    try {
      const t0 = 1_792_573_980;
      const glyphs = [0, 1, 2].map(
        (n) =>
          lineOf(r.render(following({}), instantOf(new Date((t0 + n / MOVING_FPS + 0.001) * 1000)))).match(SPINNER)![0],
      );
      expect(new Set(glyphs).size).toBe(3);
      expect(lineOf(r.render(following({ fps: 29 })))).toMatch(
        new RegExp(`statusline \\(B\\) ${SPINNER.source} 29 fps`, "u"),
      );
      expect(lineOf(r.render(following({}))).includes("off screen")).toBe(false);
    } finally {
      r.dispose();
    }
  });

  test("followed from a pane judged off screen, it says so", () => {
    const r = showToggles();
    try {
      expect(lineOf(r.render(following({ fps: 1, shown: false })))).toMatch(
        / 1 fps · off screen/u,
      );
    } finally {
      r.dispose();
    }
  });
});

// [LAW:verifiable-goals] Every bar says how it is redrawn, in its own cell
// right after the door: a bar the feed draws shows the pace the feed draws it
// at (not a count of pushes, which is the lane toggle's); a bar answering
// Claude Code's request shows that it is polled. Every form is one width.
describe("the frame rate beside the door", () => {
  const doorLine = (rendered: string): string => plain(rendered).split("\n")[0]!;
  // The readout is the next text after the door: only padding and chrome
  // between them.
  const afterDoor = (readout: string): RegExp =>
    new RegExp(`${DOOR_GLYPH}[^\\p{L}\\p{N}]*${readout}`, "u");

  test("a frame the feed drew shows the rate the feed draws at, after the door", () => {
    const r = rig(TWO_SEGMENT_ROOT);
    try {
      const line = doorLine(r.render(undefined, undefined, { by: "feed", fps: MOVING_FPS }));
      expect(line).toMatch(afterDoor(`${MOVING_FPS} fps`));
    } finally {
      r.dispose();
    }
  });

  test("a request's answer shows that Claude Code polls the bar", () => {
    const r = rig(TWO_SEGMENT_ROOT);
    try {
      const line = doorLine(r.render());
      expect(line).toMatch(afterDoor(POLLED));
      expect(line).not.toMatch(/fps/u);
    } finally {
      r.dispose();
    }
  });

  test("the still pace and polled take the moving pace's width, so nothing after the door moves", () => {
    const r = rig(TWO_SEGMENT_ROOT);
    try {
      const still = doorLine(r.render(undefined, undefined, { by: "feed", fps: 1 }));
      const moving = doorLine(r.render(undefined, undefined, { by: "feed", fps: MOVING_FPS }));
      const polled = doorLine(r.render());
      // The equal lengths are the padding: an unpadded form would be shorter.
      expect(still).toMatch(afterDoor("1 fps"));
      expect(still.length).toBe(moving.length);
      expect(polled.length).toBe(moving.length);
    } finally {
      r.dispose();
    }
  });
});
