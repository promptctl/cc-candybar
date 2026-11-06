// A session's view draws from one turn (candybar-gather-renderer-76bb.6pj.83l):
// the facts document, the payload composed from it and the globals the draw's
// options are built from are stamped together, so no reader joins one turn's
// document to another's request. A turn that cannot be stamped is a value the
// draw reads, not a line in a log, and a view that fails to open leaves
// nothing running.
//
// [LAW:behavior-not-structure] Each case is a view opened through the daemon's
// own composition (test/helpers/session-rig.ts) and read the way a draw reads
// it; what moves is an owner, a pick, a request or the update fact.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observable, reaction, runInAction } from "mobx";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { presetNames } from "../src/config/presets";
import { assembleFacts } from "../src/daemon/facts-assembly";
import {
  composePayload,
  settlePayload,
  type Readings,
} from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { instantOf } from "../src/utils/instant";
import { pendingOf } from "../src/utils/outcome";
import type { Fact } from "../src/facts/fact";
import type { UpdateNotice } from "../src/facts/session-facts";
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
} from "./helpers/session-rig";
import { sessionBar } from "./helpers/session-bar";
import { until } from "./helpers/until";

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
      rig.sessionState.set(SESSION, "preset", "compact");
      depth.set(2);
    });
    const payload = view.source.payload();
    const effective = view.source.effective();
    expect(effective.preset).toBe("compact");
    expect(payload.preset.effective).toBe("compact");
    expect(payload.history.undo).toBe(2);
    expect(view.source.facts().session).toBe(SESSION);
  });
});

describe("a turn that cannot be stamped", () => {
  test("is a failure the draw reads, the last turn stays drawn, and the next good turn clears it", async () => {
    const broken = observable.box(false);
    const logged: string[] = [];
    const changed: string[] = [];
    const rig = sessionRig(dir, cleanups, {
      update: () => {
        if (broken.get()) throw new Error("update watch exploded");
        return pendingOf("unread");
      },
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
    expect(view.source.failure()).toContain("update watch exploded");
    // The bar is still the last turn's, whole.
    expect(view.source.payload()).toEqual(before);
    expect(logged.join("\n")).toContain("update watch exploded");

    const failed = changed.length;
    runInAction(() => broken.set(false));
    expect(changed.length).toBeGreaterThan(failed);
    expect(view.source.failure()).toBeNull();
  });
});

describe("a fault that persists", () => {
  test("is one fault: a later landing that fails the same way wakes nobody and logs nothing again", async () => {
    const broken = observable.box(false);
    // What the facts source reads of the update: a landing is a move of it.
    const landings = observable.box(0);
    const logged: string[] = [];
    const changed: string[] = [];
    const rig = sessionRig(dir, cleanups, {
      update: () => {
        landings.get();
        if (broken.get()) throw new Error("update watch exploded");
        return pendingOf("unread");
      },
      log: (level, message) => logged.push(`${level} ${message}`),
      observers: { onViewChanged: (sid) => changed.push(sid) },
    });
    const view = await openSettled(rig, dir, cleanups, null);

    runInAction(() => broken.set(true));
    const payload = view.source.payload();
    const lines = logged.length;
    const woken = changed.length;

    runInAction(() => landings.set(1));
    expect(view.source.failure()).toContain("update watch exploded");
    expect(view.source.payload()).toBe(payload);
    expect(logged.length).toBe(lines);
    expect(changed.length).toBe(woken);
  });
});

describe("a view that fails to open", () => {
  test("is reported, and what it began is released: a later pick declares nothing", () => {
    const rig = sessionRig(dir, cleanups, {
      update: () => {
        throw new Error("no update fact");
      },
    });
    let declarations = 0;
    const declare = rig.providers.gitProvider.declare;
    rig.providers.gitProvider.declare = ((...args: Parameters<typeof declare>) => {
      declarations++;
      return declare(...args);
    }) as typeof declare;
    const configFile = path.join(dir, "config.json5");
    fs.writeFileSync(configFile, "{}");

    expect(() =>
      rig.cache.holdSession(dir, dir, configFile, requestOf(dir)),
    ).toThrow(/no update fact/);
    const declaredAtOpen = declarations;

    // The view's preset reaction would redeclare on this pick if it ran on.
    runInAction(() => rig.sessionState.set(SESSION, "preset", "git"));
    expect(declarations).toBe(declaredAtOpen);
  });
});

describe("what wakes a view", () => {
  async function woken() {
    const changed: string[] = [];
    const depth = observable.box(0);
    const update = observable.box<Fact<UpdateNotice>>(pendingOf("unread"));
    const rig = sessionRig(dir, cleanups, {
      source: {
        history: () => ({ undo: depth.get(), redo: 0, sinceEdit: 0 }),
      },
      update: () => update.get(),
      observers: { onViewChanged: (sid) => changed.push(sid) },
    });
    const view = await openSettled(rig, dir, cleanups, null);
    return { rig, view, changed, depth, update };
  }

  test("a history move and an update move each wake it", async () => {
    const { changed, depth, update } = await woken();
    const settled = changed.length;
    runInAction(() => depth.set(1));
    expect(changed.length).toBeGreaterThan(settled);

    const afterDepth = changed.length;
    runInAction(() => update.set({ kind: "absent", at: AT }));
    expect(changed.length).toBeGreaterThan(afterDepth);
  });

  test("a request naming other hints wakes it", async () => {
    const { rig, changed } = await woken();
    const settled = changed.length;
    const request = requestOf(dir);
    rig.cache.holdSession(dir, dir, path.join(dir, "config.json5"), {
      ...request,
      hints: { ...request.hints, termCols: 77 },
    })[Symbol.dispose]();
    expect(changed.length).toBeGreaterThan(settled);
  });

  test("an owner re-landing what it already held wakes nothing", async () => {
    const { rig, view, changed } = await woken();
    const document = view.source.facts();
    const payload = view.source.payload();
    const settled = changed.length;
    // The same request refreshes every lane again: each owner stores an equal
    // answer in a new object.
    await view.settle(AT).landed;
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
  const waiting = { kind: "pending", why: "unread", landed: new Promise<void>(() => {}) } as const;
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
    },
    today: waiting,
    runs: new Map(),
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
        sessionIdOf(SESSION),
        pendingReadings,
        pendingOf("unread"),
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
      const { frame } = bar.render(AT, () =>
        composePayload(
          document,
          {
            hookData: requestOf(dir).hookData,
            hints: requestOf(dir).hints,
            home: "/home/tester",
          },
          {
            effective,
            configFacts: {
              unsaved: 0,
              resettable: perSetting(() => false),
              themeDefault: { differs: false },
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
