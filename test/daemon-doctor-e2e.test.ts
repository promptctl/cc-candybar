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
import { VERB_DOCTOR_PROBE, VERB_DOCTOR_RUN } from "../src/click/wire";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { tryClickViaDaemon } from "../src/daemon/client";
import { parseHandlerUrl } from "../src/install/index";
import { checkByName } from "../src/doctor/checks";
import {
  probeUrlHandler,
  productionHandlerProbeEdge,
} from "../src/doctor/handler-probe";
import { PACKAGE_VERSION } from "../src/version";

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

// brandon-doctor-v62x.a1z: the daemon's half of `cc-candybar doctor`'s probe,
// over the real socket — a `doctor-probe` click as the URL handler sends it
// (its own version on the request) is listed in the stats the CLI reads back,
// and the doctor row of a session reads the version its own click carried.
test("a probe click is listed in stats; a doctor click's handler version is its row", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const request = (body: Record<string, unknown>) =>
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, ...body } as never, 5000);

    const nonce = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      await request({
        kind: "click",
        verb: VERB_DOCTOR_PROBE,
        value: nonce,
        clientVersion: "0.0.1",
      }),
    ).toMatchObject({ ok: true });
    expect(await request({ kind: "stats" })).toMatchObject({
      ok: true,
      stats: { handlerProbes: [{ nonce, handler: "0.0.1" }] },
    });

    const SID = "doctor-e2e-2";
    await render(sockPath, SID, projectDir);
    expect(
      await request({
        kind: "click",
        verb: VERB_DOCTOR_RUN,
        value: SID,
        clientVersion: "0.0.1",
      }),
    ).toMatchObject({ ok: true });
    await click(sockPath, urlWriting(await render(sockPath, SID, projectDir), SETTINGS_ANCHOR, SETTINGS_OPEN));
    await click(sockPath, urlWriting(await render(sockPath, SID, projectDir), `${SETTINGS_NS}tab`, "tools"));
    expect(flat(await render(sockPath, SID, projectDir))).toContain(
      "✗ URL handler — the URL handler runs cc-candybar 0.0.1; the bar runs",
    );
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// The CLI's probe end to end over real processes, less Launch Services: the
// production edge, with the one leg this test cannot isolate — macOS handing
// the link to the handler app, which would deliver it to the user's own
// daemon — replaced by what that app runs, `url-handle`'s own send.
test("the CLI's probe reads its own link back from the daemon it was delivered to", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const savedSocket = process.env.CC_CANDYBAR_SOCKET;
  process.env.CC_CANDYBAR_SOCKET = sockPath;
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const delivered: Promise<unknown>[] = [];
    const facts = await probeUrlHandler({
      ...productionHandlerProbeEdge(),
      platform: "darwin",
      open: (url) => {
        const { verb, value } = parseHandlerUrl(url);
        delivered.push(tryClickViaDaemon(verb, value));
        return null;
      },
    });
    expect(await Promise.all(delivered)).toMatchObject([{ kind: "ok" }]);
    expect(facts).toEqual({
      kind: "arrived",
      handler: PACKAGE_VERSION,
      bar: PACKAGE_VERSION,
    });
    expect(
      checkByName("urlHandler")!.probe({ urlHandler: facts } as never),
    ).toEqual({ ok: true });
  } finally {
    if (savedSocket === undefined) delete process.env.CC_CANDYBAR_SOCKET;
    else process.env.CC_CANDYBAR_SOCKET = savedSocket;
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});
