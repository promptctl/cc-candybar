// The host takes every renderer turn in its mailbox. Commands receive their
// own replies, and a taker's failure cannot undo a completed turn.

import { rendererHost } from "../../src/daemon/renderer-host";
import type { HostAct } from "../../src/daemon/acts";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { FOREGROUND_BURST } from "../../src/utils/keyed-serial-queue";
import {
  failureOf,
  type Failure,
} from "../../src/daemon/foundations/verb-error";
import {
  type CommandReply,
  type Effect,
  type EffectId,
  type Event,
  type PushedFrame,
  type RendererOutput,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { StoreWrite } from "../../src/renderer-interface/stored-state";
import type { Monotonic } from "../../src/time";
import { instantOf, type Tick } from "../../src/utils/instant";
import { fieldsOf } from "../../src/utils/logfmt";
import { hostHeld, NO_ACTS, NO_CONFIGS } from "../helpers/renderers";
import type { Renderer } from "../../src/renderer-interface/interface";
import { ABSENT } from "../../src/utils/outcome";
import { digestOf } from "../../src/utils/plain";
import { heardRequest } from "../helpers/click";
import { daemonFactsOf } from "../helpers/daemon-facts";
import { recordedInto } from "../helpers/work-threw";

// A renderer held as the host holds it, its turns taking no time.
const held = (renderer: Renderer) => hostHeld(renderer, () => 0);

const NONE: Subscriptions = {
  sources: {},
  lanes: {},
  managedFolders: [],
  configSelections: [],
  configs: [],
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

type Ended =
  | { readonly kind: "answered"; readonly reply?: CommandReply }
  | { readonly kind: "threw"; readonly failure: Failure };

function hostOver(
  output: Ended &
    Partial<
      Pick<RendererOutput, "diagnostics" | "effects" | "frames" | "stored">
    >,
  log?: (line: string) => void,
) {
  const taken: Subscriptions[] = [];
  const logged: string[] = [];
  const unheard: string[] = [];
  const framed: PushedFrame[] = [];
  const stored: StoreWrite[] = [];
  const acted: HostAct[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) =>
        event.kind === "effect-done"
          ? answered()
          : { ...answered(), ...output },
    }),
    (_level, line) => {
      log?.(line);
      logged.push(line);
    },
    {
      subscribed: (subscriptions) => void taken.push(subscriptions),
      frames: (frames) => void framed.push(...frames),
      stored: (writes) => void stored.push(...writes),
      recorded: () => {},
      holding: () => {
        throw new Error("a command holds no session");
      },
    },
    {
      ...NO_ACTS,
      unheard: (line) => void unheard.push(line),
      perform: async (effect) => {
        acted.push(effect);
        return { kind: "ok" };
      },
    },
  );
  return { host, taken, logged, unheard, framed, stored, acted };
}

const commandSession = sessionIdOf("command-session");
const offeredFrame: PushedFrame = {
  session: commandSession,
  frame: { kind: "failed", message: "an unrelated frame" },
};
const offeredEffect: Effect = {
  kind: "copy",
  session: null,
  id: 1 as EffectId,
  text: "an unrelated effect",
};
const offeredWrite: StoreWrite = {
  store: "session-state",
  key: commandSession,
  value: { menu: "closed" },
};

test("a command takes its own reply, writes and subscriptions", async () => {
  const { host, taken, stored } = hostOver({
    kind: "answered",
    reply: { kind: "close-journal" },
    stored: [offeredWrite],
  });
  expect(await host.command({ kind: "close-journal" })).toEqual({
    kind: "close-journal",
  });
  expect(taken).toEqual([NONE]);
  expect(stored).toEqual([offeredWrite]);
});

test("a command with another command's reply rejects, naming both", async () => {
  const { host, taken, framed, stored, acted, logged } = hostOver({
    kind: "answered",
    reply: { kind: "close-views" },
    frames: [offeredFrame],
    effects: [offeredEffect],
    stored: [offeredWrite],
    diagnostics: [
      { level: "warn", line: "the command returned the wrong reply" },
    ],
  });
  await expect(host.command({ kind: "close-journal" })).rejects.toThrow(
    "renderer main command close-journal returned a close-views reply",
  );
  expect({ taken, framed, stored, acted }).toEqual({
    taken: [],
    framed: [],
    stored: [],
    acted: [],
  });
  expect(logged).toContain("the command returned the wrong reply");
});

