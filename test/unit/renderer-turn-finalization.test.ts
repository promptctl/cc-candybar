import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
import { observable, runInAction } from "mobx";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { createGates } from "../../src/daemon/foundations/gates";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { rendererFailureOf, BadVerbArgs,
  CrossedFailure } from "../../src/daemon/foundations/verb-error";
import { failureOf } from "../../src/daemon/foundations/host-failure";
import { rendererHost } from "../../src/daemon/renderer-host";
import {
  timed,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { StoreWrite } from "../../src/renderer-interface/stored-state";
import {
  rendererOverLines,
  serveRenderer,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import { mainRenderer } from "../../src/renderer/main";
import { RenderCache, SOURCES_NOTHING } from "../../src/renderer/render-cache";
import { SessionState } from "../../src/renderer/session-state";
import { SettingsHistory } from "../../src/renderer/settings-history";
import { WorldStates } from "../../src/renderer/world-states";
import { readingsAt } from "../../src/utils/instant";
import { fieldsOf } from "../../src/utils/logfmt";
import type { DaemonLogger, LogLine } from "../../src/utils/logger";
import { heldClock } from "../helpers/held-clock";
import { NO_LAYERS } from "../helpers/history-step";
import { rendererParts } from "../helpers/renderer-parts";
import { NO_ACTS } from "../helpers/renderers";

const SESSION = sessionIdOf("session");
const SOURCES: Subscriptions["sources"] = {
  [SESSION]: [{ kind: "env", name: "UNCHANGED" }],
};

function rig(
  fault: {
    readonly state?: () => void;
    readonly history?: (say: DaemonLogger) => void;
    readonly subscriptions?: () => void;
    readonly prune?: () => void;
    readonly closeJournal?: (say: DaemonLogger) => void;
    readonly rendererClock?: () => number;
  } = {},
) {
  const clock = heldClock(new Date(0));
  const state = new SessionState();
  const history = new SettingsHistory(state, () => {});
  const cache = new (class extends RenderCache {
    override subscriptions() {
      fault.subscriptions?.();
      return { sources: SOURCES };
    }
    override prune(keep: ReadonlySet<string>) {
      fault.prune?.();
      super.prune(keep);
    }
  })(
    {
      region: SAMPLE_REGION,
      editRevision: () => null,
      clock,
      locations: {
        home: "/home",
        configHome: "/config",
        dataHome: "/data",
        dataDirs: [],
      },
      sessionState: state,
      gates: createGates(),
      source: SOURCES_NOTHING,
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  const parts = rendererParts({
    cache,
    sessionState: state,
    worldStates: new WorldStates(),
  });
  const say = parts.turnLog.add;
  const renderer = mainRenderer(
    {
      ...parts,
      configWrites: { close: () => fault.closeJournal?.(say) },
    },
    {
      navigation: { drain: () => [] },
      draft: { drain: () => [] },
      "session-state": {
        heard: (session) => state.heard(session),
        drain: () => {
          fault.state?.();
          return state.drain();
        },
      },
      "settings-history": {
        heard: (session) => history.heard(session),
        drain: () => {
          fault.history?.(say);
          return history.drain();
        },
      },
    },
  );
  // Events and commands go through the actual negotiated JSON
  // transport before the same mailbox that lands production output.
  const pipe = rendererOverLines({
    observed: () => {},
    send: (input) => receive(JSON.parse(JSON.stringify(input))),
    fault: (message) => {
      throw new Error(message);
    },
  });
  const lines: RendererLine[] = [];
  const logged: LogLine[] = [];
  const receive = serveRenderer({
    observe: () => { throw new Error("unexpected session commit"); },
    renderer: timed(renderer, fault.rendererClock ?? clock.monotonic, (line) => {
      logged.push({ level: "warn", line });
    }),
    send: (line) => {
      const crossed = JSON.parse(JSON.stringify(line)) as RendererLine;
      lines.push(crossed);
      pipe.heard(crossed);
    },
    memory: () => {
      throw new Error("unexpected memory probe");
    },
    heapSnapshot: () => {
      throw new Error("unexpected heap snapshot");
    },
  });
  const stored: Array<readonly StoreWrite[]> = [];
  const subscriptions: Subscriptions[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clock,
    pipe.renderer,
    (level, line) => logged.push({ level, line }),
    {
      subscribed: (next) => subscriptions.push(next),
      prepare: (writes) => () => stored.push(writes),
      holding: () => () => {},
      recorded: () => {},
      frames: () => {},
    },
    NO_ACTS,
  );
  const due = (work: () => void = () => {}) => {
    parts.time.during(readingsAt(clock), () => parts.time.after("test task", 0, work));
    return host.deliver(() => ({ kind: "event", event: { kind: "due" } }), []);
  };
  const setTheme = (theme: string) => state.set(SESSION, "theme", theme);
  const journalTheme = (theme: string) => {
    const journal = history.begin(NO_LAYERS);
    journal.sessionState.set(SESSION, "theme", theme);
    journal.commit();
  };
  return {
    cache,
    clock,
    due,
    host,
    journalTheme,
    lines,
    logged,
    renderer,
    say,
    setTheme,
    stored,
    subscriptions,
    time: parts.time,
  };
}

test("a failed body keeps its classification and the writes already drained", async () => {
  let historyFailed = false;
  const fixture = rig({
    history: () => {
      if (historyFailed) throw new Error("history drain failed");
    },
  });
  expect(await fixture.due(() => fixture.setTheme("nord"))).toMatchObject({
    kind: "answered",
  });
  const failed = await fixture.due(() => {
    fixture.setTheme("dracula");
    historyFailed = true;
    throw new BadVerbArgs("invalid menu choice");
  });
  expect(failed).toMatchObject({
    kind: "threw",
    failure: { kind: "bad-request", message: "invalid menu choice" },
    secondary: [
      {
        stage: "settings-history",
        failure: { kind: "threw", message: "history drain failed" },
      },
    ],
  });
  expect(
    fixture.logged.map(({ line }) =>
      fieldsOf(line).get("finalize.settings-history"),
    ),
  ).toEqual([expect.stringContaining("history drain failed")]);
  historyFailed = false;
  expect(await fixture.due()).toMatchObject({ kind: "answered" });
  expect(fixture.stored).toEqual([
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "nord" } }],
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "dracula" } }],
    [],
  ]);
});

