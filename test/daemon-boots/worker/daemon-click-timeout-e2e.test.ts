// [LAW:verifiable-goals] What a click is answered when the daemon's loop is
// held past its request guard. A click whose frame the daemon has reached runs
// and is answered with its own outcome however long its turn takes. A bar's
// click writes the file the link names, so a landed click is a file written.

import { reportingClock } from "../../../src/daemon/task-throws";
import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { REQUEST_TIMEOUT_MS } from "../../../src/daemon/foundations/request-deadline";
import { inProcessRenderer } from "../../../src/in-process-renderer";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import { clickBody, linkTo, render } from "../../helpers/daemon-e2e";
import { heldClock } from "../../helpers/held-clock";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { openedOn } from "../../helpers/opened-connection";
import { hearingEvents, holdable } from "../../helpers/renderers";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

const [PALETTE] = listResolvablePaletteNames();
const SID = "click-timeout";

// A project whose bar draws one link, whose click pins the palette in its
// config file: the file is what a landed click leaves behind.
function projectWithPin() {
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-click-timeout-")),
  );
  const file = path.join(project, "config.json5");
  fs.writeFileSync(
    file,
    `{
      actions: { pin: { persist: "palette", to: "${PALETTE}" } },
      segments: { pin: { template: '{{ action "pin" "PIN" }}' } },
      root: { h: ["pin"] },
    }`,
  );
  const pinned = (): unknown =>
    (JSON5.parse(fs.readFileSync(file, "utf8")) as {
      globals?: { palette?: unknown };
    }).globals?.palette;
  return {
    project,
    args: ["cc-candybar", "--config", file],
    pinned,
    remove: () => fs.rmSync(project, { recursive: true, force: true }),
  };
}

test("a click the daemon has read is answered with its own outcome though its turn outlasts the guard", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-click-held");
  const bar = projectWithPin();
  const clock = heldClock(new Date(), reportingClock);
  const entered = Promise.withResolvers<void>();
  let release = (): void => {};
  const renderer = inProcessRenderer((real) => {
    const held = holdable(real);
    return hearingEvents(held.renderer, ({ event }) => {
      if (event.kind === "click") {
        release = held.hold();
        entered.resolve();
      }
    });
  });
  const daemon = startDaemon(env, { clock, renderer });
  try {
    const pin = linkTo(
      await render(daemon, SID, bar.project, {}, bar.args),
      "PIN",
    );
    const opened = openedOn(daemon.connect());
    opened.send(clickBody(pin));
    await entered.promise;

    await clock.settle(REQUEST_TIMEOUT_MS * 3);
    expect(opened.received).toEqual([]);
    expect(daemon.daemon.stats.requestsTimedOut).toBe(0);

    release();
    await until(() => opened.received.length > 0, "the click's own answer");
    expect(opened.received).toEqual([{ ok: true, output: "" }]);
    expect(bar.pinned()).toBe(PALETTE);
  } finally {
    release();
    await daemon.stop();
    removeTmpDirs();
    bar.remove();
  }
});
