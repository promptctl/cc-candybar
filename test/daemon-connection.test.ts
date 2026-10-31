// [LAW:verifiable-goals] What a connection does, over a stream in this jest
// worker with no socket: the request backstop, a half-close and a hang-up, the
// exit a reply carries, and a subscriber's frames. A stand-in holds a request
// open where a real one would answer inside the backstop; the daemon's own
// handling answers the rest.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers";

import {
  handleConnection,
  type ConnectionDaemon,
} from "../src/daemon/connection";
import {
  createDaemon,
  SYSTEM_CLOCK,
  type Daemon,
  type DaemonClock,
} from "../src/daemon/daemon";
import { NOTHING_DELIVERED } from "../src/daemon/draw-bar";
import type { Subscriber } from "../src/daemon/frame-feed";
import { memoryLimitBytes } from "../src/daemon/limits";
import {
  FRAME_HEADER_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
  type Request,
  type Response,
} from "../src/daemon/protocol";
import type { HandledRequest, Reply } from "../src/daemon/reply";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import { sessionIdOf } from "../src/daemon/session-id";
import { EPHEMERAL_SESSION_STORAGE } from "../src/daemon/session-state";
import { EPHEMERAL_HISTORY_STORAGE } from "../src/daemon/settings-history";
import { RuntimeStats } from "../src/daemon/stats";
import {
  TIMEOUT_RETRY_BUDGET,
  renderBody,
  stripAnsi,
} from "./helpers/daemon-e2e";
import { loggedLines, renderEventsOf } from "./helpers/daemon-log";
import { memoryConnection } from "./helpers/memory-connection";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

const STATS: Request = { v: PROTOCOL_VERSION, kind: "stats" };
const SUBSCRIBE: Request = {
  v: PROTOCOL_VERSION,
  kind: "subscribe",
  sessionId: "a-session",
  lane: "statusline",
};
const SUBSCRIBED: HandledRequest = {
  kind: "subscribe",
  sessionId: sessionIdOf("a-session"),
  lane: "statusline",
};
const ANSWER: Response = { ok: true, output: "the answer" };

const replyWith = (over: Partial<Reply> = {}): HandledRequest => ({
  kind: "reply",
  resp: ANSWER,
  exitAfterFlush: null,
  delivered: NOTHING_DELIVERED,
  ...over,
});

// A memory stream runs on process ticks and microtasks, which all drain before
// a macrotask: one later, everything sent has landed.
const settled = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface Opened {
  readonly client: ReturnType<typeof memoryConnection>["client"];
  readonly received: Response[];
  send(req: Request): void;
  // Whether the daemon's side ended the connection.
  ended(): boolean;
}

const open = (daemon: ConnectionDaemon): Opened => {
  const { daemonEnd, client } = memoryConnection();
  handleConnection(daemon, daemonEnd);
  const received: Response[] = [];
  let over = false;
  client.on(
    "data",
    makeFrameReader(
      (frame) => received.push(frame as Response),
      (err) => {
        throw err;
      },
    ),
  );
  client.on("end", () => (over = true));
  return {
    client,
    received,
    send: (req) => client.write(encodeFrame(req)),
    ended: () => over,
  };
};

// A request the stand-in holds until the test answers it.
const held = () => {
  let answer!: (handled: HandledRequest) => void;
  let told: (() => boolean) | undefined;
  return {
    handle: (async (_req, timedOut) => {
      told = timedOut;
      return new Promise<HandledRequest>((resolve) => (answer = resolve));
    }) as ConnectionDaemon["handle"],
    answer: (handled: HandledRequest) => answer(handled),
    timedOut: () => told!(),
  };
};

