// [LAW:verifiable-goals] What a click's reader is told when the daemon's loop
// is held past its request guard. A click read after the guard fired is
// answered TIMEOUT and ran nothing, and a click read in time is answered with
// its own outcome however long its turn takes. A bar's click writes the file
// the link names, so a landed click is a file written. The reader the answer
// reaches is `cc-candybar url-handle`, whose message is read off the daemon's
// own answer.

import { reportingClock } from "../../../src/daemon/task-throws";
import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { linksOf } from "../../../src/click/read";
import { interpretResponse } from "../../../src/daemon/client-transport";
import { REQUEST_TIMEOUT_MS } from "../../../src/daemon/foundations/request-deadline";
import { inProcessRenderer } from "../../../src/in-process-renderer";
import { urlHandlePlan } from "../../../src/install/index";
import { textOf, type Frame } from "../../../src/render/frame";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import { clickBody, click, render } from "../../helpers/daemon-e2e";
import { loggedWhen, logLines } from "../../helpers/daemon-log";
import { heldClock } from "../../helpers/held-clock";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { openedOn } from "../../helpers/opened-connection";
import { hearingEvents, holdable } from "../../helpers/renderers";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";
import { fieldsOf } from "../../../src/utils/logfmt";

jest.setTimeout(30_000);

const [PALETTE] = listResolvablePaletteNames();
const SID = "click-timeout";

const linkTo = (frame: Frame, text: string): string => {
  const hit = linksOf(frame).find((l) => l.text === text);
  if (hit === undefined)
    throw new Error(`no link "${text}" in:\n${textOf(frame)}`);
  return hit.url;
};

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

test("a click read after the guard fired is answered TIMEOUT and ran nothing; url-handle says to click again", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-click-late");
  const bar = projectWithPin();
  const clock = heldClock(new Date(), reportingClock);
  const daemon = startDaemon(env, { clock });
  try {
    const pin = linkTo(
      await render(daemon, SID, bar.project, {}, bar.args),
      "PIN",
    );
    const from = logLines(env).length;

    // The loop is held past the guard with the click's frame unread: the
    // backstop's timer comes due, in the same turn, ahead of the stream's data.
    const opened = openedOn(daemon.connect());
    opened.send(clickBody(pin));
    clock.advance(REQUEST_TIMEOUT_MS + 1);
    await until(() => opened.received.length > 0, "the click's answer");
    const [answer] = opened.received;
    expect(answer).toMatchObject({ ok: false, code: "TIMEOUT" });

    const lines = await loggedWhen(
      env,
      (all) => all.slice(from).some((l) => l.includes("] click ")),
      "the refused click's event",
    );
    const event = fieldsOf(lines.slice(from).find((l) => l.includes("] click "))!);
    expect(event.get("outcome")).toBe("abandoned");
    expect(event.get("timedOut")).toBe("Y");
    expect(bar.pinned()).toBeUndefined();

    // What its reader is told, from the answer itself.
    const outcome = interpretResponse("click", answer!, () => undefined);
    if (outcome.kind === "ok") throw new Error("a TIMEOUT read as ok");
    const plan = urlHandlePlan(outcome);
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/ran nothing; click again/);

    // Sent again, as the message says, it lands once.
    await click(daemon, pin);
    expect(bar.pinned()).toBe(PALETTE);
  } finally {
    await daemon.stop();
    removeTmpDirs();
    bar.remove();
  }
});

test("a click read in time is answered with its own outcome though its turn outlasts the guard", async () => {
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
