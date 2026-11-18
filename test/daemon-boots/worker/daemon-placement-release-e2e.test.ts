// [LAW:verifiable-goals] A placement removed by a click, through the daemon's
// own request handling, the click gate and the host's landing: every session
// holding its state releases it where its view meets the reloaded config. The
// clicking session's release is its click's step, so its undo brings the
// placement back with its unsaved values; another session viewing the same
// config releases its own outside any click, so that undo brings nothing back
// for it. Session state is read from the file the daemon keeps it in, once
// the daemon has stopped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
import { click, findUrl, render, urlWriting } from "../../helpers/daemon-e2e";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { hostOf } from "../../helpers/host";
import { daemonPaths } from "../../../src/daemon/paths";
import { encodeLayoutOp } from "../../../src/config/layout-ops";
import { presetRootKey } from "../../../src/config/loader/persist-target";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../../src/config/loader/edit-mode";
import { placementDraftKey } from "../../../src/config/edit-chrome";
import {
  SETTINGS_ANCHOR,
  SETTINGS_OPEN,
} from "../../../src/config/settings-menu";
import { VERB_APPLY_LAYOUT_OP, VERB_UNDO } from "../../../src/click/wire";

jest.setTimeout(30_000);

const CLICKER = "release-clicker";
const VIEWER = "release-viewer";

// One segment with a setting, placed twice, under two presets: `b` stages the
// config's own root, so it renders the row `default` does.
const SRC = `{
  segments: {
    vcs: {
      template: '{{ if .settings.detail }}D{{ else }}d{{ end }}',
      settings: { detail: { label: 'detail', domain: 'bool', default: false } },
    },
  },
  presets: { b: {} },
  root: { h: ['vcs', { seg: 'vcs', id: 'vcs2' }] },
}
`;

const inDefault = placementDraftKey("default", "vcs", "detail");
const inB = placementDraftKey("b", "vcs", "detail");
const kept = placementDraftKey("default", "vcs2", "detail");

test("a removal releases every session's state of the placement, and the clicking session's undo brings back its own", async () => {
  const isolated = prepareIsolatedDaemonEnv("cc-candybar-release-e2e");
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cc-candybar-release-e2e-project-"),
  );
  const configFile = path.join(
    isolated.env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, SRC);
  const stateFile = daemonPaths(hostOf(isolated.env)).sessionState;
  // Both sessions arranging, each with unsaved values of `vcs` in both presets
  // and one of `vcs2`; the clicker configuring `vcs`.
  const drafts = { [inDefault]: "true", [inB]: "true", [kept]: "true" };
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      [CLICKER]: {
        [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE,
        [EDIT_CONFIGURE_KEY]: configureMember("default", "vcs"),
        ...drafts,
      },
      [VIEWER]: { [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE, ...drafts },
    }),
  );
  const daemon = startDaemon(isolated.env);
  try {
    // Meeting the config the state was made over releases nothing: the
    // placement renders its unsaved value.
    await render(daemon, VIEWER, projectDir);
    const before = await render(daemon, CLICKER, projectDir);
    expect(textOf(before)).toContain("D");
    const remove = findUrl(linkUrls(before), (effects) =>
      effects.some(
        (e) =>
          e.verb === VERB_APPLY_LAYOUT_OP &&
          e.args[2] === presetRootKey("default") &&
          e.args[3] === encodeLayoutOp({ op: "remove", target: "vcs" }),
      ),
    );
    expect(remove).toBeDefined();
    await click(daemon, remove!);
    // The undo the settings menu offers, as the clicker reaches it.
    await click(
      daemon,
      urlWriting(
        await render(daemon, CLICKER, projectDir),
        SETTINGS_ANCHOR,
        SETTINGS_OPEN,
      ),
    );
    const menu = await render(daemon, CLICKER, projectDir);
    const undo = findUrl(linkUrls(menu), (effects) =>
      effects.some((e) => e.verb === VERB_UNDO),
    );
    expect(undo).toBeDefined();
    await click(daemon, undo!);
    expect(fs.readFileSync(configFile, "utf8")).toBe(SRC);
    await render(daemon, CLICKER, projectDir);
    await render(daemon, VIEWER, projectDir);
  } finally {
    await daemon.stop();
  }
  try {
    const sessions = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<
      string,
      Record<string, string>
    >;
    const heldBy = (sid: string) => {
      const state = sessions[sid] ?? {};
      return {
        [inDefault]: state[inDefault] ?? null,
        [inB]: state[inB] ?? null,
        [kept]: state[kept] ?? null,
        [EDIT_CONFIGURE_KEY]: state[EDIT_CONFIGURE_KEY] ?? null,
      };
    };
    // The clicker's undo restores the placement with the unsaved values the
    // removal released, in both presets. Configuring is navigation, which
    // undo doesn't step: the removal ended it.
    expect(heldBy(CLICKER)).toEqual({
      [inDefault]: "true",
      [inB]: "true",
      [kept]: "true",
      [EDIT_CONFIGURE_KEY]: null,
    });
    // The viewer released its own when its view met the reloaded config, and
    // the clicker's undo is not its history.
    expect(heldBy(VIEWER)).toEqual({
      [inDefault]: null,
      [inB]: null,
      [kept]: "true",
      [EDIT_CONFIGURE_KEY]: null,
    });
  } finally {
    isolated.removeTmpDirs();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
