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
import { discover, readShared } from "../src/daemon/config-discovery/discover";
import {
  diskFiles,
  type DiscoveryFiles,
} from "../src/daemon/config-discovery/discovery-files";
import {
  ConfigDiscovery,
  type RendererConfigs,
} from "../src/daemon/config-discovery/config-discovery";
import {
  MAIN_RENDERER,
  rendererNameOf,
  type RendererName,
} from "../src/daemon/foundations/renderer-name";
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
function discoveryRig(files = diskFiles) {
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
  const delivered: Array<readonly [RendererName, string]> = [];
  const service = new ConfigDiscovery({
    locations: locations(HOST),
    stateDir: stateDir(HOST),
    watchers,
    files,
    log: (_level, line) => logged.push(line),
    moved: (renderer, origins) => {
      for (const origin of origins) {
        const key = originKey(origin);
        moved.push(key);
        delivered.push([renderer, key]);
      }
    },
  });
  cleanups.push(() => watchers.closeAll());
  cleanups.push(() => service.close());
  const discovery = service.forRenderer(MAIN_RENDERER);
  return { service, discovery, counters, moved, logged, delivered };
}

const textOfLayer = (
  discovery: RendererConfigs,
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
  const { service, discovery, counters } = discoveryRig();
  const { origin } = named("a");
  discovery.follow([origin]);
  service.close();
  expect(counters.watchersClosed).toBe(counters.watchersOpened);
  discovery.follow([origin]);
  expect(discovery.snapshotOf(origin)).toBeNull();
});

test("two named renderers share one read and watch until the last releases", async () => {
  const { origin, file } = named("shared-origin");
  const name = rendererNameOf("next");
  const key = originKey(origin);
  let reads = 0;
  const {
    service,
    discovery: first,
    counters,
    delivered,
  } = discoveryRig({
    ...diskFiles,
    text(read) {
      if (read === file) reads++;
      return diskFiles.text(read);
    },
  });
  const second = service.forRenderer(name);
  first.follow([origin]);
  const opened = counters.watchersOpened;
  const closed = counters.watchersClosed;
  expect(first.snapshotOf(origin)).not.toBeNull();
  expect(second.snapshotOf(origin)).toBeNull();
  second.follow([{ ...origin, target: { ...origin.target } }]);
  expect(second.snapshotOf(origin)).toBe(first.snapshotOf(origin));
  expect(counters.watchersOpened).toBe(opened);
  expect(reads).toBe(1);

  let n = 0;
  const edit = () => fs.writeFileSync(file, `{ globals: { n: ${++n} } }`);
  await untilHeard(edit, () => delivered.length >= 2, "both renderer names");
  expect(delivered.slice(0, 2)).toEqual([
    [MAIN_RENDERER, key],
    [name, key],
  ]);
  expect(second.snapshotOf(origin)).toBe(first.snapshotOf(origin));

  first.follow([]);
  expect(first.snapshotOf(origin)).toBeNull();
  expect(first.path(origin, "user")).toBeUndefined();
  expect(second.path(origin, "user")).toBe(file);
  expect(counters.watchersClosed).toBe(closed);
  const began = delivered.length;
  await untilHeard(
    edit,
    () => delivered.length > began,
    "the remaining renderer",
  );
  expect(new Set(delivered.slice(began).map(([renderer]) => renderer))).toEqual(
    new Set([name]),
  );

  second.follow([]);
  expect(second.snapshotOf(origin)).toBeNull();
  expect(counters.watchersClosed).toBeGreaterThan(closed);
});

test("a landed write synchronously returns only the writer's reloads and routes all others", () => {
  const { origin, file } = named("written-origin");
  const { service, discovery: first, delivered } = discoveryRig();
  const name = rendererNameOf("next");
  const second = service.forRenderer(name);
  first.follow([origin]);
  second.follow([origin]);
  fs.writeFileSync(file, "{ globals: {} }");
  expect(first.landed([file], false)).toEqual([origin]);
  expect(delivered).toEqual([[name, originKey(origin)]]);
  expect(second.snapshotOf(origin)).toBe(first.snapshotOf(origin));
  expect(textOfLayer(second, origin, file)).toBe("{ globals: {} }");
});

