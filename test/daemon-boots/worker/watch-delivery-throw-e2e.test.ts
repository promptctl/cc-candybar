// [LAW:no-silent-failure] A config watch's delivery window that throws is
// the daemon's: every session's bar shows it, its viewer reads it whole, and
// daemon.log holds its record. The throw is made in production code: the
// log refuses the record discovery writes inside the window, after the
// moved config was handed on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonLog } from "../../../src/daemon/log";
import { daemonPaths } from "../../../src/daemon/paths";
import { textOf } from "../../../src/render/frame";
import { systemTimekeeper } from "../../../src/time";
import { fieldsOf } from "../../../src/utils/logfmt";
import { render } from "../../helpers/daemon-e2e";
import { logLines } from "../../helpers/daemon-log";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { hostOf } from "../../helpers/host";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const REFUSED = "config discovery why=config-watch ";
const configOf = (mark: string): string =>
  `{ segments: { mark: { template: '${mark}' } }, root: { h: ['mark'] } }`;

// The daemon's own log, but for the window's record: every other member is
// the real log's, bound to it.
function refusingLog(file: string): DaemonLog {
  const real = new DaemonLog(file, systemTimekeeper);
  return new Proxy(real, {
    get(target, key) {
      if (key === "log")
        return (...[level, msg]: Parameters<DaemonLog["log"]>) => {
          if (msg.startsWith(REFUSED))
            throw new Error("the log refused the line");
          target.log(level, msg);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a config watch window that throws shows on every session's bar and in daemon.log", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-watch-throw");
  const project = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-watch-throw-")),
  );
  const userFile = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  let daemon: InWorkerDaemon | undefined;
  try {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, configOf("before"));
    const running = startDaemon(env, {
      daemonLog: refusingLog(daemonPaths(hostOf(env)).log),
    });
    daemon = running;
    const first = await render(running, "first", project);
    expect(textOf(first)).toContain("before");
    expect(indicatorOf(first)).toBeNull();

    await untilHeard(
      () => fs.writeFileSync(userFile, configOf("after")),
      async () => indicatorOf(await render(running, "first", project)) !== null,
      "the window's throw on the bar",
    );

    for (const session of ["first", "second"]) {
      const bar = await render(running, session, project);
      // The moved config was handed on before the window threw.
      expect(textOf(bar)).toContain("after");
      expect(indicatorOf(bar)).toMatch(/^⚠ /);
      const pages = await readDiagnostics(running, session, project, bar);
      expect(pages.map(({ text }) => text).join("\n")).toContain(
        "watch delivery threw window=config-discovery",
      );
    }

    await running.stop();
    daemon = undefined;
    const records = logLines(env).filter((line) =>
      line.includes("watch delivery threw"),
    );
    expect(records.length).toBeGreaterThan(0);
    expect(Object.fromEntries(fieldsOf(records[0]!))).toMatchObject({
      window: "config-discovery",
      failed: expect.stringContaining("the log refused the line"),
    });
  } finally {
    await daemon?.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
});
