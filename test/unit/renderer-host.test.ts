// The host's one path to a renderer (src/daemon/renderer-host.ts): `ask` hands
// back the reply of the push's own kind or rejects, and `tell` says a failure
// on the log, since nothing awaits it; a start heads the mailbox; every input
// is made at the instant its slot comes; and each output's declarations and
// frames reach the host, none once its close has begun.

import { rendererHost, type Declared } from "../../src/daemon/renderer-host";
import { failureOf } from "../../src/daemon/foundations/verb-error";
import {
  rendererOf,
  type AdapterOutput,
  type PushedFrame,
  type RendererOutput,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { Instant } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";
import { NO_ACTS, pushRenderer, timedOf } from "../helpers/renderers";
import type { SessionId } from "../../src/daemon/foundations/session-id";

const NONE: Subscriptions = { sources: {}, lanes: {}, wake: null };
const S = "s" as SessionId;

const answered = (over: Partial<RendererOutput> = {}): RendererOutput =>
  ({
    kind: "answered",
    effects: [],
    subscriptions: NONE,
    record: [],
    frames: [],
    ...over,
  }) as RendererOutput;

// A host over a renderer that answers every push with `output`; `said`
// settles with the first line it logs.
function hostOver(output: AdapterOutput) {
  let say: (line: string) => void = () => {};
  const said = new Promise<string>((resolve) => (say = resolve));
  const host = rendererHost(
    "main",
    { now: () => 0, monotonic: () => 0 as Monotonic },
    timedOf(pushRenderer(async () => output)),
    (level, line) => say(`${level} ${line}`),
    {
      declared: () => {},
      framed: () => {
        throw new Error("a push draws no frame");
      },
      writableSettings: () => {
        throw new Error("a push lands no change");
      },
      holding: () => {
        throw new Error("a push holds no session");
      },
    },
    NO_ACTS,
  );
  return { host, said };
}

test("an ask is handed the reply of its push's own kind", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "reload-every" },
    subscriptions: NONE,
  });
  expect(await host.ask({ kind: "reload-every", since: 0 })).toEqual({
    kind: "reload-every",
  });
});

test("an ask answered with another push's reply rejects, naming both", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "close-journal" },
    subscriptions: NONE,
  });
  await expect(host.ask({ kind: "reload-every", since: 0 })).rejects.toThrow(
    "renderer main answered push reload-every with a close-journal reply",
  );
});

test("an ask whose push threw rejects with the renderer's failure", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("the view broke")),
    subscriptions: NONE,
  });
  await expect(host.ask({ kind: "stats" })).rejects.toThrow(
    /renderer main push stats threw: .*the view broke/,
  );
});

test("a tell that fails is said on the log, and nothing rejects", async () => {
  const { host, said } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("no such origin")),
    subscriptions: NONE,
  });
  expect(host.tell({ kind: "close-views" })).toBe(undefined);
  expect(await said).toMatch(
    /^error renderer main push close-views threw: .*no such origin/,
  );
});

// A host over a renderer whose events `event` answers and whose pushes are
// answered at once, with what it declared and drew.
function recordingHost(
  event: (kind: string, at: Instant) => Promise<RendererOutput>,
  {
    now = () => 0,
    adapter = async (): Promise<AdapterOutput> => ({
      kind: "replied",
      reply: { kind: "reload-every" },
      subscriptions: NONE,
    }),
    closing = () => false,
  }: {
    readonly now?: () => number;
    readonly adapter?: () => Promise<AdapterOutput>;
    readonly closing?: () => boolean;
  } = {},
) {
  const declared: Declared[] = [];
  const framed: PushedFrame[] = [];
  const host = rendererHost(
    "main",
    { now, monotonic: () => 0 as Monotonic },
    timedOf(
      rendererOf({
        event: (input) => event(input.event.kind, input.at),
        adapter,
      }),
    ),
    () => {},
    {
      declared: (d) => void declared.push(d),
      framed: (frames) => void framed.push(...frames),
      writableSettings: () => [],
      holding: () => () => {},
    },
    { ...NO_ACTS, closing },
  );
  return { host, declared, framed };
}

test("a start heads the mailbox, behind only the slot in progress", async () => {
  const heard: string[] = [];
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const { host } = recordingHost(
    async (kind) => {
      heard.push(kind);
      return answered();
    },
    {
      adapter: async () => {
        heard.push("push:reload-every");
        await opened;
        return {
          kind: "replied",
          reply: { kind: "reload-every" },
          subscriptions: NONE,
        };
      },
    },
  );
  const held = host.ask({ kind: "reload-every", since: 0 });
  const waiting = host.deliver(
    (at) => ({ kind: "event", at, event: { kind: "retire", session: S } }),
    [],
  );
  const started = host.start(
    (at) => ({
      kind: "event",
      at,
      event: { kind: "start", viewers: {}, sessions: [] },
    }),
    [],
  );
  open();
  await Promise.all([held, waiting, started]);
  expect(heard).toEqual(["push:reload-every", "start", "retire"]);
});

// [LAW:no-ambient-temporal-coupling] An input waiting behind a long turn runs
// at the instant it is made, never at its arrival, so no turn runs at an
// instant earlier than one ahead of it.
test("every input is made at the instant its slot comes", async () => {
  let wallMs = 1_000;
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const ran: Array<[string, Instant]> = [];
  const { host } = recordingHost(
    async (kind, at) => {
      ran.push([kind, at]);
      if (kind === "due") await opened;
      return answered();
    },
    { now: () => wallMs },
  );
  const first = host.answer((at) => ({
    kind: "event",
    at,
    event: { kind: "due" },
  }));
  const second = host.deliver(
    (at) => ({ kind: "event", at, event: { kind: "retire", session: S } }),
    [],
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  wallMs = 3_500;
  open();
  await Promise.all([first, second]);
  expect(ran).toEqual([
    ["due", 1],
    ["retire", 3.5],
  ]);
});

test("each turn's declarations reach the host with the turn that declared them, and its frames reach the subscribers", async () => {
  const wake = 9 as Instant;
  const frame: PushedFrame = {
    session: S,
    bar: {} as never,
    answers: { resp: "r", statusline: "s" },
  };
  const { host, declared, framed } = recordingHost(async (kind) =>
    kind === "due"
      ? {
          kind: "threw",
          failure: failureOf(new Error("a feed broke")),
          effects: [],
          record: [],
          subscriptions: { ...NONE, wake },
          frames: [frame],
        }
      : answered(),
  );
  await host.answer((at) => ({
    kind: "event",
    at: (at + 5) as Instant,
    event: { kind: "due" },
  }));
  await host.ask({ kind: "reload-every", since: 0 });
  expect(declared).toEqual([
    {
      subscriptions: { ...NONE, wake },
      due: { at: 5, failure: expect.objectContaining({ kind: "threw" }) },
    },
    { subscriptions: NONE, due: null },
  ]);
  expect(framed).toEqual([frame]);
});

test("once the close has begun, no turn's declarations or frames are taken", async () => {
  const { host, declared, framed } = recordingHost(
    async () =>
      answered({
        subscriptions: { ...NONE, wake: 1 as Instant },
        frames: [
          {
            session: S,
            bar: {} as never,
            answers: { resp: "r", statusline: "s" },
          },
        ],
      }),
    { closing: () => true },
  );
  await host.answer((at) => ({ kind: "event", at, event: { kind: "due" } }));
  await host.ask({ kind: "reload-every", since: 0 });
  expect(declared).toEqual([]);
  expect(framed).toEqual([]);
});
