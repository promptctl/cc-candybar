// The supervisor of a renderer in its own process, over a channel the test
// plays the renderer's side of and a clock it moves by hand: what it spawns,
// what waits for a start, how an end is said and backed off from, when a
// silent renderer is ended, and whose ids cross.

import type { Asked } from "../../src/utils/outcome";
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CLOSE_GRACE_MS,
  HUNG_AFTER_MS,
  PING_PERIOD_MS,
  YOUNG_MS,
  backoffMs,
  inProcessPort,
  processRenderer,
  rendererNodeArgs,
} from "../../src/daemon/renderer-process";
import type {
  Channel,
  ChannelOpts,
  Failed,
  LaunchResult,
} from "../../src/proc/launcher";
import type { HostLine, RendererLine } from "../../src/renderer-interface/wire";
import type {
  StorageHoldId,
  WatchId,
} from "../../src/renderer-interface/adapter";
import type {
  AdapterInput,
  AdapterOutput,
  EffectId,
  RendererOutput,
} from "../../src/renderer-interface/interface";
import { rendererOf } from "../../src/renderer-interface/interface";
import type { HeldEvent } from "../../src/utils/event-hold";
import type { Instant } from "../../src/utils/instant";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import {
  RendererDown,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import { heldClock, type HeldClock } from "../helpers/held-clock";
import { inertHost } from "../helpers/renderer-parts";

// One renderer process as the test plays it: what the host wrote to it, and
// what it says back.
interface Child {
  readonly opts: ChannelOpts;
  readonly written: HostLine[];
  stdinEnded: boolean;
  say(line: RendererLine): void;
  exit(result: LaunchResult): void;
}

const EXITED: LaunchResult = { ok: true, stdout: "", stderr: "", exitCode: 0 };
const CRASHED: Failed = {
  ok: false,
  reason: "signal",
  stdout: "",
  stderr: "",
  exitCode: null,
  signal: "SIGSEGV",
};

const SESSION = "s1" as SessionId;

function rig(start: () => Promise<void> = async () => {}) {
  const clock: HeldClock = heldClock(new Date("2026-11-15T00:00:00Z"));
  const children: Child[] = [];
  const logs: string[] = [];
  const ends: HeldEvent[] = [];
  const watched: Array<["watch" | "unwatch", WatchId]> = [];
  const held: Array<["hold" | "release", StorageHoldId]> = [];
  // The key as the host reads it now: what each boot carries.
  const key = { read: { kind: "ok", value: "a2V5" } as Asked<string> };
  const launcher = {
    launchChannel: (opts: ChannelOpts): Channel => {
      let finish: (result: LaunchResult) => void = () => {};
      const ended = new Promise<LaunchResult>((resolve) => (finish = resolve));
      const child: Child = {
        opts,
        written: [],
        stdinEnded: false,
        // A child's output arrives on a later turn than the write it answers.
        say: (line) => opts.heard.stdout(`${JSON.stringify(line)}\n`),
        exit: finish,
      };
      opts.signal?.addEventListener("abort", () =>
        finish({ ...CRASHED, reason: "aborted", signal: "SIGTERM" }),
      );
      children.push(child);
      return {
        pid: 9000 + children.length,
        write: (text) => {
          for (const line of text.split("\n").filter((l) => l !== ""))
            child.written.push(JSON.parse(line) as HostLine);
        },
        end: () => {
          child.stdinEnded = true;
        },
        ended,
      };
    },
  };
  const link = processRenderer({
    reaches: {
      ...inertHost(),
      watches: {
        watch: (id) => watched.push(["watch", id]),
        unwatch: (id) => watched.push(["unwatch", id]),
      },
      storage: {
        hold: (id) => held.push(["hold", id]),
        release: (id) => held.push(["release", id]),
      },
    },
    log: (_level, msg) => logs.push(msg),
    clock,
    start,
    ended: (event) => ends.push(event),
    launcher,
    node: [
      "/bin/node",
      "--inspect=9229",
      "--max-old-space-size=64",
      "--loader=x",
    ],
    entry: "/app/index.mjs",
    cwd: "/state",
    heapCapMb: 512,
    boot: () => ({
      digest: "d1",
      host: { env: {}, home: "/home", tmp: "/tmp" },
      bundle: "/app/index.mjs",
      memoryLimitBytes: 1,
      linkKey: key.read,
    }),
  });
  // The inputs the host sent the child, in order.
  const inputs = (child: Child) =>
    child.written.flatMap((l) => (l.kind === "input" ? [l] : []));
  return { clock, children, logs, ends, watched, held, link, inputs, key };
}

// Every promise chain the supervisor started settles: it awaits nothing but
// promises, so draining the microtask queue a while is enough.
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const pin: AdapterInput = {
  kind: "adapter",
  push: { kind: "pin", session: SESSION },
  at: 0 as Instant,
};
const PINNED: AdapterOutput = { kind: "replied", reply: { kind: "pin" } };

describe("a renderer process's start", () => {
  test("it runs the host's node with the renderer's own heap cap and no inspector, in the state directory, and boots with the host's digest", () => {
    const { link, children } = rig();
    link.arm();
    const [child] = children;
    expect(child!.opts).toMatchObject({
      bin: "/bin/node",
      args: [
        "--loader=x",
        "--max-old-space-size=512",
        "/app/index.mjs",
        "renderer",
      ],
      cwd: "/state",
      category: "renderer",
    });
    expect(child!.written).toEqual([
      {
        kind: "boot",
        boot: {
          digest: "d1",
          host: { env: {}, home: "/home", tmp: "/tmp" },
          bundle: "/app/index.mjs",
          memoryLimitBytes: 1,
          linkKey: { kind: "ok", value: "a2V5" },
        },
      },
    ]);
    expect(rendererNodeArgs(["--max-old-space-size=9"], 7)).toEqual([
      "--max-old-space-size=7",
    ]);
  });

  test("an input during the boot waits, and goes after the complete start's own", async () => {
    const order: string[] = [];
    const { link, children, inputs } = rig(async () => {
      order.push("start");
    });
    link.arm();
    const child = children[0]!;
    const answered = link.renderer.answer(pin);
    await settled();
    expect(inputs(child)).toEqual([]);
    child.say({ kind: "started", pid: 9001 });
    await settled();
    expect(order).toEqual(["start"]);
    const [sent] = inputs(child);
    expect(sent!.input).toEqual(pin);
    child.say({ kind: "output", n: sent!.n, output: PINNED });
    await expect(answered).resolves.toEqual(PINNED);
  });

  test("the complete start heads what waits for the boot, so an input during the boot follows it as a change", async () => {
    const unpin: AdapterInput = {
      ...pin,
      push: { kind: "unpin", session: SESSION },
    };
    const r = rig(async () => {
      await r.link.renderer.answer(pin);
    });
    r.link.arm();
    void r.link.renderer.answer(unpin);
    r.children[0]!.say({ kind: "started", pid: 9001 });
    await settled();
    expect(r.inputs(r.children[0]!).map((l) => l.input)).toEqual([pin, unpin]);
  });

  test("a boot that is refused ends with its reason, on the ⚠ as in the log", async () => {
    const { link, children, ends } = rig();
    link.arm();
    children[0]!.say({
      kind: "refused",
      failure: failureOf(new Error("the session state cannot be read")),
    });
    children[0]!.exit({ ...CRASHED, reason: "non-zero", exitCode: 1 });
    await settled();
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringMatching(
        /^renderer main\[1\] refused its boot: .*the session state cannot be read; it restarts/,
      ),
    ]);
  });

  test("a booting renderer counts as its process, and writes no heap until it is live", async () => {
    const { link } = rig();
    link.arm();
    const booting = link.process();
    expect(booting).toMatchObject({ pid: 9001, usage: null });
    await expect(booting!.heapSnapshot("/s/heap")).rejects.toThrow(
      "renderer main[1] is not live, so its heap was not written",
    );
  });

  test("a boot ended for hanging counts as young, so the next waits its backoff", async () => {
    const { link, children, clock } = rig();
    link.arm();
    clock.advance(HUNG_AFTER_MS + PING_PERIOD_MS);
    await settled();
    expect(children).toHaveLength(1);
    clock.advance(BACKOFF_FIRST_MS - 1);
    expect(children).toHaveLength(1);
    clock.advance(1);
    expect(children).toHaveLength(2);
  });

  test("a start that never answers is ended as a renderer that stopped answering", async () => {
    const { link, children, clock, ends } = rig();
    link.arm();
    const waiting = expect(link.renderer.answer(pin)).rejects.toThrow(
      RendererDown,
    );
    clock.advance(HUNG_AFTER_MS + PING_PERIOD_MS);
    await settled();
    await waiting;
    expect(ends.map((e) => e.text)).toEqual([
      `renderer main[1] stopped answering for ${HUNG_AFTER_MS / 1000} s; it restarts, and unsaved state (open menus, armed confirms) is lost`,
    ]);
    expect(children[0]!.opts.signal?.aborted).toBe(true);
  });
});