test("a batch reads shared layer, plugin root and definition paths once", () => {
  const dir = project("shared");
  const nested = project("shared/nested");
  const pluginRoot = path.join(dir, ".cc-candybar", "plugins");
  const pluginDir = path.join(pluginRoot, "widget");
  const plugin = path.join(pluginDir, "plugin.json5");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(plugin, '{ segments: { row: { template: "widget" } } }');
  const alias = path.join(dir, "alias");
  fs.symlinkSync(pluginDir, alias);
  const listed = path.join(alias, "plugin.json5");
  const config = path.join(dir, ".cc-candybar.json5");
  const configText = JSON.stringify({ plugins: [listed, plugin] });
  fs.writeFileSync(config, configText);
  const configLinks = ["left.json5", "right.json5"].map((name) => {
    const link = path.join(dir, name);
    fs.symlinkSync(config, link);
    return link;
  });
  answerRepo(dir);
  const texts: string[] = [];
  const roots: string[] = [];
  const candidates: string[] = [];
  const resolved: string[] = [];
  const files: DiscoveryFiles = {
    ...diskFiles,
    presence(file) {
      candidates.push(file);
      return diskFiles.presence(file);
    },
    realpath(file) {
      resolved.push(file);
      return diskFiles.realpath(file);
    },
    text(file) {
      texts.push(file);
      return diskFiles.text(file);
    },
    folders(folder) {
      roots.push(folder);
      return diskFiles.folders(folder);
    },
  };
  const world = { locations: locations(HOST), stateDir: stateDir(HOST) };
  const shared = readShared(world, files);
  for (const cwd of [dir, nested]) {
    const { snapshot } = discover({ projectDir: dir, cwd }, shared);
    const layer = snapshot.chain.find(({ path: file }) => file === config);
    expect(layer?.listed[listed]?.definition).toMatchObject({
      kind: "text",
      dir: pluginDir,
    });
    expect(layer?.listed[plugin]?.definition).toEqual(
      layer?.listed[listed]?.definition,
    );
    expect(snapshot.plugins).toContainEqual(layer?.listed[plugin]);
  }
  for (const configFile of configLinks) {
    for (const cwd of [dir, nested]) {
      const { snapshot } = discover({ configFile, cwd }, shared);
      expect(snapshot.chain).toEqual([
        expect.objectContaining({
          path: configFile,
          content: { kind: "text", text: configText },
        }),
      ]);
    }
    expect(resolved.filter((file) => file === configFile)).toHaveLength(1);
    expect(texts).not.toContain(configFile);
  }
  expect(candidates.filter((file) => file === config)).toHaveLength(1);
  expect(roots.filter((folder) => folder === pluginRoot)).toHaveLength(1);
  for (const file of [config, plugin])
    expect(texts.filter((read) => read === file)).toHaveLength(1);
  expect(texts).not.toContain(listed);

  // A later batch sees changed bytes without needing to discard an old cache.
  fs.writeFileSync(config, "{}");
  const { snapshot } = discover(
    { projectDir: dir, cwd: dir },
    readShared(world, files),
  );
  expect(
    snapshot.chain.find(({ path: file }) => file === config)?.listed,
  ).toEqual({});
  expect(texts.filter((file) => file === config)).toHaveLength(2);
});

test("an unchecked extension remains the unreadable layer at its actual path", () => {
  const home = project("home");
  const locked = path.join(home, "cc-candybar", "config.json");
  const world = {
    locations: { ...locations(HOST), configHome: home },
    stateDir: stateDir(HOST),
  };
  const files = {
    ...diskFiles,
    presence: (file: string) =>
      file === locked
        ? { path: file, error: "EACCES" }
        : diskFiles.presence(file),
  };
  const { snapshot } = discover({ cwd: root }, readShared(world, files));
  expect(snapshot.chain).toEqual([
    {
      role: "user",
      path: locked,
      content: { kind: "unreadable", error: "EACCES" },
      listed: {},
    },
  ]);
  expect(snapshot.notices).toContain(
    `Config location could not be checked: ${locked} — EACCES`,
  );
});
