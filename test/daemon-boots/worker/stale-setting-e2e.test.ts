// [LAW:verifiable-goals] A stored setting its domain no longer holds, driven
// through a daemon built in this worker: the session's picks are on disk before
// it starts, as a session that outlived a theme, a style or a range finds them.
// Every case reads what the bar draws and clicks what it drew.
//
// No test here installs or removes a theme: the registry is the library's. A
// theme nothing installs stands in for a retired one, and a domain coming back
// is shown with a style the config declares again, through the same parse.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../../../src/render/frame";
import { linksOf } from "../../../src/click/read";
import { sessionStatePath } from "../../../src/daemon/paths";
import {
  EDIT_LIVE_KEY,
  placementDraftKey,
} from "../../../src/config/edit-chrome";
import { menuStateKey } from "../../../src/config/menu-keys";
import { SETTINGS_ANCHOR } from "../../../src/config/door";
import { DISCLOSURE_OPEN } from "../../../src/config/disclosure";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../../src/config/loader/edit-mode";
import { effectsOf, type DecodedEffect } from "../../helpers/click";
import { click, render, renderUntil } from "../../helpers/daemon-e2e";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import { hostOf } from "../../helpers/host";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { notInstalledTheme } from "../../../src/themes/policy";

jest.setTimeout(30_000);

const STALE = "stale-session";
const FRESH = "fresh-session";
const GONE_THEME = "no-such-theme";
const THEME_MENU = menuStateKey("pickers", "applyTheme", undefined);
// The bundled styles merge under the file's own, so the domain names both.
const STALE_STYLE =
  '"vapor" is not one of "none", "vivid", "muted", "dim", "bright", "inverted", "washed"';

// Every reader of each global setting: a label, the theme's carousel and its
// picker, a padding stepper, the three saves, and a placement with a setting
// of each domain arm (`theme` is every placement's own).
const CONFIG = (styles: string): string => `{
  globals: { palette: "nord", style: "washed", padding: 1 },
  styles: { none: {}, washed: { chromaScale: 0.3 }${styles} },
  presets: { roomy: { globals: { padding: 2 } } },
  editGlobals: { style: "none" },
  variables: { ring: { kind: "state", key: "ring", default: "closed" } },
  actions: {
    applyTheme: { set: "theme", from: "themes" },
    openRing: { set: "ring", cycle: ["closed", "open"] },
    padUp: { set: "padding", min: 0, max: 16, by: 1 },
    keep: { save: true },
    keepPreset: { preset: "save" },
    keepLook: { themeDefault: "save" },
  },
  segments: {
    probe: { template: 'T={{ .theme.effective }} S={{ .style.effective }} P={{ .preset.effective }} E={{ .effect.effective }} PAD={{ .padding.effective }}' },
    pickers: { template: '{{ carousel "applyTheme" "openRing" "theme" }} {{ menu "applyTheme" "▸" "▾" }}' },
    controls: { template: '{{ action "padUp" "PAD+" }} {{ action "keep" "SAVE" }} {{ action "keepPreset" "SAVEPRESET" }} {{ action "keepLook" "SAVELOOK" }}' },
    knob: {
      template: 'N={{ .settings.n }} M={{ .settings.mode }} PT={{ .settings.theme }}',
      settings: {
        n: { label: "N", domain: { min: 1, max: 5 }, default: 2 },
        mode: { label: "Mode", domain: ["a", "b"], default: "a" },
      },
    },
    ghost: {
      template: 'G={{ .settings.mode }}',
      when: '{{ eq .ring "open" }}',
      settings: { mode: { label: "Mode", domain: ["a", "b"], default: "a" } },
    },
  },
  root: { v: [{ h: ["probe"] }, { h: ["pickers", "controls"] }, { h: ["knob", "ghost"] }] },
}`;

interface StaleBar {
  readonly daemon: InWorkerDaemon;
  readonly configPath: string;
  readonly projectDir: string;
  draw(session?: string): Promise<Frame>;
  // Click the link of `session`'s last render whose effects `match` accepts,
  // then render that session again.
  clickWhere(
    match: (effects: DecodedEffect[]) => boolean,
    session?: string,
  ): Promise<Frame>;
  // Every message the bar's indicator opens, read off the viewer. A render
  // warning is its frame's own, counted by the frame after it.
  messages(session?: string): Promise<string[]>;
  stop(): Promise<void>;
}

let open: StaleBar | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