test("a matching inspection cannot publish a frame or perform an effect", async () => {
  const { host, taken, framed, acted } = hostOver({
    kind: "answered",
    reply: { kind: "debug", snapshot: { what: "config", config: null } },
    frames: [offeredFrame],
    effects: [offeredEffect],
  });
  await expect(host.command({ kind: "debug", what: "config" })).rejects.toThrow(
    "renderer main command debug returned a frame or effect",
  );
  expect({ taken, framed, acted }).toEqual({
    taken: [],
    framed: [],
    acted: [],
  });
});

test("truncated inspection results are refused before their stores or subscriptions land", async () => {
  const vars = hostOver({
    kind: "answered",
    // @ts-expect-error A same-version renderer sent a truncated JSON result.
    reply: { kind: "debug", snapshot: { what: "vars" } },
    stored: [offeredWrite],
  });
  await expect(
    vars.host.command({ kind: "debug", what: "vars" }),
  ).rejects.toThrow("returned invalid vars snapshot");
  expect([vars.stored, vars.taken]).toEqual([[], []]);

  const stats = hostOver({
    kind: "answered",
    // @ts-expect-error A same-version renderer omitted the snapshot fields.
    reply: { kind: "stats", stats: {} },
    stored: [offeredWrite],
  });
  await expect(stats.host.command({ kind: "stats" })).rejects.toThrow(
    "returned invalid stats snapshot",
  );
  expect([stats.stored, stats.taken]).toEqual([[], []]);
});

test("an answered command with no reply rejects", async () => {
  const { host } = hostOver({ kind: "answered" });
  await expect(host.command({ kind: "close-journal" })).rejects.toThrow(
    "renderer main command close-journal returned no reply",
  );
});

test("a reply on an ordinary turn is reported and its declaration still lands", async () => {
  const { host, logged, taken } = hostOver({
    kind: "answered",
    reply: { kind: "close-journal" },
  });
  expect(
    await host.answer(() => ({ kind: "event", event: { kind: "due" } })),
  ).toMatchObject({
    kind: "answered",
  });
  expect(taken).toEqual([NONE]);
  expect(logged).toEqual([
    "renderer main returned an unasked command reply to due",
  ]);
});

test("a failed diagnostic sink cannot discard a completed notification's writes", async () => {
  const { host, taken, stored, unheard } = hostOver(
    {
      kind: "answered",
      reply: { kind: "close-journal" },
      stored: [offeredWrite],
    },
    () => {
      throw new Error("log unavailable");
    },
  );
  const turn = await host.answer(() => ({
    kind: "event",
    event: { kind: "due" },
  }));
  expect(turn.kind).toBe("answered");
  expect(taken).toEqual([NONE]);
  expect(stored).toEqual([offeredWrite]);
  expect(unheard).toEqual([
    expect.stringMatching(/unasked command reply to due: .*log unavailable/),
  ]);
});

test("a failed command preserves the renderer's failure and turn time", async () => {
  const failure = failureOf(new Error("the view broke"));
  const { host, taken, logged, framed, stored, acted } = hostOver({
    kind: "threw",
    failure,
    diagnostics: [{ level: "warn", line: "first write completed" }],
    frames: [offeredFrame],
    effects: [offeredEffect],
    stored: [offeredWrite],
  });
  const reported = await host.command({ kind: "stats" }).then(() => {
    throw new Error("expected this command to fail");
  }, failureOf);
  expect(reported.message).toBe(
    "renderer main command stats threw: the view broke",
  );
  expect(fieldsOf(reported.detail)).toEqual(
    new Map([
      ["took", "0ms"],
      ["error", failure.detail],
    ]),
  );
  expect(logged).toContain("first write completed");
  expect({ taken, framed, stored, acted }).toEqual({
    taken: [NONE],
    framed: [],
    stored: [offeredWrite],
    acted: [],
  });
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
  wake: null,
  record: [],
  frames: [],
});

test("a start heads the mailbox, behind only the slot in progress", async () => {
  const heard: string[] = [];
  const followed = jest.fn(NO_CONFIGS.follow);
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) => {
        heard.push(event.kind);
        if (event.kind !== "close-journal") return answered();
        await opened;
        return { ...answered(), reply: { kind: "close-journal" } };
      },
    }),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    { ...NO_ACTS, configs: () => ({ ...NO_CONFIGS, follow: followed }) },
  );
  const asked = host.command({ kind: "close-journal" });
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
  expect(heard).toEqual(["close-journal", "start", "retire"]);
  expect(followed).not.toHaveBeenCalled();
});