describe("a connection over a stream", () => {
  const subscriptions: Subscriber[] = [];
  const unsubscribe = jest.fn();
  const exit = jest.fn();

  const standIn = (
    over: Partial<ConnectionDaemon> = {},
  ): ConnectionDaemon & { stats: RuntimeStats } => ({
    stats: new RuntimeStats(),
    clock: SYSTEM_CLOCK,
    handle: async () => replyWith(),
    subscribe: (_sessionId, subscriber) => {
      subscriptions.push(subscriber);
      return unsubscribe;
    },
    exit,
    ...over,
  });

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    subscriptions.length = 0;
    unsubscribe.mockClear();
    exit.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("a request is answered, the connection ends, and delivered runs once the client holds it", async () => {
    const delivered = jest.fn();
    const daemon = standIn({
      handle: async () => replyWith({ delivered }),
    });
    const { send, received, ended } = open(daemon);
    expect(daemon.stats.inFlight).toBe(1);

    send(STATS);
    await settled();

    expect(received).toEqual([ANSWER]);
    expect(ended()).toBe(true);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(daemon.stats.inFlight).toBe(0);
    expect(exit).not.toHaveBeenCalled();
  });

  test("a request that outlives the backstop is answered TIMEOUT, and its late reply goes nowhere", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { send, received, ended } = open(daemon);
    send(STATS);
    await settled();

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    await settled();
    expect(received).toEqual([]);
    expect(request.timedOut()).toBe(false);

    jest.advanceTimersByTime(1);
    await settled();
    expect(received).toMatchObject([{ ok: false, code: "TIMEOUT" }]);
    expect(ended()).toBe(true);
    expect(request.timedOut()).toBe(true);
    expect(daemon.stats.requestsTimedOut).toBe(1);

    const delivered = jest.fn();
    request.answer(replyWith({ delivered }));
    await settled();
    expect(received).toHaveLength(1);
    expect(delivered).not.toHaveBeenCalled();
  });

  test("a client that half-closes before its answer is answered to no one", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, received } = open(daemon);

    client.end(encodeFrame(STATS));
    await settled();
    expect(daemon.stats.inFlight).toBe(0);

    const delivered = jest.fn();
    request.answer(replyWith({ delivered }));
    await settled();
    expect(received).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
  });

  test("a client that hangs up leaves nothing in flight and no backstop armed", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, send } = open(daemon);
    send(STATS);
    await settled();

    client.destroy();
    await settled();
    expect(daemon.stats.inFlight).toBe(0);

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(daemon.stats.requestsTimedOut).toBe(0);
  });

  test("the exit a reply carries runs once the client holds the reply", async () => {
    let heldAtExit = 0;
    const { send, received } = open(
      standIn({
        handle: async () => replyWith({ exitAfterFlush: 3 }),
        exit: (code) => {
          heldAtExit = received.length;
          exit(code);
        },
      }),
    );

    send(STATS);
    await settled();

    expect(exit).toHaveBeenCalledWith(3);
    expect(heldAtExit).toBe(1);
  });

  test("the exit a reply carries survives a client that hung up", async () => {
    const request = held();
    const { client, send } = open(standIn({ handle: request.handle }));
    send(STATS);
    await settled();
    client.destroy();
    await settled();

    const delivered = jest.fn();
    request.answer(replyWith({ exitAfterFlush: 0, delivered }));
    await settled();

    expect(exit).toHaveBeenCalledWith(0);
    expect(delivered).not.toHaveBeenCalled();
  });

  test("the exit a reply carries survives a backstop that answered first", async () => {
    const request = held();
    const { send, received } = open(standIn({ handle: request.handle }));
    send(STATS);
    await settled();
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();

    request.answer(replyWith({ exitAfterFlush: 0 }));
    await settled();

    expect(exit).toHaveBeenCalledWith(0);
    expect(received).toEqual([expect.objectContaining({ code: "TIMEOUT" })]);
  });

  test("a late reply leaves a subscription streaming, and its exit still runs", async () => {
    const request = held();
    const { client, send, received, ended } = open(
      standIn({
        handle: async (req, timedOut, accepted) =>
          req.kind === "subscribe"
            ? SUBSCRIBED
            : request.handle(req, timedOut, accepted),
      }),
    );
    send(STATS);
    send(SUBSCRIBE);
    await settled();
    expect(subscriptions).toHaveLength(1);

    request.answer(replyWith({ exitAfterFlush: 0 }));
    await settled();

    expect(exit).toHaveBeenCalledWith(0);
    expect(received).toEqual([]);
    expect(ended()).toBe(false);
    client.destroy();
  });

  test("a frame that does not parse is answered BAD_REQUEST", async () => {
    const { client, received, ended } = open(standIn());
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(3);
    client.write(Buffer.concat([header, Buffer.from("not")]));
    await settled();
    expect(received).toMatchObject([{ ok: false, code: "BAD_REQUEST" }]);
    expect(ended()).toBe(true);
  });

  test("a handler that throws is answered RENDER_FAILED", async () => {
    const { send, received } = open(
      standIn({
        handle: async () => {
          throw new Error("the handler broke");
        },
      }),
    );
    send(STATS);
    await settled();
    expect(received).toEqual([
      expect.objectContaining({
        ok: false,
        code: "RENDER_FAILED",
        error: "the handler broke",
      }),
    ]);
  });

  describe("a subscribe", () => {
    const subscribing = (over: Partial<ConnectionDaemon> = {}) =>
      standIn({ handle: async () => SUBSCRIBED, ...over });

    test("turns the connection over to the session's frames: no backstop, and out of in-flight", async () => {
      const daemon = subscribing();
      const { send, received, ended } = open(daemon);
      send(SUBSCRIBE);
      await settled();
      expect(subscriptions).toHaveLength(1);
      expect(daemon.stats.inFlight).toBe(0);

      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await settled();
      expect(daemon.stats.requestsTimedOut).toBe(0);
      expect(ended()).toBe(false);

      subscriptions[0]!.frame(ANSWER, JSON.stringify(ANSWER));
      subscriptions[0]!.frame(ANSWER, JSON.stringify(ANSWER));
      await settled();
      expect(received).toEqual([ANSWER, ANSWER]);
    });

    test("a refusal ends the stream", async () => {
      const { send, received, ended } = open(subscribing());
      send(SUBSCRIBE);
      await settled();

      const refusal: Extract<Response, { ok: false }> = {
        ok: false,
        error: "the lane is off",
        code: "SWITCHED_OFF",
      };
      subscriptions[0]!.refused(refusal);
      await settled();

      expect(received).toEqual([refusal]);
      expect(ended()).toBe(true);
    });

    test.each([
      ["hangs up", (client: Opened["client"]) => client.destroy()],
      ["half-closes", (client: Opened["client"]) => client.end()],
    ])("a subscriber that %s is unsubscribed", async (_how, leave) => {
      const { client, send } = open(subscribing());
      send(SUBSCRIBE);
      await settled();
      expect(unsubscribe).not.toHaveBeenCalled();

      leave(client);
      await settled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    test("one the backstop answered while it was on its way attaches nothing", async () => {
      const request = held();
      const { send, received } = open(subscribing({ handle: request.handle }));
      send(SUBSCRIBE);
      await settled();

      // In one turn, so the subscribe lands while the TIMEOUT is still closing
      // the stream: not yet destroyed, and a feed attached now would never
      // hear the close.
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      request.answer(SUBSCRIBED);
      await settled();

      expect(received).toMatchObject([{ code: "TIMEOUT" }]);
      expect(subscriptions).toEqual([]);
    });

    test("one whose subscriber hung up first attaches nothing", async () => {
      const request = held();
      const { client, send } = open(subscribing({ handle: request.handle }));
      send(SUBSCRIBE);
      await settled();
      client.destroy();
      await settled();

      request.answer(SUBSCRIBED);
      await settled();
      expect(subscriptions).toEqual([]);
    });

    test("one that throws is answered RENDER_FAILED, never an open stream nothing feeds", async () => {
      const { send, received, ended } = open(
        subscribing({
          subscribe: () => {
            throw new Error("the feed refused");
          },
        }),
      );
      send(SUBSCRIBE);
      await settled();
      expect(received).toMatchObject([
        { code: "RENDER_FAILED", error: "the feed refused" },
      ]);
      expect(ended()).toBe(true);
    });

    test("a subscriber slower than the frames gets the newest, never a backlog", async () => {
      const { client, send, received } = open(subscribing());
      send(SUBSCRIBE);
      await settled();

      client.pause();
      // Over a stream's high-water mark on every node this runs on, so the
      // first frame fills the stream.
      const frame = (name: string): void => {
        const resp: Response = { ok: true, output: name.repeat(128 * 1024) };
        subscriptions[0]!.frame(resp, JSON.stringify(resp));
      };
      ["a", "b", "c", "d"].forEach(frame);
      await settled();
      client.resume();
      await until(() => received.length >= 2, "the newest frame");

      expect(received.map((r) => "output" in r && r.output[0])).toEqual([
        "a",
        "d",
      ]);
    });
  });
});

