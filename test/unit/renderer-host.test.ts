// The host's one path to a renderer (src/daemon/renderer-host.ts): `ask` hands
// back the reply of the push's own kind or rejects, and `tell` says a failure
// on the log, since nothing awaits it; a start heads the mailbox; every input
// carries the slot's readings; and an output is taken whole, a taker's throw
// failing no turn that answered.

import { rendererHost } from "../../src/daemon/renderer-host";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { FOREGROUND_BURST } from "../../src/utils/keyed-serial-queue";
import {
  failureOf,
  type Failure,
} from "../../src/daemon/foundations/verb-error";
import {
  rendererOf,
  type AdapterOutput,
  type PushedFrame,
  type RendererOutput,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { AdapterReply } from "../../src/renderer-interface/adapter";
import type { Monotonic } from "../../src/time";
import type { Tick } from "../../src/utils/instant";
import { hostHeld, NO_ACTS, pushRenderer } from "../helpers/renderers";
import type { Renderer } from "../../src/renderer-interface/interface";

// A renderer held as the host holds it, its turns taking no time.
const held = (renderer: Renderer) => hostHeld(renderer, () => 0);

const NONE: Subscriptions = { sources: {}, lanes: {}, configs: [], wake: null };

// A clock that reads `wall` and `mono` as they stand, and sets no timer: no
// output here declares a wake.
const clockAt = (read: { wall: number; mono: number }) => ({
  now: () => read.wall,
  monotonic: () => read.mono as Monotonic,
  after: (): (() => void) => {
    throw new Error("this rig sets no timer");
  },
});

// A host over a renderer that answers every push with `output`; `said`
// settles with the first line it logs.
// A push's end, without the subscriptions and stored writes every push
// answers with.
type Ended =
  | { readonly kind: "replied"; readonly reply: AdapterReply }
  | { readonly kind: "threw"; readonly failure: Failure };

function hostOver(output: Ended) {
  let say: (line: string) => void = () => {};
  const said = new Promise<string>((resolve) => (say = resolve));
  const taken: Subscriptions[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      pushRenderer(
        async (): Promise<AdapterOutput> => ({
          ...output,
          subscriptions: NONE,
          stored: [],
        }),
      ),
    ),
    (level, line) => say(`${level} ${line}`),
    {
      subscribed: (subscriptions) => void taken.push(subscriptions),
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => {
        throw new Error("a push holds no session");
      },
    },
    NO_ACTS,
  );
  return { host, said, taken };
}

test("an ask is handed the reply of its push's own kind, and its subscriptions are taken", async () => {
  const { host, taken } = hostOver({
    kind: "replied",
    reply: { kind: "close-journal" },
  });
  expect(await host.ask({ kind: "close-journal" })).toEqual({
    kind: "close-journal",
  });
  expect(taken).toEqual([NONE]);
});

test("an ask answered with another push's reply rejects, naming both", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "close-views" },
  });
  await expect(host.ask({ kind: "close-journal" })).rejects.toThrow(
    "renderer main answered push close-journal with a close-views reply",
  );
});

test("an ask whose push threw rejects with the renderer's failure and the turn's time", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("the view broke")),
  });
  await expect(host.ask({ kind: "stats" })).rejects.toThrow(
    /renderer main push stats threw: .*the view broke/,
  );
  await expect(host.ask({ kind: "stats" })).rejects.toMatchObject({
    failure: { detail: expect.stringMatching(/ took=\d+ms: /) },
  });
});

test("a tell that fails is said on the log, and nothing rejects", async () => {
  const { host, said } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("no such session")),
  });
  expect(host.tell({ kind: "close-views" })).toBe(undefined);
  expect(await said).toMatch(
    /^error renderer main push close-views threw.*: .*no such session/,
  );
});

// Every promise chain a turn starts settles on microtasks alone: these
// renderers answer at once.
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const answered = (): RendererOutput => ({
  kind: "answered",
  stored: [],
  effects: [],
  subscriptions: NONE,
  record: [],
  frames: [],
});