// A daemon over CONFIG whose sessions already hold `sessions` on disk.
function staleBar(
  sessions: Readonly<Record<string, Readonly<Record<string, string>>>>,
): StaleBar {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("cc-candybar-stale");
  const configPath = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, CONFIG(""));
  const statePath = sessionStatePath(hostOf(env));
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(sessions));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-stale-"));
  const daemon = startDaemon(env);
  const last = new Map<string, Frame>();
  const draw = async (session = STALE): Promise<Frame> => {
    const frame = await render(daemon, session, projectDir);
    last.set(session, frame);
    return frame;
  };
  const bar: StaleBar = {
    daemon,
    configPath,
    projectDir,
    draw,
    clickWhere: async (match, session = STALE) => {
      const drawn = last.get(session) ?? (await draw(session));
      const hit = linksOf(drawn).find(({ url }) => match(effectsOf(url)));
      if (hit === undefined) {
        throw new Error(`the bar drew no such link:\n${textOf(drawn)}`);
      }
      await click(daemon, hit.url);
      return draw(session);
    },
    messages: async (session = STALE) => {
      await draw(session);
      const shown = await draw(session);
      const pages = await readDiagnostics(daemon, session, projectDir, shown);
      return pages.map((p) => p.text);
    },
    stop: async () => {
      await daemon.stop();
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    },
  };
  open = bar;
  return bar;
}

const writes =
  (verb: string, key?: string, value?: string) =>
  (effects: DecodedEffect[]): boolean =>
    effects.some(
      (e) =>
        e.verb === verb &&
        (key === undefined || e.args[1] === key) &&
        (value === undefined || e.args[2] === value),
    );

// Into edit mode the way a person goes: the settings door, then `✎ arrange`.
async function arrange(bar: StaleBar): Promise<Frame> {
  await bar.draw();
  await bar.clickWhere(writes("set-state", SETTINGS_ANCHOR, DISCLOSURE_OPEN));
  return bar.clickWhere(writes("set-state", EDIT_MODE_KEY, EDIT_MODE_ARRANGE));
}

// Each drawn link as its text and the effects it fires, with the session left
// out: two sessions drawing the same bar draw the same of these.
const linksAsDrawn = (frame: Frame): string[] =>
  linksOf(frame).map(
    ({ text, url }) =>
      `${text} → ${effectsOf(url)
        .map((e) => [e.verb, ...e.args.slice(1)].join(" "))
        .join("; ")}`,
  );

// A stale pick's message as the viewer shows it, under its level's glyph.
const stale = (setting: string, why: string, wears: string): string =>
  `⚠ ${setting}: ${why}, so the bar wears "${wears}" until the session picks again or saves`;

