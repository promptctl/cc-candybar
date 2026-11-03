// [LAW:verifiable-goals] A connection to a daemon built in this jest worker, over
// a stream with no socket: its own handling answers a render, feeds a subscriber
// and reaches the exit it was built with. A connection to a stand-in daemon is the
// other half (test/daemon-connection.test.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  systemTimekeeper,
  type Monotonic,
  type Timekeeper,
} from "../../../src/time";
import { PROTOCOL_VERSION, type Request, type Response } from "../../../src/daemon/protocol";
import { textOf } from "../../../src/render/frame";
import { render, renderBody } from "../../helpers/daemon-e2e";
import { loggedLines, renderEventsOf } from "../../helpers/daemon-log";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import { openedOn, type Opened } from "../../helpers/opened-connection";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

const SUBSCRIBE: Request = {
  v: PROTOCOL_VERSION,
  kind: "subscribe",
  sessionId: "a-session",
  lane: "statusline",
};

describe("a connection to a daemon built in this worker", () => {
  let root: string;
  let projectDir: string;
  let config: string;
  let started: InWorkerDaemon | null = null;
  const exit = jest.fn();

  const start = (clock: Timekeeper = systemTimekeeper): InWorkerDaemon => {
    started = startDaemon(process.env, { clock, exit });
    return started;
  };

  const renderRequest = (sessionId: string, deadline: number): Request =>
    ({
      v: PROTOCOL_VERSION,
      kind: "render",
      ...renderBody(sessionId, projectDir, { termCols: 200, termRows: 40 }, [
        "cc-candybar",
        "--config",
        config,
      ]),
      deadline,
    }) as Request;

  const answered = async (opened: Opened): Promise<Response> => {
    await until(() => opened.received.length > 0, "the connection's answer");
    return opened.received[0]!;
  };

  // What a band frame drew. Anything else is named, where a bare read of `band`
  // would leave the assertion to fail without saying what came back.
  const drawn = (resp: Response): string => {
    if (!("band" in resp))
      throw new Error(`no drawn band: ${JSON.stringify(resp)}`);
    return resp.band
      .map((row) => row.map(({ text }) => text).join(""))
      .join("\n");
  };

  // [LAW:no-ambient-temporal-coupling] The backstop here is the real one, and a
  // cold first render on a loaded runner outlasts it, so a render goes through
  // the helper that asks again on TIMEOUT.
  const rendered = async (
    daemon: InWorkerDaemon,
    sessionId: string,
  ): Promise<string> =>
    textOf(
      await render(
        daemon,
        sessionId,
        projectDir,
        { termCols: 200, termRows: 40 },
        ["cc-candybar", "--config", config],
      ),
    );

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-connection-"));
    projectDir = root;
    config = path.join(root, "bar.json5");
    writeFileSync(
      config,
      `{ globals: { experimentalBand: true, experimentalStatusline: true }, segments: { mark: { template: 'a drawn mark' } }, root: { h: ['mark'] } }`,
    );
  });

  afterEach(async () => {
    await started?.stop();
    started = null;
    exit.mockClear();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a render is answered by the daemon's own handling", async () => {
    expect(await rendered(start(), "connection-render")).toContain(
      "a drawn mark",
    );
  });

  test("a subscribe receives the frames the daemon draws", async () => {
    const running = start();
    await rendered(running, "connection-feed");

    const feed = openedOn(running.connect());
    feed.send({
      ...SUBSCRIBE,
      sessionId: "connection-feed",
      lane: "band",
    } as Request);
    expect(drawn(await answered(feed))).toContain("a drawn mark");
    expect(running.daemon.stats.inFlight).toBe(0);
    feed.client.destroy();
  });

  test("a shutdown request reaches the exit the daemon was built with", async () => {
    const opened = openedOn(start().connect());
    opened.send({ v: PROTOCOL_VERSION, kind: "shutdown" });
    await until(() => exit.mock.calls.length > 0, "the daemon's exit");
    expect(exit).toHaveBeenCalledWith(0);
    expect(opened.received).toEqual([{ ok: true, output: "" }]);
  });

  test("how long a render queued reads from its accept on the daemon's clock", async () => {
    let monotonic = 1_000_000;
    const at = new Date();
    const opened = openedOn(
      start({
        ...systemTimekeeper,
        now: () => at.getTime(),
        monotonic: () => monotonic as Monotonic,
      }).connect(),
    );
    monotonic += 500;
    opened.send(renderRequest("connection-clock", at.getTime() + 2_000));

    // Read off the render's own event: a backstop that answered first abandons
    // the answer, not the render, and the attempt is logged either way.
    const [event] = await loggedLines(
      process.env,
      (lines) => renderEventsOf(lines, "connection-clock"),
      (events) => events.length > 0,
      "the render event of connection-clock",
    );
    expect(event).toContain(" queued=500ms ");
  });
});
