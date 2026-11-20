// [LAW:verifiable-goals] brandon-unfiled-3248.8vba's done-when, through the
// daemon's own request handling: a session holds picks outside their settings'
// domains (seeded into its session-state file, as a theme since retired or a
// style the config stopped declaring leaves one), and every click is a link
// the bar drew.
//
// - Each stale pick draws what lies beneath it under a ⚠ naming the setting,
//   the spelling held, what the bar wears and what the setting can hold.
// - A step or pick moves from what the bar shows.
// - After save, save-preset or save-theme-default the bar keeps what was
//   saved when the domain returns; with no save, the pick comes back.
// - A staged value above a stale pick, and a placement the frame does not
//   draw, warn of nothing.

import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { linksOf } from "../../../src/click/read";
import { DOOR_GLYPH } from "../../../src/config/disclosure";
import { textOf, type Frame } from "../../../src/render/frame";
import { VERB_STEP_STATE } from "../../../src/click/wire";
import { click, findUrl, render, urlWriting } from "../../helpers/daemon-e2e";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { linkUrls } from "../../helpers/frame";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

jest.setTimeout(90_000);

const draft = (preset: string, id: string, setting: string): string =>
  `edit.draft.${preset}.${id}.${setting}`;
const MODE = draft("default", "probe", "mode");
const SIZE = draft("default", "probe", "size");
const PROBE_THEME = draft("default", "probe", "theme");
// A placement only the `roomy` preset draws.
const OTHER_MODE = draft("roomy", "other", "mode");
// A placement this frame places but draws nothing for.
const GHOST_MODE = draft("default", "ghost", "mode");

const PROBE = {
  template: "MODE={{ .settings.mode }} SIZE={{ .settings.size }}",
  settings: {
    mode: { label: "Mode", domain: ["a", "b", "c"], default: "a" },
    size: { label: "Size", domain: { min: 0, max: 5 }, default: 1 },
  },
};

// The config, with `vapor` declared or not: the domain that leaves and comes
// back.
const configWith = (vapor: boolean) => ({
  globals: { padding: 1 },
  styles: vapor ? { vapor: { hueShift: 90 } } : {},
  presets: {
    roomy: {
      globals: { padding: 3 },
      root: { h: ["shown", { seg: "probe", id: "other" }] },
    },
  },
  actions: {
    padUp: { set: "padding", min: 0, max: 16, by: 1 },
    keep: { save: true },
    asPreset: { preset: "save" },
    asThemeDefault: { themeDefault: "save" },
  },
  segments: {
    shown: {
      template:
        "THEME={{ .theme.effective }} STYLE={{ .style.effective }} PRESET={{ .preset.effective }} PAD={{ .padding.effective }} FX={{ .effect.effective }}",
    },
    probe: PROBE,
    ghost: { ...PROBE, when: "{{ false }}" },
    ctl: {
      template:
        '{{ action "padUp" "[pad+]" }} {{ action "keep" "[save]" }} {{ action "asPreset" "[as-preset]" }} {{ action "asThemeDefault" "[as-default]" }}',
    },
  },
  root: {
    h: [
      "shown",
      { seg: "probe", id: "probe", settings: { mode: "b", size: 3 } },
      { seg: "ghost", id: "ghost" },
      "ctl",
    ],
  },
});

interface Rig {
  readonly daemon: InWorkerDaemon;
  readonly project: string;
  readonly userFile: string;
}

