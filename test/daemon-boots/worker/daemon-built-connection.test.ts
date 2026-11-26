import {
  reportingClock,
  type ReportingClock,
} from "../../../src/daemon/task-throws";
import { decodeAnsi } from "@promptctl/rich-js";
// [LAW:verifiable-goals] A connection to a daemon built in this jest worker, over
// a stream with no socket: its own handling answers a render, feeds a subscriber
// and reaches the exit it was built with. A connection to a stand-in daemon is the
// other half (test/daemon-connection.test.ts).

import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Monotonic, type Timekeeper } from "../../../src/time";
import { daemonClock } from "../../../src/host";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import {
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
  type Request,
  type Response,
} from "../../../src/daemon/foundations/protocol";
import { handleConnection } from "../../../src/daemon/connection";
import type { HandledRequest } from "../../../src/daemon/reply";
import { REQUEST_TIMEOUT_MS } from "../../../src/daemon/foundations/request-deadline";
import { inProcessRenderer } from "../../../src/in-process-renderer";
import type { LinkOwner } from "../../../src/daemon/renderer-process";
import { textOf } from "../../../src/render/frame";
import { instantAt } from "../../../src/utils/instant";
import {
  DAEMON_EVENT_HOLD_S,
  type HeldEvent,
} from "../../../src/utils/event-hold";
import { hookData, render, renderBody } from "../../helpers/daemon-e2e";
import { loggedLines, renderEventsOf } from "../../../scripts/lib/daemon/log";
import { heldClock } from "../../helpers/held-clock";
import {
  startDaemon,
  statsOf,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { memoryConnection } from "../../helpers/memory-connection";
import { openedOn, type Opened } from "../../helpers/opened-connection";
import { field, landedEvents, only } from "../../helpers/request-event";
import { hearingEvents, holdable } from "../../helpers/renderers";
import { fakeLauncher } from "../../../scripts/lib/draw-fixtures/fake-launcher";
import { until } from "../../../scripts/lib/until";
import { MAIN_RENDERER } from "../../../src/daemon/foundations/renderer-name";
import { rendererPanelOf } from "../../../src/daemon/foundations/stats-snapshot";

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

  const start = (clock: ReportingClock = daemonClock()): InWorkerDaemon => {
    started = startDaemon(process.env, { clock, exit });
    return started;
  };

  const renderRequest = (
    sessionId: string,
    deadline: number | undefined,
    cost = 0,
  ): ReaderRenderRequest => {
    const body = renderBody(
      sessionId,
      projectDir,
      { termCols: 200, termRows: 40 },
      ["cc-candybar", "--config", config],
    );
    return {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...body,
      hookData: {
        ...hookData(sessionId, projectDir),
        cost: { total_cost_usd: cost },
      },
      deadline,
    } as ReaderRenderRequest;
  };

  const answered = async (opened: Opened): Promise<Response> => {
    await until(() => opened.received.length > 0, "the connection's answer");
    return opened.received[0]!;
  };

  const drawn = (response: Response): string => {
    if (!response.ok || !("output" in response))
      throw new Error(`expected a drawn frame: ${JSON.stringify(response)}`);
    return decodeAnsi(response.output).plain;
  };

  // [LAW:no-ambient-temporal-coupling] A feed draws without waiting for a
  // value still loading (the mark's cost, from the session's usage), and draws
  // again when it lands, so what a case reads is the frame that shows `text`,
  // not whichever frame came first.
  const showing = async (opened: Opened, text: string): Promise<string> => {
    const frames = () => opened.received.map(drawn);
    let shown: string | undefined;
    await until(
      () =>
        (shown = frames().find((frame) => frame.includes(text))) !== undefined,
      () => `a frame showing "${text}"; received:\n${frames().join("\n")}`,
    );
    return shown!;
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
      `{ globals: { experimentalStatusline: true, experimentalPane: true }, segments: { mark: { template: 'a drawn mark {{ .session.cost }}' } }, root: { h: ['mark'] } }`,
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
      lane: "statusline",
    } as Request);
    await showing(feed, "a drawn mark");
    expect(running.daemon.stats.inFlight).toBe(0);
    feed.client.destroy();
  });

  function daemonWithWarning() {
    let owner: LinkOwner | undefined;
    let observed: HeldEvent | null = null;
    let standingReads = 0;
    const inProcess = inProcessRenderer((real) =>
      hearingEvents(real, ({ event }) => {
        if (event.kind === "context" && event.worldState.session === "observe")
          observed =
            event.worldState.daemon.held.find(
              ({ kind }) => kind === "renderer-ended",
            )?.event ?? null;
      }),
    );
    const running = startDaemon(process.env, {
      launcher: (own) => {
        const { launcher } = fakeLauncher(systemTimekeeper, own);
        return {
          ...launcher,
          standing: () => {
            standingReads++;
            return launcher.standing();
          },
        };
      },
      renderer: (prepared) => ({
        start: (link) => {
          owner = link;
          return inProcess(prepared).start(link);
        },
      }),
    });
    started = running;
    const link = owner;
    if (link === undefined)
      throw new Error("the daemon did not attach a renderer");
    const warning = {
      text: "the renderer stopped",
      at: instantAt(running.daemon.clock),
      answered: false,
    };
    const reply = async (session = "warning-draw") => {
      const result = await running.daemon.reply(
        renderRequest(session, undefined),
        () => false,
        running.daemon.stats.accept(),
        () => false,
      );
      expect(drawn(result.resp)).not.toBe("");
      return result;
    };
    const held = async () => {
      const check = await reply("observe");
      check.settled(false);
      return observed;
    };
    return {
      running,
      reply,
      held,
      report: () => link.ended(warning),
      replace: () => link.start(),
      standingReads: () => standingReads,
    };
  }

  test("a confirmed ordinary reply answers its daemon event across replacement and only for that occurrence", async () => {
    const { running, reply, held, report, replace } = daemonWithWarning();
    report();
    const first = await reply();
    expect(drawn(first.resp)).toMatch(/⚠\s+1/);
    await replace();
    expect(await held()).toMatchObject({ revision: 1, answered: false });
    first.settled(true);
    expect(await held()).toMatchObject({ revision: 1, answered: true });

    report();
    const dropped = await reply();
    dropped.settled(false);
    expect(await held()).toMatchObject({ revision: 2, answered: false });
    const older = await reply();
    report();
    older.settled(true);
    expect(await held()).toMatchObject({ revision: 3, answered: false });

    await rendered(running, "warning-draw");
    expect(await held()).toMatchObject({ revision: 3, answered: true });
  });

  test("the pane connection acknowledges its own confirmed warning frame", async () => {
    const { running, reply, held, report } = daemonWithWarning();
    const initial = await reply("pane-warning");
    initial.settled(true);
    report();
    expect(await held()).toMatchObject({ revision: 1, answered: false });

    const feed = openedOn(running.connect());
    try {
      feed.send({
        ...SUBSCRIBE,
        sessionId: "pane-warning",
        lane: "pane",
      } as Request);
      const pane = await showing(feed, "a drawn mark");
      expect(pane).toMatch(/⚠\s+1/);
      expect(await held()).toMatchObject({ revision: 1, answered: true });
    } finally {
      feed.client.destroy();
    }
  });

  test("an already answered event stays visible without rereading daemon warnings", async () => {
    const { reply, report, standingReads } = daemonWithWarning();
    report();
    const first = await reply();
    const concurrent = await reply();
    expect(drawn(first.resp)).toMatch(/⚠\s+1/);
    const before = standingReads();
    first.settled(true);
    expect(standingReads()).toBe(before + 1);
    concurrent.settled(true);
    expect(standingReads()).toBe(before + 1);

    const insideHold = await reply();
    expect(drawn(insideHold.resp)).toMatch(/⚠\s+1/);
    insideHold.settled(true);
    expect(standingReads()).toBe(before + 1);
  });

  test("a task's throw draws on every bar, once per task; what follows while it is held is counted, and its hold's end shows the latest with the count", async () => {
    const clock = heldClock(new Date(), reportingClock);
    // Thrown before the daemon exists: the inbox holds it for the daemon.
    clock.throws.report("daemon boot", new Error("too early"), clock.now());
    const running = startDaemon(process.env, { clock });
    started = running;
    const reply = async (session: string) => {
      const result = await running.daemon.reply(
        renderRequest(session, undefined),
        () => false,
        running.daemon.stats.accept(),
        () => false,
      );
      result.settled(true);
      return drawn(result.resp);
    };
    const sweepLines = (count: number) =>
      loggedLines(
        process.env,
        (lines) =>
          lines.filter((line) => line.includes("[error] session sweep threw")),
        (picked) => picked.length >= count,
        "the sweep's throws logged",
      );
    expect(await reply("task-throw-a")).toMatch(/⚠\s+1/);

    clock.throws.report("session sweep", new Error("it broke"), clock.now());
    expect(await reply("task-throw-a")).toMatch(/⚠\s+2/);
    // While it is held, a throw is counted, whatever it says.
    clock.throws.report("session sweep", new Error("it broke"), clock.now());
    clock.throws.report(
      "session sweep",
      new Error("it broke again"),
      clock.now(),
    );
    expect(await reply("task-throw-b")).toMatch(/⚠\s+2/);
    expect(running.daemon.stats.tasksThrew).toBe(4);

    // Its hold ends with throws counted: the latest is held, and logged once
    // with their count. The boot's, answered with nothing since, leaves.
    clock.advance(DAEMON_EVENT_HOLD_S * 1000);
    expect(await sweepLines(2)).toEqual([
      expect.stringMatching(/session sweep threw: Error: it broke$/),
      expect.stringMatching(
        /session sweep threw 2 more times: Error: it broke again$/,
      ),
    ]);
    expect(await reply("task-throw-a")).toMatch(/⚠\s+1/);

    // With nothing counted since, the next hold's end lets it go.
    clock.advance(DAEMON_EVENT_HOLD_S * 1000);
    expect(await reply("task-throw-a")).not.toMatch(/⚠/);
  });

  test("a valid pane subscribe leaves no follower when its peer departs", async () => {
    const clock = heldClock(new Date(), reportingClock);
    const running = start(clock);
    const daemon = running.daemon;
    const sessionId = "connection-pane-hangup";
    const request: Request = { ...SUBSCRIBE, sessionId, lane: "pane" };
    await rendered(running, sessionId);
    const { daemonEnd, client } = memoryConnection();
    const read = Promise.withResolvers<HandledRequest>();
    const release = Promise.withResolvers<void>();
    // Hold the real parser's reply where the connection will act on it, so
    // the daemon has read the frame but the peer can close before admission.
    handleConnection(
      {
        ...daemon,
        handle: async (...args) => {
          const reply = daemon.handle(...args);
          reply.then(read.resolve, read.reject);
          await release.promise;
          return reply;
        },
      },
      daemonEnd,
    );
    const leaving = openedOn(client);
    let live: Opened | undefined;
    try {
      leaving.send(request);
      expect(await read.promise).toEqual({
        kind: "subscribe",
        drawing: true,
        sessionId,
        lane: "pane",
        owner: null,
      });
      const peerClosed = once(daemonEnd, "close");
      leaving.client.destroy();
      await peerClosed;
      release.resolve();
      await clock.settle(0);
      expect((await statsOf(daemon)).frameFeeds).toMatchObject({
        feeds: 0,
        subscribers: 0,
      });

      live = openedOn(running.connect());
      live.send(request);
      await clock.settle(0);
      await showing(live, "a drawn mark");
      expect((await statsOf(daemon)).frameFeeds).toMatchObject({
        feeds: 1,
        subscribers: 1,
      });
      live.client.destroy();
      await clock.settle(0);
      expect((await statsOf(daemon)).frameFeeds).toMatchObject({
        feeds: 0,
        subscribers: 0,
      });
    } finally {
      release.resolve();
      leaving.client.destroy();
      live?.client.destroy();
    }
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
        ...daemonClock(),
        now: () => at.getTime(),
        monotonic: () => monotonic as Monotonic,
      }).connect(),
    );
    monotonic += 500;
    opened.send(renderRequest("connection-clock", at.getTime() + 2_000));

    // The attempt still records its queue time after its reply budget ends.
    const [event] = await loggedLines(
      process.env,
      (lines) => renderEventsOf(lines, "connection-clock"),
      (events) => events.length > 0,
      "the render event of connection-clock",
    );
    expect(event).toContain(" queued=500ms ");
  });

  // [LAW:verifiable-goals] Hold a real render at the renderer boundary so the
  // connection's backstop can win without blocking the process or waiting.
  test("a render that outlives its request timeout writes timedOut=Y", async () => {
    const clock = heldClock(new Date(), reportingClock);
    let entered = (): void => {};
    const drawing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => {};
    const renderer = inProcessRenderer((real) => {
      const held = holdable(real);
      return hearingEvents(held.renderer, ({ event }) => {
        if (event.kind === "request") {
          release = held.hold();
          entered();
        }
      });
    });
    const running = startDaemon(process.env, { clock, renderer });
    started = running;
    const opened = openedOn(running.connect());
    try {
      opened.send(renderRequest("ev-backstop", clock.now() + 2_000));
      await drawing;
      await clock.settle(REQUEST_TIMEOUT_MS + 1);
      expect(await answered(opened)).toMatchObject({
        ok: false,
        code: "TIMEOUT",
      });
      release();

      const late = only(await landedEvents(process.env, "ev-backstop", 1));
      expect(field(late, "outcome")).toBe("ok");
      expect(field(late, "timedOut")).toBe("Y");
      expect(field(late, "took")).toBe(`${REQUEST_TIMEOUT_MS + 1}ms`);
      expect(opened.received).toHaveLength(1);
      const stats = openedOn(running.connect());
      stats.send({ v: PROTOCOL_VERSION, kind: "stats" });
      expect(await answered(stats)).toMatchObject({
        ok: true,
        stats: {
          renderers: [
            {
              name: MAIN_RENDERER,
              stats: { kind: "ok", value: { renderCache: { held: 0 } } },
            },
          ],
        },
      });
    } finally {
      release();
    }
  });

  test("an embedded client with no deadline can still take a draw", async () => {
    const clock = heldClock(new Date(), reportingClock);
    const entered = Promise.withResolvers<void>();
    let draws = 0;
    let release = () => {};
    const renderer = inProcessRenderer((real) => {
      const held = holdable(real);
      return hearingEvents(held.renderer, ({ event }) => {
        if (event.kind === "request") draws++;
        if (event.kind === "context") {
          release = held.hold();
          entered.resolve();
        }
      });
    });
    const running = startDaemon(process.env, { clock, renderer });
    started = running;
    const answer = running.daemon.reply(
      renderRequest("embedded", undefined, 17),
      () => false,
      running.daemon.stats.accept(),
      () => false,
    );
    try {
      await entered.promise;
      await clock.settle(REQUEST_TIMEOUT_MS + 1);
      release();
      await clock.settle(0);
      const { resp, settled } = await answer;
      settled(true);
      expect(draws).toBe(1);
      expect(drawn(resp).length).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  test.each([
    { cause: "the socket backstop", budget: 2_000, expiry: REQUEST_TIMEOUT_MS },
    { cause: "the client's deadline", budget: 100, expiry: 100 },
  ])(
    "drops abandoned draws at $cause and still updates the pane",
    async ({ budget, expiry }) => {
      const clock = heldClock(new Date(), reportingClock);
      const occupied = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const draws: string[] = [];
      const contexts: string[] = [];
      let occupyNext = false;
      let occupiedTurn: ReturnType<typeof statsOf> | undefined;
      const renderer = inProcessRenderer((real) => {
        return {
          answer: async (input) => {
            const { event } = input;
            if (event.kind === "context") {
              const session = event.context.hookData.session_id;
              contexts.push(session);
              if (session === "draw-a" && occupyNext) {
                occupyNext = false;
                occupiedTurn = statsOf(running.daemon);
              }
            }
            if (event.kind === "request")
              draws.push(event.context.hookData.session_id);
            if (event.kind === "stats" && occupiedTurn !== undefined) {
              occupied.resolve();
              await release.promise;
            }
            return real.answer(input);
          },
        };
      });
      const running = startDaemon(process.env, { clock, renderer });
      started = running;
      const send = (
        session: string,
        cost: number,
        budgetMs = 2_000,
      ): Opened => {
        const opened = openedOn(running.connect());
        opened.send(renderRequest(session, clock.now() + budgetMs, cost));
        return opened;
      };

      let pane: Opened | undefined;
      try {
        expect(drawn(await answered(send("draw-a", 1)))).toContain(
          "a drawn mark",
        );
        expect(drawn(await answered(send("draw-b", 2)))).toContain(
          "a drawn mark",
        );
        await clock.settle(0);
        draws.length = 0;
        contexts.length = 0;
        occupyNext = true;

        const expiring = send("draw-a", 3, budget);
        await occupied.promise;
        await clock.settle(0);
        const queuedDraw = statsOf(running.daemon);
        const admittedBefore = running.daemon.stats.requestsTotal;
        const departing = send("draw-b", 97);
        await clock.settle(0);
        expect(running.daemon.stats.requestsTotal).toBe(admittedBefore + 1);
        departing.client.destroy();

        await clock.settle(50);
        // By the time its draw is admitted, this client is inside its draw
        // reserve. Its full reply deadline remains ahead of the clock.
        const fresh = send("draw-a", 11, expiry - 50 + 20);
        pane = openedOn(running.connect());
        pane.send({ ...SUBSCRIBE, sessionId: "draw-b", lane: "pane" });
        await clock.settle(expiry - 50 + 1);
        release.resolve();
        expect(await answered(expiring)).toMatchObject({
          ok: false,
          code: "TIMEOUT",
          request: expect.any(Number),
        });
        expect(drawn(await answered(fresh))).toContain("a drawn mark 11");
        expect(
          rendererPanelOf(await queuedDraw, MAIN_RENDERER).mailbox.queued,
        ).toBeGreaterThan(0);
        await clock.settle(0);
        await showing(pane, "a drawn mark 97");
        expect(contexts).toEqual(["draw-a", "draw-b", "draw-a"]);
        expect(expiring.received).toHaveLength(1);
        expect(draws).toEqual(["draw-a"]);
      } finally {
        release.resolve();
        pane?.client.destroy();
      }
    },
  );
});
