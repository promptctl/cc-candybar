// [LAW:no-silent-failure] A watch delivery that throws runs on a timer, where
// no caller can hear it: the daemon holds it for every bar and logs it. The
// case makes the config window's completion throw through the daemon's own
// log adapter, which its batch record is written to, so the throw is the
// production delivery's and needs no seam of its own.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DaemonLog } from "../../../src/daemon/log";
import { daemonPaths } from "../../../src/daemon/paths";
import { textOf } from "../../../src/render/frame";
import { systemTimekeeper } from "../../../src/time";
import { fieldsOf } from "../../../src/utils/logfmt";
import { render } from "../../helpers/daemon-e2e";
import { loggedLines } from "../../helpers/daemon-log";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { HOST } from "../../helpers/host";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const configOf = (mark: string): string =>
  `{ segments: { mark: { template: '${mark}' } }, root: { h: ['mark'] } }`;

test("a watch delivery that throws shows on every session's bar and in the log", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-delivery");
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "ccb-delivery-")),
  );
  const config = path.join(dir, "bar.json5");
  writeFileSync(config, configOf("before"));
  const args = ["cc-candybar", "--config", config];
  const real = new DaemonLog(
    daemonPaths({ ...HOST, env }).log,
    systemTimekeeper,
  );
  let refuse = false;
  // The real log, but the config window's batch record throws while refused.
  const log: DaemonLog["log"] = (level, msg) => {
    if (refuse && msg.startsWith("config discovery why=config-watch"))
      throw new Error("the batch record broke");
    real.log(level, msg);
  };
  const breaking = new Proxy(real, {
    get: (target, key) => {
      if (key === "log") return log;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let daemon: InWorkerDaemon | undefined;
  try {
    daemon = startDaemon(env, { daemonLog: breaking });
    const running = daemon;
    const draw = (session: string) => render(running, session, dir, {}, args);
    for (const session of ["first", "second"])
      expect(textOf(await draw(session))).toContain("before");

    refuse = true;
    // Only a delivered event proves the watch live: the edit is laid down
    // again until the first session draws it.
    await untilHeard(
      () => writeFileSync(config, configOf("after")),
      async () => textOf(await draw("first")).includes("after"),
      "the config watch delivers the edit",
    );

    const shown = `watch delivery threw batch="config discovery" error="the batch record broke"`;
    for (const session of ["first", "second"]) {
      const bar = await draw(session);
      expect(indicatorOf(bar)).toBe("⚠ 1");
      const pages = await readDiagnostics(running, session, dir, bar, {}, args);
      expect(pages.map((page) => page.text)).toEqual([
        expect.stringContaining(shown),
      ]);
    }
    const [logged] = await loggedLines(
      env,
      (lines) => lines.filter((line) => line.includes("watch delivery threw")),
      (picked) => picked.length > 0,
      "the delivery's failure is logged",
    );
    expect(Object.fromEntries(fieldsOf(logged!))).toMatchObject({
      batch: "config discovery",
      error: expect.stringContaining("the batch record broke"),
    });
  } finally {
    refuse = false;
    await daemon?.stop();
    rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  }
});