async function withDaemon(
  seeded: Record<string, Record<string, string>>,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const { env, stateDir, removeTmpDirs } =
    prepareIsolatedDaemonEnv("ccb-stale");
  const userFile = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(configWith(false)));
  fs.writeFileSync(
    path.join(stateDir, "session-state.json"),
    JSON.stringify(seeded),
  );
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-stale-project-")),
  );
  const daemon = startDaemon(env);
  try {
    await body({ daemon, project, userFile });
  } finally {
    await daemon.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

// A session's bar, drawn twice: a frame's warnings show on the frame after it.
async function settled(rig: Rig, sid: string): Promise<Frame> {
  await render(rig.daemon, sid, rig.project);
  return render(rig.daemon, sid, rig.project);
}

async function messagesOf(rig: Rig, sid: string): Promise<string[]> {
  const bar = await settled(rig, sid);
  return (await readDiagnostics(rig.daemon, sid, rig.project, bar)).map(
    (page) => page.text,
  );
}

const staleAbout = (messages: readonly string[], setting: string) =>
  messages.filter((m) => m.startsWith(`⚠ Setting ${setting} holds`));

const linkTo = (frame: Frame, text: string): string => {
  const hit = linksOf(frame).find((l) => l.text === text);
  if (hit === undefined)
    throw new Error(`no link "${text}" in:\n${textOf(frame)}`);
  return hit.url;
};

// Into edit mode, through the settings door.
async function arrange(rig: Rig, sid: string): Promise<void> {
  const draw = () => render(rig.daemon, sid, rig.project);
  await click(rig.daemon, linkTo(await draw(), DOOR_GLYPH));
  await click(rig.daemon, linkTo(await draw(), "✎ arrange"));
}

const urlStepping = (frame: Frame, key: string, by: number): string => {
  const url = findUrl(linkUrls(frame), (effects) =>
    effects.some(
      (e) =>
        e.verb === VERB_STEP_STATE &&
        e.args[1] === key &&
        e.args[2] === String(by),
    ),
  );
  if (url === undefined) throw new Error(`no link steps ${key} by ${by}`);
  return url;
};

// Lay `vapor` back into the user's file, whatever the saves wrote there.
function declareVapor(userFile: string): void {
  const file = JSON5.parse(fs.readFileSync(userFile, "utf8")) as {
    styles?: Record<string, unknown>;
  };
  fs.writeFileSync(
    userFile,
    JSON.stringify({
      ...file,
      styles: { ...file.styles, vapor: { hueShift: 90 } },
    }),
  );
}

const ALL = "stale-all";
const RETIRED = "stale-retired";
const STAGED = "stale-staged";

describe("a pick its setting cannot hold", () => {
  test("draws what lies beneath it, under one ⚠ per pick that decided, and every reader agrees", async () => {
    await withDaemon(
      {
        [ALL]: {
          theme: "no-such-theme",
          style: "vapor",
          preset: "gone",
          effect: "glitter",
          endcaps: "bogus",
          padding: "99",
          [MODE]: "z",
          [SIZE]: "9",
          [PROBE_THEME]: "no-such-theme",
          [OTHER_MODE]: "z",
          [GHOST_MODE]: "z",
        },
        [RETIRED]: { theme: "dark" },
        [STAGED]: { endcaps: "bogus" },
      },
      async (rig) => {
        const bar = await settled(rig, ALL);
        const text = textOf(bar);
        // Each reader shows what the bar wears: the label, the placement.
        expect(text).toContain("STYLE=none");
        expect(text).toContain("PRESET=default");
        expect(text).toContain("PAD=1");
        expect(text).toContain("MODE=b SIZE=3");
        // One ⚠ per stale pick the frame wears; neither the roomy placement nor
        // the ghost is drawn, so their picks decide nothing.
        expect(indicatorOf(bar)).toBe("⚠ 9");
        const messages = await messagesOf(rig, ALL);
        const [theme] = staleAbout(messages, "theme");
        expect(theme).toMatch(
          /holds "no-such-theme", which it cannot hold, so the bar wears "[a-z-]+"\. It can hold one of the \d+ "themes" names, such as /,
        );
        expect(theme).toMatch(/Pick it again\.$/);
        // The label names the theme the message says the bar wears.
        const wears = /so the bar wears "([^"]+)"/.exec(theme!)![1];
        expect(text).toContain(`THEME=${wears}`);
        expect(staleAbout(messages, "style")[0]).toContain(
          'holds "vapor", which it cannot hold, so the bar wears "none". It can hold one of "none"',
        );
        expect(staleAbout(messages, "preset")[0]).toContain(
          'holds "gone", which it cannot hold, so the bar wears "default". It can hold one of "default", "compact"',
        );
        expect(staleAbout(messages, "effect")[0]).toContain('holds "glitter"');
        expect(staleAbout(messages, "endcaps")[0]).toContain('holds "bogus"');
        expect(staleAbout(messages, "padding")[0]).toContain(
          'holds "99", which it cannot hold, so the bar wears "1". It can hold an integer from 0 to 16',
        );
        expect(
          staleAbout(messages, '"mode" of placement "probe"')[0],
        ).toContain(
          'holds "z", which it cannot hold, so the bar wears "b". It can hold one of "a", "b", "c"',
        );
        expect(
          staleAbout(messages, '"size" of placement "probe"')[0],
        ).toContain(
          'holds "9", which it cannot hold, so the bar wears "3". It can hold an integer from 0 to 5',
        );
        expect(
          staleAbout(messages, '"theme" of placement "probe"')[0],
        ).toContain('holds "no-such-theme"');
        expect(staleAbout(messages, '"mode" of placement "other"')).toEqual([]);
        expect(staleAbout(messages, '"mode" of placement "ghost"')).toEqual([]);
        expect(messages.every((m) => !/\bsave\b/i.test(m))).toBe(true);

        // A retired theme names its successor.
        const [retired] = staleAbout(await messagesOf(rig, RETIRED), "theme");
        expect(retired).toContain('holds "dark"');
        expect(retired).toContain(
          '"dark" was retired; its successor is "textual-dark"',
        );

        // Edit mode stages endcaps over the session's pick: it decided
        // nothing, so it warns of nothing.
        await arrange(rig, STAGED);
        expect(staleAbout(await messagesOf(rig, STAGED), "endcaps")).toEqual(
          [],
        );

        // A step moves from what the bar shows: padding 1 → 2.
        await click(rig.daemon, linkTo(await settled(rig, ALL), "[pad+]"));
        expect(textOf(await settled(rig, ALL))).toContain("PAD=2");

        // So do a placement's step and pick, in its configure controls.
        const draw = () => render(rig.daemon, ALL, rig.project);
        await arrange(rig, ALL);
        await click(
          rig.daemon,
          urlWriting(await draw(), "edit.configure", "default:probe"),
        );
        const controls = await draw();
        // The control reads the same value the placement draws.
        expect(textOf(controls)).toContain("◀ Size 3 ▶");
        // The size stepper shows 3 and steps to 4, never from the stored 9.
        await click(rig.daemon, urlStepping(controls, SIZE, 1));
        // The mode list rings around b: its neighbours are a and c.
        await click(rig.daemon, urlWriting(await draw(), MODE, "c"));
        expect(textOf(await draw())).toContain("MODE=c SIZE=4");
        const after = await messagesOf(rig, ALL);
        expect(staleAbout(after, '"mode" of placement "probe"')).toEqual([]);
        expect(staleAbout(after, '"size" of placement "probe"')).toEqual([]);
      },
    );
  });
});

