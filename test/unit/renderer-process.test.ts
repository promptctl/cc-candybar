import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
// The supervisor of a renderer in its own process, over a channel the test
// plays the renderer's side of and a clock it moves by hand: what it spawns,
// what waits for a start, how an end is said and backed off from, when a
// silent renderer is ended, and whose ids cross.

import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { inProcessRenderer } from "../../src/in-process-renderer";
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CLOSE_GRACE_MS,
  HUNG_AFTER_MS,
  PING_PERIOD_MS,
  YOUNG_MS,
  backoffMs,
  processRenderer,
  rendererNodeArgs,
  type RendererLink,
  type RendererProcess,
} from "../../src/daemon/renderer-process";
import type {
  Channel,
  ChannelOpts,
  Failed,
  LaunchResult,
} from "../../src/proc/launcher";
import {
  RENDERER_WIRE_VERSION,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import type {
  EventInput,
  EffectId,
  RendererOutput,
  Timed,
} from "../../src/renderer-interface/interface";
import type { WireFrame } from "../../src/render/frame";
import type { HeldEvent } from "../../src/utils/event-hold";
import type { Instant, Tick } from "../../src/utils/instant";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { DaemonClosing,
  RendererDown } from "../../src/daemon/foundations/verb-error";
import { failureOf } from "../../src/daemon/foundations/host-failure";
import { heldClock, type HeldClock } from "../helpers/held-clock";
import {
  oversizedRendererHistory,
  oversizedSession,
} from "../helpers/oversized-renderer-history";
import type { LogLine } from "../../src/utils/logger";

// One renderer process as the test plays it: what the host wrote to it, and
// what it says back.
interface Child {
  readonly opts: ChannelOpts;
  readonly written: HostLine[];
  // How many times the host closed its stdin.
  stdinEnds: number;
  say(line: RendererLine): void;
  exit(result: LaunchResult): void;
}

const startedLine = (pid: number): RendererLine => ({
  kind: "started",
  pid,
  wireVersion: RENDERER_WIRE_VERSION,
});

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

const RENDERER_BOOT = {
  locations: {
    home: "/home",
    configHome: "/config",
    dataHome: "/data",
    dataDirs: [],
  },
  region: SAMPLE_REGION,
  memoryLimitBytes: 1,
  stored: EMPTY_STORED_STATE,
} satisfies Extract<HostLine, { kind: "boot" }>["boot"];

function rig(start: () => Promise<void> = async () => {}) {
  const clock: HeldClock = heldClock(new Date("2026-11-15T00:00:00Z"));
  const children: Child[] = [];
  const logs: string[] = [];
  const levels: string[] = [];
  const ends: HeldEvent[] = [];
  const launcher = {
    launchChannel: (opts: ChannelOpts): Channel => {
      let finish: (result: LaunchResult) => void = () => {};
      const ended = new Promise<LaunchResult>((resolve) => (finish = resolve));
      const child: Child = {
        opts,
        written: [],
        stdinEnds: 0,
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
          child.stdinEnds++;
        },
        ended,
      };
    },
  };
  const link = processRenderer({
    log: (level, msg) => {
      logs.push(msg);
      levels.push(level);
    },
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
    name: MAIN_RENDERER,
    boot: () => RENDERER_BOOT,
  });
  // The inputs the host sent the child, in order.
  const inputs = (child: Child) =>
    child.written.flatMap((l) => (l.kind === "input" ? [l] : []));
  return {
    clock,
    children,
    logs,
    levels,
    ends,
    link,
    inputs,
  };
}

// Every promise chain the supervisor started settles: it awaits nothing but
// promises, so draining the microtask queue a while is enough.
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// A process the host stopped: its stdin closed at once, and its signal after
// the grace.
async function stopped(clock: HeldClock, child: Child): Promise<void> {
  await settled();
  expect(child.stdinEnds).toBe(1);
  expect(child.opts.signal?.aborted).toBe(false);
  clock.advance(CLOSE_GRACE_MS);
  await settled();
  expect(child.opts.signal?.aborted).toBe(true);
}