test("a start heads the mailbox, behind only the slot in progress", async () => {
  const heard: string[] = [];
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async (input) => {
          heard.push(input.event.kind);
          return answered();
        },
        adapter: async (input) => {
          heard.push(`push:${input.push.kind}`);
          await opened;
          return {
            kind: "replied",
            stored: [],
            reply: { kind: "close-journal" },
            subscriptions: NONE,
          };
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const asked = host.ask({ kind: "close-journal" });
  const waiting = host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session: "s" as never } }),
    [],
  );
  const started = host.start(
    () => ({
      kind: "event",
      event: { kind: "start", viewers: {}, sessions: [] },
    }),
    [],
  );
  open();
  await Promise.all([asked, waiting, started]);
  expect(heard).toEqual(["push:close-journal", "start", "retire"]);
});

test("every turn's record reaches `recorded`, whatever input it took and however it was asked", async () => {
  const records: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async (input) => ({
          ...answered(),
          record: [["took", input.event.kind]],
        }),
        adapter: async () => {
          throw new Error("this rig sends no push");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: (record) =>
        void records.push(record.map(([k, v]) => `${k}=${v}`).join(" ")),
      holding: () => () => {},
    },
    NO_ACTS,
  );
  await host.start(
    () => ({
      kind: "event",
      event: { kind: "start", viewers: {}, sessions: [] },
    }),
    [],
  );
  await host.answer(() => ({
    kind: "event",
    event: { kind: "retire", session: "s" as never },
  }));
  await host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session: "t" as never } }),
    [],
  );
  expect(records).toEqual(["took=start", "took=retire", "took=retire"]);
});

test("an input carries the clock's two readings as its slot comes, never as it was asked", async () => {
  const read = { wall: 100_000, mono: 5000 };
  const readings: Array<{ at: number; tick: number }> = [];
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt(read),
    held(
      rendererOf({
        event: async (input) => {
          readings.push({ at: input.at, tick: input.tick });
          if (input.event.kind === "due") await opened;
          return answered();
        },
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const first = host.deliver(
    () => ({ kind: "event", event: { kind: "due" } }),
    [],
  );
  // Asked while the first holds the mailbox, at the clock as it stands.
  const second = host.deliver(
    () => ({ kind: "event", event: { kind: "due" } }),
    [],
  );
  await Promise.resolve();
  read.wall = 107_000;
  read.mono = 12_000;
  open();
  await Promise.all([first, second]);
  expect(readings).toEqual([
    { at: 100, tick: 5 },
    { at: 107, tick: 12 },
  ]);
});

test("a taker that throws fails no turn that answered: it is said on every bar, and the frames are still taken", async () => {
  const unheard: string[] = [];
  const frames: PushedFrame[] = [];
  const pushed: PushedFrame = {
    session: sessionIdOf("s"),
    frame: {
      kind: "drawn",
      bar: {
        depth: "none",
        rows: [{ kind: "diagnostic", runs: [{ text: "the bar" }] }],
        nextChange: null,
        motion: "still",
        pending: [],
      },
      handoff: null,
    },
  };
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async () => ({
          ...answered(),
          frames: [pushed],
        }),
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {
        throw new Error("the collector broke");
      },
      frames: (taken) => void frames.push(...taken),
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    { ...NO_ACTS, unheard: (text) => void unheard.push(text) },
  );
  const turn = await host.answer(() => ({
    kind: "event",
    event: { kind: "due" },
  }));
  expect(turn.kind).toBe("answered");
  expect(frames).toEqual([pushed]);
  expect(unheard).toEqual([
    expect.stringMatching(
      /^renderer main's subscriptions could not be taken: .*the collector broke/,
    ),
  ]);
});

test("a failed record and a rejected act leave the answer and both effect acknowledgements intact", async () => {
  const heard: number[] = [];
  const performed: string[] = [];
  const unheard: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async ({ event }) => {
          if (event.kind === "effect-done") heard.push(event.of);
          return {
            ...answered(),
            effects:
              event.kind === "due"
                ? [
                    {
                      kind: "copy",
                      id: 1 as never,
                      session: null,
                      text: "first",
                    },
                    {
                      kind: "copy",
                      id: 2 as never,
                      session: null,
                      text: "second",
                    },
                  ]
                : [],
          };
        },
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {
        throw new Error("record sink failed");
      },
      holding: () => () => {},
    },
    {
      ...NO_ACTS,
      unheard: (text) => void unheard.push(text),
      perform: async (act) => {
        if (act.kind !== "copy") throw new Error("unexpected act");
        performed.push(act.text);
        if (act.text === "first") throw new Error("copy failed");
        return { kind: "ok" };
      },
    },
  );
  const turn = await host.answer(() => ({
    kind: "event",
    event: { kind: "due" },
  }));
  expect(turn.kind).toBe("answered");
  expect(turn.settled).toEqual([
    { kind: "failed", reason: expect.stringContaining("copy failed") },
    { kind: "ok" },
  ]);
  expect(performed).toEqual(["first", "second"]);
  expect(heard).toEqual([1, 2]);
  expect(unheard).toContainEqual(expect.stringContaining("record sink failed"));
});