describe("a stored setting its domain no longer holds", () => {
  test.each([
    ["theme", "nord", "T=nord", notInstalledTheme(GONE_THEME), GONE_THEME],
    // A retired theme's name says which theme to write instead.
    [
      "theme",
      "nord",
      "T=nord",
      `"dark" is not an installed theme — "dark" was retired; write "textual-dark", the same palette`,
      "dark",
    ],
    ["style", "washed", "S=washed", STALE_STYLE, "vapor"],
    [
      "preset",
      "default",
      "P=default",
      '"gone" is not one of "default", "compact", "verbose", "zen", "git", "usage", "dense", "roomy"',
      "gone",
    ],
    [
      "effect",
      "none",
      "E=none",
      '"gone" is not one of "none", "shimmer", "pulse", "sparkle", "wheel"',
      "gone",
    ],
    ["padding", "1", "PAD=1", '"99" is not an integer from 0 to 16', "99"],
  ])(
    "a stale %s draws the fallback %s under a ⚠ naming the setting, the stored value and what the bar wears",
    async (setting, wears, shown, why, stored) => {
      const bar = staleBar({ [STALE]: { [setting]: stored } });
      expect(textOf(await bar.draw())).toContain(shown);
      expect(await bar.messages()).toEqual([
        stale(`setting "${setting}"`, why, wears),
      ]);
    },
  );

  test("a placement's stale settings draw the saved values, each under its own ⚠", async () => {
    const bar = staleBar({
      [STALE]: {
        [placementDraftKey("default", "knob", "n")]: "9",
        [placementDraftKey("default", "knob", "mode")]: "c",
        [placementDraftKey("default", "knob", "theme")]: GONE_THEME,
      },
    });
    expect(textOf(await bar.draw())).toContain("N=2 M=a PT=bar");
    expect((await bar.messages()).sort()).toEqual(
      [
        stale(
          `placement "knob" setting "mode"`,
          '"c" is not one of "a", "b"',
          "a",
        ),
        stale(
          `placement "knob" setting "n"`,
          '"9" is not an integer from 1 to 5',
          "2",
        ),
        stale(
          `placement "knob" setting "theme"`,
          `${notInstalledTheme(GONE_THEME)}, and not "bar" (the bar's own theme)`,
          "bar",
        ),
      ].sort(),
    );
  });

  test("a placement the bar does not draw reports no stale pick until it is drawn", async () => {
    const bar = staleBar({
      [STALE]: { [placementDraftKey("default", "ghost", "mode")]: "c" },
    });
    expect(textOf(await bar.draw())).not.toContain("G=");
    expect(await bar.messages()).toEqual([]);
    const shown = await bar.clickWhere(writes("set-state", "ring", "open"));
    expect(textOf(shown)).toContain("G=a");
    expect(await bar.messages()).toEqual([
      stale(
        `placement "ghost" setting "mode"`,
        '"c" is not one of "a", "b"',
        "a",
      ),
    ]);
  });

  test("every reader of a stale theme draws what a session wearing that theme draws", async () => {
    // Both sessions wear nord: one never picked, one picked a theme nothing
    // installs. The label, the carousel's arrows and the open picker's mark
    // are the same frame for both.
    const bar = staleBar({
      [FRESH]: { [THEME_MENU]: "open" },
      [STALE]: { theme: GONE_THEME, [THEME_MENU]: "open" },
    });
    const fresh = await bar.draw(FRESH);
    const staleFrame = await bar.draw(STALE);
    expect(textOf(staleFrame)).toBe(textOf(fresh));
    expect(linksAsDrawn(staleFrame)).toEqual(linksAsDrawn(fresh));
  });

  test("a carousel step from a stale theme moves from the theme the bar wears", async () => {
    const bar = staleBar({ [FRESH]: {}, [STALE]: { theme: GONE_THEME } });
    const right = (effects: DecodedEffect[]): boolean =>
      writes("set-state", "theme")(effects);
    // The ▶ each session draws writes the same theme: the one after nord.
    const fresh = await bar.clickWhere(right, FRESH);
    const after = await bar.clickWhere(right, STALE);
    const theme = /T=(\S+)/.exec(textOf(fresh))![1]!;
    expect(theme).not.toBe("nord");
    expect(textOf(after)).toContain(`T=${theme}`);
    expect(await bar.messages()).toEqual([]);
  });

  test("a step from a stale integer moves from what the bar shows", async () => {
    const bar = staleBar({ [STALE]: { padding: "99" } });
    expect(textOf(await bar.draw())).toContain("PAD=1");
    const after = await bar.clickWhere(writes("step-state", "padding"));
    expect(textOf(after)).toContain("PAD=2");
  });

  test("a placement's stepper shows what the placement draws, and steps from it", async () => {
    const key = placementDraftKey("default", "knob", "n");
    const bar = staleBar({ [STALE]: { [key]: "9" } });
    await arrange(bar);
    const drawn = textOf(
      await bar.clickWhere(
        writes(
          "set-state",
          EDIT_CONFIGURE_KEY,
          configureMember("default", "knob"),
        ),
      ),
    );
    expect(drawn).toContain("N=2");
    // The stepper names the value the placement draws, not the stored one.
    expect(drawn).not.toContain("9");
    const after = await bar.clickWhere((effects) =>
      effects.some(
        (e) =>
          e.verb === "step-state" && e.args[1] === key && Number(e.args[2]) > 0,
      ),
    );
    expect(textOf(after)).toContain("N=3");
  });

  // A save is the session deciding what the bar draws, so it settles the
  // stale pick with the rest: once the saved file declares the pick's domain
  // again, the bar still draws what was saved, and says nothing.
  test.each([["save"], ["save-preset"], ["save-theme-default"]])(
    "a %s settles the stale pick",
    async (verb) => {
      // A held pick beside the stale one, so the save has something to write.
      const bar = staleBar({ [STALE]: { style: "vapor", padding: "3" } });
      await bar.draw();
      await bar.clickWhere(writes(verb));
      // The saved file, declaring the style again and marking the probe so
      // a frame drawn from it can be told apart.
      const saved = readFileSync(bar.configPath, "utf8");
      const declared = saved
        .replace(/(["']?washed["']?\s*:\s*\{)/, "vapor: { hueShift: 40 }, $1")
        .replace("T={{", "R T={{");
      expect(declared).toContain("vapor: { hueShift: 40 }");
      expect(declared).toContain("R T={{");
      writeFileSync(bar.configPath, declared);
      const frame = await renderUntil(
        bar.daemon,
        STALE,
        bar.projectDir,
        (f) => textOf(f).includes("R T="),
        "the bar drawn by the file that declares the style again",
      );
      expect(textOf(frame)).toContain("S=washed");
      expect(await bar.messages()).toEqual([]);
    },
  );

  test("the domain coming back brings the stored pick back", async () => {
    const bar = staleBar({ [STALE]: { style: "vapor" } });
    expect(textOf(await bar.draw())).toContain("S=washed");
    writeFileSync(bar.configPath, CONFIG(", vapor: { hueShift: 40 }"));
    await renderUntil(
      bar.daemon,
      STALE,
      bar.projectDir,
      (f) => textOf(f).includes("S=vapor"),
      "the bar wearing the style the config declares again",
    );
    expect(await bar.messages()).toEqual([]);
  });

  test("a staged value that outranks the session's pick shows no warning", async () => {
    // Edit mode stages `editGlobals.style` over the session's pick, so the
    // stale pick decides nothing and nothing is reported.
    const bar = staleBar({ [STALE]: { style: "vapor" } });
    await arrange(bar);
    // The live view draws the bar's own cells under edit mode's staging.
    const live = await bar.clickWhere(
      writes("set-state", EDIT_LIVE_KEY, DISCLOSURE_OPEN),
    );
    expect(textOf(live)).toContain("S=none");
    expect(await bar.messages()).toEqual([]);
  });
});