test("a failed end-clock read logs a transport warning and leaves semantic diagnostics intact", async () => {
  let reads = 0;
  const fixture = rig({
    rendererClock: () => {
      if (++reads === 2) throw new Error("end clock failed");
      return 0;
    },
  });
  const result = await fixture.due(() => {
    fixture.say("info", "menu opened");
    fixture.setTheme("nord");
  });
  expect(result).toMatchObject({ kind: "answered", turnMs: null });
  expect(fixture.stored).toEqual([
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "nord" } }],
  ]);
  const line = fixture.lines[0];
  expect(line?.kind === "output" && line.output.diagnostics).toEqual([
    { level: "info", line: "menu opened" },
  ]);
  expect(fixture.logged).toEqual([
    {
      level: "warn",
      line: "renderer turn timing failed: Error: end clock failed",
    },
    { level: "info", line: "menu opened" },
  ]);
  expect(await fixture.due()).toMatchObject({ kind: "answered", turnMs: 0 });
  expect(fixture.logged).toHaveLength(2);
});

test("a nested input refusal preserves the active turn's clock and diagnostics", async () => {
  const fixture = rig();
  let nested: Promise<void> | undefined;
  const result = await fixture.due(() => {
    const readings = readingsAt(fixture.clock);
    fixture.say("info", "outer work began");
    nested = expect(
      fixture.renderer.answer({
        ...readings,
        kind: "event",
        event: { kind: "due" },
      }),
    ).rejects.toThrow("renderer diagnostics already in scope");
    expect(fixture.time.at).toBe(readings.at);
    expect(fixture.time.tick).toBe(readings.tick);
    fixture.say("info", "outer work ended");
  });
  await nested;
  expect(result).toMatchObject({ kind: "answered" });
  expect(fixture.logged).toEqual([
    { level: "info", line: "outer work began" },
    { level: "info", line: "outer work ended" },
  ]);
});

test("turn diagnostics cross only with their answer and land once in order", async () => {
  const opened: LogLine = { level: "info", line: "menu opened" };
  const refused: LogLine = { level: "warn", line: "menu choice refused" };
  const drained: LogLine = {
    level: "info",
    line: "history drained after refusal",
  };
  const closing: LogLine = { level: "error", line: "view remained held" };
  let badClick = false;
  const fixture = rig({
    history: (say) => {
      if (badClick) say(drained.level, drained.line);
    },
    closeJournal: (say) => {
      say(closing.level, closing.line);
      throw new Error("close failed");
    },
  });
  await fixture.due(() => fixture.say(opened.level, opened.line));
  badClick = true;
  expect(
    await fixture.due(() => {
      fixture.say(refused.level, refused.line);
      throw new BadVerbArgs("invalid menu choice");
    }),
  ).toMatchObject({ kind: "threw", failure: { kind: "bad-request" } });
  badClick = false;
  await fixture.due();
  await expect(fixture.host.command({ kind: "close-journal" })).rejects.toThrow(
    "close failed",
  );

  expect(fixture.lines.map(({ kind }) => kind)).toEqual(
    Array(4).fill("output"),
  );
  expect(
    fixture.lines.flatMap((line) =>
      line.kind === "output" ? [line.output.diagnostics] : [],
    ),
  ).toEqual([[opened], [refused, drained], undefined, [closing]]);
  expect(
    fixture.logged.filter(({ line }) => !line.startsWith("turn ")),
  ).toEqual([opened, refused, drained, closing]);
});

