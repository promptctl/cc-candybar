import { observable, runInAction } from "mobx";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { createGates } from "../../src/daemon/foundations/gates";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  BadVerbArgs,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import { rendererHost } from "../../src/daemon/renderer-host";
import {
  timed,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { StoreWrite } from "../../src/renderer-interface/stored-state";
import {
  rendererOverLines,
  serveRenderer,
} from "../../src/renderer-interface/wire";
import { mainRenderer } from "../../src/renderer/main";
import { RenderCache, SOURCES_NOTHING } from "../../src/renderer/render-cache";
import { SessionState } from "../../src/renderer/session-state";
import { SettingsHistory } from "../../src/renderer/settings-history";
import { WorldStates } from "../../src/renderer/world-states";
import { readingsAt } from "../../src/utils/instant";
import { fieldsOf } from "../../src/utils/logfmt";
import { heldClock } from "../helpers/held-clock";
import { NO_LAYERS } from "../helpers/history-step";
import { inertHost, rendererParts } from "../helpers/renderer-parts";
import { NO_ACTS } from "../helpers/renderers";

const SESSION = sessionIdOf("session");
const SOURCES: Subscriptions["sources"] = {
  [SESSION]: [{ kind: "env", name: "UNCHANGED" }],
};

function rig(
  fault: {
    readonly state?: () => void;
    readonly history?: () => void;
    readonly subscriptions?: () => void;
    readonly prune?: () => void;
    readonly push?: () => void;
  } = {},
) {
  const clock = heldClock(new Date(0));
  const state = new SessionState();
  const history = new SettingsHistory(state, () => {});
  const adapter = inertHost();
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
  const renderer = mainRenderer(
    parts,
    () => {
      fault.push?.();
      return { kind: "close-journal" };
    },
    {
      "session-state": () => {
        fault.state?.();
        return state.drain();
      },
      "settings-history": () => {
        fault.history?.();
        return history.drain();
      },
    },
  );
  // Both normal events and pushes go through the actual negotiated JSON
  // transport before the same mailbox that lands production output.
  const pipe = rendererOverLines({
    send: (input) => receive(JSON.parse(JSON.stringify(input))),
    host: adapter,
    fault: (message) => {
      throw new Error(message);
    },
  });
  const receive = serveRenderer({
    renderer: timed(renderer, clock.monotonic),
    send: (line) => pipe.heard(JSON.parse(JSON.stringify(line))),
    memory: () => {
      throw new Error("unexpected memory probe");
    },
    heapSnapshot: () => {
      throw new Error("unexpected heap snapshot");
    },
  });
  const stored: Array<readonly StoreWrite[]> = [];
  const subscriptions: Subscriptions[] = [];
  const logged: string[] = [];
  const host = rendererHost(
    MAIN_RENDERER,
    clock,
    pipe.renderer,
    (_level, line) => logged.push(line),
    {
      subscribed: (next) => subscriptions.push(next),
      stored: (writes) => stored.push(writes),
      holding: () => () => {},
      recorded: () => {},
      frames: () => {},
    },
    NO_ACTS,
  );
  const due = (work: () => void = () => {}) => {
    parts.time.during(readingsAt(clock), () => parts.time.after(0, work));
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
    logged,
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
    fixture.logged.map((line) =>
      fieldsOf(line).get("finalize.settings-history"),
    ),
  ).toEqual([expect.stringContaining("history drain failed")]);
  historyFailed = false;
  expect(await fixture.due()).toMatchObject({ kind: "answered" });
  expect(fixture.stored).toEqual([
    [{ store: "session-state", key: SESSION, value: { theme: "nord" } }],
    [{ store: "session-state", key: SESSION, value: { theme: "dracula" } }],
    [],
  ]);
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
    fixture.time.after(2_000, wake);
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
      store: "settings-history",
      key: SESSION,
      value: {
        past: [
          [{ kind: "session", key: "theme", before: null, after: "nord" }],
        ],
        future: [],
      },
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
  // A push settles after the scheduled turn. It sees nothing left to write
  // from the successful part of the failed turn.
  await fixture.host.ask({ kind: "close-journal" });
  expect(fixture.stored.slice(2)).toEqual([
    [{ store: "session-state", key: SESSION, value: { theme: "nord" } }],
    [],
  ]);
  fixture.host.closeWake();
});

test("a failed push still lands current writes and carries the second failure to its caller", async () => {
  const primary = new BadVerbArgs(
    "invalid push\ntook=999ms finalize.settings-history=spoofed",
  );
  const fixture = rig({
    push: () => {
      throw primary;
    },
    history: () => {
      throw new Error("push history drain failed");
    },
  });
  fixture.setTheme("nord");
  const failure = await fixture.host.ask({ kind: "close-journal" }).then(() => {
    throw new Error("expected this push to fail");
  }, failureOf);
  expect(failure).toMatchObject({
    kind: "bad-request",
    message: expect.stringContaining("invalid push"),
  });
  const fields = fieldsOf(failure.detail);
  expect(fields.get("took")).toBe("0ms");
  expect(fields.get("error")).toBe(failureOf(primary).detail);
  expect(fields.get("finalize.settings-history")).toContain(
    "push history drain failed",
  );
  expect(fixture.stored).toEqual([
    [{ store: "session-state", key: SESSION, value: { theme: "nord" } }],
  ]);
});

test("a successful push reports its first finalizer failure and lands its successful drain", async () => {
  let blocked = true;
  const fixture = rig({
    history: () => {
      if (blocked) throw new Error("push history drain failed");
    },
  });
  fixture.setTheme("nord");
  await expect(
    fixture.host.ask({ kind: "close-journal" }),
  ).rejects.toMatchObject({
    failure: {
      kind: "threw",
      message: expect.stringContaining("push history drain failed"),
    },
  });
  blocked = false;
  expect(await fixture.host.ask({ kind: "close-journal" })).toEqual({
    kind: "close-journal",
  });
  expect(fixture.stored).toEqual([
    [{ store: "session-state", key: SESSION, value: { theme: "nord" } }],
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
