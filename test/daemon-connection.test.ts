// [LAW:verifiable-goals] What a connection does, over a stream with no socket and
// no daemon: the request backstop, a half-close and a hang-up, the exit a reply
// carries, and a subscriber's frames. A stand-in holds a request open where a real
// one would answer inside the backstop. A connection to a daemon built in the
// worker is the other half (test/daemon-boots/worker/daemon-built-connection.test.ts).

import type { Acceptance } from "../src/daemon/foundations/request-event";
import { setImmediate } from "node:timers";

import {
  handleConnection,
  type ConnectionDaemon,
} from "../src/daemon/connection";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { clockOver, systemTimers } from "../src/time";
import { NOTHING_TO_SETTLE } from "../src/daemon/statusline-answer";
import type { Subscriber } from "../src/daemon/frame-feed";
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJsonFrame,
  sendOne,
  type ClientAct,
  type Request,
  type Response,
} from "../src/daemon/foundations/protocol";
import {
  replyOf,
  type HandledRequest,
  type Reply,
} from "../src/daemon/reply";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/foundations/request-deadline";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { barOf } from "./helpers/drawn-frame";
import { LANE_NAMES } from "../src/config/lanes";
import { renderFailed } from "../src/daemon/foundations/render-answers";
import { RuntimeStats } from "../src/daemon/stats";
import { memoryConnection } from "./helpers/memory-connection";
import { openedOn, type Opened } from "./helpers/opened-connection";
import { until } from "../scripts/lib/until";

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
  owner: null,
};
const ANSWER: Response = { ok: true, output: "the answer" };

const replyWith = (
  over: Partial<Pick<Reply, "resp" | "exitAfterFlush" | "settled">> = {},
): HandledRequest => ({
  kind: "reply",
  ...replyOf(
    over.resp ?? ANSWER,
    over.exitAfterFlush ?? null,
    over.settled ?? NOTHING_TO_SETTLE,
  ),
});

