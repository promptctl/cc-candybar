// The e2e click helper on a click the daemon answered TIMEOUT. The daemon's
// guard abandons the reply, not the click, so the helper sends the click once
// and takes its outcome from the click event the daemon logs once it has run.

import { MAIN_NAME, homeOf } from "../src/daemon/home";
import fs from "node:fs";
import { hostOf } from "./helpers/host";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { logLine } from "../src/daemon/log";
import { logPath, stateDir } from "../src/daemon/paths";
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
import { homeEndpoint, type DaemonEndpoint } from "./helpers/daemon-wire";
import { fakeDialer } from "./helpers/dial";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";

interface StandIn {
  // The stand-in as the click helper reaches it, through a fake dialer.
  readonly target: DaemonEndpoint;
  readonly clicks: () => number;
  close(): Promise<void>;
}

// A daemon stand-in on an isolated daemon's socket: it answers every click
// TIMEOUT, as the request guard does, and logs the click's event a beat later,
// as the daemon does once a click queued behind its loop has run.
async function timingOut(outcome: RequestOutcome): Promise<StandIn> {
  const { env, home, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-clk");
  // The stand-in logs where the daemon it plays would, so it makes the
  // state directory the daemon makes at boot.
  fs.mkdirSync(stateDir(home), { recursive: true });
  // A write still pending when the stand-in closes is dropped with it, so no
  // timer of this file outlives its test.
  const pending = new Set<NodeJS.Timeout>();
  let clicks = 0;
  const dialer = fakeDialer();
  const stopListening = dialer.listen(sockPath, (sock) => {
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
            fs.appendFileSync(logPath(homeOf(hostOf(env))), logLine(level, line, Date.now()));
          }, 100);
          pending.add(write);
        },
        () => {},
      ),
    );
  });
  return {
    target: homeEndpoint(home, dialer),
    clicks: () => clicks,
    close: async () => {
      for (const write of pending) clearTimeout(write);
      stopListening();
      removeTmpDirs();
    },
  };
}

const URL = effectsUrl(MAIN_NAME, [
  { verb: VERB_SET_STATE, args: ["bc-click", "candybar.diagnostics", "0"] },
]);

test("a click answered TIMEOUT lands by the daemon's own event, sent once", async () => {
  const daemon = await timingOut({ kind: "ok" });
  try {
    await click(daemon.target, URL);
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
    await expect(click(daemon.target, URL)).rejects.toThrow(
      /already rebuilding/,
    );
    expect(daemon.clicks()).toBe(1);
  } finally {
    await daemon.close();
  }
});
