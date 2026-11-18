// The host's one path to a renderer (src/daemon/renderer-host.ts): an
// inspect is handed back the reading its turn reported or rejects, and a
// close step rejects with its turn's failure; a start heads the mailbox; every
// input carries the slot's readings; and an output is taken whole, a taker's
// throw failing no turn that answered.

import { rendererHost } from "../../src/daemon/renderer-host";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import {
  failureOf,
  type Failure,
} from "../../src/daemon/foundations/verb-error";
import type {
  Effect,
  Reading,
  RendererOutput,
  Subscriptions,
} from "../../src/renderer-interface/interface";
import type { Monotonic } from "../../src/time";
import type { Tick } from "../../src/utils/instant";
import { eventRenderer, hostHeld, NO_ACTS } from "../helpers/renderers";
import type { Renderer } from "../../src/renderer-interface/interface";

// A renderer held as the host holds it, its turns taking no time.
const held = (renderer: Renderer) => hostHeld(renderer, () => 0);

const NONE: Subscriptions = {
  sources: {},
  lanes: {},
  configs: [],
  storage: { folders: [], loads: 0 },
  wake: null,
};

// A clock that reads `wall` and `mono` as they stand, and sets no timer: no
// output here declares a wake.
const clockAt = (read: { wall: number; mono: number }) => ({
  now: () => read.wall,
  monotonic: () => read.mono as Monotonic,
  after: (): (() => void) => {
    throw new Error("this rig sets no timer");
  },
});

// A stats reading, as an inspect of the stats reports one.
const STATS: Reading = { kind: "stats", stats: { framesDrawn: 3 } as never };

// A turn's end, without the subscriptions and stored writes every turn
// answers with.
type Ended =
  | { readonly kind: "answered"; readonly effects: readonly Effect[] }
  | { readonly kind: "threw"; readonly failure: Failure };

// A host over a renderer that answers every turn with `output`; `said`
// settles with the first line the host logs, and `unheard` holds what it
// said no bar would.
function hostOver(output: Ended) {
  let say: (line: string) => void = () => {};
  const said = new Promise<string>((resolve) => (say = resolve));
  const taken: Subscriptions[] = [];
  const unheard: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      eventRenderer(
        async (): Promise<RendererOutput> => ({
          ...(output.kind === "answered" ? output : { ...output, effects: [] }),
          subscriptions: NONE,
          stored: [],
          logged: [],
          record: [],
          frames: [],
        }),
      ),
    ),
    (level, line) => say(`${level} ${line}`),
    {
      subscribed: (subscriptions) => void taken.push(subscriptions),
      frames: () => {},
      stored: () => {},
      writableSettings: () => {
        throw new Error("this rig lands no change");
      },
      recorded: () => {},
      holding: () => {
        throw new Error("this rig holds no session");
      },
    },
    { ...NO_ACTS, unheard: (text) => void unheard.push(text) },
  );
  return { host, said, taken, unheard };
}

test("an inspect is handed the reading its turn reported, and its subscriptions are taken", async () => {
  const { host, taken } = hostOver({
    kind: "answered",
    effects: [{ kind: "report", reading: STATS }],
  });
  expect(await host.inspect({ kind: "stats" })).toEqual(STATS);
  expect(taken).toEqual([NONE]);
});

test("an inspect answered with another kind's report, or none, rejects naming both", async () => {
  const { host } = hostOver({
    kind: "answered",
    effects: [{ kind: "report", reading: STATS }],
  });
  await expect(
    host.inspect({ kind: "debug", what: { kind: "all" } as never }),
  ).rejects.toThrow("renderer main answered inspect debug with a stats report");
  const none = hostOver({ kind: "answered", effects: [] });
  await expect(none.host.inspect({ kind: "stats" })).rejects.toThrow(
    "renderer main answered inspect stats with no report",
  );
});

test("an inspect whose turn threw rejects with the renderer's failure and the turn's time", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("the view broke")),
  });
  await expect(host.inspect({ kind: "stats" })).rejects.toThrow(
    /renderer main inspect stats threw: .*the view broke/,
  );
  await expect(host.inspect({ kind: "stats" })).rejects.toMatchObject({
    failure: { detail: expect.stringMatching(/ took=\d+ms: /) },
  });
});

test("a close step whose turn threw rejects, naming the step", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("no such session")),
  });
  await expect(host.closeStep("close")).rejects.toThrow(
    /renderer main close step close threw: .*no such session/,
  );
});

test("a report from a turn that is no inspect is said, as no bar would show it", async () => {
  const { host, said, unheard } = hostOver({
    kind: "answered",
    effects: [{ kind: "report", reading: STATS }],
  });
  await host.closeStep("closing");
  expect(await said).toBe(
    "error renderer main: a closing turn returned a report",
  );
  expect(unheard).toEqual(["renderer main: a closing turn returned a report"]);
});

// Every promise chain a turn starts settles on microtasks alone: these
// renderers answer at once.
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const answered = (): RendererOutput => ({
  kind: "answered",
  stored: [],
  logged: [],
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
      eventRenderer(async (input) => {
        heard.push(input.event.kind);
        if (input.event.kind === "closing") await opened;
        return answered();
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const asked = host.closeStep("closing");
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
  expect(heard).toEqual(["closing", "start", "retire"]);
});

test("every turn's record reaches `recorded`, whatever input it took and however it was asked", async () => {
  const records: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      eventRenderer(async (input) => ({
        ...answered(),
        record: [["took", input.event.kind]],
      })),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
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
      eventRenderer(async (input) => {
        readings.push({ at: input.at, tick: input.tick });
        if (input.event.kind === "due") await opened;
        return answered();
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
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
  const frames: number[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held(
      eventRenderer(async () => ({
        ...answered(),
        frames: [
          {
            session: "s" as never,
            bar: { rows: [] } as never,
            answers: { resp: "r", statusline: "s" },
          },
        ],
      })),
    ),
    () => {},
    {
      subscribed: () => {
        throw new Error("the collector broke");
      },
      frames: (taken) => void frames.push(taken.length),
      stored: () => {},
      writableSettings: () => [],
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
  expect(frames).toEqual([1]);
  expect(unheard).toEqual([
    expect.stringMatching(
      /^renderer main's subscriptions could not be taken: .*the collector broke/,
    ),
  ]);
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
      eventRenderer(async (input) => {
        heard.push(input.event.kind);
        return {
          ...answered(),
          subscriptions: {
            ...NONE,
            wake: input.event.kind === "due" ? null : (1 as Tick),
          },
        };
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
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
      eventRenderer(async (input) => ({
        ...answered(),
        effects:
          input.event.kind === "due"
            ? [{ kind: "copy", id: 1 as never, session: null, text: "x" }]
            : [],
        subscriptions: { ...NONE, wake: (read.mono / 1000 + 1) as Tick },
      })),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
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

test("a `due` waits behind every input that arrives while it waits, so a click that has arrived lands before an idle close", async () => {
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
      eventRenderer(async (input) => {
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
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      writableSettings: () => [],
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
  // Arrives after the `due` joined the mailbox, as a click would.
  const behind = retire("click");
  open();
  await Promise.all([long, behind]);
  await settled();
  expect(heard).toEqual(["retire:first", "retire:long", "retire:click", "due"]);
});
