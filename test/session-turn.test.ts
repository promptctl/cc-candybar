// A session's view draws from one turn (candybar-gather-renderer-76bb.6pj.83l):
// the world state, the payload composed from it and the globals the draw's
// options are built from are derived together, so no reader joins one turn's
// document to another's request. A world state that cannot be stamped is a
// value the draw reads, not a line in a log.
//
// [LAW:behavior-not-structure] Each case is a view opened through the daemon's
// own composition (test/helpers/session-rig.ts) and read the way a draw reads
// it; what moves is an owner, a pick, a request or a daemon warning.

import { daemonFactsOf, FILE_EVENTS_STALLED } from "./helpers/daemon-facts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observable, reaction, runInAction } from "mobx";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { presetNames } from "../src/config/presets";
import { assembleFacts } from "../src/daemon/facts-assembly";
import { composePayload } from "../src/renderer/render-payload";
import { settledWorld } from "./helpers/settled";
import type { Readings } from "../src/daemon/readings";
import { readTranscriptLanes } from "./helpers/payload-owners";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { instantOf } from "../src/utils/instant";
import { ABSENT, ok, pendingOf } from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
import type { DaemonFacts } from "../src/facts/world-state";
import { perSetting } from "../src/config/setting-projections";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import {
  AT,
  PROJECT,
  SESSION,
  openSettled,
  requestOf,
  sessionRig,
  settledRequest,
} from "./helpers/session-rig";
import { sessionBar } from "./helpers/session-bar";
import { until } from "./helpers/until";
import { fakeLauncher } from "./helpers/fake-launcher";
import { SourceRuns } from "../src/daemon/source-runs";
import { exits, runsFor, shell } from "../src/proc/spawner-fake";
import { systemTimekeeper } from "../src/time";
import { originOf } from "./helpers/config-host";
import { watchersFor } from "./helpers/background-faults.js";

const SID = sessionIdOf(SESSION);

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-turn-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

describe("one turn", () => {
  test("the payload, the globals and the document read together are of one turn", async () => {
    const depth = observable.box(0);
    const rig = sessionRig(dir, cleanups, {
      source: {
        history: () => ({ undo: depth.get(), redo: 0, sinceEdit: 0 }),
      },
    });
    const view = await openSettled(rig, dir, cleanups, null);

    // A pick and a history move land in one action: the turn that follows
    // holds both, never one of them beside the other's old value.
    runInAction(() => {
      rig.sessionState.set(SID, "preset", "compact");
      depth.set(2);
    });
    const payload = view.source.payload();
    const effective = view.source.effective();
    expect(effective.preset).toBe("compact");
    expect(payload.preset.effective).toBe("compact");
    expect(payload.history.undo).toBe(2);
    expect(view.source.facts().session).toBe(SESSION);
  });

  // Every built-in is declared for every session, so what a pick shows takes
  // no hold, and the repository's read stands through the pick.
  test("a preset pick declares nothing new, and the repository's fact stands", async () => {
    const rig = sessionRig(dir, cleanups);
    let declarations = 0;
    const declare = rig.providers.gitProvider.declare;
    rig.providers.gitProvider.declare = ((
      ...args: Parameters<typeof declare>
    ) => {
      declarations++;
      return declare(...args);
    }) as typeof declare;
    const view = await openSettled(rig, dir, cleanups, "compact");
    await until(
      () => view.source.facts().builtins.git.kind === "ok",
      "the repository's first read",
    );
    const declaredAtOpen = declarations;
    // Every value the git fact takes while the pick lands, in order.
    const seen: string[] = [];
    cleanups.push(
      reaction(
        () => view.source.facts().builtins.git.kind,
        (kind) => seen.push(kind),
        { fireImmediately: true },
      ),
    );
    runInAction(() => rig.sessionState.set(SID, "preset", "git"));
    expect(view.source.effective().preset).toBe("git");
    expect(declarations).toBe(declaredAtOpen);
    expect(seen).toEqual(["ok"]);
  });
});

// The host's name read through `check`, which throws to fail the owners.
const hostThrowing = (check: () => void) => ({
  hostService: {
    declareName: () => {
      const lane = settledLane(ok("tester-box"));
      return {
        ...lane,
        current: () => {
          check();
          return lane.current();
        },
      };
    },
    declareUser: () => settledLane(ok("tester")),
  },
});

