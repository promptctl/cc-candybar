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
      ...inertHost({} as never),
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
