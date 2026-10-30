// The e2e click helper on a click the daemon answered TIMEOUT. The daemon's
// guard abandons the reply, not the click, so the helper sends the click once
// and takes its outcome from the click event the daemon logs once it has run.

import fs from "node:fs";
import net from "node:net";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { logLine } from "../src/daemon/log";
import { logPath } from "../src/daemon/paths";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
} from "../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import {
  requestEvent,
  type RequestOutcome,
} from "../src/daemon/request-event";
import { click } from "./helpers/daemon-e2e";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";

interface StandIn {
  readonly sockPath: string;
  readonly clicks: () => number;
  close(): Promise<void>;
}

// A daemon stand-in on an isolated daemon's socket: it answers every click
// TIMEOUT, as the request guard does, and logs the click's event a beat later,
// as the daemon does once a click queued behind its loop has run.
async function timingOut(outcome: RequestOutcome): Promise<StandIn> {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-clk");
  // A write still pending when the stand-in closes is dropped with it, so no
  // timer of this file outlives its test.
  const pending = new Set<NodeJS.Timeout>();
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
              error: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
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
          const write = setTimeout(() => {
            pending.delete(write);
            fs.appendFileSync(logPath(env), logLine(level, line));
          }, 100);
          pending.add(write);
        },
        () => {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  return {
    sockPath,
    clicks: () => clicks,
    close: () => {
      for (const write of pending) clearTimeout(write);
      return new Promise<void>((resolve) =>
        server.close(() => {
          removeTmpDirs();
          resolve();
        }),
      );
    },
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
