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
// - A staged value above a stale pick warns of nothing.
//
// A placement's pick is an open edit's own and never reaches the session
// file, so a stale one cannot be seeded here; test/configure-mode.test.ts
// holds those inside an edit.

import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { DOOR_GLYPH } from "../../../src/config/disclosure";
import { textOf, type Frame } from "../../../src/render/frame";
import { click, linkTo, render } from "../../helpers/daemon-e2e";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

jest.setTimeout(90_000);

// The config, with `vapor` declared or not: the domain that leaves and comes
// back.
const configWith = (vapor: boolean) => ({
  globals: { padding: 1 },
  styles: vapor ? { vapor: { hueShift: 90 } } : {},
  presets: { roomy: { globals: { padding: 3 } } },
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
    ctl: {
      template:
        '{{ action "padUp" "[pad+]" }} {{ action "keep" "[save]" }} {{ action "asPreset" "[as-preset]" }} {{ action "asThemeDefault" "[as-default]" }}',
    },
  },
  root: { h: ["shown", "ctl"] },
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

// Into edit mode, through the settings door.
async function arrange(rig: Rig, sid: string): Promise<void> {
  const draw = () => render(rig.daemon, sid, rig.project);
  await click(rig.daemon, linkTo(await draw(), DOOR_GLYPH));
  await click(rig.daemon, linkTo(await draw(), "✎ arrange"));
}

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
        // One ⚠ per stale pick the frame wears.
        expect(indicatorOf(bar)).toBe("⚠ 6");
        const messages = await messagesOf(rig, ALL);
        const [theme] = staleAbout(messages, "theme");
        expect(theme).toMatch(
          /holds "no-such-theme", which it cannot hold, so the bar wears "[a-z-]+"\. It can hold one of \d+ values, such as /,
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
        expect(messages.every((m) => !/\bsave\b/i.test(m))).toBe(true);

        // A retired theme names its successor.
        const [retired] = staleAbout(await messagesOf(rig, RETIRED), "theme");
        expect(retired).toContain('holds "dark"');
        expect(retired).toContain('"dark" was retired; write "textual-dark"');

        // Edit mode stages endcaps over the session's pick: it decided
        // nothing, so it warns of nothing.
        await arrange(rig, STAGED);
        expect(staleAbout(await messagesOf(rig, STAGED), "endcaps")).toEqual(
          [],
        );

        // A step moves from what the bar shows: padding 1 → 2.
        await click(rig.daemon, linkTo(await settled(rig, ALL), "[pad+]"));
        expect(textOf(await settled(rig, ALL))).toContain("PAD=2");
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
