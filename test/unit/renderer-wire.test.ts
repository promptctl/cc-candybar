// [LAW:one-type-per-behavior] The lines are a transport, not a second
// renderer: one renderer answers the same inputs the same way, its logged
// lines and readings in its output, in this process as over the lines a
// process speaks.

import {
  lineSplitter,
  rendererOverLines,
  serveRenderer,
  type HostLine,
} from "../../src/renderer-interface/wire";
import {
  timed,
  type RendererInput,
  type TimedRenderer,
} from "../../src/renderer-interface/interface";
import type { Instant, Tick } from "../../src/utils/instant";
import {
  CrossedFailure,
  failureOf,
} from "../../src/daemon/foundations/verb-error";

// A renderer whose stats inspect answers with a reading and two logged
// lines, and whose close throws. Its turns take no time, so both ends time
// them alike.
function talkingRenderer(): TimedRenderer {
  return timed(
    {
      answer: async ({ event }) => {
        if (event.kind === "close") throw new Error("close refused");
        if (event.kind !== "inspect") throw new Error("no such turn here");
        return {
          kind: "answered",
          stored: [],
          logged: [
            { level: "info", line: "inspected" },
            { level: "warn", line: "and said so" },
          ],
          effects: [
            {
              kind: "report",
              reading: {
                kind: "stats",
                stats: {
                  sessions: 1,
                  entries: 0,
                  compiles: 0,
                  views: 0,
                } as never,
              },
            },
          ],
          subscriptions: {
            sources: {},
            lanes: {},
            configs: [],
            storage: { folders: ["/plug"], loads: 1 },
            wake: null,
          },
          record: [],
          frames: [],
        };
      },
    },
    () => 0,
  );
}

// Each line crosses as JSON does, and on a later turn, as a pipe carries it.
// The renderer's heap is `heap`, its text in pieces.
function linesOver(
  heap: Parameters<typeof serveRenderer>[0]["heapSnapshot"] = async () => {},
) {
  const crossed = <T>(line: T): T => JSON.parse(JSON.stringify(line)) as T;
  let toRenderer: (line: HostLine) => void = () => {};
  const lines = rendererOverLines({
    send: (line) => queueMicrotask(() => toRenderer(crossed(line))),
    fault: (message) => {
      throw new Error(message);
    },
  });
  toRenderer = serveRenderer({
    renderer: talkingRenderer(),
    send: (line) => queueMicrotask(() => lines.heard(crossed(line))),
    memory: () => ({ rss: 1, heapTotal: 1 }),
    heapSnapshot: heap,
  });
  return lines;
}

const overLines = (): TimedRenderer => linesOver().renderer;

const input = (event: RendererInput["event"]): RendererInput => ({
  event,
  at: 0 as Instant,
  tick: 0 as Tick,
});
const INSPECT = input({ kind: "inspect", ask: { kind: "stats" } });
const CLOSE = input({ kind: "close" });

describe("the renderer over lines", () => {
  test("answers as it does in this process, its logged lines and its reading in its output", async () => {
    const inProcess = await talkingRenderer().answer(INSPECT);
    const crossed = await overLines().answer(INSPECT);
    expect(crossed).toEqual(inProcess);
    expect(crossed.logged).toEqual([
      { level: "info", line: "inspected" },
      { level: "warn", line: "and said so" },
    ]);
  });

  test("a heap snapshot reaches the host as its text, in order, and settles once it has all come", async () => {
    const written: string[] = [];
    const lines = linesOver(async (chunk) => {
      chunk('{"snap');
      await Promise.resolve();
      chunk('shot":1}');
    });
    await lines.heapSnapshot((chunk) => written.push(chunk));
    expect(written.join("")).toBe('{"snapshot":1}');
  });

  test("a heap snapshot the renderer could not take fails with its failure, after the chunks it sent", async () => {
    const written: string[] = [];
    const lines = linesOver(async (chunk) => {
      chunk("{");
      throw new Error("out of memory");
    });
    await expect(
      lines.heapSnapshot((chunk) => written.push(chunk)),
    ).rejects.toThrow("out of memory");
    expect(written).toEqual(["{"]);
  });

  test("a line heard after the renderer's end reaches nothing, and is said", () => {
    const faults: string[] = [];
    const lines = rendererOverLines({
      send: () => {},
      fault: (message) => faults.push(message),
    });
    lines.ended(new Error("renderer main exited"));
    lines.heard({ kind: "ping", n: 1, usage: { rss: 1, heapTotal: 1 } });
    expect(faults).toEqual([
      "renderer said ping after its end (renderer main exited)",
    ]);
  });

  test("a turn that threw fails as it does in this process, its failure kept", async () => {
    const here = talkingRenderer().answer(CLOSE);
    const there = overLines().answer(CLOSE);
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