test("a config named by a push reaches the renderer before the next queued event", async () => {
  const origin = {
    projectDir: "/p",
    cwd: "/p",
    target: { source: "search" as const },
  };
  const subscriptions = { ...NONE, configs: [origin] };
  const seen: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async ({ event }) => {
          seen.push(event.kind);
          return { ...answered(), subscriptions };
        },
        adapter: async () => {
          seen.push("push");
          return {
            kind: "replied",
            reply: { kind: "close-journal" },
            subscriptions,
            stored: [],
          };
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    {
      ...NO_ACTS,
      configs: {
        ...NO_ACTS.configs,
        follow: () => {},
        snapshotOf: () => ({
          chain: [],
          repo: null,
          plugins: [],
          strays: [],
          checkout: { root: origin.cwd, git: false },
          notices: [],
          watch: null,
        }),
      },
    },
  );
  const push = host.ask({ kind: "close-journal" });
  const next = host.answer(() => ({ kind: "event", event: { kind: "due" } }));
  await Promise.all([push, next]);
  expect(seen).toEqual(["push", "config", "due"]);
});

test("a failed start's input does not keep the previous renderer's served config", async () => {
  const origin = {
    projectDir: "/p",
    cwd: "/p",
    target: { source: "search" as const },
  };
  const read: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      rendererOf({
        event: async () => ({
          ...answered(),
          subscriptions: { ...NONE, configs: [origin] },
        }),
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    {
      ...NO_ACTS,
      configs: {
        ...NO_ACTS.configs,
        follow: () => {},
        snapshotOf: ({ cwd }) => {
          read.push(cwd);
          return null;
        },
      },
    },
  );
  const due = () => ({ kind: "event", event: { kind: "due" } }) as const;
  await host.answer(due);
  await host.answer(due);
  expect(read).toEqual(["/p"]);
  const start = await host.start(() => {
    throw new Error("start could not be made");
  }, []);
  expect(start.kind).toBe("threw");
  await host.answer(due);
  expect(read).toEqual(["/p", "/p"]);
});

test("a declared wake is handed in as a `due`, and none is made after the wake closes", async () => {
  const fire: Array<() => void> = [];
  const heard: string[] = [];
  const read = { wall: 0, mono: 0 };
  const host = rendererHost(
    MAIN_RENDERER,
    {
      ...clockAt(read),
      after: (_ms: number, run: () => void) => {
        fire.push(run);
        return () => {};
      },
    },
    held(
      rendererOf({
        event: async (input) => {
          heard.push(input.event.kind);
          return {
            ...answered(),
            subscriptions: {
              ...NONE,
              wake: input.event.kind === "due" ? null : (1 as Tick),
            },
          };
        },
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  await host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session: "s" as never } }),
    [],
  );
  expect(fire).toHaveLength(1);
  read.mono = 1000;
  fire[0]!();
  await settled();
  expect(heard).toEqual(["retire", "due"]);
  // Declared again, then closed: the timer that fires makes no `due`.
  await host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session: "s" as never } }),
    [],
  );
  host.closeWake();
  fire.at(-1)!();
  await settled();
  expect(heard).toEqual(["retire", "due", "retire"]);
});

test("the wake arms its next `due` once the renderer answered, while an act its `due` returned is still on its way", async () => {
  const fire: Array<() => void> = [];
  const read = { wall: 0, mono: 0 };
  let finish = (): void => {};
  const acted = new Promise<void>((resolve) => (finish = resolve));
  const host = rendererHost(
    MAIN_RENDERER,
    {
      ...clockAt(read),
      after: (_ms: number, run: () => void) => {
        fire.push(run);
        return () => {};
      },
    },
    held(
      rendererOf({
        event: async (input) => ({
          ...answered(),
          effects:
            input.event.kind === "due"
              ? [{ kind: "copy", id: 1 as never, session: null, text: "x" }]
              : [],
          subscriptions: { ...NONE, wake: (read.mono / 1000 + 1) as Tick },
        }),
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    {
      ...NO_ACTS,
      perform: async () => {
        await acted;
        return { kind: "ok" };
      },
    },
  );
  await host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session: "s" as never } }),
    [],
  );
  read.mono = 1000;
  fire[0]!();
  await settled();
  // The copy has not ended, and the next `due` is armed all the same.
  expect(fire).toHaveLength(2);
  finish();
  await settled();
});