describe("a world state that cannot be stamped", () => {
  test("is a failure the draw reads, the last one stays drawn, and the next good stamp clears it", async () => {
    const broken = observable.box(false);
    const logged: string[] = [];
    const changed: string[] = [];
    const rig = sessionRig(dir, cleanups, {
      owners: hostThrowing(() => {
        if (broken.get()) throw new Error("host read exploded");
      }),
      log: (level, message) => logged.push(`${level} ${message}`),
      observers: { onViewChanged: (sid) => changed.push(sid) },
    });
    const view = await openSettled(rig, dir, cleanups, null);
    const before = view.source.payload();
    expect(view.source.failure()).toBeNull();

    // The flip is what wakes the view: a pushed frame says the bar is behind.
    const settled = changed.length;
    runInAction(() => broken.set(true));
    expect(changed.length).toBeGreaterThan(settled);
    expect(view.source.failure()).toContain("host read exploded");
    // The bar is still the last turn's, whole.
    expect(view.source.payload()).toEqual(before);
    expect(logged.join("\n")).toContain("host read exploded");

    const failed = changed.length;
    runInAction(() => broken.set(false));
    expect(changed.length).toBeGreaterThan(failed);
    expect(view.source.failure()).toBeNull();
  });
});

describe("a fault that persists", () => {
  test("is one world state: a later move under the same failure hands in nothing and logs nothing again", async () => {
    const broken = observable.box(false);
    // What the stamp reads beside the failing read, so it stamps again.
    const tick = observable.box(0);
    const logged: string[] = [];
    const changed: string[] = [];
    const rig = sessionRig(dir, cleanups, {
      owners: hostThrowing(() => {
        tick.get();
        if (broken.get()) throw new Error("host read exploded");
      }),
      log: (level, message) => logged.push(`${level} ${message}`),
      observers: { onViewChanged: (sid) => changed.push(sid) },
    });
    const view = await openSettled(rig, dir, cleanups, null);

    runInAction(() => broken.set(true));
    const document = view.source.facts();
    const payload = view.source.payload();
    const lines = logged.length;
    const woken = changed.length;

    runInAction(() => tick.set(1));
    expect(view.source.failure()).toContain("host read exploded");
    expect(view.source.facts()).toBe(document);
    expect(view.source.payload()).toBe(payload);
    expect(logged.length).toBe(lines);
    expect(changed.length).toBe(woken);
  });
});

describe("what wakes a view", () => {
  async function woken() {
    const changed: string[] = [];
    const depth = observable.box(0);
    const warnings = observable.box<DaemonFacts["fileEvents"]>([]);
    const rig = sessionRig(dir, cleanups, {
      daemon: () => daemonFactsOf(warnings.get()),
      source: {
        history: () => ({ undo: depth.get(), redo: 0, sinceEdit: 0 }),
      },
      observers: { onViewChanged: (sid) => changed.push(sid) },
    });
    const view = await openSettled(rig, dir, cleanups, null);
    return { rig, view, changed, depth, warnings };
  }

  test("a history move and a daemon warning each wake it", async () => {
    const { changed, depth, warnings } = await woken();
    const settled = changed.length;
    runInAction(() => depth.set(1));
    expect(changed.length).toBeGreaterThan(settled);

    const afterDepth = changed.length;
    runInAction(() => warnings.set(FILE_EVENTS_STALLED));
    expect(changed.length).toBeGreaterThan(afterDepth);
  });

  test("a request naming other hints wakes it", async () => {
    const { rig, changed } = await woken();
    const settled = changed.length;
    const request = requestOf(dir);
    rig.cache
      .holdSession(originOf(dir, dir, path.join(dir, "config.json5")), {
        ...request,
        hints: { ...request.hints, termCols: 77 },
      })
      [Symbol.dispose]();
    expect(changed.length).toBeGreaterThan(settled);
  });

  test("an owner re-landing what it already held wakes nothing", async () => {
    const { rig, view, changed } = await woken();
    const document = view.source.facts();
    const payload = view.source.payload();
    const settled = changed.length;
    // The transcript lanes are read again: each owner stores an equal answer
    // in a new object.
    await readTranscriptLanes(rig.providers, {
      ...requestOf(dir),
      cwd: PROJECT,
    });
    await settledWorld(
      () => rig.served.worldStates.of(SID),
      () => [...view.registry.namedRuns().values()].map((r) => r.digest),
    );
    expect(view.source.facts()).toBe(document);
    expect(view.source.payload()).toBe(payload);
    expect(changed.length).toBe(settled);
  });
});