describe("a renderer process's end", () => {
  test("it is said once, inputs while down fail as down and are counted, and the next start says how many", async () => {
    const { link, children, clock, ends, logs } = rig();
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    await settled();
    children[0]!.exit(CRASHED);
    await settled();
    expect(ends).toHaveLength(1);
    expect(ends[0]!.text).toMatch(/^renderer main\[1\] killed by SIGSEGV;/);
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new RendererDown("renderer main is down: killed by SIGSEGV"),
    );
    await expect(link.renderer.answer(pin)).rejects.toThrow(RendererDown);
    // It lived under a minute, so the next waits the first backoff.
    clock.advance(BACKOFF_FIRST_MS - 1);
    expect(children).toHaveLength(1);
    clock.advance(1);
    expect(children).toHaveLength(2);
    children[1]!.say({ kind: "started", pid: 9002 });
    await settled();
    expect(logs).toContain(
      "renderer main[2] started pid=9002 refused-while-down=2",
    );
  });

  test("renderers that end young wait twice as long each time, to a minute, and one that lived restarts at once", () => {
    expect([0, 1, 2, 3, 7, 30].map(backoffMs)).toEqual([
      0, 1_000, 2_000, 4_000, 60_000, 60_000,
    ]);
  });

  // Removing a broken key file, its error's own remedy, recovers at the next
  // start with no restart of the host.
  test("each start boots with the key as the host reads it then", async () => {
    const { link, children, clock, key } = rig();
    key.read = { kind: "failed", reason: "link key holds 3 bytes" };
    link.arm();
    children[0]!.exit(CRASHED);
    await settled();
    key.read = { kind: "ok", value: "bmV3" };
    clock.advance(backoffMs(1));
    const boots = children.map(
      (child) => child.written.find((l) => l.kind === "boot")!,
    );
    expect(
      boots.map((l) => (l.kind === "boot" ? l.boot.linkKey : null)),
    ).toEqual([
      { kind: "failed", reason: "link key holds 3 bytes" },
      { kind: "ok", value: "bmV3" },
    ]);
  });

  test("a renderer that lived past young restarts at once", async () => {
    const { link, children, clock } = rig();
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    clock.advance(YOUNG_MS);
    await settled();
    children[0]!.exit(CRASHED);
    await settled();
    clock.advance(0);
    expect(children).toHaveLength(2);
  });

  test("a live renderer whose ping goes unanswered past the allowance is ended", async () => {
    const { link, children, clock, ends } = rig();
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    await settled();
    clock.advance(PING_PERIOD_MS);
    const ping = children[0]!.written.find((l) => l.kind === "ping");
    expect(ping).toBeDefined();
    // Answered, the next goes out a period later; unanswered, it is judged.
    children[0]!.say({
      kind: "ping",
      n: (ping as { n: number }).n,
      usage: { rss: 5, heapTotal: 3 },
    });
    await settled();
    expect(link.process()).toMatchObject({
      pid: 9001,
      usage: { rss: 5, heapTotal: 3 },
    });
    clock.advance(PING_PERIOD_MS + HUNG_AFTER_MS + PING_PERIOD_MS);
    await settled();
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringMatching(/^renderer main\[1\] stopped answering/),
    ]);
  });
});