// A url frame's answer: its verdict, and when its click lands. A frame whose
// writer carries out acts (`handed`) has its verdict written once its click
// has landed, with those acts in it.
const urlAnswer = (
  landed: Promise<void> = Promise.resolve(),
  awaitsVerdict = false,
  handed: readonly ClientAct[] | null = null,
): HandledRequest => ({
  kind: "url",
  awaitsVerdict,
  handsBack: handed !== null,
  verdict:
    handed === null
      ? { ok: false, error: "forged", code: "BAD_REQUEST", daemonV: 3 }
      : { ok: true, output: "" },
  land: () => landed.then(() => handed ?? []),
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
  let acceptance: Acceptance | undefined;
  return {
    handle: (async (_req, timedOut, accepted, clientLeft) => {
      told = timedOut;
      left = clientLeft;
      acceptance = accepted;
      return new Promise<HandledRequest>((resolve) => (answer = resolve));
    }) as ConnectionDaemon["handle"],
    answer: (handled: HandledRequest) => answer(handled),
    timedOut: () => told!(),
    clientLeft: () => left!(),
    accepted: () => acceptance!,
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

  test("a request is answered, the connection ends, and it is settled delivered once the client holds it", async () => {
    const settle = jest.fn();
    const daemon = standIn({
      handle: async () => replyWith({ settled: settle }),
    });
    const { send, received, ended } = open(daemon);
    expect(daemon.stats.inFlight).toBe(1);

    send(STATS);
    await settled();

    expect(received).toEqual([ANSWER]);
    expect(ended()).toBe(true);
    expect(settle.mock.calls).toEqual([[true]]);
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

    const settle = jest.fn();
    request.answer(replyWith({ settled: settle }));
    await settled();
    expect(received).toHaveLength(1);
    expect(settle.mock.calls).toEqual([[false]]);
  });

  // [LAW:verifiable-goals] A TIMEOUT to a click means its action did not run, so a
  // click that was read is answered with its own outcome, however long it
  // takes. Only a click whose frame was not read before the
  // backstop answered was told TIMEOUT.
  describe("a click request", () => {
    const CLICK: Request = {
      v: PROTOCOL_VERSION,
      kind: "click",
      url: "cc-candybar://x",
    };

    test("read before the backstop answered outlives it and is answered with its own reply", async () => {
      const request = held();
      const daemon = standIn({ handle: request.handle });
      const { send, received, ended } = open(daemon);
      send(CLICK);
      await settled();

      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS * 3);
      await settled();
      expect(received).toEqual([]);
      expect(request.timedOut()).toBe(false);
      expect(daemon.stats.requestsTimedOut).toBe(0);
      expect(daemon.stats.inFlight).toBe(1);

      const settle = jest.fn();
      request.answer(replyWith({ settled: settle }));
      await settled();
      expect(received).toEqual([ANSWER]);
      expect(ended()).toBe(true);
      expect(settle.mock.calls).toEqual([[true]]);
      expect(daemon.stats.inFlight).toBe(0);
    });

    // A busy daemon runs its expired timers before it reads the socket the
    // frame arrived on, so the frame is read first and the backstop never
    // answers it.
    test("already waiting on the socket when the backstop's timer fires is read, not answered TIMEOUT", async () => {
      const request = held();
      const daemon = standIn({ handle: request.handle });
      const { client, received } = open(daemon);
      client.write(encodeFrame(CLICK));
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await settled();
      expect(received).toEqual([]);
      expect(request.timedOut()).toBe(false);
      expect(daemon.stats.requestsTimedOut).toBe(0);

      request.answer(replyWith());
      await settled();
      expect(received).toEqual([ANSWER]);
    });

    test("read after the backstop answered is told it was timed out, and its reply goes nowhere", async () => {
      const request = held();
      const daemon = standIn({ handle: request.handle });
      const { client, received } = open(daemon);
      // Open on its side after the TIMEOUT, as a client still waiting for its
      // answer is.
      client.allowHalfOpen = true;
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await settled();
      expect(received).toMatchObject([{ ok: false, code: "TIMEOUT" }]);

      client.write(encodeFrame(CLICK));
      await settled();
      expect(request.timedOut()).toBe(true);
      expect(request.clientLeft()).toBe(false);

      const settle = jest.fn();
      request.answer(replyWith({ settled: settle }));
      await settled();
      expect(received).toHaveLength(1);
      expect(settle.mock.calls).toEqual([[false]]);
      expect(daemon.stats.requestsTimedOut).toBe(1);
    });

    test("whose client hangs up while it is held is said to have left", async () => {
      const request = held();
      const { client, send } = open(standIn({ handle: request.handle }));
      send(CLICK);
      await settled();
      expect(request.clientLeft()).toBe(false);

      client.destroy();
      await settled();
      expect(request.clientLeft()).toBe(true);
    });
  });

  test("each TIMEOUT names the request its handler was handed, however many are in flight", async () => {
    const requests = [held(), held()];
    let next = 0;
    const daemon = standIn({
      handle: (...args) => requests[next++]!.handle(...args),
    });
    const clients = [open(daemon), open(daemon)];
    for (const { send } of clients) send(STATS);
    await settled();

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();
    const ids = requests.map((r) => r.accepted().id);
    expect(new Set(ids).size).toBe(2);
    expect(clients.map((c) => c.received)).toEqual(
      ids.map((request) => [expect.objectContaining({ code: "TIMEOUT", request })]),
    );
  });

  // The URL handler app writes its frame and hangs up without reading
  // (candybar-daemon-health-ajx0.co4): the frame is still handled, the answer
  // goes to no one, and the daemon says nothing about it above info, since
  // this is the forwarder's design and not a peer that vanished.
  test("a frame whose writer hung up at once is handled, answered to no one, and not a warning", async () => {
    const handle = jest.fn(async () => urlAnswer());
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
  // a client leaving: a url frame stays in flight until handled, however long
  // that takes, and no one is said to have left.
  test("a url frame whose writer hung up stays in flight past the backstop, with no client gone", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client } = open(daemon);
    client.end(encodeFrame({ kind: "url", urlV: 1, url: "cc-candybar://x" }));
    await settled();
    expect(daemon.stats.inFlight).toBe(1);
    expect(request.clientLeft()).toBe(false);
    expect(request.timedOut()).toBe(false);

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS * 3);
    await settled();
    expect(request.timedOut()).toBe(false);
    expect(request.clientLeft()).toBe(false);
    expect(daemon.stats.requestsTimedOut).toBe(0);
    expect(daemon.stats.inFlight).toBe(1);

    request.answer(urlAnswer());
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
  });

  // [LAW:dataflow-not-control-flow] The acts a click hands back are its
  // output, so the writer that carries them out hears its verdict only once the
  // click has landed, and the verdict holds them in the order asked.
  test("a url frame whose writer carries out acts is told once its click has landed, with the acts", async () => {
    let land = () => {};
    const landed = new Promise<void>((done) => (land = done));
    const handed: ClientAct[] = [
      { kind: "copy", text: "/work/repo" },
      { kind: "open", target: "/work/repo" },
    ];
    const daemon = standIn({
      handle: async () => urlAnswer(landed, true, handed),
    });
    const { client, received } = open(daemon);
    client.allowHalfOpen = true;
    client.write(encodeFrame({ kind: "url", urlV: 3, url: "cc-candybar://x" }));
    await settled();
    const before = [...received];
    land();
    await settled();
    client.destroy();
    await settled();
    expect({ before, received, inFlight: daemon.stats.inFlight }).toEqual({
      before: [],
      received: [{ ok: true, output: "", clientActs: handed }],
      inFlight: 0,
    });
  });

  // A frame that reaches the daemon only after the backstop answered finds
  // TIMEOUT as the socket's one answer, so a writer that reads a verdict is
  // written nothing more.
  test("a url frame read after the backstop answered is told nothing more, with no client gone", async () => {
    let land = () => {};
    const landed = new Promise<void>((done) => (land = done));
    const request = held();
    const log = jest.fn();
    const daemon = standIn({ handle: request.handle, log });
    const { client, received } = open(daemon);
    // Open on its side after the TIMEOUT, as a writer still waiting for its
    // verdict is, so a second write would be a write after end.
    client.allowHalfOpen = true;
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();
    client.write(encodeFrame({ kind: "url", urlV: 2, url: "cc-candybar://x" }));
    await settled();
    request.answer(urlAnswer(landed, true));
    await settled();
    land();
    await settled();
    client.destroy();
    await settled();
    expect({
      received,
      timedOut: request.timedOut(),
      clientLeft: request.clientLeft(),
      warnings: log.mock.calls.filter(([level]) => level !== "info"),
      inFlight: daemon.stats.inFlight,
      timeouts: daemon.stats.requestsTimedOut,
    }).toEqual({
      received: [expect.objectContaining({ code: "TIMEOUT" })],
      timedOut: true,
      clientLeft: false,
      warnings: [],
      inFlight: 0,
      timeouts: 1,
    });
  });

  // [LAW:single-enforcer] A verdict is the socket's one answer: a click that
  // throws as it starts to land writes nothing further to the ended socket,
  // and its throw reaches the daemon's clock.
  test("a url frame whose click throws after its verdict was written is told nothing more", async () => {
    const log = jest.fn();
    const threw: Array<{ task: string; thrown: unknown }> = [];
    const daemon = standIn({
      handle: async () => ({
        ...urlAnswer(Promise.resolve(), true),
        land: () => {
          throw new Error("the click broke as it began");
        },
      }),
      clock: clockOver(systemTimers, (task, thrown) =>
        threw.push({ task, thrown }),
      ),
      log,
    });
    const { client, received } = open(daemon);
    client.allowHalfOpen = true;
    client.write(encodeFrame({ kind: "url", urlV: 2, url: "cc-candybar://x" }));
    await settled();
    client.destroy();
    await settled();
    expect({
      received,
      warnings: log.mock.calls.filter(([level]) => level === "warn"),
      threw,
    }).toEqual({
      received: [expect.objectContaining({ code: "BAD_REQUEST" })],
      warnings: [],
      threw: [
        {
          task: "url click landing",
          thrown: new Error("the click broke as it began"),
        },
      ],
    });
  });

  // [LAW:one-source-of-truth] A waiting client has left once its hang-up is
  // heard, and only then.
  test("a request's client is said to have left once it hangs up", async () => {
    const request = held();
    const { client, send } = open(standIn({ handle: request.handle }));
    send(STATS);
    await settled();
    expect(request.clientLeft()).toBe(false);
    client.destroy();
    await settled();
    expect(request.clientLeft()).toBe(true);
  });

  // The app is told at once whether its link opened, and the click it carries
  // runs on however long it takes: a slow click that lands is never told failed.
  test("a url frame whose writer reads the verdict is told it at once, and stays in flight until its click lands", async () => {
    let land = () => {};
    const landed = new Promise<void>((done) => (land = done));
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, received } = open(daemon);
    client.write(encodeFrame({ kind: "url", urlV: 2, url: "cc-candybar://x" }));
    await settled();
    request.answer(urlAnswer(landed, true));
    await settled();
    expect(received).toEqual([
      { ok: false, error: "forged", code: "BAD_REQUEST", daemonV: 3 },
    ]);
    expect(daemon.stats.inFlight).toBe(1);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await settled();
    expect(request.timedOut()).toBe(false);
    expect(received).toHaveLength(1);
    land();
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
  });

  test("a client that half-closes before its answer is answered to no one", async () => {
    const request = held();
    const daemon = standIn({ handle: request.handle });
    const { client, received } = open(daemon);

    client.end(encodeFrame(STATS));
    await settled();
    expect(daemon.stats.inFlight).toBe(0);

    const settle = jest.fn();
    request.answer(replyWith({ settled: settle }));
    await settled();
    expect(received).toEqual([]);
    expect(settle.mock.calls).toEqual([[false]]);
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

    const settle = jest.fn();
    request.answer(replyWith({ exitAfterFlush: 0, settled: settle }));
    await settled();

    expect(exit).toHaveBeenCalledWith(0);
    expect(settle.mock.calls).toEqual([[false]]);
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

  // [LAW:verifiable-goals] A connection reads one frame: whatever follows it,
  // in the same chunk or after the answer, is never handled.
  test("two frames in one chunk are handled once, and answered once", async () => {
    const handle = jest.fn(async () => replyWith());
    const { client, received, ended } = open(standIn({ handle }));
    client.write(Buffer.concat([encodeFrame(STATS), encodeFrame(STATS)]));
    await settled();
    expect({ handled: handle.mock.calls.length, received, ended: ended() }).toEqual({
      handled: 1,
      received: [ANSWER],
      ended: true,
    });
  });

  test("a frame written while its answer is pending is not handled", async () => {
    const request = held();
    const handle = jest.fn(request.handle);
    const { send, received } = open(standIn({ handle }));
    send(STATS);
    await settled();
    send(SUBSCRIBE);
    await settled();
    request.answer(replyWith());
    await settled();
    expect({ handled: handle.mock.calls.length, received }).toEqual({
      handled: 1,
      received: [ANSWER],
    });
    expect(subscriptions).toHaveLength(0);
  });

  test("a frame that does not parse, then a valid one, is answered BAD_REQUEST once and the valid one never handled", async () => {
    const handle = jest.fn(async () => replyWith());
    const { client, received } = open(standIn({ handle }));
    // Open on its side after the answer, so the valid frame reaches the
    // daemon's reader.
    client.allowHalfOpen = true;
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(3);
    client.write(Buffer.concat([header, Buffer.from("not")]));
    await settled();
    client.write(encodeFrame(STATS));
    await settled();
    expect({ handled: handle.mock.calls.length, received }).toEqual({
      handled: 0,
      received: [expect.objectContaining({ ok: false, code: "BAD_REQUEST" })],
    });
  });

  test("a frame stated past the cap, written on, is one parse failure and one BAD_REQUEST", async () => {
    const log = jest.fn();
    const { client, received } = open(standIn({ log }));
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(0xffffffff);
    client.write(header);
    for (let i = 0; i < 10; i++) client.write(Buffer.alloc(1024, 1));
    await settled();
    expect({
      received,
      failures: log.mock.calls.filter(([, line]) =>
        String(line).startsWith("frame parse failed"),
      ).length,
    }).toEqual({
      received: [expect.objectContaining({ ok: false, code: "BAD_REQUEST" })],
      failures: 1,
    });
  });

  // [LAW:no-silent-failure] An answer no reader would take is answered
  // RENDER_FAILED, which ends the stream, and the exit it carried still runs.
  test("a reply past the frame cap is answered RENDER_FAILED, ends the stream, and runs its exit", async () => {
    const settledDelivered = jest.fn();
    const daemon = standIn({
      handle: async () =>
        replyWith({
          resp: { ok: true, output: "x".repeat(MAX_FRAME_BYTES + 1) },
          exitAfterFlush: 0,
          settled: settledDelivered,
        }),
    });
    const { client, send, received, ended } = open(daemon);
    send(STATS);
    await settled();
    expect({
      received,
      ended: ended(),
      exits: exit.mock.calls,
      delivered: settledDelivered.mock.calls,
    }).toEqual({
      received: [
        expect.objectContaining({
          ok: false,
          code: "RENDER_FAILED",
          error: expect.stringContaining("byte cap"),
        }),
      ],
      ended: true,
      exits: [[0]],
      delivered: [[false]],
    });
    client.destroy();
    await settled();
    expect(daemon.stats.inFlight).toBe(0);
  });

  test("a handler that throws before it returns is answered RENDER_FAILED", async () => {
    const daemon = standIn({
      handle: () => {
        throw new Error("thrown at once");
      },
    });
    const { send, received, ended } = open(daemon);
    send(STATS);
    await settled();
    expect({ received, ended: ended(), inFlight: daemon.stats.inFlight }).toEqual({
      received: [
        expect.objectContaining({
          ok: false,
          code: "RENDER_FAILED",
          error: "thrown at once",
        }),
      ],
      ended: true,
      inFlight: 0,
    });
  });

  test("a url frame whose handler fails is told the failure and leaves flight", async () => {
    const daemon = standIn({
      handle: async () => {
        throw new Error("the click broke");
      },
    });
    const { client, received } = open(daemon);
    client.write(encodeFrame({ kind: "url", urlV: 2, url: "cc-candybar://x" }));
    await settled();
    expect({ received, inFlight: daemon.stats.inFlight }).toEqual({
      received: [
        expect.objectContaining({
          ok: false,
          code: "RENDER_FAILED",
          error: "the click broke",
        }),
      ],
      inFlight: 0,
    });
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

  // [LAW:verifiable-goals] A failed request costs its own answer and nothing
  // more: the daemon logs the throw, neither exits nor keeps it in flight, and
  // the next connection is served as if nothing had failed.
  test("a handler that throws is answered RENDER_FAILED, and the next request is served", async () => {
    const log = jest.fn();
    const daemon = standIn({
      log,
      handle: jest
        .fn(async () => replyWith())
        .mockRejectedValueOnce(new Error("the handler broke")),
    });
    const failed = open(daemon);
    failed.send(STATS);
    await settled();
    const next = open(daemon);
    next.send(STATS);
    await settled();
    expect({
      failed: failed.received,
      next: next.received,
      exits: exit.mock.calls,
      inFlight: daemon.stats.inFlight,
      logged: log.mock.calls,
    }).toEqual({
      failed: [
        expect.objectContaining({
          ok: false,
          code: "RENDER_FAILED",
          error: "the handler broke",
        }),
      ],
      next: [ANSWER],
      exits: [],
      inFlight: 0,
      logged: [["error", expect.stringContaining("the handler broke")]],
    });
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

      const confirmations: boolean[] = [];
      const confirm = (ok: boolean) => confirmations.push(ok);
      subscriptions[0]!.frame(JSON.stringify(ANSWER), confirm);
      subscriptions[0]!.frame(JSON.stringify(ANSWER), confirm);
      await settled();
      expect(received).toEqual([ANSWER, ANSWER]);
      expect(confirmations).toEqual([true, true]);
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

    test("one its feed refuses as it subscribes is told the refusal, ends, and leaves flight", async () => {
      const refusal: Extract<Response, { ok: false }> = {
        ok: false,
        error: "the lane is off",
        code: "SWITCHED_OFF",
      };
      const daemon = subscribing({
        subscribe: (_sessionId, subscriber) => {
          subscriber.refused(refusal);
          return unsubscribe;
        },
      });
      const { client, send, received, ended } = open(daemon);
      send(SUBSCRIBE);
      await settled();
      expect({ received, ended: ended() }).toEqual({
        received: [refusal],
        ended: true,
      });
      client.destroy();
      await settled();
      expect(daemon.stats.inFlight).toBe(0);
    });

    // [LAW:no-silent-failure] On a stream a render failure is a frame, which
    // the follower can draw. Ending the stream on it would read
    // as a restart, and the follower would resubscribe into the same failure.
    test.each(LANE_NAMES)(
      "a frame past the cap on the %s lane is pushed as that lane draws a render that failed, and the stream goes on",
      async (lane) => {
        const { send, received, ended } = open(
          subscribing({
            handle: async () => ({ ...SUBSCRIBED, lane }),
          }),
        );
        send({ ...SUBSCRIBE, lane });
        await settled();
        const huge = "x".repeat(MAX_FRAME_BYTES);
        const json = JSON.stringify({ ok: true, output: huge });
        const confirmations: boolean[] = [];
        const confirm = (ok: boolean) => confirmations.push(ok);
        subscriptions[0]!.frame(json, confirm);
        subscriptions[0]!.frame(JSON.stringify(ANSWER), confirm);
        await settled();
        expect(confirmations).toEqual([false, true]);
        // The renderer's own render failure (src/renderer/draw-bar.ts): its
        // bar, and its RENDER_FAILED answer, naming why.
        let failed!: ReturnType<typeof renderFailed>;
        try {
          encodeJsonFrame(json);
        } catch (e) {
          failed = renderFailed(e);
        }
        expect(failed.error).toContain("byte cap");
        expect({ received, ended: ended() }).toEqual({
          received: [failed, ANSWER],
          ended: false,
        });
        expect(unsubscribe).not.toHaveBeenCalled();
      },
    );

    // [LAW:single-enforcer] A refusal is the socket's one answer: a throw
    // after it writes nothing further to the ended socket.
    test("a subscribe that throws after its feed refused it writes nothing more", async () => {
      const refusal: Extract<Response, { ok: false }> = {
        ok: false,
        error: "the lane is off",
        code: "SWITCHED_OFF",
      };
      const log = jest.fn();
      const daemon = subscribing({
        log,
        subscribe: (_sessionId, subscriber) => {
          subscriber.refused(refusal);
          throw new Error("the feed broke after");
        },
      });
      const { client, send, received } = open(daemon);
      // Open on its side after the refusal, so a second write would be a
      // write after end.
      client.allowHalfOpen = true;
      send(SUBSCRIBE);
      await settled();
      client.destroy();
      await settled();
      expect({
        received,
        warnings: log.mock.calls.filter(([level]) => level === "warn"),
        inFlight: daemon.stats.inFlight,
      }).toEqual({ received: [refusal], warnings: [], inFlight: 0 });
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
      // The reply comes in the turn the deferred TIMEOUT runs, so the subscribe
      // lands while the TIMEOUT is still closing the stream: not yet destroyed,
      // and a feed attached now would never hear the close.
      const clock = {
        ...systemTimekeeper,
        defer: (task: string, fire: () => unknown) =>
          systemTimekeeper.defer(task, () => {
            const ran = fire();
            request.answer(SUBSCRIBED);
            return ran;
          }),
      };
      const { send, received } = open(
        subscribing({ handle: request.handle, clock }),
      );
      send(SUBSCRIBE);
      await settled();

      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await settled();

      expect(received).toMatchObject([{ code: "TIMEOUT" }]);
      expect(subscriptions).toEqual([]);
    });

    test("one already waiting on the socket when the backstop's timer fires attaches, and is not answered TIMEOUT", async () => {
      const daemon = subscribing();
      const { client, received } = open(daemon);
      client.write(encodeFrame(SUBSCRIBE));
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await settled();

      expect(subscriptions).toHaveLength(1);
      expect(daemon.stats.requestsTimedOut).toBe(0);
      expect(received).toEqual([]);
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

    test("one that throws is answered RENDER_FAILED, never an open stream nothing feeds, and leaves nothing on the socket", async () => {
      const daemon = subscribing({
        subscribe: () => {
          throw new Error("the feed refused");
        },
      });
      const { daemonEnd, client } = memoryConnection();
      handleConnection(daemon, daemonEnd);
      const { send, received, ended } = openedOn(client);
      send(SUBSCRIBE);
      await settled();
      expect({
        received,
        ended: ended(),
        drains: daemonEnd.listenerCount("drain"),
      }).toEqual({
        received: [
          expect.objectContaining({
            code: "RENDER_FAILED",
            error: "the feed refused",
          }),
        ],
        ended: true,
        drains: 0,
      });
      client.destroy();
      await settled();
      expect(daemon.stats.inFlight).toBe(0);
    });

    test("a subscriber slower than the frames gets the newest, never a backlog", async () => {
      const { client, send, received } = open(subscribing());
      send(SUBSCRIBE);
      await settled();

      client.pause();
      // Over a stream's high-water mark on every node this runs on, so the
      // first frame fills the stream.
      const confirmed = new Map<string, boolean>();
      const frame = (name: string): void => {
        const resp: Response = { ok: true, output: name.repeat(128 * 1024) };
        subscriptions[0]!.frame(JSON.stringify(resp), (ok) => confirmed.set(name, ok));
      };
      ["a", "b", "c", "d"].forEach(frame);
      await settled();
      client.resume();
      await until(() => received.length >= 2, "the newest frame");
      expect(Object.fromEntries(confirmed)).toEqual({ a: true, b: false, c: false, d: true });

      expect(received.map((r) => "output" in r && r.output[0])).toEqual([
        "a",
        "d",
      ]);
    });
  });
});
