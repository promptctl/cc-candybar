// [LAW:verifiable-goals] What a connection does, over a stream with no socket and
// no daemon: the request backstop, a half-close and a hang-up, the exit a reply
// carries, and a subscriber's frames. A stand-in holds a request open where a real
// one would answer inside the backstop. A connection to a daemon built in the
// worker is the other half (test/daemon-boots/worker/daemon-built-connection.test.ts).

import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";

import {
  handleConnection,
  type ConnectionDaemon,
} from "../src/daemon/connection";
import { systemTimekeeper } from "../src/time";
import { NOTHING_DELIVERED } from "../src/daemon/draw-bar";
import type { Subscriber } from "../src/daemon/frame-feed";
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  readOneFrame,
  sendOne,
  type Request,
  type Response,
} from "../src/daemon/protocol";
import type { HandledRequest, Reply } from "../src/daemon/reply";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import { sessionIdOf } from "../src/daemon/session-id";
import { RuntimeStats } from "../src/daemon/stats";
import { memoryConnection } from "../src/dial/dialer-fake";
import { openedOn, type Opened } from "./helpers/opened-connection";
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

const open = (daemon: ConnectionDaemon): Opened => {
  const { daemonEnd, client } = memoryConnection();
  handleConnection(daemon, daemonEnd);
  return openedOn(client);
};

// A request the stand-in holds until the test answers it.
const held = () => {
  let answer!: (handled: HandledRequest) => void;
  let told: (() => boolean) | undefined;
  let left: (() => boolean) | undefined;
  return {
    handle: (async (_req, timedOut, _accepted, clientLeft) => {
      told = timedOut;
      left = clientLeft;
      return new Promise<HandledRequest>((resolve) => (answer = resolve));
    }) as ConnectionDaemon["handle"],
    answer: (handled: HandledRequest) => answer(handled),
    timedOut: () => told!(),
    clientLeft: () => left!(),
  };
};

