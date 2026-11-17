// [LAW:one-type-per-behavior] The lines are a transport, not a second
// renderer: one renderer answers the same inputs the same way, and reaches the
// host the same way, in this process as over the lines a process speaks.

import {
  hostOverLines,
  lineSplitter,
  rendererOverLines,
  serveRenderer,
  timed,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import {
  rendererOf,
  type AdapterInput,
  type Renderer,
  type TimedRenderer,
} from "../../src/renderer-interface/interface";
import type {
  AdapterToHost,
  StorageHoldId,
} from "../../src/renderer-interface/adapter";
import type { Instant } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";
import {
  CrossedFailure,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import { inertHost } from "../helpers/renderer-parts";
import { QUIET } from "../helpers/renderers";

const HOLD = 7 as StorageHoldId;

// A renderer that tells the host two notices and answers; one push that
// throws; and an event it answers with nothing.
function talkingRenderer(host: AdapterToHost): Renderer {
  return rendererOf({
    event: async () => ({
      kind: "answered",
      effects: [],
      record: [],
      subscriptions: QUIET,
      frames: [],
    }),
    adapter: async (input) => {
      if (input.push.kind === "reload-every") throw new Error("reload refused");
      host.log("info", "closing");
      host.storage.hold(HOLD, ["/folder"]);
      return {
        kind: "replied",
        reply: { kind: "close-journal" },
        subscriptions: QUIET,
      };
    },
  });
}

// What the host saw of the renderer, whichever way it ran.
function recordingHost(): { host: AdapterToHost; saw: string[] } {
  const saw: string[] = [];
  return {
    saw,
    host: {
      ...inertHost(),
      log: (_level, msg) => saw.push(`log ${msg}`),
      storage: {
        ...inertHost().storage,
        hold: (id, folders) => saw.push(`hold ${id} ${folders.join(",")}`),
      },
    },
  };
}

// A clock whose every reading is 5 ms after the last.
function steppingClock(): { monotonic: () => Monotonic } {
  let at = 0;
  return { monotonic: () => (at += 5) as Monotonic };
}

// Each line crosses as JSON does, and on a later turn, as a pipe carries it.
function overLines(host: AdapterToHost): TimedRenderer {
  const crossed = <T>(line: T): T => JSON.parse(JSON.stringify(line)) as T;
  let toRenderer: (line: HostLine) => void = () => {};
  const lines = rendererOverLines({
    send: (line) => queueMicrotask(() => toRenderer(crossed(line))),
    host,
    fault: (message) => {
      throw new Error(message);
    },
  });
  const reaches = hostOverLines((line: RendererLine) =>
    queueMicrotask(() => lines.heard(crossed(line))),
  );
  toRenderer = serveRenderer({
    renderer: timed(talkingRenderer(reaches), steppingClock()),
    send: (line) => queueMicrotask(() => lines.heard(crossed(line))),
    memory: () => ({ rss: 1, heapTotal: 1 }),
    heapSnapshot: () => {},
  });
  return lines.renderer;
}

const push = (
  push: { kind: "close-journal" } | { kind: "reload-every"; since: number },
): AdapterInput => ({ kind: "adapter", push, at: 0 as Instant });

describe("the renderer over lines", () => {
  test("answers as it does in this process, reaching the host in the same order", async () => {
    const here = recordingHost();
    const there = recordingHost();
    const asked = push({ kind: "close-journal" });
    const inProcess = await talkingRenderer(here.host).answer(asked);
    const crossed = await overLines(there.host).answer(asked);
    expect(crossed).toEqual(inProcess);
    expect(there.saw).toEqual(here.saw);
    expect(there.saw).toEqual(["log closing", `hold ${HOLD} /folder`]);
  });

  test("an event's output crosses with its turn timed on the serving side, around the renderer's answer", async () => {
    const crossed = await overLines(recordingHost().host).answer({
      kind: "event",
      at: 0 as Instant,
      event: { kind: "due" },
    });
    expect(crossed.turnMs).toBe(5);
  });

  test("two notices heard in one chunk reach the host in the order sent", () => {
    const { host, saw } = recordingHost();
    const lines = rendererOverLines({
      send: () => {},
      host,
      fault: (message) => {
        throw new Error(message);
      },
    });
    lines.heard({ kind: "notice", reach: "storage.hold", args: [HOLD, ["/f"]] });
    lines.heard({ kind: "notice", reach: "log", args: ["info", "after"] });
    expect(saw).toEqual([`hold ${HOLD} /f`, "log after"]);
  });

  test("a line heard after the renderer's end reaches nothing, and is said", () => {
    const { host, saw } = recordingHost();
    const faults: string[] = [];
    const lines = rendererOverLines({
      send: () => {},
      host,
      fault: (message) => faults.push(message),
    });
    lines.ended(new Error("renderer main exited"));
    lines.heard({ kind: "notice", reach: "log", args: ["info", "late"] });
    expect(saw).toEqual([]);
    expect(faults).toEqual([
      "renderer said notice after its end (renderer main exited)",
    ]);
  });

  test("a push that threw fails as it does in this process, its failure kept", async () => {
    const asked = push({ kind: "reload-every", since: 0 });
    const here = talkingRenderer(recordingHost().host).answer(asked);
    const there = overLines(recordingHost().host).answer(asked);
    const thrownHere = failureOf(await here.catch((e: unknown) => e));
    const thrownThere = await there.catch((e: unknown) => e);
    expect(thrownThere).toBeInstanceOf(CrossedFailure);
    expect(failureOf(thrownThere)).toMatchObject({
      kind: thrownHere.kind,
      message: thrownHere.message,
    });
  });

  test("a line split across chunks is heard whole, and a last line without its newline at the end", () => {
    const heard: string[] = [];
    const split = lineSplitter((line) => heard.push(line));
    split.push('{"a"');
    split.push(':1}\n{"b":2}\n{"c"');
    expect(heard).toEqual(['{"a":1}', '{"b":2}']);
    split.end();
    expect(heard).toEqual(['{"a":1}', '{"b":2}', '{"c"']);
  });
});