test("a scheduled turn gives a short burst of queued input its turn first", async () => {
  const fire: Array<() => void> = [];
  const heard: string[] = [];
  const read = { wall: 0, mono: 0 };
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const named = (event: { kind: string; session?: unknown }): string =>
    event.kind === "retire" ? `retire:${String(event.session)}` : event.kind;
  const host = rendererHost(
    MAIN_RENDERER,
    {
      ...clockAt(read),
      after: (_ms: number, run: () => void) => {
        fire.push(run);
        return () => {};
      },
    },
    held(
      rendererOf({
        event: async (input) => {
          heard.push(named(input.event));
          // The long turn the `due` waits behind.
          if (named(input.event) === "retire:long") await opened;
          return {
            ...answered(),
            subscriptions: {
              ...NONE,
              wake: input.event.kind === "due" ? null : (1 as Tick),
            },
          };
        },
        adapter: async () => {
          throw new Error("no push here");
        },
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const retire = (session: string) =>
    host.deliver(
      () => ({
        kind: "event",
        event: { kind: "retire", session: session as never },
      }),
      [],
    );
  await retire("first");
  const long = retire("long");
  await settled();
  read.mono = 1000;
  fire[0]!();
  // Arrives after the `due` joined the mailbox and keeps its ordinary slot.
  const behind = retire("next");
  open();
  await Promise.all([long, behind]);
  await settled();
  expect(heard).toEqual(["retire:first", "retire:long", "retire:next", "due"]);
});


test("a scheduled frame is published while ordinary renderer turns replenish the mailbox", async () => {
  const fire: Array<() => void> = [];
  const read = { wall: 0, mono: 0 };
  let open = (): void => {};
  const heldTurn = new Promise<void>((resolve) => (open = resolve));
  let end = (): void => {};
  const done = new Promise<void>((resolve) => (end = resolve));
  let traffic = 0;
  const receivedAt: number[] = [];
  const session = sessionIdOf("frame-viewer");
  const host = rendererHost(
    MAIN_RENDERER,
    {
      ...clockAt(read),
      after: (_ms, run) => {
        fire.push(run);
        return () => {};
      },
    },
    held(rendererOf({
      event: async ({ event }) => {
        if (event.kind === "due") return {
          ...answered(),
          frames: [{
            session,
            frame: {
              kind: "drawn",
              bar: {
                depth: "none",
                rows: [{ kind: "bar", runs: [{ text: "frame" }] }],
                nextChange: null,
                motion: "still",
                pending: [],
              },
              handoff: null,
            },
          }],
        };
        if (event.kind === "retire") await heldTurn;
        if (event.kind === "viewers") {
          traffic++;
          if (traffic < 3 * FOREGROUND_BURST) void submit();
          else end();
        }
        return {
          ...answered(),
          subscriptions: { ...NONE, wake: traffic === 0 ? (1 as Tick) : null },
        };
      },
      adapter: async () => { throw new Error("no push here"); },
    })),
    () => {},
    {
      subscribed: () => {},
      frames: (frames) => {
        if (frames.some((frame) => frame.session === session)) receivedAt.push(traffic);
      },
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const submit = () => host.deliver(
    () => ({ kind: "event", event: { kind: "viewers", viewers: {} } }),
    [],
  );
  await host.start(() => ({ kind: "event", event: { kind: "start", viewers: {}, sessions: [] } }), []);
  const blocked = host.deliver(() => ({ kind: "event", event: { kind: "retire", session } }), []);
  read.mono = 1000;
  fire[0]!();
  const first = submit();
  open();
  await Promise.all([blocked, first, done]);
  expect(receivedAt).toEqual([FOREGROUND_BURST]);
  expect(traffic).toBe(3 * FOREGROUND_BURST);
});