describe("a connection over a stream", () => {
  const subscriptions: Subscriber[] = [];
  const unsubscribe = jest.fn();
  const exit = jest.fn();

  const standIn = (
    over: Partial<ConnectionDaemon> = {},
  ): ConnectionDaemon & { stats: RuntimeStats } => ({
    stats: new RuntimeStats(systemTimekeeper),
    log: () => {},
    clock: systemTimekeeper,
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

  // A socket's peer that vanishes ends the daemon's side at once. Held, the
  // request has no answer and its backstop is far off, so only the hang-up can
  // take it out of in-flight.
  test("a client that gives up hangs up the daemon's end", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const gaveUp = sendOne(
      open(daemon).client,
      STATS,
      Date.now() + 20,
      systemTimekeeper,
    );
    await settled();
    expect(daemon.stats.inFlight).toBe(1);

    jest.advanceTimersByTime(20);
    await expect(gaveUp).rejects.toThrow("TIMEOUT");
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
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

  // The URL handler app writes its frame and hangs up without reading
  // (candybar-daemon-health-ajx0.co4): the frame is still handled, the answer
  // goes to no one, and the daemon says nothing about it above info, since
  // this is the forwarder's design and not a peer that vanished.
  test("a frame whose writer hung up at once is handled, answered to no one, and not a warning", async () => {
    const handle = jest.fn(async () => replyWith());
    const log = jest.fn();
    const daemon = standIn({ handle, log });
    const { client, received } = open(daemon);
    client.end(encodeFrame({ kind: "url", urlV: 1, url: "cc-candybar://x" }));
    await settled();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    expect(daemon.stats.inFlight).toBe(0);
    expect(log.mock.calls.filter(([level]) => level !== "info")).toEqual([]);
  });

  // [LAW:dataflow-not-control-flow] The forwarder's hang-up is its design, not
  // a client leaving: a url frame stays in flight until handled, no one is
  // said to have left, and the request deadline still holds over it — so a
  // click that waited past the deadline is refused, as every client's is
  // (src/daemon/journal-turns.ts), and a repeat click cannot revert it.
  test("a url frame whose writer hung up stays in flight, under the deadline, with no client gone", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, received } = open(daemon);
    client.end(encodeFrame({ kind: "url", urlV: 1, url: "cc-candybar://x" }));
    await settled();
    expect(daemon.stats.inFlight).toBe(1);
    expect(request.clientLeft()).toBe(false);
    expect(request.timedOut()).toBe(false);

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();
    expect(request.timedOut()).toBe(true);
    expect(request.clientLeft()).toBe(false);
    expect(daemon.stats.requestsTimedOut).toBe(1);
    expect(daemon.stats.inFlight).toBe(1);

    request.answer(replyWith());
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
    expect(received).toEqual([]);
  });

  test("a url frame read after the backstop fired stays in flight until handled, with no client gone", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, received } = open(daemon);
    // The forwarder's frame sat unread while the daemon was busy: it is sent
    // after the TIMEOUT only because a memory stream cannot hold it unread.
    client.allowHalfOpen = true;
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();
    expect(daemon.stats.requestsTimedOut).toBe(1);

    client.end(encodeFrame({ kind: "url", urlV: 1, url: "cc-candybar://x" }));
    await settled();
    expect(request.timedOut()).toBe(true);
    expect(request.clientLeft()).toBe(false);
    expect(daemon.stats.inFlight).toBe(1);

    request.answer(replyWith());
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
    expect(received).toMatchObject([{ code: "TIMEOUT" }]);
  });

  // A socket error destroys it at once, and its 'close' comes later: a click
  // whose turn falls between sees its client gone.
  test("a socket error is its client leaving, before the close", async () => {
    const request = held();
    const { daemonEnd, client } = memoryConnection();
    handleConnection(standIn({ handle: request.handle }), daemonEnd);
    client.write(encodeFrame(STATS));
    await settled();
    expect(request.clientLeft()).toBe(false);

    daemonEnd.emit("error", new Error("read ECONNRESET"));
    expect(request.clientLeft()).toBe(true);
    client.destroy();
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

  test("an answered request is not timed out by a client slow to close", async () => {
    const daemon = standIn();
    const { client, send, received } = open(daemon);
    client.allowHalfOpen = true;
    send(STATS);
    await settled();
    expect(received).toHaveLength(1);
    expect(client.destroyed).toBe(false);

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

  test("the exit a reply carries goes unsent with a reply the backstop beat", async () => {
    const request = held();
    const { send, received } = open(standIn({ handle: request.handle }));
    send(STATS);
    await settled();
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();

    request.answer(replyWith({ exitAfterFlush: 0 }));
    await settled();

    expect(exit).not.toHaveBeenCalled();
    expect(received).toEqual([expect.objectContaining({ code: "TIMEOUT" })]);
  });

  // A connection reads one frame: whatever its client sends after it is never
  // handled, so no click runs and no render opens views for an answer that
  // goes nowhere.
  describe("one frame per connection", () => {
    const counted = () => {
      const handle = jest.fn(async () => replyWith());
      return { handle, daemon: standIn({ handle }) };
    };

    test("two frames in one chunk: the first is handled and answered, the second is not read", async () => {
      const { handle, daemon } = counted();
      const { client, received } = open(daemon);
      client.write(Buffer.concat([encodeFrame(STATS), encodeFrame(STATS)]));
      await settled();
      expect(handle).toHaveBeenCalledTimes(1);
      expect(received).toEqual([ANSWER]);
    });

    test("a frame written after the answer is not handled", async () => {
      const { handle, daemon } = counted();
      const { client, send, received } = open(daemon);
      client.allowHalfOpen = true;
      send(STATS);
      await settled();
      expect(received).toEqual([ANSWER]);

      send(STATS);
      await settled();
      expect(handle).toHaveBeenCalledTimes(1);
      client.destroy();
    });

    test("a frame that is not JSON is answered BAD_REQUEST, and the valid one after it is not handled", async () => {
      const { handle, daemon } = counted();
      const { client, send, received } = open(daemon);
      client.allowHalfOpen = true;
      const header = Buffer.alloc(FRAME_HEADER_BYTES);
      header.writeUInt32BE(3);
      client.write(Buffer.concat([header, Buffer.from("not")]));
      await settled();
      send(STATS);
      await settled();
      expect(received).toMatchObject([{ ok: false, code: "BAD_REQUEST" }]);
      expect(handle).not.toHaveBeenCalled();
      client.destroy();
    });

    // A sender stating a length past the cap and writing on: its bytes are
    // read once, refused once, and never buffered, so they cannot grow the
    // daemon toward its memory limit.
    test("a header past the frame cap is refused once, whatever follows it", async () => {
      const log = jest.fn();
      const { client, received } = open(standIn({ log }));
      client.allowHalfOpen = true;
      const header = Buffer.alloc(FRAME_HEADER_BYTES);
      header.writeUInt32BE(MAX_FRAME_BYTES + 1);
      client.write(header);
      for (let i = 0; i < 10; i++) client.write(Buffer.alloc(1024, i));
      await settled();
      expect(
        log.mock.calls.filter(([, line]) =>
          String(line).startsWith("frame parse failed"),
        ),
      ).toHaveLength(1);
      expect(received).toMatchObject([{ ok: false, code: "BAD_REQUEST" }]);
      client.destroy();
    });
  });

  // [LAW:no-silent-failure] A throw from what handles the frame is that throw,
  // raised where the stream delivered the bytes, never a parse failure dropped
  // because a frame was already read.
  test("a throw from the frame's handler reaches the stream as itself", () => {
    const stream = new PassThrough();
    const onError = jest.fn();
    readOneFrame(
      stream,
      () => {
        throw new Error("the handler broke");
      },
      onError,
    );
    expect(() => stream.emit("data", encodeFrame(STATS))).toThrow(
      "the handler broke",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  // [LAW:no-silent-failure] An answer that cannot be encoded is still an
  // answer: the client is told what failed, and the stream ends.
  test("a reply that cannot be encoded is answered RENDER_FAILED, ends the stream, and keeps its exit", async () => {
    const daemon = standIn({
      handle: async () =>
        replyWith({
          resp: { ok: true, output: 1n } as unknown as Response,
          exitAfterFlush: 2,
        }),
    });
    const { send, received, ended } = open(daemon);
    send(STATS);
    await settled();
    expect(received).toMatchObject([{ ok: false, code: "RENDER_FAILED" }]);
    expect(ended()).toBe(true);
    expect(exit).toHaveBeenCalledWith(2);
    expect(daemon.stats.inFlight).toBe(0);
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

  // A throw before the handler's first await is the same failure as one after
  // it: answered and logged, never an exception out of the socket's read.
  test("a handler that throws before it returns a promise is answered RENDER_FAILED", async () => {
    const log = jest.fn();
    const daemon = standIn({
      log,
      handle: () => {
        throw new Error("the handler broke at once");
      },
    });
    const { send, received, ended } = open(daemon);
    send(STATS);
    await settled();
    expect(received).toMatchObject([
      { ok: false, code: "RENDER_FAILED", error: "the handler broke at once" },
    ]);
    expect(ended()).toBe(true);
    expect(daemon.stats.inFlight).toBe(0);
    expect(
      log.mock.calls.some(([, line]) =>
        String(line).startsWith("handler threw"),
      ),
    ).toBe(true);
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

      subscriptions[0]!.frame({ json: JSON.stringify(ANSWER), value: null });
      subscriptions[0]!.frame({ json: JSON.stringify(ANSWER), value: null });
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
      const daemon = subscribing({
        subscribe: () => {
          throw new Error("the feed refused");
        },
      });
      const { send, received, ended } = open(daemon);
      send(SUBSCRIBE);
      await settled();
      expect(received).toMatchObject([
        { code: "RENDER_FAILED", error: "the feed refused" },
      ]);
      expect(ended()).toBe(true);
      expect(daemon.stats.inFlight).toBe(0);
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
        subscriptions[0]!.frame({ json: JSON.stringify(resp), value: null });
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

  // A request answered past the backstop by design (a recording): its work
  // starts only while its client waits, and its answer is the reply it settles
  // with.
  describe("a held request", () => {
    const RECORDED: Response = {
      ok: true,
      recorded: {
        path: "/r.jsonl",
        lines: 4,
        answers: 1,
        frames: 0,
        daemonClosed: false,
      },
    };
    // Held work the test finishes, counting its starts.
    const work = () => {
      let finish!: (reply: Reply) => void;
      const start = jest.fn(
        () => new Promise<Reply>((resolve) => (finish = resolve)),
      );
      return {
        handled: { kind: "held", start } as HandledRequest,
        start,
        finish: () =>
          finish({
            resp: RECORDED,
            exitAfterFlush: null,
            delivered: NOTHING_DELIVERED,
          }),
      };
    };

    test("is answered when its work settles, long after the backstop would have fired", async () => {
      const held = work();
      const { send, received, ended } = open(
        standIn({ handle: async () => held.handled }),
      );
      send(STATS);
      await settled();
      expect(held.start).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS * 50);
      await settled();
      expect(received).toEqual([]);
      held.finish();
      await settled();
      expect(received).toEqual([RECORDED]);
      expect(ended()).toBe(true);
    });

    test("one the backstop answered while it was on its way starts nothing", async () => {
      const request = held();
      const job = work();
      const { send, received } = open(standIn({ handle: request.handle }));
      send(STATS);
      await settled();
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      request.answer(job.handled);
      await settled();
      expect(received).toMatchObject([{ code: "TIMEOUT" }]);
      expect(job.start).not.toHaveBeenCalled();
    });

    test("one whose client hung up first starts nothing", async () => {
      const request = held();
      const job = work();
      const { client, send } = open(standIn({ handle: request.handle }));
      send(STATS);
      await settled();
      client.destroy();
      await settled();
      request.answer(job.handled);
      await settled();
      expect(job.start).not.toHaveBeenCalled();
    });

    test("one whose client hangs up while it runs is told the client left", async () => {
      const held = work();
      const { client, send } = open(
        standIn({ handle: async () => held.handled }),
      );
      send(STATS);
      await settled();
      const [left] = held.start.mock.calls[0] as unknown as [AbortSignal];
      expect(left.aborted).toBe(false);
      client.destroy();
      await settled();
      expect(left.aborted).toBe(true);
    });
  });
});
