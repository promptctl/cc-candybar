// The e2e click helper on a click the daemon answered TIMEOUT. A TIMEOUT to a
// click means the daemon refused it unread and ran nothing, so the helper
// sends it again within its budget, and reads what became of it from the
// answer it got, never from the daemon's log.

import net from "node:net";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
  type Response,
} from "../src/daemon/foundations/protocol";
import type { RequestId } from "../src/renderer-interface/interface";
import { timeoutResponse } from "../src/daemon/foundations/request-deadline";
import { click } from "./helpers/daemon-e2e";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";

const TIMEOUT = (request: number): Response =>
  timeoutResponse(request as RequestId);
const OK: Response = { ok: true, output: "" };
const BAD_REQUEST: Response = {
  ok: false,
  error: "copy: clipboard unavailable",
  code: "BAD_REQUEST",
  daemonV: PROTOCOL_VERSION,
};

interface StandIn {
  readonly sockPath: string;
  readonly clicks: () => number;
  close(): Promise<void>;
}

// A daemon stand-in on an isolated daemon's socket that answers the nth click
// as `answer` says, so a case chooses what the helper is told.
async function answering(answer: (nth: number) => Response): Promise<StandIn> {
  const { sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-clk");
  let clicks = 0;
  const server = net.createServer((sock) => {
    sock.on(
      "data",
      makeFrameReader(
        () => {
          sock.end(encodeFrame(answer(++clicks)));
          return "done";
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
          removeTmpDirs();
          resolve();
        }),
      ),
  };
}

const URL = effectsUrl([
  { verb: VERB_SET_STATE, args: ["bc-click", "candybar.diagnostics", "0"] },
]);

test("a click answered TIMEOUT is sent again, and is done on the answer it then gets", async () => {
  const daemon = await answering((nth) => (nth === 1 ? TIMEOUT(nth) : OK));
  try {
    await expect(click(daemon.sockPath, URL)).resolves.toBeUndefined();
    expect(daemon.clicks()).toBe(2);
  } finally {
    await daemon.close();
  }
});

test("a click answered TIMEOUT until the budget is spent fails naming TIMEOUT", async () => {
  const daemon = await answering(TIMEOUT);
  try {
    await expect(click(daemon.sockPath, URL, 150)).rejects.toThrow(
      /click failed: .*\(TIMEOUT\)/,
    );
    expect(daemon.clicks()).toBeGreaterThan(1);
  } finally {
    await daemon.close();
  }
});

test("a click the daemon refused is sent once, and fails with the refusal", async () => {
  const daemon = await answering(() => BAD_REQUEST);
  try {
    await expect(click(daemon.sockPath, URL)).rejects.toThrow(
      /clipboard unavailable/,
    );
    expect(daemon.clicks()).toBe(1);
  } finally {
    await daemon.close();
  }
});