// A live renderer its boot's ping has read, as the backstop is handed it.
async function readRenderer(
  link: RendererLink,
  children: readonly Child[],
): Promise<RendererProcess> {
  link.arm();
  const child = children[0]!;
  child.say(startedLine(9001));
  await settled();
  const ping = child.written.find(
    (l): l is Extract<HostLine, { kind: "ping" }> => l.kind === "ping",
  );
  if (ping === undefined) throw new Error("the renderer was sent no ping");
  child.say({ kind: "ping", n: ping.n, usage: { rss: 5, heapTotal: 3 } });
  await settled();
  const state = link.process();
  if (state.kind !== "spawned" || state.process.usage.kind !== "read")
    throw new Error(`the renderer is ${state.kind}, not read`);
  return state.process;
}

const pin: EventInput = {
  kind: "event",
  event: { kind: "close-journal" },
  at: 0 as Instant,
  tick: 0 as Tick,
};
const PINNED: Timed<RendererOutput> = {
  kind: "answered",
  record: [],
  frames: [],
  effects: [],
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
  turnMs: 0,
};

describe("a renderer process's start", () => {
  test.each(["started", "refused"] as const)(
    "takes %s boot diagnostics before the boot record, once",
    (kind) => {
      const { link, children, logs, levels } = rig();
      const diagnostic: LogLine = {
        level: "warn",
        line: "construction warning",
      };
      link.arm();
      const child = children[0]!;
      const boot: RendererLine =
        kind === "started"
          ? {
              kind,
              pid: 9001,
              wireVersion: RENDERER_WIRE_VERSION,
              diagnostics: [diagnostic],
            }
          : {
              kind,
              wireVersion: RENDERER_WIRE_VERSION,
              failure: failureOf(new Error("refused by fixture")),
              diagnostics: [diagnostic],
            };
      child.say(boot);
      child.say(boot);
      const index = logs.indexOf(diagnostic.line);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(levels[index]).toBe(diagnostic.level);
      expect(logs[index + 1]).toContain(
        kind === "started" ? "started pid=" : "refused its boot:",
      );
      expect(logs.filter((line) => line === diagnostic.line)).toHaveLength(1);
    },
  );
  test("it runs the host's node with the renderer's own heap cap and no inspector, in the state directory, and boots with the wire version", () => {
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
        wireVersion: RENDERER_WIRE_VERSION,
        boot: RENDERER_BOOT,
      },
    ]);
    expect(rendererNodeArgs(["--max-old-space-size=9"], 7)).toEqual([
      "--max-old-space-size=7",
    ]);
  });

  test.each([
    ["a legacy acknowledgment", {}, "no version"],
    [
      "another version",
      { wireVersion: RENDERER_WIRE_VERSION + 1 },
      `version ${RENDERER_WIRE_VERSION + 1}`,
    ],
    [
      "a string version",
      { wireVersion: String(RENDERER_WIRE_VERSION) },
      `version "${RENDERER_WIRE_VERSION}"`,
    ],
  ])(
    "%s fails the boot before sending any input or ping",
    async (_name, fields, sent) => {
      const { link, children, logs, ends, clock } = rig();
      link.arm();
      const child = children[0]!;
      const refused = expect(link.renderer.answer(pin)).rejects.toThrow(
        "renderer wire version mismatch",
      );
      const diagnostics = [
        { level: "warn", line: "diagnostics in an unaccepted protocol" },
      ];
      child.opts.heard.stdout(
        `${JSON.stringify({ kind: "started", pid: 9001, diagnostics, ...fields })}\n`,
      );
      // A later acknowledgment cannot rescue the rejected process during teardown.
      child.say(startedLine(9001));
      await refused;
      await stopped(clock, child);
      expect(child.written.map(({ kind }) => kind)).toEqual(["boot"]);
      const mismatch = `renderer wire version mismatch (renderer sent ${sent}, expected version ${RENDERER_WIRE_VERSION})`;
      expect(logs).toContainEqual(expect.stringContaining(mismatch));
      expect(logs).not.toContain(diagnostics[0]?.line);
      expect(ends[0]?.text).toContain(mismatch);
      clock.advance(BACKOFF_FIRST_MS - 1);
      expect(children).toHaveLength(1);
      clock.advance(1);
      expect(children).toHaveLength(2);
    },
  );

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
    child.say(startedLine(9001));
    await settled();
    expect(order).toEqual(["start"]);
    const [sent] = inputs(child);
    expect(sent!.input).toEqual(pin);
    child.say({ kind: "output", n: sent!.n, output: PINNED });
    await expect(answered).resolves.toEqual(PINNED);
  });

  test("the complete start heads what waits for the boot, so an input during the boot follows it as a change", async () => {
    const unpin: EventInput = {
      ...pin,
      event: { kind: "close-views" },
    };
    const r = rig(async () => {
      await r.link.renderer.answer(pin);
    });
    r.link.arm();
    void r.link.renderer.answer(unpin);
    r.children[0]!.say(startedLine(9001));
    await settled();
    expect(r.inputs(r.children[0]!).map((l) => l.input)).toEqual([pin, unpin]);
  });

  test("a boot that is refused ends with its reason, on the ⚠ as in the log", async () => {
    const { link, children, ends } = rig();
    link.arm();
    children[0]!.say({
      kind: "refused",
      wireVersion: RENDERER_WIRE_VERSION,
      failure: failureOf(new Error("the session state cannot be read")),
    });
    children[0]!.exit({ ...CRASHED, reason: "non-zero", exitCode: 1 });
    await settled();
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringMatching(
        /^renderer main\[1\] refused its boot: .*the session state cannot be read\. Retrying with committed settings/,
      ),
    ]);
  });

  test("a boot that is refused by a renderer that does not exit is signalled after the grace", async () => {
    const { link, children, clock, ends } = rig();
    link.arm();
    children[0]!.say({
      kind: "refused",
      wireVersion: RENDERER_WIRE_VERSION,
      failure: failureOf(new Error("the session state cannot be read")),
    });
    await stopped(clock, children[0]!);
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringContaining("refused its boot:"),
    ]);
  });

  test.each([
    ["boot", null],
    ["output", "not a diagnostic batch"],
    ["output", [{ level: "verbose", line: "discard this" }]],
    ["output", [{ level: "info", line: 12 }]],
  ])(
    "a malformed %s diagnostic leaves the valid answer usable",
    async (at, diagnostics) => {
      const { link, children, inputs, logs } = rig();
      link.arm();
      const child = children[0]!;
      child.opts.heard.stdout(
        `${JSON.stringify({
          ...startedLine(9001),
          ...(at === "boot" ? { diagnostics } : {}),
        })}\n`,
      );
      const answered = link.renderer.answer(pin);
      const [sent] = inputs(child);
      child.opts.heard.stdout(
        `${JSON.stringify({
          kind: "output",
          n: sent!.n,
          output: { ...PINNED, ...(at === "output" ? { diagnostics } : {}) },
        })}\n`,
      );
      await expect(answered).resolves.toEqual(PINNED);
      expect(
        logs.filter((line) => line.includes("invalid diagnostics")),
      ).toHaveLength(1);
      expect(logs).not.toContain("discard this");
    },
  );

  test("a refused boot after readiness cannot change this link or write its diagnostics", async () => {
    const { link, children, inputs, logs } = rig();
    link.arm();
    const child = children[0]!;
    child.say(startedLine(9001));
    child.say({
      kind: "refused",
      wireVersion: RENDERER_WIRE_VERSION,
      failure: failureOf(new Error("obsolete refusal")),
      diagnostics: [{ level: "warn", line: "obsolete log" }],
    });
    const answered = link.renderer.answer(pin);
    child.say({ kind: "output", n: inputs(child)[0]!.n, output: PINNED });
    await expect(answered).resolves.toEqual(PINNED);
    expect(child.opts.signal?.aborted).toBe(false);
    expect(logs.join("\n")).not.toContain("obsolete");
  });

  test.each([
    [
      { kind: "started", pid: null, wireVersion: RENDERER_WIRE_VERSION },
      "invalid pid",
    ],
    [
      { kind: "refused", failure: null, wireVersion: RENDERER_WIRE_VERSION },
      "invalid refusal",
    ],
  ])(
    "a malformed required boot field refuses the worker immediately",
    async (raw, why) => {
      const { link, children, clock } = rig();
      link.arm();
      const child = children[0]!;
      const refused = expect(link.renderer.answer(pin)).rejects.toThrow(why);
      child.opts.heard.stdout(`${JSON.stringify(raw)}\n`);
      await refused;
      await stopped(clock, child);
      expect(child.written.map(({ kind }) => kind)).toEqual(["boot"]);
    },
  );

  test("an incompatible refusal can explain the version without publishing its diagnostics", async () => {
    const { link, children, logs } = rig();
    link.arm();
    const child = children[0]!;
    const refused = expect(link.renderer.answer(pin)).rejects.toThrow(
      "incompatible boot",
    );
    child.opts.heard.stdout(
      `${JSON.stringify({
        kind: "refused",
        wireVersion: RENDERER_WIRE_VERSION - 1,
        failure: failureOf(new Error("incompatible boot")),
        diagnostics: [{ level: "info", line: "foreign diagnostic" }],
      })}\n`,
    );
    child.exit({ ...CRASHED, reason: "non-zero", exitCode: 1 });
    await refused;
    expect(logs.join("\n")).not.toContain("foreign diagnostic");
  });
  test("a booting renderer is its process from its spawn, unread until a ping answers", () => {
    const { link } = rig();
    link.arm();
    expect(link.process()).toMatchObject({
      kind: "spawned",
      process: {
        name: MAIN_RENDERER,
        generation: 1,
        pid: 9001,
        usage: { kind: "unread", why: "no ping has answered yet" },
      },
    });
  });

  test("a renderer that breaches while it starts is ended, its heap refused for its phase", async () => {
    const { link, logs } = rig();
    link.arm();
    const state = link.process();
    if (state.kind !== "spawned") throw new Error(`it is ${state.kind}`);
    await expect(state.process.heapSnapshot("/d/heap")).rejects.toThrow(
      "renderer main[1] is starting, so its heap was not written",
    );
    state.process.end(
      "passed its memory limit: phys_footprint 900 MB > limit 800 MB",
    );
    expect(link.process()).toEqual({
      kind: "not-running",
      why: "it is ending: passed its memory limit: phys_footprint 900 MB > limit 800 MB",
    });
    expect(logs).not.toContainEqual(expect.stringContaining("was not ended"));
  });

  test("a renderer ended for its memory says why, and starts again after its backoff", async () => {
    const { link, children, clock, ends, logs } = rig();
    const read = await readRenderer(link, children);
    read.end("passed its memory limit: phys_footprint 900 MB > limit 800 MB");
    // Ending, it is judged no more and serves no input, though its process
    // has yet to exit.
    expect(link.process()).toEqual({
      kind: "not-running",
      why: "it is ending: passed its memory limit: phys_footprint 900 MB > limit 800 MB",
    });
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      "renderer main is ending: passed its memory limit: phys_footprint 900 MB > limit 800 MB",
    );
    // The first reason owns the end, and a later one is said.
    read.end("passed its memory limit again");
    expect(logs).toContainEqual(
      "renderer main[1] was not ended for passed its memory limit again: it is already ending: passed its memory limit: phys_footprint 900 MB > limit 800 MB",
    );
    await stopped(clock, children[0]!);
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringContaining(
        "passed its memory limit: phys_footprint 900 MB > limit 800 MB",
      ),
    ]);
    clock.advance(BACKOFF_FIRST_MS);
    await settled();
    expect(children).toHaveLength(2);
  });

  test("a renderer ended for its memory waits its backoff, however long it served", async () => {
    const { link, children, clock } = rig();
    const read = await readRenderer(link, children);
    clock.advance(YOUNG_MS);
    read.end("passed its memory limit: phys_footprint 900 MB > limit 800 MB");
    await stopped(clock, children[0]!);
    clock.advance(BACKOFF_FIRST_MS - 1);
    expect(children).toHaveLength(1);
    clock.advance(1);
    expect(children).toHaveLength(2);
  });

  test("a recording asked of a renderer that is ending keeps its end: said, counted toward the backoff, and the recording starts once it exits", async () => {
    const { link, children, clock, ends, logs } = rig();
    const read = await readRenderer(link, children);
    read.end("passed its memory limit: phys_footprint 900 MB > limit 800 MB");
    const restarted = link.restart();
    await settled();
    expect(children).toHaveLength(1);
    await stopped(clock, children[0]!);
    await restarted;
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringContaining(
        "passed its memory limit: phys_footprint 900 MB > limit 800 MB",
      ),
    ]);
    expect(logs).toContainEqual(
      `renderer main[1] passed its memory limit: phys_footprint 900 MB > limit 800 MB after 0 s; next start in ${BACKOFF_FIRST_MS / 1000} s`,
    );
    expect(logs).not.toContainEqual(
      expect.stringContaining("ended for a requested recording"),
    );
    // The recording does not wait out the backoff, as from down.
    expect(children).toHaveLength(2);
  });

  test("a renderer read before its close writes no heap and is not ended by it, so it takes the close's steps", async () => {
    const { link, children, logs } = rig();
    const read = await readRenderer(link, children);
    link.beginClose();
    await expect(read.heapSnapshot("/s/heap")).rejects.toThrow(
      "renderer main[1] is closing, so its heap was not written",
    );
    read.end("passed its memory limit");
    await settled();
    expect(children[0]!.stdinEnds).toBe(0);
    expect(logs).toContainEqual(
      "renderer main[1] was not ended for passed its memory limit: it is closing",
    );
    children[0]!.exit(EXITED);
    await link.close();
    expect(children).toHaveLength(1);
  });

  test("a boot ended for hanging counts as young, so the next waits its backoff", async () => {
    const { link, children, clock } = rig();
    link.arm();
    clock.advance(HUNG_AFTER_MS + PING_PERIOD_MS);
    await stopped(clock, children[0]!);
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
    await waiting;
    await stopped(clock, children[0]!);
    expect(ends.map((e) => e.text)).toEqual([
      `renderer main[1] stopped answering for ${HUNG_AFTER_MS / 1000} s. Retrying with committed settings. Unsaved edits and menu Back history last only for the renderer’s lifetime.`,
    ]);
  });
});