const SAVED = "stale-save";
const PRESET_SAVED = "stale-save-preset";
const DEFAULT_SAVED = "stale-save-theme-default";
const UNSAVED = "stale-unsaved";

describe("a stale pick and the domain that returns", () => {
  test("after any save the bar keeps what was saved; with no save the pick comes back", async () => {
    await withDaemon(
      Object.fromEntries(
        [SAVED, PRESET_SAVED, DEFAULT_SAVED, UNSAVED].map((sid) => [
          sid,
          { style: "vapor" },
        ]),
      ),
      async (rig) => {
        for (const sid of [SAVED, PRESET_SAVED, DEFAULT_SAVED, UNSAVED]) {
          const bar = await settled(rig, sid);
          expect(textOf(bar)).toContain("STYLE=none");
          expect(staleAbout(await messagesOf(rig, sid), "style")).toHaveLength(
            1,
          );
        }
        await click(rig.daemon, linkTo(await settled(rig, SAVED), "[save]"));
        await click(
          rig.daemon,
          linkTo(await settled(rig, PRESET_SAVED), "[as-preset]"),
        );
        await click(
          rig.daemon,
          linkTo(await settled(rig, DEFAULT_SAVED), "[as-default]"),
        );

        declareVapor(rig.userFile);
        await until(
          async () =>
            textOf(await render(rig.daemon, UNSAVED, rig.project)).includes(
              "STYLE=vapor",
            ),
          "the unsaved pick to come back with its domain",
        );
        for (const sid of [SAVED, PRESET_SAVED, DEFAULT_SAVED]) {
          const bar = await settled(rig, sid);
          expect(textOf(bar)).toContain("STYLE=none");
          expect(staleAbout(await messagesOf(rig, sid), "style")).toEqual([]);
        }
        expect(staleAbout(await messagesOf(rig, UNSAVED), "style")).toEqual([]);
      },
    );
  });
});
