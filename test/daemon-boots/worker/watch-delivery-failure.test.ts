// [LAW:no-silent-failure] A watch delivery that throws is a broken contract
// nothing else will ever hear of, so the daemon holds it on every bar. Driven
// through a real daemon: a checkout adapter that throws instead of answering
// breaks config discovery's read of the session's working directory, while
// the bar's location reads a different directory and still draws.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { textOf } from "../../../src/render/frame";
import { checkoutFiles } from "../../../src/utils/git-root";
import { frameRequest, hookData, renderBody } from "../../helpers/daemon-e2e";
import { logLines } from "../../helpers/daemon-log";
import { indicatorOf } from "../../helpers/diagnostics-viewer";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import {
  prepareIsolatedDaemonEnv,
  type IsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";

let root: string;
let isolated: IsolatedDaemonEnv;
let daemon: InWorkerDaemon | undefined;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-watch-failure-")),
  );
  isolated = prepareIsolatedDaemonEnv("ccb-watch-failure");
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  isolated.removeTmpDirs();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a config watch delivery that throws shows on every bar and in the log", async () => {
  const cwd = path.join(root, "cwd");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  fs.mkdirSync(workspace);
  const config = path.join(root, "bar.json5");
  const write = (label: string) =>
    fs.writeFileSync(
      config,
      JSON.stringify({
        segments: { mark: { template: label } },
        root: { h: ["mark"] },
      }),
    );
  write("before");
  let broken = false;
  daemon = startDaemon(isolated.env, {
    checkoutFiles: {
      ...checkoutFiles,
      stat(file) {
        if (broken && file.startsWith(`${cwd}${path.sep}`))
          throw new Error("the checkout adapter broke its contract");
        return checkoutFiles.stat(file);
      },
    },
  });
  const running = daemon;
  const draw = async () => {
    const hook = hookData("watch-failure", cwd);
    return frameRequest(running, {
      ...renderBody("watch-failure", cwd, {}, [
        "cc-candybar",
        "--config-only",
        config,
      ]),
      hookData: {
        ...hook,
        workspace: { ...hook.workspace, current_dir: workspace },
      },
    });
  };

  const first = await draw();
  expect(textOf(first)).toContain("before");
  expect(indicatorOf(first)).toBeNull();

  broken = true;
  let n = 0;
  await untilHeard(
    () => write(`after ${++n}`),
    async () => indicatorOf(await draw()) === "⚠ 1",
    "the bar once the config watch's delivery threw",
  );
  // The batch wrote no snapshot: the bar still draws the config it had.
  expect(textOf(await draw())).toContain("before");
  expect(logLines(isolated.env)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /watch delivery to config discovery threw: the checkout adapter broke its contract/,
      ),
    ]),
  );

  // The origin stays owed: once reads answer again, the next window
  // delivers the change.
  broken = false;
  await untilHeard(
    () => write(`after ${++n}`),
    async () => textOf(await draw()).includes(`after ${n}`),
    "the config once discovery reads again",
  );
});