describe("the all-pending document", () => {
  const config = parseAndValidate(
    "<user>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const waiting = {
    kind: "pending",
    why: "unread",
    landed: new Promise<void>(() => {}),
  } as const;
  // Every owner has not answered yet.
  const pendingReadings: Readings = {
    lanes: {
      git: waiting,
      usage: pendingOf("unread"),
      context: pendingOf("unread"),
      metrics: pendingOf("unread"),
      activity: pendingOf("unread"),
      tmuxSession: waiting,
      hostName: waiting,
      hostUser: waiting,
      cache: pendingOf("unread"),
      speed: pendingOf("unread"),
      autoCompact: pendingOf("unread"),
      sources: new Map(),
      runs: new Map(),
      env: new Map(),
    },
    today: waiting,
    faults: [],
  };

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    "draws preset %s with the settings menu open",
    (preset) => {
      const picks = (key: string): string | null =>
        key === "preset" ? preset : key === "candybar.menu" ? "open" : null;
      const effective = resolveEffectiveGlobals(config, picks, () => false);
      const document = assembleFacts(
        undefined,
        SID,
        pendingReadings,
        daemonFactsOf(),
        instantOf(new Date(0)),
      );
      // Nothing is known: every fact of the document is pending, and the draw
      // takes each as its loading cell.
      expect(
        Object.values(document.builtins).every((f) => f.kind === "pending"),
      ).toBe(true);
      const bar = sessionBar("{}", 120);
      cleanups.push(() => bar.dispose());
      bar.pick("preset", preset);
      bar.pick("candybar.menu", "open");
      const { frame } = bar.render(
        AT,
        () =>
          composePayload(
            document,
            {
              hookData: requestOf(dir).hookData,
              hints: requestOf(dir).hints,
              home: "/home/tester",
            },
            {
              sources: [],
              effective,
              configFacts: {
                unsaved: 0,
                resettable: perSetting(() => false),
                themeDefault: { differs: false },
                layers: { user: true, project: false, local: false },
                configPath: null,
              },
              history: { undo: 0, redo: 0, sinceEdit: 0 },
              back: 0,
            },
          ) as never,
      );
      expect(frame.rows.length).toBeGreaterThan(0);
    },
  );
});

// A run keyed on a fact that lands after the config turn is named only when
// that fact lands, before the host subscribes it: the request still waits on
// its first read.
describe("a request's wait", () => {
  test("covers a run whose key lands after the request arrived", async () => {
    const rig = sessionRig(dir, cleanups);
    // The run takes real time to answer, so a wait that ended before the host
    // subscribed it would draw it pending.
    const runs = fakeLauncher(systemTimekeeper);
    runs.spawner.program(shell("echo hi"), runsFor(30, exits(0, "hi\n")));
    const sourceRuns = new SourceRuns({
      watchers: watchersFor(systemTimekeeper),
      launcher: runs.launcher,
      clock: systemTimekeeper,
    });
    cleanups.push(() => sourceRuns.close());
    rig.providers.sourceRuns = sourceRuns;
    // The repository lands after the request's own refresh has, as a real
    // read of it does, so the key moves while the wait is already listening.
    const landed = observable.box(false);
    setTimeout(() => runInAction(() => landed.set(true)), 20);
    const declare = rig.providers.gitProvider.declare;
    rig.providers.gitProvider.declare = ((
      ...args: Parameters<typeof declare>
    ) => {
      const lane = declare(...args);
      return {
        current: () =>
          landed.get()
            ? lane.current()
            : {
                kind: "pending",
                why: "unread",
                landed: until(() => landed.get(), "git"),
              },
      };
    }) as typeof declare;
    const configFile = path.join(dir, "config.json5");
    fs.writeFileSync(
      configFile,
      `{ variables: { branchy: { kind: "shell", command: "echo hi", cache: { key: "{{ .git.branch }}" } } },
         segments: { mine: { template: "b={{ .branchy }}" } }, root: { h: ["mine"] } }`,
    );
    const view = await settledRequest(rig, dir, configFile, cleanups);
    const run = view.registry.namedRuns().get("branchy");
    expect(run).toBeDefined();
    expect(view.source.run(run!.digest).reading).toMatchObject({
      kind: "ok",
    });
  });
});
