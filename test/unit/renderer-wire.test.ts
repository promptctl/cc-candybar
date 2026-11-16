// [LAW:one-type-per-behavior] The lines are a transport, not a second
// renderer: one renderer answers the same inputs the same way, and reaches the
// host the same way, in this process as over the lines a process speaks.

import {
  hostOverLines,
  lineSplitter,
  rendererOverLines,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import {
  rendererOf,
  type AdapterInput,
  type RendererInput,
  type Renderer,
} from "../../src/renderer-interface/interface";
import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Instant } from "../../src/utils/instant";
import {
  CrossedFailure,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import { inertHost } from "../helpers/renderer-parts";

const SESSION = "s1" as SessionId;

// A renderer that tells the host a notice, awaits a call, and answers with
// what the call returned; and one push that throws.
function talkingRenderer(host: AdapterToHost): Renderer {
  return rendererOf({
    event: async () => {
      throw new Error("no events here");
    },
    adapter: async (input) => {
      if (input.push.kind === "lanes") throw new Error("lanes refused");
      host.log("info", "pinned");
      const gone = await host.clicks.gone({} as never);
      return {
        kind: "replied",
        reply: gone ? { kind: "pin" } : { kind: "unpin" },
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
      clicks: {
        gone: async () => {
          saw.push("gone?");
          return true;
        },
      },
    },
  };
}

// Each line crosses as JSON does, and on a later turn, as a pipe carries it.
function overLines(host: AdapterToHost): Renderer {
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
    renderer: talkingRenderer(reaches.host),
    host: reaches,
    send: (line) => queueMicrotask(() => lines.heard(crossed(line))),
    memory: () => ({ rss: 1, heapTotal: 1 }),
    heapSnapshot: () => {},
    clock: {
      defer: () => {
        throw new Error("these pushes draw no frame");
      },
    },
  });
  return lines.renderer;
}

const push = (kind: "pin" | "lanes"): AdapterInput => ({
  kind: "adapter",
  push: { kind, session: SESSION },
  at: 0 as Instant,
});

describe("the renderer over lines", () => {
  test("answers as it does in this process, reaching the host in the same order", async () => {
    const here = recordingHost();
    const there = recordingHost();
    const inProcess = await talkingRenderer(here.host).answer(push("pin"));
    const crossed = await overLines(there.host).answer(push("pin"));
    expect(crossed).toEqual(inProcess);
    expect(there.saw).toEqual(here.saw);
    expect(there.saw).toEqual(["log pinned", "gone?"]);
  });

  test("a call and the notice after it, heard in one chunk, reach the host in the order sent", () => {
    const { host, saw } = recordingHost();
    const lines = rendererOverLines({
      send: () => {},
      host,
      fault: (message) => {
        throw new Error(message);
      },
    });
    lines.heard({ kind: "call", n: 1, reach: "clicks.gone", args: [{}] });
    lines.heard({ kind: "notice", reach: "log", args: ["info", "after"] });
    expect(saw).toEqual(["gone?", "log after"]);
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
    const here = talkingRenderer(recordingHost().host).answer(push("lanes"));
    const there = overLines(recordingHost().host).answer(push("lanes"));
    const thrownHere = failureOf(await here.catch((e: unknown) => e));
    const thrownThere = await there.catch((e: unknown) => e);
    expect(thrownThere).toBeInstanceOf(CrossedFailure);
    expect(failureOf(thrownThere)).toMatchObject({
      kind: thrownHere.kind,
      message: thrownHere.message,
    });
  });

  test("an event, and what it awaits, runs ahead of every frame heard with it or after it, and a frame draws one per turn", async () => {
    const seen: string[] = [];
    const turns: Array<() => void> = [];
    const answers = new Map<number, () => void>();
    const serve = serveRenderer({
      renderer: rendererOf({
        event: async (input) => {
          const name = (input.event as unknown as { name: string }).name;
          seen.push(name);
          await Promise.resolve();
          seen.push(`${name} continued`);
          return {} as never;
        },
        adapter: async (input) => {
          seen.push((input.push as { session: string }).session);
          return {} as never;
        },
      }),
      host: hostOverLines(() => {}),
      send: (line) => {
        const answered = answers.get((line as { n: number }).n);
        if (answered === undefined)
          throw new Error(`an answer to no input: ${JSON.stringify(line)}`);
        answered();
      },
      memory: () => ({ rss: 1, heapTotal: 1 }),
      heapSnapshot: () => {},
      clock: {
        defer: (step) => {
          turns.push(step);
          return () => {};
        },
      },
    });
    let n = 0;
    // Hears one input line, and resolves once its answer is sent.
    const hear = (input: RendererInput): Promise<void> => {
      n += 1;
      const line: HostLine = { kind: "input", n, input };
      return new Promise((answered) => {
        answers.set(line.n, answered);
        serve(line);
      });
    };
    const event = (name: string): Promise<void> =>
      hear({ kind: "event", event: { name } as never, at: 0 as Instant });
    const frame = (name: string): Promise<void> =>
      hear({
        kind: "adapter",
        push: { kind: "frame", session: name as SessionId } as never,
        at: 0 as Instant,
      });
    const turn = (): void => {
      const step = turns.shift();
      if (step === undefined) throw new Error("no frame's turn was owed");
      step();
    };

    // One chunk: a frame, a request, a frame.
    const f1 = frame("f1");
    const e1 = event("e1");
    const f2 = frame("f2");
    await e1;
    expect(seen).toEqual(["e1", "e1 continued"]);

    turn();
    await f1;
    expect(seen).toEqual(["e1", "e1 continued", "f1"]);

    // Heard between the two frames' turns: it goes ahead of the second.
    await event("e2");
    expect(turns).toHaveLength(1);
    turn();
    await f2;
    expect(seen).toEqual([
      "e1",
      "e1 continued",
      "f1",
      "e2",
      "e2 continued",
      "f2",
    ]);
    expect(turns).toEqual([]);
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
