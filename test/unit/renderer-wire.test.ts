// [LAW:one-type-per-behavior] The lines are a transport, not a second
// renderer: it answers the same inputs in process and over lines.

import {
  lineSplitter,
  rendererBootFrom,
  rendererOverLines,
  RENDERER_WIRE_VERSION,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import {
  timed,
  type EventInput,
  type EffectId,
  type RendererOutput,
  type RequestId,
  type Subscriptions,
  type TimedRenderer,
} from "../../src/renderer-interface/interface";
import type { Instant, Tick } from "../../src/utils/instant";
import { joinedEvent, type DisplayedEvent } from "../../src/utils/event-hold";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  CrossedFailure,
  failureOf,
} from "../../src/daemon/foundations/verb-error";

// A renderer that answers with a diagnostic. Its turns
// take no time, so both ends time them alike.
function talkingRenderer(): TimedRenderer {
  return timed(
    {
      answer: async (input) => {
        if (input.event.kind === "close-views") throw new Error("close refused");
        return {
          kind: "answered",
          record: [],
          effects: [],
          frames: [],
          diagnostics: [{ level: "info", line: "closed" }],
          stored: [],
          reply: { kind: "close-journal" },
          subscriptions: {
            sources: {},
            lanes: {},
            managedFolders: [],
            configSelections: [],
            configs: [],
          },
          wake: null,
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
  options: {
    readonly renderer?: TimedRenderer;
    readonly heard?: RendererLine[];
  } = {},
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
    renderer: options.renderer ?? talkingRenderer(),
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

const command = (kind: "close-journal" | "close-views"): EventInput => ({
  kind: "event",
  event: { kind },
  at: 0 as Instant,
  tick: 0 as Tick,
});

const empty: Subscriptions = {
  sources: {},
  lanes: {},
  managedFolders: [],
  configSelections: [],
  configs: [],
};
const opened: Subscriptions = {
  ...empty,
  managedFolders: ["/p/plugin/session"],
  configs: [{ projectDir: "/p", cwd: "/p", target: { source: "search" } }],
};

test("both presentation paths carry the displayed event in their turn's answer", async () => {
  const session = sessionIdOf("wire-events");
  const frame = {
    depth: "none",
    rows: [],
    nextChange: null,
    motion: "still",
    pending: [],
  } as const;
  const displayedEvents: readonly DisplayedEvent[] = [
    {
      kind: "act-failed",
      event: joinedEvent(null, "a daemon failure", 7 as Instant),
    },
  ];
  const output: RendererOutput = {
    kind: "answered",
    record: [],
    effects: [
      {
        kind: "present",
        id: 1 as EffectId,
        session,
        request: 1 as RequestId,
        surface: "statusline",
        frame,
        displayedEvents,
      },
    ],
    frames: [
      {
        session,
        frame: {
          kind: "drawn",
          receipt: 2 as EffectId,
          bar: frame,
          handoff: null,
          displayedEvents,
        },
      },
    ],
    subscriptions: empty,
    wake: null,
    stored: [],
  };
  const renderer = timed(
    { answer: async () => output },
    () => 0,
  );
  const heard: RendererLine[] = [];
  const transport = linesOver(undefined, { renderer, heard });
  const answer = await transport.renderer.answer({
    kind: "event",
    event: { kind: "due" },
    at: 7 as Instant,
    tick: 0 as Tick,
  });
  expect(answer).toEqual({ ...output, turnMs: 0 });
  expect(heard).toMatchObject([{ kind: "output", output }]);
});

function declaring(subscriptions: readonly Subscriptions[]): TimedRenderer {
  let step = 0;
  return timed(
    {
      answer: async (): Promise<RendererOutput> => {
        const next = subscriptions[step];
        if (next === undefined) throw new Error("no declaration scripted");
        return {
          kind: "answered",
          record: [],
          effects: [],
          frames: [],
          reply: { kind: "close-journal" },
          subscriptions: next,
          wake: ++step as Tick,
          stored: [],
        };
      },
    },
    () => 0,
  );
}

test("a renderer pipe carries changes to the declaration independently of wakes", async () => {
  const heard: RendererLine[] = [];
  const wire = linesOver(undefined, {
    heard,
    renderer: declaring([empty, empty, opened, opened, empty]),
  });
  const answers = [];
  for (let step = 0; step < 5; step++)
    answers.push(await wire.renderer.answer(command("close-journal")));
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
  expect(outputs.map((value) => "subscriptions" in value)).toEqual([
    true,
    false,
    true,
    false,
    true,
  ]);
  expect(outputs[0]).toMatchObject({ subscriptions: empty, wake: 1 });
  expect(outputs[4]).toMatchObject({ subscriptions: empty });
});

test("a selection change crosses the wire without republishing unchanged resource demand", async () => {
  const origin = opened.configs[0]!;
  const selected = {
    ...opened,
    configSelections: [{ origin, digest: null }],
  };
  const { renderer } = linesOver(undefined, {
    renderer: declaring([opened, selected, selected]),
  });
  const before = (await renderer.answer(command("close-journal"))).subscriptions;
  const after = (await renderer.answer(command("close-journal"))).subscriptions;
  const repeated = (await renderer.answer(command("close-journal"))).subscriptions;
  expect(after.configSelections).toEqual(selected.configSelections);
  expect(after.managedFolders).toBe(before.managedFolders);
  expect(after.configs).toBe(before.configs);
  expect(repeated).toBe(after);
});

test("a replacement process sends the same nonempty declaration on its first answer", async () => {
  for (let generation = 0; generation < 2; generation++) {
    const heard: RendererLine[] = [];
    const { renderer } = linesOver(undefined, {
      heard,
      renderer: declaring([opened]),
    });
    await expect(renderer.answer(command("close-journal"))).resolves.toMatchObject(
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
    fault: (message) => {
      throw new Error(message);
    },
  });
  const answer = wire.renderer.answer(command("close-journal"));
  if (asked?.kind !== "input") throw new Error("expected an input line");
  wire.heard({
    kind: "output",
    n: asked.n,
    output: {
      kind: "answered",
          record: [],
          effects: [],
          frames: [],
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
  test("answers as it does in this process", async () => {
    const inProcess = await talkingRenderer().answer(command("close-journal"));
    const crossed = await linesOver().renderer.answer(command("close-journal"));
    expect(crossed).toEqual(inProcess);
    expect(crossed.diagnostics).toEqual([{ level: "info", line: "closed" }]);
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

  test("a command that rejected fails as it does in this process, its failure kept", async () => {
    const here = talkingRenderer().answer(command("close-views"));
    const there = linesOver().renderer.answer(command("close-views"));
    const thrownHere = failureOf(await here.catch((e: unknown) => e));
    const thrownThere = await there.catch((e: unknown) => e);
    expect(thrownThere).toBeInstanceOf(CrossedFailure);
    expect(failureOf(thrownThere)).toEqual({
      kind: thrownHere.kind,
      message: thrownHere.message,
      detail: "Error: close refused",
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
