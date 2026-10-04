// [LAW:verifiable-goals] brandon-doctor-v62x.e91 through a REAL daemon over a
// REAL socket: the 🩺 doctor click reads the config load of the render-cache
// entry the session's bar is drawn from. The in-process suite
// (test/doctor-menu.test.ts) fakes that edge; this is the one place the
// daemon's own is exercised — a project config found first, a user config
// unread behind it, and a declaration the project config never uses.

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  killAndWait,
  linkUrls,
  render,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { effectsOf } from "./helpers/click";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { VERB_DOCTOR_RUN } from "../src/click/wire";

jest.setTimeout(30_000);

// The report row wraps at the client's width; its text is what is asserted.
const flat = (rendered: string): string =>
  stripAnsi(rendered).replace(/\s+/g, " ");

test("the doctor's config row reports the session's own config load", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const userConfig = path.join(env.XDG_CONFIG_HOME!, "cc-candybar", "config.json5");
  mkdirSync(path.dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, "{}");
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const projectConfig = path.join(projectDir, ".cc-candybar.json5");
  writeFileSync(projectConfig, `{ helpers: { idle: "x" } }`);

  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const SID = "doctor-e2e-1";
    const closed = await render(sockPath, SID, projectDir);
    await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
    const opened = await render(sockPath, SID, projectDir);
    await click(sockPath, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
    const tools = await render(sockPath, SID, projectDir);
    const run = linkUrls(tools).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(sockPath, run!);

    expect(flat(await render(sockPath, SID, projectDir))).toContain(
      `✗ config — ${userConfig} is never read — ${projectConfig} is found first (+1 more — run \`cc-candybar doctor\`)`,
    );

    // Fixing both — the helper removed, the unread file gone — turns the row
    // over on the very next run: the click reloads the entry, so it never
    // reports the load from before the edit while the fs watcher catches up.
    writeFileSync(projectConfig, `{}`);
    rmSync(userConfig);
    await click(sockPath, run!);
    expect(flat(await render(sockPath, SID, projectDir))).toContain("✓ config");
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});
