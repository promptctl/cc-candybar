// The e2e click helper on a click the daemon answered TIMEOUT. The daemon's
// guard abandons the reply, not the click, so the helper sends the click once
// and takes its outcome from the click event the daemon logs once it has run.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { logPath } from "../src/daemon/paths";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
} from "../src/daemon/protocol";
import {
  requestEvent,
  type RequestOutcome,
} from "../src/daemon/request-event";
import { click } from "./helpers/daemon-e2e";

interface StandIn {
  readonly sockPath: string;
  readonly clicks: () => number;
  close(): Promise<void>;
}

// A daemon stand-in on an isolated state directory's socket: it answers every
// click TIMEOUT, as the 200 ms guard does, and logs the click's event a beat
// later, as the daemon does once a click queued behind its loop has run.
async function timingOut(outcome: RequestOutcome): Promise<StandIn> {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-clk-"));
  const env = { XDG_STATE_HOME: stateRoot };
  const sockPath = path.join(stateRoot, "cc-candybar", "socket");
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  let clicks = 0;
  const server = net.createServer((sock) => {
    sock.on(
      "data",
      makeFrameReader(
        () => {
          clicks++;
          sock.end(
            encodeFrame({
              ok: false,
              error: "request exceeded 200ms",
              code: "TIMEOUT",
              daemonV: PROTOCOL_VERSION,
            }),
          );
          const { level, line } = requestEvent(
            "click",
            [
              ["queued", "240ms"],
              ["verb", "dispatch"],
              ["timedOut", "Y"],
            ],
            outcome,
            1,
          );
          setTimeout(
            () =>
              fs.appendFileSync(
                logPath(env),
                `${new Date().toISOString()} [${level}] ${line}\n`,
              ),
            100,
          );
        },
        () => {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  return {
    sockPath,
    clicks: () => clicks,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          fs.rmSync(stateRoot, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}

const URL = effectsUrl([
  { verb: VERB_SET_STATE, args: ["bc-click", "candybar.diagnostics", "0"] },
]);

test("a click answered TIMEOUT lands by the daemon's own event, sent once", async () => {
  const daemon = await timingOut({ kind: "ok" });
  try {
    await click(daemon.sockPath, URL);
    expect(daemon.clicks()).toBe(1);
  } finally {
    await daemon.close();
  }
});

test("a click answered TIMEOUT that the daemon then refused fails with the refusal", async () => {
  const daemon = await timingOut({
    kind: "bad-request",
    problems: ["apply-update: already rebuilding…"],
  });
  try {
    await expect(click(daemon.sockPath, URL)).rejects.toThrow(
      /already rebuilding/,
    );
    expect(daemon.clicks()).toBe(1);
  } finally {
    await daemon.close();
  }
});