test("every turn's record reaches `recorded`, whatever input it took and however it was asked", async () => {
  const records: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async (input) => ({
        ...answered(),
        record: [["took", input.event.kind]],
      }),
    }),
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
    held({
      answer: async (input) => {
        readings.push({ at: input.at, tick: input.tick });
        if (input.event.kind === "due") await opened;
        return answered();
      },
    }),
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
      receipt: 1 as EffectId,
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
    held({
      answer: async () => ({
        ...answered(),
        frames: [pushed],
      }),
    }),
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
    {
      ...NO_ACTS,
      unheard: (text) => void unheard.push(text),
      threw: recordedInto(unheard),
    },
  );
  const turn = await host.answer(() => ({
    kind: "event",
    event: { kind: "due" },
  }));
  expect(turn.kind).toBe("answered");
  expect(frames).toEqual([pushed]);
  expect(unheard).toEqual([
    expect.stringMatching(
      /^renderer work not taken renderer=main work=subscriptions failed=.*the collector broke/,
    ),
  ]);
});

test("a delayed presentation receipt belongs to the worker that drew the frame", async () => {
  const session = sessionIdOf("pane");
  const receipt = 1 as EffectId;
  const pushed: PushedFrame = {
    session,
    frame: {
      kind: "drawn",
      receipt,
      bar: {
        depth: "none",
        rows: [],
        nextChange: null,
        motion: "still",
        pending: [],
      },
      handoff: null,
    },
  };
  const writes: Array<(ok: boolean) => void> = [];
  const confirmed: number[] = [];
  let worker = 0;
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) => {
        if (event.kind === "start") worker++;
        if (event.kind === "due") return { ...answered(), frames: [pushed] };
        if (event.kind === "effect-done") {
          expect(event.of).toBe(receipt);
          confirmed.push(worker);
        }
        return answered();
      },
    }),
    () => {},
    {
      subscribed: () => {},
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
      frames: (frames, settle) => {
        for (const frame of frames) writes.push((ok) => settle(frame, ok));
      },
    },
    NO_ACTS,
  );
  for (let n = 0; n < 2; n++) {
    await host.start(
      () => ({
        kind: "event",
        event: { kind: "start", viewers: {}, sessions: [] },
      }),
      [],
    );
    await host.answer(() => ({ kind: "event", event: { kind: "due" } }));
  }
  expect(writes).toHaveLength(2);
  writes[0]!(true);
  writes[1]!(true);
  await host.answer(() => ({
    kind: "event",
    event: { kind: "viewers", viewers: {} },
  }));
  expect(confirmed).toEqual([2]);
});

test("a failed record and a rejected act leave the answer and both effect acknowledgements intact", async () => {
  const heard: number[] = [];
  const performed: string[] = [];
  const unheard: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) => {
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
    }),
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
      threw: recordedInto(unheard),
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

test("a config named by a command reaches the renderer before the next queued event", async () => {
  const origin = {
    projectDir: "/p",
    cwd: "/p",
    target: { source: "search" as const },
  };
  const subscriptions = { ...NONE, configs: [origin] };
  const seen: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let named = false;
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) => {
        seen.push(event.kind);
        if (event.kind === "due" && !named) {
          entered.resolve();
          await release.promise;
        }
        if (event.kind === "close-journal") named = true;
        return {
          ...answered(),
          subscriptions: named ? subscriptions : NONE,
          ...(event.kind === "close-journal"
            ? { reply: { kind: "close-journal" as const } }
            : {}),
        };
      },
    }),
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
      configs: () => ({
        ...NO_CONFIGS,
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
      }),
    },
  );
  const due = () =>
    host.answer(() => ({ kind: "event", event: { kind: "due" } }));
  const first = due();
  await entered.promise;
  const command = host.command({ kind: "close-journal" });
  const next = due();
  expect(seen).toEqual(["due"]);
  release.resolve();
  await Promise.all([first, command, next]);
  expect(seen).toEqual(["due", "close-journal", "config", "due"]);
});

