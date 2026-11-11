// [LAW:dataflow-not-control-flow] Every built-in is gathered for every
// session, whatever the config's layout reads: what a session is shown never
// changes what is read for it. Each case is a view opened through the daemon's
// own composition (test/helpers/session-rig.ts) under a config whose layout
// places no segment, over owners that answer one fixed world.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkNodes } from "../src/config/dsl-types";
import { presetRoot } from "../src/config/presets";
import type { Refreshed } from "../src/daemon/render-payload";
import { REFRESH_LANES } from "../src/daemon/refresh-faults";
import { sessionRig, settledRequest } from "./helpers/session-rig";
import { until } from "./helpers/until";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-total-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// A wrapper of an owner's declaration that names its lane in `declared` each
// time it is taken.
function naming<A extends unknown[], R>(
  declared: string[],
  lane: string,
  declare: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    declared.push(lane);
    return declare(...args);
  };
}

// The rig's view of a config placing no segment, its keyed owners naming each
// lane they declare, and a request's refresh of it, as the daemon makes one.
async function bare() {
  const rig = sessionRig(dir, cleanups);
  const declared: string[] = [];
  const { gitProvider, tmuxService, hostService, usageStore } = rig.providers;
  gitProvider.declare = naming(declared, "git", gitProvider.declare);
  tmuxService.declare = naming(declared, "tmux", tmuxService.declare);
  hostService.declareName = naming(
    declared,
    "host.name",
    hostService.declareName,
  );
  hostService.declareUser = naming(
    declared,
    "host.user",
    hostService.declareUser,
  );
  usageStore.declareToday = naming(declared, "today", usageStore.declareToday);
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, "{ root: { h: [] } }");
  const refreshed: Refreshed = new Map();
  const view = await settledRequest(rig, dir, configFile, cleanups, refreshed);
  return { view, declared, refreshed };
}

describe("totality: a layout placing no segment still gathers every built-in", () => {
  test("the config it is opened with loaded, and places no segment of its own", async () => {
    const { view } = await bare();
    const { config } = view.state;
    const placed = [
      ...walkNodes(presetRoot(config, view.source.effective().preset).node),
    ].flatMap((node) => (node.kind === "segment" ? [node.name] : []));
    // Only the settings menu and edit bar synthesis gives every config: the
    // bundled default, drawn when a config fails to load, places its own.
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.filter((name) => !/^(candybar|edit)\./.test(name))).toEqual(
      [],
    );
  });

  test("its session declares every keyed lane once", async () => {
    const { declared } = await bare();
    expect(declared.sort()).toEqual(
      ["git", "host.name", "host.user", "tmux", "today"].sort(),
    );
  });

  test("a request refreshes every stamp-gated lane", async () => {
    const { refreshed } = await bare();
    expect([...refreshed.keys()].sort()).toEqual([...REFRESH_LANES].sort());
  });

  test("its world state has every built-in answered once the owners answer", async () => {
    const { view } = await bare();
    const kinds = () =>
      Object.fromEntries(
        Object.entries(view.source.facts().builtins).map(([name, fact]) => [
          name,
          fact.kind,
        ]),
      );
    await until(
      () => Object.values(kinds()).every((kind) => kind !== "pending"),
      () => `every built-in answered: ${JSON.stringify(kinds())}`,
    );
    // What each of the rig's owners answers.
    expect(kinds()).toEqual({
      activity: "failed",
      autocompact: "ok",
      cache: "ok",
      context: "ok",
      git: "ok",
      hostName: "ok",
      hostUser: "ok",
      metrics: "ok",
      pr: "ok",
      session: "ok",
      speed: "absent",
      tmux: "ok",
      today: "ok",
    });
  });
});