test("the first failure in collection still lands history, holds subscriptions, and arms the wake", async () => {
  const blocked = observable.box(false);
  let rejectState = false;
  const fixture = rig({
    state: () => {
      if (rejectState) throw new Error("session state drain failed");
    },
    subscriptions: () => {
      if (blocked.get()) throw new Error("subscription read failed");
    },
  });
  expect(await fixture.due()).toMatchObject({ kind: "answered" });
  let wake = (): void => {};
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const failed = await fixture.due(() => {
    fixture.journalTheme("nord");
    fixture.time.after("test task", 2_000, wake);
    rejectState = true;
    runInAction(() => blocked.set(true));
  });
  expect(failed).toMatchObject({
    kind: "threw",
    failure: { kind: "threw", message: "session state drain failed" },
    secondary: [
      {
        stage: "subscriptions",
        failure: { message: "subscription read failed" },
      },
    ],
  });
  expect(fixture.stored[1]).toEqual([
    {
      kind: "steps", store: "settings-history", key: SESSION,
      edits: [{ kind: "append", step: [{ kind: "session", key: "theme", before: null, after: "nord" }] }],
    },
  ]);
  expect(fixture.subscriptions.map(({ sources }) => sources)).toEqual([
    SOURCES,
  ]);
  expect(fixture.clock.pending()).toBe(1);
  rejectState = false;
  runInAction(() => blocked.set(false));
  fixture.clock.advance(2_000);
  await woke;
  // A command settles after the scheduled turn. It sees nothing left to write
  // from the successful part of the failed turn.
  await fixture.host.command({ kind: "close-journal" });
  expect(fixture.stored.slice(2)).toEqual([
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "nord" } }],
    [],
  ]);
  fixture.host.closeWake();
});

test("a failed command lands writes and carries both failures without runtime frames", async () => {
  const primary = Object.assign(
    new BadVerbArgs(
      "invalid command\ntook=999ms finalize.settings-history=spoofed",
    ),
    { note: "/project/authored.json5:19:3" },
  );
  const fixture = rig({
    closeJournal: () => {
      throw primary;
    },
    history: () => {
      throw new AggregateError(
        [
          new RangeError("too many entries", {
            cause: new TypeError("bad count"),
          }),
        ],
        "command history drain failed",
      );
    },
  });
  fixture.setTheme("nord");
  const failure = await fixture.host.command({ kind: "close-journal" }).then(() => {
    throw new Error("expected this command to fail");
  }, failureOf);
  expect(failure).toMatchObject({
    kind: "bad-request",
    message: expect.stringContaining("invalid command"),
  });
  const fields = fieldsOf(failure.detail);
  expect(fields.get("took")).toBe("0ms");
  expect(fields.get("error")).toBe(
    `BadVerbArgs: ${primary.message}\nnote: '/project/authored.json5:19:3'`,
  );
  expect(fields.get("finalize.settings-history")).toBe(
    [
      "threw: AggregateError: command history drain failed",
      "errors[0]: RangeError: too many entries",
      "cause: TypeError: bad count",
    ].join("\n"),
  );
  expect(failureOf(primary).detail).toContain("\n    at ");
  expect(fixture.stored).toEqual([
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "nord" } }],
  ]);
});

test("a renderer answer preserves explicit crossed failure details", async () => {
  const report = async (detail: string) => {
    const original = {
      kind: "threw",
      message: "authored config failed",
      detail,
    } as const;
    const fixture = rig({
      state: () => {
        throw new CrossedFailure(original);
      },
    });
    const output = await fixture.due();
    if (output.kind !== "threw") throw new Error("the failed turn succeeded");
    expect(output.failure).toEqual(original);
    return output.failure;
  };
  const first = await report(
    "invalid scalar\n    at /project/settings.json5:19:3",
  );
  const second = await report(
    "invalid scalar\n    at /project/settings.json5:20:3",
  );
  expect(second.message).toBe(first.message);
  expect(second.detail).not.toBe(first.detail);
});

