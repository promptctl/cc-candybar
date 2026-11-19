// [LAW:one-type-per-behavior] The lines are a transport, not a second
// renderer: one renderer answers the same inputs the same way, and reaches the
// host the same way, in this process as over the lines a process speaks.

import {
  hostOverLines,
  lineSplitter,
  rendererBootFrom,
  rendererOverLines,
  RENDERER_WIRE_VERSION,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import {
  rendererOf,
  timed,
  type AdapterInput,
  type AdapterOutput,
  type Subscriptions,
  type TimedRenderer,
} from "../../src/renderer-interface/interface";
import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import type { Instant, Tick } from "../../src/utils/instant";
import { joinedEvent, type HeldEvent } from "../../src/utils/event-hold";
import {
  CrossedFailure,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import { inertHost } from "../helpers/renderer-parts";

const EVENT: HeldEvent = { text: "e", at: 7 as Instant, answered: false };

// A renderer that tells the host two notices and answers; and one push that
// throws. Its turns take no time, so both ends time them alike.
function talkingRenderer(host: AdapterToHost): TimedRenderer {
  return timed(
    rendererOf({
      event: async () => {
        throw new Error("no events here");
      },
      adapter: async (input) => {
        if (input.push.kind === "close-views") throw new Error("close refused");
        host.log("info", "closed");
        host.eventAnswered(EVENT);
        return {
          kind: "replied",
          stored: [],
          reply: { kind: "close-journal" },
          subscriptions: { sources: {}, lanes: {}, configs: [] },
          wake: null,
        };
      },
    }),
    () => 0,
  );
}

// What the host saw of the renderer, whichever way it ran.
function recordingHost(): { host: AdapterToHost; saw: string[] } {
  const saw: string[] = [];
  return {
    saw,
    host: {
      ...inertHost(),
      log: (_level, msg) => saw.push(`log ${msg}`),
      eventAnswered: (event) => saw.push(`answered ${event.text} ${event.at}`),
    },
  };
}

// Each line crosses as JSON does, and on a later turn, as a pipe carries it.
// The renderer's heap is `heap`, its text in pieces.
function linesOver(
  host: AdapterToHost,
  heap: Parameters<typeof serveRenderer>[0]["heapSnapshot"] = async () => {},
  options: {
    readonly subscriptionUpdates?: boolean;
    readonly renderer?: TimedRenderer;
    readonly heard?: RendererLine[];
  } = {},
) {
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
    renderer: options.renderer ?? talkingRenderer(reaches),
    subscriptionUpdates: options.subscriptionUpdates,
    send: (line) => {
      const received = crossed(line);
      options.heard?.push(received);
      queueMicrotask(() => lines.heard(received));
    },
    memory: () => ({ rss: 1, heapTotal: 1 }),
    heapSnapshot: heap,
  });
  return lines;
}

const overLines = (host: AdapterToHost): TimedRenderer =>
  linesOver(host).renderer;

test("v8 notices carry legacy and revised held event identities through JSON", () => {
  const heard: HeldEvent[] = [];
  const lines = rendererOverLines({
    send: () => {},
    host: { ...inertHost(), eventAnswered: (event) => void heard.push(event) },
    fault: (message) => { throw new Error(message); },
  });
  const toHost = hostOverLines((line) => {
    lines.heard(JSON.parse(JSON.stringify(line)) as RendererLine);
  });
  const revised = joinedEvent(EVENT, "a later failure", EVENT.at);
  toHost.eventAnswered(EVENT);
  toHost.eventAnswered(revised);
  expect(heard).toEqual([EVENT, revised]);
  expect(heard[1]?.revision).toBe(1);
});

const push = (kind: "close-journal" | "close-views"): AdapterInput => ({
  kind: "adapter",
  push: { kind },
  at: 0 as Instant,
  tick: 0 as Tick,
});

const empty: Subscriptions = { sources: {}, lanes: {}, configs: [] };
const opened: Subscriptions = {
  ...empty,
  configs: [{ projectDir: "/p", cwd: "/p", target: { source: "search" } }],
};

function declaring(subscriptions: readonly Subscriptions[]): TimedRenderer {
  let step = 0;
  return timed(
    rendererOf({
      event: async () => {
        throw new Error("no event expected");
      },
      adapter: async (): Promise<AdapterOutput> => {
        const next = subscriptions[step];
        if (next === undefined) throw new Error("no declaration scripted");
        return {
          kind: "replied",
          reply: { kind: "close-journal" },
          subscriptions: next,
          wake: ++step as Tick,
          stored: [],
        };
      },
    }),
    () => 0,
  );
}

test.each([true, false])(
  "a renderer pipe takes full replacements and stable wakes (subscription updates: %s)",
  async (subscriptionUpdates) => {
    const heard: RendererLine[] = [];
    const wire = linesOver(inertHost(), undefined, {
      heard,
      subscriptionUpdates,
      renderer: declaring([empty, empty, opened, opened, empty]),
    });
    const answers = [];
    for (let step = 0; step < 5; step++)
      answers.push(await wire.renderer.answer(push("close-journal")));
    expect(answers.map(({ subscriptions }) => subscriptions)).toEqual([
      empty,
      empty,
      opened,
      opened,
      empty,
    ]);
    expect(answers.map(({ wake }) => wake)).toEqual([1, 2, 3, 4, 5]);
    expect(answers[1]?.subscriptions).toBe(answers[0]?.subscriptions);
    expect(answers[3]?.subscriptions).toBe(answers[2]?.subscriptions);
    const outputs = heard.flatMap((line) =>
      line.kind === "output" ? [line.output] : [],
    );
    expect(outputs.map((value) => "subscriptions" in value)).toEqual(
      subscriptionUpdates
        ? [true, false, true, false, true]
        : [true, true, true, true, true],
    );
    expect(outputs[0]).toMatchObject(
      subscriptionUpdates
        ? { subscriptions: empty, wake: 1 }
        : { subscriptions: { ...empty, wake: 1 } },
    );
    expect(outputs[4]).toMatchObject({ subscriptions: empty });
  },
);