describe("ids a renderer mints", () => {
  test("cross as the host's own, never repeated across renderers, and a gone renderer's holds go once the next has started", async () => {
    let started: () => void = () => {};
    const { link, children, clock, watched, held, inputs } = rig(
      () => new Promise<void>((resolve) => (started = resolve)),
    );
    link.arm();
    const first = children[0]!;
    first.say({ kind: "started", pid: 9001 });
    first.say({ kind: "notice", reach: "watches.watch", args: [1, "k", []] });
    first.say({ kind: "notice", reach: "storage.hold", args: [1, ["/f"]] });
    first.say({
      kind: "notice",
      reach: "storage.hold",
      args: [1, ["/f", "/g"]],
    });
    started();
    await settled();
    first.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_FIRST_MS);
    const second = children[1]!;
    second.say({ kind: "started", pid: 9002 });
    second.say({ kind: "notice", reach: "watches.watch", args: [1, "k", []] });
    await settled();
    // The first renderer's watch and hold stand until the second has started.
    expect(watched).toEqual([
      ["watch", 1],
      ["watch", 3],
    ]);
    expect(held).toEqual([
      ["hold", 2],
      ["hold", 2],
    ]);
    started();
    await settled();
    expect(watched).toEqual([
      ["watch", 1],
      ["watch", 3],
      ["unwatch", 1],
    ]);
    expect(held.at(-1)).toEqual(["release", 2]);
    // A push for the first renderer's watch fails as down; the second's goes
    // to it by its own id.
    await expect(
      link.renderer.answer({
        kind: "adapter",
        push: { kind: "watch", id: 1 as WatchId, heard: null, deaf: [] },
        at: 0 as Instant,
      }),
    ).rejects.toThrow(RendererDown);
    void link.renderer.answer({
      kind: "adapter",
      push: { kind: "watch", id: 3 as WatchId, heard: null, deaf: [] },
      at: 0 as Instant,
    });
    await settled();
    expect(inputs(second).at(-1)!.input).toMatchObject({
      push: { kind: "watch", id: 1 },
    });
  });

  test("a gone renderer's holds stand while the next ends before its start answers, and go once one answers", async () => {
    const starts: Array<() => void> = [];
    const { link, children, clock, held } = rig(
      () => new Promise<void>((resolve) => starts.push(resolve)),
    );
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    children[0]!.say({
      kind: "notice",
      reach: "storage.hold",
      args: [1, ["/f"]],
    });
    starts[0]!();
    await settled();
    children[0]!.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_FIRST_MS);
    children[1]!.say({ kind: "started", pid: 9002 });
    await settled();
    children[1]!.exit(CRASHED);
    starts[1]!();
    await settled();
    expect(held).toEqual([["hold", 1]]);
    clock.advance(2 * BACKOFF_FIRST_MS);
    children[2]!.say({ kind: "started", pid: 9003 });
    starts[2]!();
    await settled();
    expect(held).toEqual([
      ["hold", 1],
      ["release", 1],
    ]);
  });

  test("a renderer that never took over releases what it held as it ends", async () => {
    const { link, children, held } = rig();
    link.arm();
    children[0]!.say({
      kind: "notice",
      reach: "storage.hold",
      args: [1, ["/f"]],
    });
    await settled();
    children[0]!.exit(CRASHED);
    await settled();
    expect(held).toEqual([
      ["hold", 1],
      ["release", 1],
    ]);
  });

  test("a start with nothing to await releases no holds before its renderer has booted", async () => {
    const { link, children, clock, held } = rig();
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    children[0]!.say({
      kind: "notice",
      reach: "storage.hold",
      args: [1, ["/f"]],
    });
    await settled();
    children[0]!.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_FIRST_MS);
    await settled();
    expect(held).toEqual([["hold", 1]]);
    children[1]!.say({ kind: "started", pid: 9002 });
    await settled();
    expect(held).toEqual([
      ["hold", 1],
      ["release", 1],
    ]);
  });

  test("an effect's id is the host's, and its done goes back by the renderer's", async () => {
    const { link, children, inputs } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    const effect = {
      kind: "present",
      id: 7 as EffectId,
      session: SESSION,
      surface: "statusline",
      request: 1,
      frame: {},
    } as const;
    const output = link.renderer.answer({
      kind: "event",
      at: 0,
      event: { kind: "retire", session: SESSION },
    } as never);
    await settled();
    const answeredWith: RendererOutput = {
      kind: "answered",
      record: [],
      effects: [effect as never],
      subscriptions: { sources: {}, tmuxStatus: [] },
      turnMs: 0,
    };
    child.say({ kind: "output", n: inputs(child)[0]!.n, output: answeredWith });
    const answered = await output;
    expect(answered).toMatchObject({ kind: "answered" });
    if (answered.kind !== "answered") throw new Error("the turn threw");
    const hostId = answered.effects[0]!.id;
    expect(hostId).not.toBe(7);
    void link.renderer.answer({
      kind: "event",
      at: 0,
      event: {
        kind: "effect-done",
        session: SESSION,
        of: hostId,
        outcome: { kind: "ok" },
      },
    } as never);
    await settled();
    expect(inputs(child)[1]!.input).toMatchObject({
      event: { kind: "effect-done", of: 7 },
    });
  });

  // A run or a restart outlives the renderer that asked for it: its end is
  // owed to that renderer alone, and the next one, whose ids start again,
  // would take it for one of its own.
  test("an effect-done for an effect an ended renderer returned reaches no newer renderer", async () => {
    const { link, children, inputs, clock } = rig();
    link.arm();
    const first = children[0]!;
    first.say({ kind: "started", pid: 9001 });
    await settled();
    const output = link.renderer.answer({
      kind: "event",
      at: 0,
      event: { kind: "retire", session: SESSION },
    } as never);
    await settled();
    first.say({
      kind: "output",
      n: inputs(first)[0]!.n,
      output: {
        kind: "answered",
        record: [],
        effects: [
          { kind: "copy", id: 1 as EffectId, session: SESSION, text: "x" },
        ],
        subscriptions: { sources: {}, tmuxStatus: [] },
        turnMs: 0,
      },
    });
    const answered = await output;
    if (answered.kind !== "answered") throw new Error("the turn threw");
    const hostId = answered.effects[0]!.id;
    first.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_FIRST_MS);
    const second = children[1]!;
    second.say({ kind: "started", pid: 9002 });
    await settled();
    const heard = inputs(second).length;
    await expect(
      link.renderer.answer({
        kind: "event",
        at: 0,
        event: {
          kind: "effect-done",
          session: SESSION,
          of: hostId,
          outcome: { kind: "failed", reason: "copy: pbcopy failed" },
        },
      } as never),
    ).rejects.toThrow(
      new RendererDown(
        `renderer main: effect ${hostId} was returned by a renderer that has ended`,
      ),
    );
    expect(inputs(second)).toHaveLength(heard);
  });
});