test("the in-process link logs construction diagnostics once before its first answer", async () => {
  const logs: LogLine[] = [];
  const link = inProcessRenderer()({
    name: MAIN_RENDERER,
    boot: () => ({ ...RENDERER_BOOT, stored: oversizedRendererHistory() }),
    entry: "/app/index.mjs",
    node: ["/bin/node"],
  }).start({
    log: (level, line) => void logs.push({ level, line }),
    clock: heldClock(new Date(0)),
    start: async () => {},
    ended: () => {},
  });
  link.serve();
  link.serve();
  expect(logs).toEqual([
    {
      level: "info",
      line: `settings-history: trimmed an old step for session ${oversizedSession}`,
    },
  ]);
  const answered = await link.renderer.answer(pin);
  expect(answered).not.toHaveProperty("diagnostics");
  expect(answered.stored).toEqual([
    {
      kind: "steps",
      store: "settings-history",
      key: oversizedSession,
      edits: [{ kind: "clear" }],
    },
  ]);
});

describe("a renderer process's end", () => {
  test("it is said once, inputs while down fail as down and are counted, and the next start says how many", async () => {
    const { link, children, clock, ends, logs } = rig();
    link.arm();
    children[0]!.say(startedLine(9001));
    await settled();
    clock.advance(2_000);
    children[0]!.exit({ ...CRASHED, signal: "SIGKILL" });
    await settled();
    expect(ends).toHaveLength(1);
    expect(logs).toContain(
      "renderer main[1] killed by SIGKILL after 2 s; next start in 1 s",
    );
    expect(ends[0]!.text).toMatch(
      /^renderer main\[1\] killed by SIGKILL\. Retrying with committed settings/,
    );
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new RendererDown("renderer main is down: killed by SIGKILL"),
    );
    await expect(link.renderer.answer(pin)).rejects.toThrow(RendererDown);
    // It lived under a minute, so the next waits the first backoff.
    clock.advance(BACKOFF_FIRST_MS - 1);
    expect(children).toHaveLength(1);
    clock.advance(1);
    expect(children).toHaveLength(2);
    children[1]!.say(startedLine(9002));
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

  test("a renderer that lived past young restarts at once", async () => {
    const { link, children, clock } = rig();
    link.arm();
    children[0]!.say(startedLine(9001));
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
    children[0]!.say(startedLine(9001));
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
      kind: "spawned",
      process: {
        pid: 9001,
        usage: { kind: "read", sizes: { rss: 5, heapTotal: 3 } },
      },
    });
    clock.advance(PING_PERIOD_MS + HUNG_AFTER_MS + PING_PERIOD_MS);
    await stopped(clock, children[0]!);
    expect(ends.map((e) => e.text)).toEqual([
      expect.stringMatching(/^renderer main\[1\] stopped answering/),
    ]);
  });
});

