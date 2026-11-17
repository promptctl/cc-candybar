// [LAW:verifiable-goals] The host's config discovery
// (src/daemon/config-discovery/config-discovery.ts): it follows exactly the
// origins the renderer names, each discovered once as it is first named and
// let go with its watch when it is not; a landing discovers again only the
// origins whose chain holds a written file and answers those that moved; a
// hand edit an origin's watch hears moves that origin; and an answer to the
// trust book moves every origin with a repository to ask about.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST } from "./helpers/host";
import { answerRepo } from "./helpers/repo-approval";
import { untilHeard } from "./helpers/reload-signal";
import { originOf } from "./helpers/config-host";
import { originKey, type RenderOrigin } from "../src/config-hint";
import { ConfigDiscovery } from "../src/daemon/config-discovery/config-discovery";
import {
  WatcherRegistry,
  type WatcherCounters,
} from "../src/daemon/cache/watchers";
import { locations, stateDir } from "../src/daemon/paths";
import { systemTimekeeper } from "../src/time";

let root: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-discovery-")),
  );
  cleanups = [];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  fs.rmSync(root, { recursive: true, force: true });
});

// A project directory under the test's root.
function project(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// An origin in its own project directory whose `--config` names a file
// there holding `text`: its chain is that one layer.
function named(
  name: string,
  text = "{}",
): {
  readonly origin: RenderOrigin;
  readonly file: string;
} {
  const dir = project(name);
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, text);
  return { origin: originOf(dir, dir, file), file };
}

// A discovery over a real watcher registry; `moved` is every origin a watch
// moved, by key, in order, and `logged` every line.
function discoveryRig() {
  const counters: WatcherCounters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    counters,
    logger: () => {},
  });
  const moved: string[] = [];
  const logged: string[] = [];
  const discovery = new ConfigDiscovery({
    locations: locations(HOST),
    stateDir: stateDir(HOST),
    watchers,
    log: (_level, line) => logged.push(line),
    moved: (origins) => moved.push(...origins.map(originKey)),
  });
  cleanups.push(() => watchers.closeAll());
  cleanups.push(() => discovery.close());
  return { discovery, counters, moved, logged };
}

const textOfLayer = (
  discovery: ConfigDiscovery,
  origin: RenderOrigin,
  file: string,
): string | null => {
  const layer = discovery
    .snapshotOf(origin)
    ?.chain.find((l) => l.path === file);
  return layer?.content.kind === "text" ? layer.content.text : null;
};

test("follows exactly the origins named: each discovered once as it is first named, and one let go is dropped with its watch", () => {
  const { discovery, counters, logged } = discoveryRig();
  const { origin: a } = named("a");
  const { origin: b } = named("b");
  const follows = () => logged.filter((l) => l.includes("why=follow"));
  discovery.follow([a]);
  discovery.follow([a, b]);
  discovery.follow([a, b]);
  expect(follows()).toEqual([
    "config discovery why=follow followed=1 discovered=1 released=0",
    "config discovery why=follow followed=2 discovered=1 released=0",
  ]);
  expect(discovery.snapshotOf(a)).not.toBeNull();
  const opened = counters.watchersOpened;
  const closedBefore = counters.watchersClosed;
  discovery.follow([b]);
  expect(follows().at(-1)).toBe(
    "config discovery why=follow followed=1 discovered=0 released=1",
  );
  expect(discovery.snapshotOf(a)).toBeNull();
  expect(counters.watchersOpened).toBe(opened);
  expect(counters.watchersClosed).toBeGreaterThan(closedBefore);
});

test("a landing discovers again only the origins whose chain holds a written file, and answers those that moved", () => {
  const { discovery, logged } = discoveryRig();
  const { origin: a, file } = named("a");
  const { origin: b } = named("b");
  discovery.follow([a, b]);
  fs.writeFileSync(file, "{ globals: {} }");
  expect(discovery.landed([file], false)).toEqual([a]);
  expect(textOfLayer(discovery, a, file)).toBe("{ globals: {} }");
  expect(logged.at(-1)).toMatch(/why=landed followed=2 discovered=1 moved=1$/);
  // A landing that moved nothing answers none.
  expect(discovery.landed([file], false)).toEqual([]);
});

test("a hand edit the origin's watch hears moves that origin", async () => {
  const { discovery, moved } = discoveryRig();
  const { origin, file } = named("a");
  discovery.follow([origin]);
  let n = 0;
  await untilHeard(
    () => fs.writeFileSync(file, `{ globals: { n: ${++n} } }`),
    () => moved.includes(originKey(origin)),
    "the watch's move of the edited origin",
  );
  expect(textOfLayer(discovery, origin, file)).toMatch(
    /^\{ globals: \{ n: \d+ \} \}$/,
  );
});

test("an answer to the trust book moves every origin with a repository to ask about", async () => {
  const { discovery, moved } = discoveryRig();
  const dir = project("repo");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".cc-candybar/plugins/p"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".cc-candybar/plugins/p/plugin.json5"),
    `{ segments: { s: { template: "x" } } }`,
  );
  const origin = originOf(dir, dir);
  discovery.follow([origin]);
  expect(discovery.snapshotOf(origin)?.repo?.standing).toBe("awaiting");
  let answer: "approved" | "declined" = "declined";
  await untilHeard(
    () => {
      answer = answer === "approved" ? "declined" : "approved";
      answerRepo(dir, answer);
    },
    () => moved.includes(originKey(origin)),
    "the answers watch's move of the asking origin",
  );
  expect(discovery.snapshotOf(origin)?.repo?.standing).toBe(answer);
});

test("once closed, it follows nothing and lets every watch go", () => {
  const { discovery, counters } = discoveryRig();
  const { origin } = named("a");
  discovery.follow([origin]);
  discovery.close();
  expect(counters.watchersClosed).toBe(counters.watchersOpened);
  discovery.follow([origin]);
  expect(discovery.snapshotOf(origin)).toBeNull();
});