test("a replacement process sends the same nonempty declaration on its first answer", async () => {
  for (let generation = 0; generation < 2; generation++) {
    const heard: RendererLine[] = [];
    const { renderer } = linesOver(inertHost(), undefined, {
      heard,
      subscriptionUpdates: true,
      renderer: declaring([opened]),
    });
    await expect(renderer.answer(push("close-journal"))).resolves.toMatchObject(
      {
        subscriptions: opened,
      },
    );
    expect(heard).toMatchObject([
      { kind: "output", output: { subscriptions: opened } },
    ]);
  }
});

test("reusing a declaration before the first replacement rejects the turn", async () => {
  let asked: HostLine | undefined;
  const wire = rendererOverLines({
    send: (line) => (asked = line),
    host: inertHost(),
    fault: (message) => {
      throw new Error(message);
    },
  });
  const answer = wire.renderer.answer(push("close-journal"));
  if (asked?.kind !== "input") throw new Error("expected an input line");
  wire.heard({
    kind: "output",
    n: asked.n,
    output: {
      kind: "replied",
      reply: { kind: "close-journal" },
      wake: null,
      turnMs: 0,
      stored: [],
    },
  });
  await expect(answer).rejects.toThrow(
    "reused subscriptions before declaring them",
  );
});

describe("a renderer's boot line", () => {
  const locations = {
    home: "/h",
    configHome: "/c",
    dataHome: "/d",
    dataDirs: ["/s"],
  };
  const stored = {
    sessions: { "session-a": { pick: "blue" } },
    history: { "session-a": { past: [], future: [] } },
  };
  const boot = {
    locations,
    stored,
    memoryLimitBytes: Number.MAX_SAFE_INTEGER * 1024 * 1024,
  };
  const read = (value: unknown) =>
    rendererBootFrom({
      kind: "boot",
      wireVersion: RENDERER_WIRE_VERSION,
      boot: value,
    });

  test("selects the resolved fields and the committed profile", () => {
    expect(
      read({
        ...boot,
        digest: "a compatible build",
        locations: { ...locations, tmp: "/unused" },
      }),
    ).toEqual(boot);
  });

  test.each([
    [
      { ...boot, locations: { ...locations, dataDirs: [1] } },
      "invalid resolved locations",
    ],
    [{ ...boot, memoryLimitBytes: -1 }, "memoryLimitBytes"],
    [{ ...boot, stored: {} }, "stored.sessions"],
    [
      {
        ...boot,
        stored: { ...stored, sessions: { "session-a": { pick: 1 } } },
      },
      "not a string",
    ],
    [
      {
        ...boot,
        stored: {
          ...stored,
          history: { "session-a": { past: "one", future: [] } },
        },
      },
      "not a list of steps",
    ],
  ] as const)(
    "refuses a malformed boot before the first turn",
    (value, reason) => {
      expect(() => read(value)).toThrow(reason);
    },
  );
});

describe("the renderer over lines", () => {
  test("answers as it does in this process, reaching the host in the same order", async () => {
    const here = recordingHost();
    const there = recordingHost();
    const inProcess = await talkingRenderer(here.host).answer(
      push("close-journal"),
    );
    const crossed = await overLines(there.host).answer(push("close-journal"));
    expect(crossed).toEqual(inProcess);
    expect(there.saw).toEqual(here.saw);
    expect(there.saw).toEqual(["log closed", "answered e 7"]);
  });

  test("a heap snapshot reaches the host as its text, in order, and settles once it has all come", async () => {
    const written: string[] = [];
    const lines = linesOver(recordingHost().host, async (chunk) => {
      chunk('{"snap');
      await Promise.resolve();
      chunk('shot":1}');
    });
    await lines.heapSnapshot((chunk) => written.push(chunk));
    expect(written.join("")).toBe('{"snapshot":1}');
  });

  test("a heap snapshot the renderer could not take fails with its failure, after the chunks it sent", async () => {
    const written: string[] = [];
    const lines = linesOver(recordingHost().host, async (chunk) => {
      chunk("{");
      throw new Error("out of memory");
    });
    await expect(
      lines.heapSnapshot((chunk) => written.push(chunk)),
    ).rejects.toThrow("out of memory");
    expect(written).toEqual(["{"]);
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
    lines.heard({ kind: "notice", reach: "eventAnswered", args: [EVENT] });
    lines.heard({ kind: "notice", reach: "log", args: ["info", "after"] });
    expect(saw).toEqual(["answered e 7", "log after"]);
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
    const here = talkingRenderer(recordingHost().host).answer(
      push("close-views"),
    );
    const there = overLines(recordingHost().host).answer(push("close-views"));
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