test("a failed restoration ends that generation and starts its successor after backoff", async () => {
  let attempt = 0;
  const { link, children, clock, logs, ends } = rig(async () => {
    if (++attempt === 1) throw new Error("unavailable config snapshot");
  });
  link.arm();
  children[0]!.say(startedLine(9001));
  await stopped(clock, children[0]!);
  expect(logs).toContainEqual(expect.stringContaining("start failed:"));
  expect(ends[0]?.text).toContain(
    "failed to start: unavailable config snapshot",
  );
  clock.advance(BACKOFF_FIRST_MS);
  children[1]!.say(startedLine(9002));
  await settled();
  expect(attempt).toBe(2);
  expect(link.process()).toMatchObject({
    kind: "spawned",
    process: { generation: 2, pid: 9002 },
  });
});

describe("ids a renderer mints", () => {
  const due: EventInput = { ...pin, event: { kind: "due" } };
  const { reply: _reply, ...NOTIFIED } = PINNED;
  const bar: WireFrame = {
    depth: "truecolor",
    rows: [],
    motion: "still",
    nextChange: null,
    pending: [],
  };
  const drawn = (receipt: number) => ({
    session: SESSION,
    frame: {
      kind: "drawn" as const,
      receipt: receipt as EffectId,
      bar,
      handoff: null,
    },
  });
  const dropped = {
    session: SESSION,
    frame: { kind: "failed" as const, message: "no frame drawn" },
  };
  const done = (of: EffectId): EventInput => ({
    ...due,
    event: {
      kind: "effect-done",
      session: SESSION,
      of,
      outcome: { kind: "ok" },
    },
  });
  const reply = async (
    { inputs, link }: ReturnType<typeof rig>,
    child: Child,
    input: EventInput,
    output: Timed<RendererOutput>,
  ) => {
    const outstanding = link.renderer.answer(input);
    await settled();
    child.say({ kind: "output", n: inputs(child).at(-1)!.n, output });
    return outstanding;
  };
  const effect = {
    kind: "copy" as const,
    id: 2 as EffectId,
    session: SESSION,
    text: "copy",
  };

  test("an effect and a drawn frame each settle by their own id despite colliding numbers", async () => {
    const host = rig();
    host.link.arm();
    const child = host.children[0]!;
    child.say(startedLine(9001));
    const output = await reply(host, child, due, {
      ...NOTIFIED,
      effects: [effect],
      frames: [dropped, drawn(1)],
    });
    expect(output.frames[0]).toEqual(dropped);
    const hostEffect = output.effects[0]!.id;
    const hostFrame = output.frames[1]!.frame;
    if (hostFrame.kind !== "drawn") throw new Error("output lost its frame");
    expect(hostFrame.receipt).not.toBe(hostEffect);
    await reply(host, child, done(hostFrame.receipt), NOTIFIED);
    await reply(host, child, done(hostEffect), NOTIFIED);
    expect(
      host
        .inputs(child)
        .slice(1)
        .map(({ input }) => input.event),
    ).toEqual([
      { kind: "effect-done", session: SESSION, of: 1, outcome: { kind: "ok" } },
      { kind: "effect-done", session: SESSION, of: 2, outcome: { kind: "ok" } },
    ]);
    await expect(
      host.link.renderer.answer(done(hostFrame.receipt)),
    ).rejects.toBeInstanceOf(RendererDown);
    expect(host.inputs(child)).toHaveLength(3);
  });

  test("a malformed command allocates no host effect or frame receipt", async () => {
    const host = rig();
    host.link.arm();
    const child = host.children[0]!;
    child.say(startedLine(9001));
    await reply(host, child, pin, {
      ...PINNED,
      effects: [effect],
      frames: [drawn(7)],
    });
    const valid = await reply(host, child, due, {
      ...NOTIFIED,
      frames: [drawn(7)],
    });
    const frame = valid.frames[0]!.frame;
    if (frame.kind !== "drawn") throw new Error("output lost its frame");
    expect(frame.receipt).toBe(1);
  });

  test("a late pane receipt cannot settle a restarted renderer's frame", async () => {
    const host = rig();
    host.link.arm();
    const first = host.children[0]!;
    first.say(startedLine(9001));
    const draw = (child: Child) =>
      reply(host, child, due, { ...NOTIFIED, frames: [drawn(7)] });
    const previous = (await draw(first)).frames[0]!.frame;
    if (previous.kind !== "drawn") throw new Error("the first frame was lost");
    first.exit(CRASHED);
    await settled();
    host.clock.advance(BACKOFF_FIRST_MS);
    const second = host.children[1]!;
    second.say(startedLine(9002));
    const next = (await draw(second)).frames[0]!.frame;
    if (next.kind !== "drawn") throw new Error("the next frame was lost");
    expect(next.receipt).not.toBe(previous.receipt);
    await expect(
      host.link.renderer.answer(done(previous.receipt)),
    ).rejects.toBeInstanceOf(RendererDown);
    expect(host.inputs(second)).toHaveLength(1);
    await reply(host, second, done(next.receipt), NOTIFIED);
    expect(host.inputs(second)[1]!.input.event).toMatchObject({
      kind: "effect-done",
      of: 7,
    });
  });

  test("an effect's id is the host's, and its done goes back by the renderer's", async () => {
    const { link, children, inputs } = rig();
    link.arm();
    const child = children[0]!;
    child.say(startedLine(9001));
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
    const answeredWith: Timed<RendererOutput> = {
      kind: "answered",
      stored: [],
      record: [],
      effects: [effect as never],
      subscriptions: {
        sources: {},
        lanes: {},
        managedFolders: [],
        configSelections: [],
        configs: [],
      },
      wake: null,
      frames: [],
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
    first.say(startedLine(9001));
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
        stored: [],
        record: [],
        effects: [
          { kind: "copy", id: 1 as EffectId, session: SESSION, text: "x" },
        ],
        subscriptions: {
          sources: {},
          lanes: {},
          managedFolders: [],
          configSelections: [],
          configs: [],
        },
        wake: null,
        frames: [],
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
    second.say(startedLine(9002));
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
  test("closing cancels inputs waiting for boot", async () => {
    const { link, clock } = rig();
    link.arm();
    const waiting = link.renderer.answer(pin);
    const closed = link.close();
    await expect(waiting).rejects.toThrow(
      new DaemonClosing("renderer main input"),
    );
    clock.advance(1_000);
    await closed;
  });

  test("its stdin closes, and one that does not end is signalled after the grace", async () => {
    const { link, children, clock } = rig();
    link.arm();
    const child = children[0]!;
    child.say(startedLine(9001));
    await settled();
    const closed = link.close();
    expect(child.stdinEnds).toBe(1);
    expect(child.opts.signal?.aborted).toBe(false);
    clock.advance(1_000);
    await closed;
    expect(child.opts.signal?.aborted).toBe(true);
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new DaemonClosing("renderer main input"),
    );
  });

  test("once the close has begun, the live renderer takes inputs, and one that ends is said and not started again", async () => {
    const { link, children, clock, logs, ends } = rig();
    link.arm();
    const child = children[0]!;
    child.say(startedLine(9001));
    clock.advance(YOUNG_MS);
    await settled();
    expect(link.beginClose()).toBe("closing");
    const heard = child.written.length;
    void link.renderer.answer(pin).catch(() => {});
    await settled();
    expect(child.written.length).toBeGreaterThan(heard);
    expect(child.stdinEnds).toBe(0);
    child.exit(CRASHED);
    await settled();
    clock.advance(BACKOFF_MAX_MS);
    expect(children).toHaveLength(1);
    expect(logs).toContain(
      "renderer main[1] killed by SIGSEGV in the daemon's close",
    );
    expect(ends).toEqual([]);
    await expect(link.renderer.answer(pin)).rejects.toThrow(
      new DaemonClosing("renderer main input"),
    );
    await link.close();
  });

  test("an end in the close is a warning unless the close had ended it and it exited", async () => {
    const early = rig();
    early.link.arm();
    early.children[0]!.say(startedLine(9001));
    await settled();
    early.link.beginClose();
    early.children[0]!.exit(EXITED);
    await settled();
    expect(early.levels.at(-1)).toBe("warn");
    expect(early.logs.at(-1)).toBe(
      "renderer main[1] exited in the daemon's close",
    );
    await early.link.close();

    const asked = rig();
    asked.link.arm();
    asked.children[0]!.say(startedLine(9001));
    await settled();
    const closed = asked.link.close();
    asked.children[0]!.exit(EXITED);
    await closed;
    expect(asked.levels.at(-1)).toBe("info");
    expect(asked.logs.at(-1)).toBe(
      "renderer main[1] exited in the daemon's close",
    );
  });

  test("a boot under way as the close begins ends then, signalled after the grace, and what waited for it is cancelled", async () => {
    const { link, children, clock } = rig();
    link.arm();
    const child = children[0]!;
    const waiting = link.renderer.answer(pin);
    expect(link.beginClose()).toBe("closed");
    expect(child.stdinEnds).toBe(1);
    await expect(waiting).rejects.toThrow(
      new DaemonClosing("renderer main input"),
    );
    clock.advance(CLOSE_GRACE_MS);
    await settled();
    expect(child.opts.signal?.aborted).toBe(true);
    await link.close();
  });

  test("a startup error remains visible after a close begins", async () => {
    let reject = (_error: Error): void => {};
    const starting = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const { link, children, logs, levels } = rig(() => starting);
    link.arm();
    expect(link.beginClose()).toBe("closed");

    reject(new Error("startup data is invalid"));
    await settled();

    const error = logs.findIndex((line) => line.includes("start failed"));
    expect(logs[error]).toContain("startup data is invalid");
    expect(levels[error]).toBe("error");
    children[0]!.exit(EXITED);
    await link.close();
  });

  test("a down renderer's next start never comes once the close has begun", async () => {
    const { link, children, clock } = rig();
    link.arm();
    children[0]!.exit(CRASHED);
    await settled();
    expect(link.beginClose()).toBe("closed");
    clock.advance(BACKOFF_MAX_MS);
    expect(children).toHaveLength(1);
    await link.close();
  });

  test("a renderer the close still waits on is judged by its pings, and stopped once", async () => {
    const { link, children, clock, logs } = rig();
    link.arm();
    const child = children[0]!;
    child.say(startedLine(9001));
    await settled();
    // Its boot's ping is answered, so only a ping sent in the close can judge
    // it.
    const booted = child.written.find((l) => l.kind === "ping");
    child.say({
      kind: "ping",
      n: (booted as { n: number }).n,
      usage: { rss: 5, heapTotal: 3 },
    });
    await settled();
    link.beginClose();
    clock.advance(PING_PERIOD_MS + HUNG_AFTER_MS + PING_PERIOD_MS);
    await settled();
    // The close, inside the end's grace, awaits the stop the end began and
    // begins no second.
    const closed = link.close();
    await stopped(clock, child);
    await closed;
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^renderer main\[1\] stopped answering .* in the daemon's close$/,
      ),
    );
  });
});