describe("a connection to a daemon built in this worker", () => {
  let root: string;
  let projectDir: string;
  let config: string;
  let built: Daemon | null = null;
  const exit = jest.fn();
  const stateHome = process.env.XDG_STATE_HOME;

  const construct = (clock: DaemonClock = SYSTEM_CLOCK): Daemon => {
    const file = path.join(root, "dist", "index.mjs");
    built = createDaemon({
      bundle: {
        entryUrl: `file://${file}`,
        path: file,
        node: [process.execPath],
        targets: [],
      },
      storage: {
        session: EPHEMERAL_SESSION_STORAGE,
        history: EPHEMERAL_HISTORY_STORAGE,
      },
      memoryLimitBytes: memoryLimitBytes(process.env),
      registryUrl: "http://127.0.0.1:1",
      clock,
      exit,
    });
    return built;
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

  // What an answer drew. Anything else is named, where a bare read of `output`
  // would leave the assertion to fail without saying what came back.
  const drawn = (resp: Response): string => {
    if (!("output" in resp))
      throw new Error(`no drawn output: ${JSON.stringify(resp)}`);
    return stripAnsi(resp.output);
  };

  // [LAW:no-ambient-temporal-coupling] The backstop here is the real one, and a
  // cold first render on a loaded runner outlasts it. TIMEOUT is a client's
  // transient, answered by asking again on its next tick (test/helpers/daemon-e2e.ts);
  // a test has no next tick, so it asks again here, on a new connection.
  const rendered = async (
    daemon: Daemon,
    sessionId: string,
  ): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      const opened = open(daemon);
      opened.send(renderRequest(sessionId, Date.now() + 2_000));
      const resp = await answered(opened);
      const again =
        "code" in resp &&
        resp.code === "TIMEOUT" &&
        attempt < TIMEOUT_RETRY_BUDGET;
      if (!again) return drawn(resp);
    }
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-connection-"));
    // A daemon in a worker holds no socket lease, so another run's global
    // teardown would sweep the state dir test/setup.ts names, log and all.
    process.env.XDG_STATE_HOME = path.join(root, "state");
    projectDir = root;
    config = path.join(root, "bar.json5");
    writeFileSync(
      config,
      `{ globals: { experimentalStatusline: true }, segments: { mark: { template: 'a drawn mark' } }, root: { h: ['mark'] } }`,
    );
  });

  afterEach(() => {
    built?.close();
    built = null;
    exit.mockClear();
  });

  afterAll(() => {
    process.env.XDG_STATE_HOME = stateHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("a render is answered by the daemon's own handling", async () => {
    expect(await rendered(construct(), "connection-render")).toContain(
      "a drawn mark",
    );
  });

  test("a subscribe receives the frames the daemon draws", async () => {
    const daemon = construct();
    await rendered(daemon, "connection-feed");

    const feed = open(daemon);
    feed.send({ ...SUBSCRIBE, sessionId: "connection-feed" } as Request);
    expect(drawn(await answered(feed))).toContain("a drawn mark");
    expect(daemon.stats.inFlight).toBe(0);
    feed.client.destroy();
  });

  test("a shutdown request reaches the exit the daemon was built with", async () => {
    const opened = open(construct());
    opened.send({ v: PROTOCOL_VERSION, kind: "shutdown" });
    await until(() => exit.mock.calls.length > 0, "the daemon's exit");
    expect(exit).toHaveBeenCalledWith(0);
    expect(opened.received).toEqual([{ ok: true, output: "" }]);
  });

  test("how long a render queued reads from its accept on the daemon's clock", async () => {
    let monotonic = 1_000_000;
    const at = new Date();
    const daemon = construct({
      date: () => at,
      monotonic: () => monotonic,
    });
    const opened = open(daemon);
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