test("nested errors have portable details even inside a cyclic cause object", async () => {
  const fail = async (worker: string) => {
    const nested = new TypeError("invalid parsed value");
    nested.stack = `TypeError: invalid parsed value\n    at ${worker}:17:3`;
    const cause = {
      pathname: "/project/recorded.json5:25:4",
      faults: [nested],
    };
    Object.assign(cause, { same: cause });
    const fixture = rig({
      state: () => {
        throw new Error("could not build row", { cause });
      },
    });
    const output = await fixture.due();
    if (output.kind !== "threw") throw new Error("the failed turn succeeded");
    return output.failure.detail;
  };
  const first = await fail("/one/renderer.mjs");
  expect(await fail("/other/renderer.mjs")).toBe(first);
  expect(first).toContain("TypeError: invalid parsed value");
  expect(first).toContain("/project/recorded.json5:25:4");
  expect(first).toContain("[Circular");
});

test("a successful command reports its first finalizer failure and lands its successful drain", async () => {
  let blocked = true;
  const fixture = rig({
    history: () => {
      if (blocked) throw new Error("command history drain failed");
    },
  });
  fixture.setTheme("nord");
  await expect(
    fixture.host.command({ kind: "close-journal" }),
  ).rejects.toMatchObject({
    failure: {
      kind: "threw",
      message: expect.stringContaining("command history drain failed"),
    },
  });
  blocked = false;
  expect(await fixture.host.command({ kind: "close-journal" })).toEqual({
    kind: "close-journal",
  });
  expect(fixture.stored).toEqual([
    [{ kind: "patch", store: "session-state", key: SESSION, changes: { theme: "nord" } }],
    [],
  ]);
});

test("a failed prune of an offered config is retried even when the declared origins stay the same", async () => {
  let blocked = false;
  const fixture = rig({
    prune: () => {
      if (blocked) throw new Error("config prune failed");
    },
  });
  const origin: RenderOrigin = {
    cwd: "/unused",
    projectDir: "/unused",
    target: { source: "search" },
  };
  const config: ConfigSnapshot = {
    chain: [],
    repo: null,
    plugins: [],
    strays: [],
    checkout: { root: origin.projectDir, git: false },
    notices: [],
    watch: null,
  };
  expect(await fixture.due()).toMatchObject({ kind: "answered" });
  blocked = true;
  expect(
    await fixture.host.deliver(
      () => ({ kind: "event", event: { kind: "config", origin, config } }),
      [],
    ),
  ).toMatchObject({
    kind: "threw",
    failure: { message: "config prune failed" },
  });
  expect(fixture.cache.holdsConfig(origin)).toBe(true);
  blocked = false;
  expect(await fixture.due()).toMatchObject({ kind: "answered" });
  expect(fixture.cache.holdsConfig(origin)).toBe(false);
  expect(fixture.subscriptions.map(({ configs }) => configs)).toEqual([[]]);
});

test("projecting a thrown value never evaluates its metadata accessors", () => {
  const get = jest.fn(() => { throw new Error("side effect in diagnostic"); });
  const error = Object.defineProperties(new Error("authored"), {
    cause: { get }, metadata: { value: Object.defineProperty({}, "value", { enumerable: true, get }), enumerable: true },
  });
  expect(rendererFailureOf(error).detail).toContain("value: [Accessor]");
  expect(get).not.toHaveBeenCalled();
});

test("native exceptions and uninspectable objects keep an answer", () => {
  expect(rendererFailureOf(new DOMException("Disconnect", "AbortError"))).toMatchObject({ message: "Disconnect", detail: "AbortError: Disconnect" });
  expect(rendererFailureOf(new Proxy(new Map(), {})).detail).toContain("Uninspectable");
  const re = Object.defineProperty(/foo/g, "source", { get() { throw new Error("getter"); } });
  expect(rendererFailureOf(re).detail).toBe("/foo/g");
});

test("each aggregate slot counts against the diagnostic budget", () => {
  const values = new Array(10000);
  for (let i = 0; i < values.length; i++)
    Object.defineProperty(values, i, { get() { throw new Error("unread"); } });
  const descriptor = jest.fn(Reflect.getOwnPropertyDescriptor);
  const error = Object.assign(new AggregateError([]), { errors: new Proxy(values, { getOwnPropertyDescriptor: descriptor }) });
  expect(rendererFailureOf(error).detail).toContain("…");
  expect(descriptor.mock.calls.length).toBeLessThanOrEqual(100);
});