describe("a renderer process's close", () => {
  test("what waits for a boot the close lands in fails as a closed renderer's", async () => {
    const { link, children, clock } = rig();
    link.arm();
    const waiting = link.renderer.answer(pin);
    let endedBeforeTeardown = false;
    const closed = link.close(async () => {
      endedBeforeTeardown = children[0]!.stdinEnded;
    });
    await expect(waiting).rejects.toThrow(
      new RendererDown("renderer main is closed"),
    );
    // A fresh boot holds nothing to flush, so the teardown never waits on it.
    expect(endedBeforeTeardown).toBe(true);
    clock.advance(1_000);
    await closed;
  });

  test("a live renderer takes inputs while the teardown runs, and its stdin closes after it", async () => {
    const { link, children } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const closed = link.close(() => released);
    const heard = child.written.length;
    void link.renderer.answer(pin).catch(() => {});
    await settled();
    expect(child.written.length).toBeGreaterThan(heard);
    expect(child.stdinEnded).toBe(false);
    release();
    await settled();
    expect(child.stdinEnded).toBe(true);
    child.exit(EXITED);
    await closed;
  });

  test("a renderer that ends while the teardown runs is not started again", async () => {
    const { link, children, clock } = rig();
    link.arm();
    children[0]!.say({ kind: "started", pid: 9001 });
    clock.advance(YOUNG_MS);
    await settled();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const closed = link.close(() => released);
    children[0]!.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_MAX_MS);
    expect(children).toHaveLength(1);
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new RendererDown("renderer main is closed"),
    );
    release();
    await closed;
  });

  test("a down renderer's next start never comes once the close begins", async () => {
    const { link, children, clock } = rig();
    link.arm();
    children[0]!.exit(CRASHED);
    await settled();
    await link.close(async () => {});
    clock.advance(BACKOFF_MAX_MS);
    expect(children).toHaveLength(1);
  });

  test("its stdin closes, and one that does not end is signalled after the grace", async () => {
    const { link, children, clock } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    const closed = link.close(async () => {});
    await settled();
    expect(child.stdinEnded).toBe(true);
    expect(child.opts.signal?.aborted).toBe(false);
    clock.advance(1_000);
    await closed;
    expect(child.opts.signal?.aborted).toBe(true);
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new RendererDown("renderer main is closed"),
    );
  });

  test("a renderer the teardown waits on is judged by its pings, and its end is said with no restart offered", async () => {
    const { link, children, clock, logs, ends } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const closed = link.close(() => released);
    clock.advance(PING_PERIOD_MS + HUNG_AFTER_MS + PING_PERIOD_MS);
    await settled();
    expect(child.opts.signal?.aborted).toBe(true);
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^renderer main\[1\] stopped answering .* in the daemon's close$/,
      ),
    );
    expect(ends).toEqual([]);
    release();
    await closed;
  });

  test("a boot the close ends is signalled after the grace, while the teardown still runs", async () => {
    const { link, children, clock } = rig();
    link.arm();
    const child = children[0]!;
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const closed = link.close(() => released);
    expect(child.stdinEnded).toBe(true);
    clock.advance(CLOSE_GRACE_MS);
    await settled();
    expect(child.opts.signal?.aborted).toBe(true);
    release();
    await closed;
  });

  test("a renderer that exits as the close ends it says so", async () => {
    const { link, children, logs } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    const closed = link.close(async () => {});
    await settled();
    child.exit(EXITED);
    await closed;
    expect(logs).toContain("renderer main[1] exited in the daemon's close");
  });

  test("a teardown that throws still ends the renderer, and the close fails with it", async () => {
    const { link, children } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    await settled();
    const closed = link.close(async () => {
      throw new Error("teardown broke");
    });
    await settled();
    expect(child.stdinEnded).toBe(true);
    child.exit(EXITED);
    await expect(closed).rejects.toThrow("teardown broke");
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new RendererDown("renderer main is closed"),
    );
  });

  test("a call the renderer awaits is answered by the host's reach, its failure keeping its kind", async () => {
    const { link, children } = rig();
    link.arm();
    const child = children[0]!;
    child.say({ kind: "started", pid: 9001 });
    child.say({ kind: "call", n: 1, reach: "serving", args: [] });
    await settled();
    expect(child.written.at(-1)).toMatchObject({
      kind: "returned",
      n: 1,
      returned: {
        kind: "failed",
        failure: {
          kind: "threw",
          message: "serving: no host part in this rig",
        },
      },
    });
  });
});

describe("a renderer in the host's process", () => {
  test("its close flushes after the teardown, and a flush that fails is said while the close still ends", async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const link = inProcessPort({
      load: () => ({
        start: () =>
          rendererOf({
            event: () => Promise.reject(new Error("no events in this rig")),
            adapter: async (input) => {
              order.push(input.push.kind);
              throw new Error("disk full");
            },
          }),
      }),
      boot: () => {
        throw new Error("no boot in process");
      },
      node: [],
    }).start({
      reaches: inertHost(),
      log: (_level, msg) => logs.push(msg),
      clock: heldClock(new Date("2026-11-15T00:00:00Z")),
      start: async () => {},
      ended: () => {},
    });
    await link.close(async () => {
      order.push("teardown");
    });
    expect(order).toEqual(["teardown", "close-session-state"]);
    expect(logs).toEqual([
      expect.stringMatching(
        /^the session state did not flush: Error: disk full/,
      ),
    ]);
  });
});
