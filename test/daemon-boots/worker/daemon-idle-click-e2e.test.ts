// [LAW:verifiable-goals] A click on a bar whose session went idle lands: the
// collector's sweep retired the session, so the renderer holds no context for
// it, and the cache entry the session last rendered at still holds its
// origin's config, so the click runs in its own turn and its write reaches the
// file. Measured on the daemon's own request handling, the click a link the
// bar drew.

import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { linksOf } from "../../../src/click/read";
import { SESSION_SWEEP_MS } from "../../../src/daemon/collector";
import { textOf, type Frame } from "../../../src/render/frame";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import { click, render } from "../../helpers/daemon-e2e";
import { loggedWhen, logLines } from "../../helpers/daemon-log";
import { heldClock } from "../../helpers/held-clock";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { fieldsOf } from "../../../src/utils/logfmt";

jest.setTimeout(30_000);

const [PALETTE] = listResolvablePaletteNames();
const SID = "idle-click";

const linkTo = (frame: Frame, text: string): string => {
  const hit = linksOf(frame).find((l) => l.text === text);
  if (hit === undefined)
    throw new Error(`no link "${text}" in:\n${textOf(frame)}`);
  return hit.url;
};

test("a click on a session the sweep retired lands its write without waiting for a config", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-idle-click");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-idle-click-")),
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
  const clock = heldClock(new Date());
  const daemon = startDaemon(env, { clock });
  try {
    const bar = await render(daemon, SID, project, {}, [
      "cc-candybar",
      "--config",
      file,
    ]);
    const pin = linkTo(bar, "PIN");
    // One sweep finds the session quiet, the next retires it.
    clock.advance(2 * SESSION_SWEEP_MS);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes(`session retired sid="${SID}"`)),
      "the session's retire",
    );
    const from = logLines(env).length;
    await click(daemon, pin);
    const palette = (
      JSON5.parse(fs.readFileSync(file, "utf8")) as {
        globals?: { palette?: unknown };
      }
    ).globals?.palette;
    expect(palette).toBe(PALETTE);
    // The click did not wait: the entry kept its origin's config held.
    const lines = await loggedWhen(
      env,
      (all) => all.slice(from).some((l) => l.includes("] click ")),
      "the click's event",
    );
    const event = lines.slice(from).find((l) => l.includes("] click "))!;
    expect(fieldsOf(event).get("parked")).toBeUndefined();
  } finally {
    await daemon.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
});