test("failed replacement starts leave the accepted declaration until a complete successor responds", async () => {
  const origin = {
    projectDir: "/p",
    cwd: "/p",
    target: { source: "search" as const },
  };
  const config = {
    chain: [],
    repo: null,
    plugins: [],
    strays: [],
    checkout: { root: origin.cwd, git: false },
    notices: [],
    watch: null,
  };
  const context = heardRequest("added", "/added");
  const added = context.requested;
  const addedConfig: ConfigSnapshot = {
    ...config,
    checkout: { root: added.cwd, git: false },
  };
  const absent = { ...ABSENT, at: instantOf(new Date(0)) };
  const worldState = {
    v: FACTS_VERSION,
    session: context.hookData.session_id,
    seq: 1,
    builtins: {
      session: absent,
      today: absent,
      speed: absent,
      context: absent,
      metrics: absent,
      activity: absent,
      cache: absent,
      autocompact: absent,
      git: absent,
      pr: absent,
      tmux: absent,
      hostName: absent,
      hostUser: absent,
    },
    sources: {},
    runs: {},
    env: {},
    daemon: daemonFactsOf(),
    diagnostics: [],
  };
  const previous = { ...NONE, sources: { kept: [] }, configs: [origin] };
  const selectedPlan = {
    ...previous,
    configSelections: [{ origin, digest: digestOf(config) }],
  };
  const taken: Subscriptions[] = [];
  const heard: Event[] = [];
  const stored: StoreWrite[] = [];
  const recorded: string[] = [];
  const performed: string[] = [];
  const write: StoreWrite = {
    store: "session-state",
    key: sessionIdOf("kept"),
    value: { "open-menu": "before failing" },
  };
  const read: string[] = [];
  const discoveries: string[] = [];
  const followed: string[][] = [];
  const heldPaths = new Set<string>();
  let attempted:
    | "make"
    | "follow"
    | "prepare"
    | "transport"
    | "renderer"
    | "success" = "success";
  let selected = false;
  let keepsDemand = true;
  const host = rendererHost(
    MAIN_RENDERER,
    clockAt({ wall: 0, mono: 0 }),
    held({
      answer: async ({ event }) => {
        heard.push(event);
        if (event.kind === "start") {
          if (attempted === "transport") throw new Error("lost transport");
          if (attempted === "renderer")
            return {
              ...answered(),
              kind: "threw",
              failure: failureOf(new Error("opening failed")),
              stored: [write],
              record: [["restoring", "failed after work"]],
              effects: [
                {
                  kind: "copy",
                  id: 1 as EffectId,
                  session: null,
                  text: "work completed",
                },
              ],
            };
          return {
            ...answered(),
            subscriptions: keepsDemand ? selectedPlan : NONE,
          };
        }
        if (event.kind === "effect-done") return answered();
        return {
          ...answered(),
          subscriptions:
            event.kind === "config" || selected ? selectedPlan : previous,
        };
      },
    }),
    () => {},
    {
      subscribed: (subscriptions) => void taken.push(subscriptions),
      frames: () => {},
      stored: (writes) => void stored.push(...writes),
      recorded: (record) =>
        void recorded.push(...record.map(([key, value]) => `${key}=${value}`)),
      holding: () => () => {},
    },
    {
      ...NO_ACTS,
      perform: async (act) => {
        if (act.kind !== "copy") throw new Error(`unexpected ${act.kind}`);
        performed.push(act.text);
        return { kind: "ok" };
      },
      configs: () => ({
        ...NO_CONFIGS,
        follow: (wanted) => {
          const paths = wanted.map(({ cwd }) => cwd);
          followed.push(paths);
          for (const cwd of paths) {
            if (!heldPaths.has(cwd)) discoveries.push(cwd);
            heldPaths.add(cwd);
          }
          if (attempted === "follow" && paths.includes(added.cwd))
            throw new Error("follow failed after acquisition");
          for (const cwd of heldPaths)
            if (!paths.includes(cwd)) heldPaths.delete(cwd);
        },
        retainedOf: (of) =>
          of.cwd === origin.cwd && selected ? "current" : undefined,
        selected: (entries, delivered) => {
          if (entries.length > 0) expect(delivered(origin)).toBe(config);
          selected = entries.length > 0;
        },
        snapshotOf: ({ cwd }) => {
          read.push(cwd);
          if (!heldPaths.has(cwd)) return null;
          if (cwd === added.cwd)
            return attempted === "prepare" ? null : addedConfig;
          return config;
        },
      }),
    },
  );
  const due = () => ({ kind: "event", event: { kind: "due" } }) as const;
  await host.answer(due);
  await host.answer(due);
  expect(read).toEqual(["/p"]);
  expect(taken).toEqual([previous]);
  const start = () =>
    host.start(() => {
      if (attempted === "make") throw new Error("start maker failed");
      return {
        kind: "event",
        event: {
          kind: "start",
          viewers: {},
          sessions: [{ context, worldState }],
        },
      };
    }, []);
  for (const [stage, reason] of [
    ["make", "start maker failed"],
    ["follow", "follow failed after acquisition"],
    ["prepare", "no config snapshot"],
    ["transport", "lost transport"],
  ] as const) {
    attempted = stage;
    expect(await start()).toMatchObject({
      kind: "threw",
      failure: { message: expect.stringContaining(reason) },
    });
    expect(heldPaths).toEqual(new Set([origin.cwd]));
    expect(selected).toBe(true);
    expect(await host.answer(due)).toMatchObject({ kind: "threw" });
    await expect(host.command({ kind: "stats" })).rejects.toThrow(reason);
  }
  expect(taken).toEqual([previous]);

  attempted = "renderer";
  expect(await start()).toMatchObject({
    kind: "threw",
    settled: [{ kind: "ok" }],
  });
  expect(stored).toEqual([write]);
  expect(recorded).toContain("restoring=failed after work");
  expect(performed).toEqual(["work completed"]);
  expect(heard.at(-1)).toMatchObject({
    kind: "effect-done",
    of: 1,
    outcome: { kind: "ok" },
  });
  expect(taken).toEqual([previous]);
  expect(heldPaths).toEqual(new Set([origin.cwd]));
  expect(selected).toBe(true);

  attempted = "success";
  expect(await start()).toMatchObject({ kind: "answered" });
  expect(heard.at(-1)).toMatchObject({
    kind: "start",
    configs: [
      { origin, config, retained: "current" },
      { origin: added, config: addedConfig },
    ],
  });
  expect(heard.map(({ kind }) => kind)).toEqual([
    "due",
    "config",
    "due",
    "start",
    "start",
    "effect-done",
    "start",
  ]);
  expect(discoveries.filter((key) => key === origin.cwd)).toEqual([origin.cwd]);
  expect(heldPaths).toEqual(new Set([origin.cwd]));
  expect(taken).toEqual([previous, selectedPlan]);

  keepsDemand = false;
  expect(await start()).toMatchObject({ kind: "answered" });
  expect(taken).toEqual([previous, selectedPlan, NONE]);
  expect(followed.at(-1)).toEqual([]);
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
    held({
      answer: async (input) => {
        heard.push(input.event.kind);
        return {
          ...answered(),
          wake: input.event.kind === "due" ? null : (1 as Tick),
        };
      },
    }),
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
    held({
      answer: async (input) => ({
        ...answered(),
        effects:
          input.event.kind === "due"
            ? [{ kind: "copy", id: 1 as never, session: null, text: "x" }]
            : [],
        wake: (read.mono / 1000 + 1) as Tick,
      }),
    }),
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
    held({
      answer: async (input) => {
        heard.push(named(input.event));
        // The long turn the `due` waits behind.
        if (named(input.event) === "retire:long") await opened;
        return {
          ...answered(),
          wake: input.event.kind === "due" ? null : (1 as Tick),
        };
      },
    }),
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
    held({
      answer: async ({ event }) => {
        if (event.kind === "due")
          return {
            ...answered(),
            frames: [
              {
                session,
                frame: {
                  kind: "drawn",
                  receipt: 1 as EffectId,
                  bar: {
                    depth: "none",
                    rows: [{ kind: "bar", runs: [{ text: "frame" }] }],
                    nextChange: null,
                    motion: "still",
                    pending: [],
                  },
                  handoff: null,
                },
              },
            ],
          };
        if (event.kind === "retire") await heldTurn;
        if (event.kind === "viewers") {
          traffic++;
          if (traffic < 3 * FOREGROUND_BURST) void submit();
          else end();
        }
        return {
          ...answered(),
          wake: traffic === 0 ? (1 as Tick) : null,
        };
      },
    }),
    () => {},
    {
      subscribed: () => {},
      frames: (frames) => {
        if (frames.some((frame) => frame.session === session))
          receivedAt.push(traffic);
      },
      stored: () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const submit = () =>
    host.deliver(
      () => ({ kind: "event", event: { kind: "viewers", viewers: {} } }),
      [],
    );
  await host.start(
    () => ({
      kind: "event",
      event: { kind: "start", viewers: {}, sessions: [] },
    }),
    [],
  );
  const blocked = host.deliver(
    () => ({ kind: "event", event: { kind: "retire", session } }),
    [],
  );
  read.mono = 1000;
  fire[0]!();
  const first = submit();
  open();
  await Promise.all([blocked, first, done]);
  expect(receivedAt).toEqual([FOREGROUND_BURST]);
  expect(traffic).toBe(3 * FOREGROUND_BURST);
});
