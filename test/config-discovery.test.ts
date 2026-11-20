import { failTest } from "./helpers/threw.js";
// [LAW:verifiable-goals] The host's config discovery
// (src/daemon/config-discovery/config-discovery.ts): it follows exactly the
// origins the renderer names, each discovered once as it is first named and
// let go with its watch when it is not; a landing discovers again only the
// origins whose chain holds a written file and answers those that moved; a
// hand edit an origin's watch hears moves that origin; and an answer to the
// trust book moves every origin that consulted it.

import { writeStatePlan } from "./helpers/state-file";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST } from "./helpers/host";
import { heldClock } from "./helpers/held-clock";
import { answerRepo } from "./helpers/repo-approval";
import { untilHeard } from "./helpers/reload-signal";
import { originOf } from "./helpers/config-host";
import {
  originKey,
  requestedConfigTarget,
  type RenderOrigin,
} from "../src/config-hint";
import { discover, readShared } from "../src/daemon/config-discovery/discover";
import {
  repoConfigs,
  repoConfigsPath,
} from "../src/daemon/config-discovery/repo-configs";
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
  DEBOUNCE_MS,
  POLL_MS,
  WatcherRegistry,
  type WatcherCounters,
} from "../src/daemon/cache/watchers";
import { locations, stateDir } from "../src/daemon/paths";
import { systemTimekeeper } from "../src/time";
import { withRegularTextFile } from "../src/utils/regular-text";
import { ConfigText } from "../src/daemon/config-discovery/config-text";
import { digestOf } from "../src/utils/plain";
import { fieldsOf } from "../src/utils/logfmt";
import {
  threwLine,
  type ThrewSink,
} from "../src/daemon/foundations/verb-error";
import { performChanges } from "../src/daemon/effect-interpreter";
import { writeConfigFile } from "../src/daemon/file-rewrites";
import { diffChanges } from "../src/config/config-changes";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type {
  ConfigChange,
  EffectId,
} from "../src/renderer-interface/interface";

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

// A logged line's fields, read the way the log is written.
const recordOf = (line: string): Record<string, string> =>
  Object.fromEntries(fieldsOf(line));

// Where a case reaches into the rig's discovery: what a failure is reported
// to, and a step each logged line and hand-off takes first, which can throw.
interface RigHooks {
  readonly failed?: ThrewSink;
  readonly logging?: (line: string) => void;
  readonly handing?: (renderer: RendererName) => void;
}

// A discovery over a real watcher registry; `moved` is every origin a watch
// moved, by key, in order, and `logged` every line.
function discoveryRig(
  files = diskFiles,
  clock = systemTimekeeper,
  state = stateDir(HOST),
  { failed = failTest, logging, handing }: RigHooks = {},
) {
  const counters: WatcherCounters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const watchers = new WatcherRegistry({
    failed,
    clock,
    counters,
    logger: () => {},
  });
  const moved: string[] = [];
  const logged: string[] = [];
  const delivered: Array<readonly [RendererName, string]> = [];
  const service = new ConfigDiscovery({
    failed,
    locations: locations(HOST),
    stateDir: state,
    watchers,
    files: () => files,
    log: (_level, line) => {
      logging?.(line);
      logged.push(line);
    },
    moved: (renderer, origins) => {
      handing?.(renderer);
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
  return { service, discovery, watchers, counters, moved, logged, delivered };
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
  const follows = () =>
    logged.map(recordOf).filter(({ why }) => why === "follow");
  discovery.follow([a]);
  discovery.follow([a, b]);
  discovery.follow([a, b]);
  expect(follows()).toEqual([
    { why: "follow", followed: "1", observed: "1", released: "0" },
    { why: "follow", followed: "2", observed: "1", released: "0" },
    { why: "follow", followed: "2", observed: "0", released: "0" },
  ]);
  expect(discovery.snapshotOf(a)).not.toBeNull();
  const opened = counters.watchersOpened;
  const closedBefore = counters.watchersClosed;
  discovery.follow([b]);
  expect(follows().at(-1)).toEqual({
    why: "follow",
    followed: "1",
    observed: "0",
    released: "1",
  });
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
  expect(discovery.landed([file])).toEqual([a]);
  expect(textOfLayer(discovery, a, file)).toBe("{ globals: {} }");
  expect(recordOf(logged.at(-1)!)).toEqual({
    why: "landed",
    followed: "2",
    observed: "1",
    moved: "1",
    sent: "0",
    owed: "0",
  });
  // A landing that moved nothing answers none, and says so.
  expect(discovery.landed([file])).toEqual([]);
  expect(recordOf(logged.at(-1)!)).toMatchObject({ observed: "1", moved: "0" });
});

test("a landing on the resolved target refreshes every origin holding an alias", () => {
  const { discovery } = discoveryRig();
  const { file, origin: direct } = named("actual");
  const dir = project("alias");
  const alias = path.join(dir, "alias.json5");
  fs.symlinkSync(file, alias);
  const linked = originOf(dir, dir, alias);
  discovery.follow([direct, linked]);

  fs.writeFileSync(file, "{ globals: { padding: 3 } }");
  expect(discovery.landed([file])).toEqual([direct, linked]);
  expect(textOfLayer(discovery, linked, alias)).toBe(
    "{ globals: { padding: 3 } }",
  );
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

test.each(["landed", "polled"] as const)(
  "a %s repository answer reaches both layered renderers after the question disappears",
  (how) => {
    const state = project("answers");
    const book = repoConfigs(state);
    const dir = project("project");
    const plugins = project("project/.cc-candybar/plugins");
    const stray = path.join(plugins, "notes.txt");
    fs.writeFileSync(stray, "ordinary loose file");
    const { file } = named("base");
    const main = originOf(dir, dir, file);
    const other = originOf(dir, project("second-cwd"), file);
    const isolated = {
      ...main,
      target: requestedConfigTarget(file, undefined, "config-only"),
    };
    const clock = heldClock(new Date());
    const { service, discovery, delivered } = discoveryRig(
      diskFiles,
      clock,
      state,
    );
    const name = rendererNameOf("worktree");
    const worker = service.forRenderer(name);
    const listed = (holder: RendererConfigs, origin: RenderOrigin) =>
      holder.snapshotOf(origin)?.strays.map(({ path }) => path);
    writeStatePlan(book.plan(() => ({ [dir]: "approved" })));
    discovery.follow([main, isolated]);
    worker.follow([other]);
    expect(discovery.snapshotOf(main)?.repo).toBeNull();
    expect(listed(discovery, main)).toEqual([stray]);
    expect(listed(worker, other)).toEqual([stray]);
    const isolatedBefore = discovery.snapshotOf(isolated);

    writeStatePlan(book.plan(() => ({ [dir]: "declined" })));
    if (how === "landed") {
      expect(discovery.landed([repoConfigsPath(state)])).toEqual([main]);
      expect(delivered).toEqual([[name, originKey(other)]]);
    } else {
      clock.advance(POLL_MS + DEBOUNCE_MS);
      expect(delivered).toEqual([
        [MAIN_RENDERER, originKey(main)],
        [name, originKey(other)],
      ]);
    }
    expect(listed(discovery, main)).toEqual([]);
    expect(listed(worker, other)).toEqual([]);
    expect(discovery.snapshotOf(isolated)).toBe(isolatedBefore);
  },
);

test("a layered renderer follows the older repository book until the first answer promotes it", () => {
  const state = project("migration");
  const old = path.join(state, "repo-configs.json");
  const dir = project("project");
  fs.writeFileSync(path.join(dir, ".cc-candybar.json5"), "{}");
  const origin = originOf(dir, dir);
  const clock = heldClock(new Date());
  const { discovery, moved } = discoveryRig(diskFiles, clock, state);
  fs.writeFileSync(old, JSON.stringify({ [dir]: "declined" }));
  discovery.follow([origin]);
  const standing = () => discovery.snapshotOf(origin)?.repo?.standing;
  expect(standing()).toBe("declined");

  fs.writeFileSync(old, JSON.stringify({ [dir]: "approved" }));
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(standing()).toBe("approved");
  writeStatePlan(repoConfigs(state).plan(() => ({ [dir]: "declined" })));
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(standing()).toBe("declined");
  expect(fs.existsSync(old)).toBe(false);
  fs.unlinkSync(repoConfigsPath(state));
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(standing()).toBe("awaiting");
  expect(moved).toEqual([
    originKey(origin),
    originKey(origin),
    originKey(origin),
  ]);
});

test.each([
  { standing: "awaiting", answer: null, admitted: false },
  { standing: "approved", answer: "approved", admitted: true },
  { standing: "declined", answer: "declined", admitted: false },
] as const)(
  "an unreadable project plugin directory reports once and recovers under its $standing decision",
  ({ standing, answer, admitted }) => {
    const state = project("access-state");
    const dir = project("plugin-project");
    const pluginRoot = path.join(dir, ".cc-candybar", "plugins");
    fs.mkdirSync(path.dirname(pluginRoot));
    fs.writeFileSync(pluginRoot, "pending installation");
    const { file } = named("user-base");
    const origin = originOf(dir, dir, file);
    const only = {
      ...origin,
      target: requestedConfigTarget(file, undefined, "config-only"),
    };
    const store = repoConfigs(state);
    if (answer !== null) writeStatePlan(store.plan(() => ({ [dir]: answer })));
    const before = store.read();
    const clock = heldClock(new Date());
    const reads: string[] = [];
    const { discovery, service } = discoveryRig(
      {
        ...diskFiles,
        text(file) {
          reads.push(file);
          return diskFiles.text(file);
        },
      },
      clock,
      state,
    );
    discovery.follow([origin, only]);
    const worktree = service.forRenderer(rendererNameOf("next"));
    worktree.follow([origin]);
    const snapshot = () => discovery.snapshotOf(origin)!;
    const errors = () =>
      snapshot().notices.filter((n) => n.includes(pluginRoot));
    expect(errors()).toEqual([expect.stringContaining("ENOTDIR")]);
    expect(snapshot().repo).toBeNull();
    expect(
      discovery.snapshotOf(only)?.notices.some((n) => n.includes(pluginRoot)),
    ).toBe(false);

    const projectFile = path.join(dir, ".cc-candybar.json5");
    fs.writeFileSync(projectFile, "{}");
    clock.advance(POLL_MS + DEBOUNCE_MS);
    expect(errors()).toEqual([expect.stringContaining("ENOTDIR")]);
    expect(snapshot().repo).toMatchObject({ dir, standing });
    expect(
      snapshot()
        .chain.filter((l) => l.role === "project")
        .map((l) => l.content),
    ).toEqual(admitted ? [{ kind: "text", text: "{}" }] : []);
    expect(reads.includes(projectFile)).toBe(admitted);
    expect(worktree.snapshotOf(origin)).toEqual(snapshot());

    fs.unlinkSync(pluginRoot);
    const folder = path.join(pluginRoot, "example");
    fs.mkdirSync(folder, { recursive: true });
    const definition = path.join(folder, "plugin.json5");
    fs.writeFileSync(definition, "{}");
    clock.advance(POLL_MS + DEBOUNCE_MS);
    expect(errors()).toEqual([]);
    expect(snapshot().repo).toMatchObject({ dir, standing });
    expect(
      snapshot()
        .plugins.filter((p) => p.scope === "repo")
        .map((p) => p.path),
    ).toEqual(admitted ? [definition] : []);
    expect(reads.filter((f) => f === definition)).toEqual(
      admitted ? [definition] : [],
    );
    expect(worktree.snapshotOf(origin)).toEqual(snapshot());
    expect(store.read()).toEqual(before);
  },
);

test("only an isolated config skips the project's plugin discovery and watch", () => {
  const projectDir = project("project-with-plugin");
  const { file } = named("explicit");
  const cwd = project("session-cwd");
  const repositoryPlugins = path.join(projectDir, ".cc-candybar", "plugins");
  const folder = path.join(repositoryPlugins, "example");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "plugin.json5"), "{}");

  const visited: string[] = [];
  const { discovery, watchers, logged } = discoveryRig({
    ...diskFiles,
    folders(dir) {
      visited.push(dir);
      return diskFiles.folders(dir);
    },
  });
  const layered = originOf(projectDir, cwd, file);
  const isolated = {
    ...layered,
    target: requestedConfigTarget(file, undefined, "config-only"),
  };
  expect(watchers.size()).toBe(0);
  discovery.follow([isolated]);
  expect(watchers.size()).toBe(1);
  expect(discovery.snapshotOf(isolated)?.repo).toBeNull();
  expect(visited).not.toContain(repositoryPlugins);
  expect(logged.some((line) => line.includes(repositoryPlugins))).toBe(false);

  discovery.follow([isolated, layered]);
  expect(visited).toContain(repositoryPlugins);
  expect(discovery.snapshotOf(isolated)?.repo).toBeNull();
  expect(discovery.snapshotOf(layered)?.repo).toMatchObject({
    dir: projectDir,
    standing: "awaiting",
  });
  expect(logged.some((line) => line.includes(repositoryPlugins))).toBe(true);
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
  expect(first.landed([file])).toEqual([origin]);
  expect(delivered).toEqual([[name, originKey(origin)]]);
  expect(second.snapshotOf(origin)).toBe(first.snapshotOf(origin));
  expect(textOfLayer(second, origin, file)).toBe("{ globals: {} }");
});

test("renderers hold only their own selected shared config observations", () => {
  const { origin, file } = named("selected-config");
  const { service, discovery: first } = discoveryRig();
  const second = service.forRenderer(rendererNameOf("second"));
  first.follow([origin]);
  second.follow([origin]);
  const original = first.snapshotOf(origin);
  if (original === null) throw new Error("missing first observation");
  first.selected([{ origin, digest: digestOf(original) }], () => original);
  second.selected([{ origin, digest: digestOf(original) }], () => original);
  expect(first.retainedOf(origin)).toBe("current");

  fs.writeFileSync(file, "{ globals: { padding: 4 } }");
  first.landed([file]);
  const current = first.snapshotOf(origin);
  if (current === null) throw new Error("missing second observation");
  expect(second.snapshotOf(origin)).toBe(current);
  expect(first.retainedOf(origin)).toBe(original);
  expect(second.retainedOf(origin)).toBe(original);
  expect(() =>
    first.selected([{ origin, digest: digestOf(current) }], () => original),
  ).toThrow("selected config revision was not delivered");
  expect(first.retainedOf(origin)).toBe(original);
  second.selected([{ origin, digest: digestOf(current) }], () => current);
  expect(second.retainedOf(origin)).toBe("current");
  expect(first.retainedOf(origin)).toBe(original);

  first.selected([], () => undefined);
  expect(first.retainedOf(origin)).toBeUndefined();
  expect(first.snapshotOf(origin)).toBe(current);
  second.follow([]);
  expect(second.retainedOf(origin)).toBeUndefined();
  expect(first.snapshotOf(origin)).toBe(current);
  service.close();
  expect(first.snapshotOf(origin)).toBeNull();
});

test("a previously selected project input cannot be restored after approval is withdrawn", () => {
  const state = project("restore-trust-state");
  const dir = project("restore-trust-repo");
  const plugin = project("restore-trust-repo/.cc-candybar/plugins/p");
  fs.writeFileSync(path.join(plugin, "plugin.json5"), "{}");
  const { file } = named("restore-trust-explicit");
  const layered = originOf(dir, dir, file);
  const isolated = {
    ...layered,
    target: requestedConfigTarget(file, undefined, "config-only"),
  };
  const book = repoConfigs(state);
  writeStatePlan(book.plan(() => ({ [dir]: "approved" })));
  const { discovery } = discoveryRig(diskFiles, systemTimekeeper, state);
  discovery.follow([layered, isolated]);
  const previous = discovery.snapshotOf(layered);
  if (previous === null) throw new Error("missing approved input");
  expect(previous.repo).toMatchObject({ dir, standing: "approved" });
  expect(previous.plugins.map(({ scope }) => scope)).toContain("repo");
  discovery.selected(
    [{ origin: layered, digest: digestOf(previous) }],
    () => previous,
  );
  expect(discovery.retainedOf(isolated)).toBeUndefined();

  for (const answers of [{ [dir]: "declined" as const }, {}]) {
    writeStatePlan(book.plan(() => answers));
    discovery.landed([repoConfigsPath(state)]);
    expect(
      discovery.snapshotOf(layered)?.plugins.map(({ scope }) => scope),
    ).not.toContain("repo");
    expect(discovery.retainedOf(layered)).toBe("current");
    expect(discovery.retainedOf(isolated)).toBeUndefined();
  }
});

test("a shared file's watch window reads it once for different held origins and stops on close", () => {
  const { origin, file } = named("shared-first");
  const dir = project("shared-next");
  const other = originOf(dir, dir, file);
  const name = rendererNameOf("next");
  const clock = heldClock(new Date(0));
  let reads = 0;
  const { service, discovery, delivered } = discoveryRig(
    {
      ...diskFiles,
      text(read) {
        if (read === file) reads++;
        return diskFiles.text(read);
      },
    },
    clock,
  );
  const second = service.forRenderer(name);
  discovery.follow([origin]);
  second.follow([other]);
  reads = 0;

  const next = "{ globals: { padding: 1 } }";
  fs.writeFileSync(file, next);
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(reads).toBe(1);
  expect(delivered).toEqual([
    [MAIN_RENDERER, originKey(origin)],
    [name, originKey(other)],
  ]);
  expect(textOfLayer(discovery, origin, file)).toBe(next);
  expect(textOfLayer(second, other, file)).toBe(next);

  fs.writeFileSync(file, "{}");
  clock.advance(POLL_MS - DEBOUNCE_MS);
  service.close();
  expect(clock.pending()).toBe(0);
  clock.advance(DEBOUNCE_MS);
  expect(reads).toBe(1);
  expect(delivered).toHaveLength(2);
});

test("one failed rediscovery leaves the writer and another holder the successful change and can retry", () => {
  const a = named("published");
  const b = named("failed-once");
  const name = rendererNameOf("next");
  let refuse = false;
  const failures: string[] = [];
  const {
    service,
    discovery: writer,
    delivered,
    logged,
  } = discoveryRig(
    {
      ...diskFiles,
      text(read) {
        if (refuse && read === b.file) throw new Error("rediscovery failed");
        return diskFiles.text(read);
      },
    },
    undefined,
    undefined,
    { failed: (...threw) => failures.push(threwLine(...threw)) },
  );
  const second = service.forRenderer(name);
  const origins = [a.origin, b.origin];
  writer.follow(origins);
  second.follow(origins);
  const next = "{ globals: { padding: 1 } }";
  for (const { file } of [a, b]) fs.writeFileSync(file, next);

  refuse = true;
  expect(writer.landed([a.file, b.file])).toEqual([a.origin]);
  expect(delivered).toEqual([[name, originKey(a.origin)]]);
  expect(textOfLayer(second, a.origin, a.file)).toBe(next);
  expect(textOfLayer(second, b.origin, b.file)).toBe("{}");
  expect(failures.map(recordOf)).toEqual([
    {
      origin: originKey(b.origin),
      why: "landed",
      error: expect.stringContaining("rediscovery failed"),
    },
  ]);
  expect(recordOf(logged.at(-1)!)).toMatchObject({ moved: "1", owed: "1" });

  refuse = false;
  service.again("events-resumed");
  expect(recordOf(logged.at(-1)!)).toMatchObject({ owed: "0" });
  expect(delivered).toEqual([
    [name, originKey(a.origin)],
    [MAIN_RENDERER, originKey(b.origin)],
    [name, originKey(b.origin)],
  ]);
  expect(textOfLayer(second, b.origin, b.file)).toBe(next);
});

test("an origin whose rediscovery throws after its watch rebinds keeps that watch, delivers on the retry, and leaves no holder behind", () => {
  const a = named("rebinds");
  const plugin = path.join(path.dirname(a.file), "widget", "plugin.json5");
  fs.mkdirSync(path.dirname(plugin));
  fs.writeFileSync(plugin, "{ name: 'widget' }");
  let refuse = false;
  const failures: string[] = [];
  const { service, discovery, counters, logged, delivered } = discoveryRig(
    diskFiles,
    undefined,
    undefined,
    {
      failed: (...threw) => failures.push(threwLine(...threw)),
      logging: (line) => {
        if (refuse && line.startsWith("config watch bound"))
          throw new Error("bound record broke");
      },
    },
  );
  discovery.follow([a.origin]);
  // Listing a plugin adds its definition to the watched targets: a rebind.
  const next = '{ plugins: ["widget/plugin.json5"] }';
  fs.writeFileSync(a.file, next);

  refuse = true;
  expect(discovery.landed([a.file])).toEqual([]);
  expect(failures.map(recordOf)).toEqual([
    {
      origin: originKey(a.origin),
      why: "landed",
      error: expect.stringContaining("bound record broke"),
    },
  ]);
  expect(recordOf(logged.at(-1)!)).toMatchObject({ observed: "0", owed: "1" });
  expect(textOfLayer(discovery, a.origin, a.file)).toBe("{}");

  refuse = false;
  service.again("asked");
  expect(delivered).toEqual([[MAIN_RENDERER, originKey(a.origin)]]);
  expect(textOfLayer(discovery, a.origin, a.file)).toBe(next);
  expect(recordOf(logged.at(-1)!)).toMatchObject({ observed: "1", owed: "0" });

  service.close();
  expect(counters.watchersClosed).toBe(
    counters.watchersOpened + counters.watchRefusals,
  );
});

test("a renderer whose hand-off throws is handed the origin by the next batch, while another holder has it from the first", () => {
  const a = named("handed");
  const next = rendererNameOf("next");
  const third = rendererNameOf("third");
  let refuse = false;
  const failures: string[] = [];
  const {
    service,
    discovery: writer,
    delivered,
  } = discoveryRig(diskFiles, undefined, undefined, {
    failed: (...threw) => failures.push(threwLine(...threw)),
    handing: (renderer) => {
      if (refuse && renderer === next) throw new Error("hand-off broke");
    },
  });
  for (const holder of [
    writer,
    ...[next, third].map(service.forRenderer, service),
  ])
    holder.follow([a.origin]);
  const changed = "{ globals: { padding: 1 } }";
  fs.writeFileSync(a.file, changed);

  refuse = true;
  expect(writer.landed([a.file])).toEqual([a.origin]);
  const key = originKey(a.origin);
  expect(delivered).toEqual([[third, key]]);
  expect(failures.map(recordOf)).toEqual([
    { renderer: next, error: expect.stringContaining("hand-off broke") },
  ]);

  // A batch that moves nothing still hands on what a holder is owed, once.
  refuse = false;
  service.again("asked");
  service.again("asked");
  expect(delivered).toEqual([
    [third, key],
    [next, key],
  ]);
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
    const { snapshot } = discover(
      { kind: "chain", projectDir: dir, cwd },
      shared,
    );
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
      const { snapshot } = discover(
        { kind: "file", path: configFile, cwd },
        shared,
      );
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
    { kind: "chain", projectDir: dir, cwd: dir },
    readShared(world, files),
  );
  expect(
    snapshot.chain.find(({ path: file }) => file === config)?.listed,
  ).toEqual({});
  expect(texts.filter((file) => file === config)).toHaveLength(2);
});

// [LAW:verifiable-goals] A regression would block during open, before any
// JavaScript timer runs. The child owns the reads, and its parent bounds it.
test("config and plugin discovery refuse a FIFO with no writer", () => {
  const dir = project("named-pipe");
  const pluginDir = project("named-pipe/widget");
  const plugin = path.join(pluginDir, "plugin.json5");
  const pipe = path.join(dir, "config-pipe.json5");
  const alias = path.join(dir, "usable.json5");
  const config = path.join(dir, "bar.json5");
  execFileSync("mkfifo", [plugin], { timeout: 5_000 });
  fs.symlinkSync(plugin, pipe);
  fs.symlinkSync(config, alias);
  fs.writeFileSync(config, JSON.stringify({ plugins: [plugin] }));
  const absent = path.join(dir, "missing.json5");
  const world = {
    locations: { ...locations(HOST), dataDirs: [], dataHome: dir },
    stateDir: dir,
  };
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { discover, readShared } from "./src/daemon/config-discovery/discover.ts";
       const [world, cwd, ...files] = process.argv.slice(1);
       const shared = readShared(JSON.parse(world));
       const snapshots = files.map(path => discover({ kind: "file", path, cwd }, shared).snapshot);
       process.stdout.write(JSON.stringify(snapshots));`,
      JSON.stringify(world),
      dir,
      pipe,
      alias,
      absent,
    ],
    { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
  );
  expect(JSON.parse(output)).toEqual([
    expect.objectContaining({
      chain: [
        expect.objectContaining({
          path: pipe,
          content: { kind: "unreadable", error: "not a file" },
        }),
      ],
    }),
    expect.objectContaining({
      chain: [
        expect.objectContaining({
          path: alias,
          content: {
            kind: "text",
            text: JSON.stringify({ plugins: [plugin] }),
          },
          listed: {
            [plugin]: expect.objectContaining({
              path: plugin,
              definition: { kind: "unreadable", error: "not a file" },
            }),
          },
        }),
      ],
    }),
    expect.objectContaining({
      chain: [
        expect.objectContaining({ path: absent, content: { kind: "absent" } }),
      ],
    }),
  ]);
});

function countingText(
  reads: string[],
  opens?: string[],
): typeof withRegularTextFile {
  return (file, use) =>
    withRegularTextFile(file, (opened) => {
      opens?.push(file);
      return use({
        ...opened,
        text: () => {
          reads.push(file);
          return opened.text();
        },
      });
    });
}

function physicalDiscovery(
  dataHome: string,
  reads: string[],
  {
    opens,
    dataDirs = [],
    state = path.join(root, "state"),
    clock = heldClock(new Date()),
    reloaded,
  }: {
    opens?: string[];
    dataDirs?: readonly string[];
    state?: string;
    clock?: ReturnType<typeof heldClock>;
    reloaded?: (folders: ReadonlySet<string>) => void;
  } = {},
) {
  const watchers = new WatcherRegistry({
    failed: failTest,
    clock,
    logger: () => {},
  });
  const service = new ConfigDiscovery({
    failed: failTest,
    locations: { ...locations(HOST), dataHome, dataDirs },
    stateDir: state,
    watchers,
    openText: countingText(reads, opens),
    log: () => {},
    moved: () => {},
    reloaded,
  });
  cleanups.push(
    () => watchers.closeAll(),
    () => service.close(),
  );
  return service;
}

test("managed folders are admitted by each renderer's own discoveries and remain only while declared", () => {
  const a = named("a", '{ plugins: ["widget/plugin.json5"] }');
  const b = named("b", '{ plugins: ["widget/plugin.json5"] }');
  const aPlugin = project("a/widget");
  const bPlugin = project("b/widget");
  for (const plugin of [aPlugin, bPlugin])
    fs.writeFileSync(path.join(plugin, "plugin.json5"), "{ name: 'widget' }");

  const aFolder = path.join(aPlugin, "session");
  const bFolder = path.join(bPlugin, "session");
  const wanted = [aFolder, bFolder, path.join(root, "unsolicited")];
  const reads: string[] = [];
  const reloaded: ReadonlySet<string>[] = [];
  const clock = heldClock(new Date());
  const service = physicalDiscovery(project("empty-data"), reads, {
    clock,
    reloaded: (observed) => reloaded.push(observed),
  });
  const sibling = rendererNameOf("sibling");
  const main = service.forRenderer(MAIN_RENDERER);
  main.follow([a.origin]);
  service.forRenderer(sibling).follow([b.origin]);

  const readCount = reads.length;
  const mainFolders = service.admitManagedFolders(
    MAIN_RENDERER,
    wanted,
    undefined,
  );
  expect(mainFolders).toEqual(new Set([aFolder]));
  expect(service.admitManagedFolders(sibling, wanted, undefined)).toEqual(
    new Set([bFolder]),
  );
  expect(
    service.admitManagedFolders(MAIN_RENDERER, [aFolder], mainFolders),
  ).toBe(mainFolders);
  expect(reads).toHaveLength(readCount);

  // An unchanged config observation still reaches the fault recovery owner.
  const observed = main.snapshotOf(a.origin);
  reloaded.length = 0;
  const changedAt = new Date("2021-01-01T00:00:00.000Z");
  fs.utimesSync(a.file, changedAt, changedAt);
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(main.snapshotOf(a.origin)).toBe(observed);
  expect(reloaded).toEqual([new Set([aFolder])]);
  expect(reads.slice(readCount)).toEqual([a.file]);

  if (observed === null) throw new Error("main config was not discovered");
  main.selected(
    [{ origin: a.origin, digest: digestOf(observed) }],
    () => observed,
  );
  fs.writeFileSync(a.file, "{ broken");
  service.again("bad edit");
  expect(
    service.admitManagedFolders(MAIN_RENDERER, [aFolder], undefined),
  ).toEqual(new Set([aFolder]));

  // While an in-flight render retains its state, it can keep a legitimate
  // folder even after the origin has gone. Its sibling cannot inherit it.
  main.follow([]);
  expect(
    service.admitManagedFolders(MAIN_RENDERER, [aFolder], mainFolders),
  ).toBe(mainFolders);
  expect(service.admitManagedFolders(sibling, [aFolder], undefined)).toEqual(
    new Set(),
  );
  const released = service.admitManagedFolders(MAIN_RENDERER, [], mainFolders);
  expect(
    service.admitManagedFolders(MAIN_RENDERER, [aFolder], released),
  ).toEqual(new Set());
});

test("two renderers read the winning plugin and promote its shadowed copy when the override is removed", () => {
  const data = project("user-data");
  const packaged = project("package-data");
  const plugin = (at: string, label: string) => {
    const dir = path.join(at, "cc-candybar", "plugins", "widget");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "plugin.json5");
    fs.writeFileSync(
      file,
      JSON.stringify({ segments: { s: { template: label } } }),
    );
    return file;
  };
  const lower = plugin(packaged, "packaged");
  const override = plugin(data, "override");
  const reads: string[] = [];
  const opens: string[] = [];
  const clock = heldClock(new Date());
  const service = physicalDiscovery(data, reads, {
    dataDirs: [packaged],
    clock,
    opens,
  });
  const main = service.forRenderer(MAIN_RENDERER);
  const other = service.forRenderer(rendererNameOf("worktree"));
  const { origin } = named("main-session");
  const second = { ...origin, cwd: project("second-session") };
  main.follow([origin]);
  other.follow([second]);
  const snapshots = () => [main.snapshotOf(origin), other.snapshotOf(second)];
  for (const snap of snapshots())
    expect(snap?.plugins).toMatchObject([
      { path: override, definition: { kind: "text" } },
    ]);
  expect(opens).not.toContain(lower);
  expect(reads.filter((file) => file === override)).toEqual([override]);

  // The folder still wins when its definition cannot be read as a file.
  fs.unlinkSync(override);
  fs.mkdirSync(override);
  clock.advance(POLL_MS + DEBOUNCE_MS);
  for (const snap of snapshots())
    expect(snap?.plugins).toMatchObject([
      { path: override, definition: { kind: "unreadable" } },
    ]);
  expect(opens).not.toContain(lower);

  fs.rmSync(path.dirname(override), { recursive: true });
  clock.advance(POLL_MS + DEBOUNCE_MS);
  for (const snap of snapshots())
    expect(snap?.plugins).toMatchObject([
      { path: lower, definition: { kind: "text" } },
    ]);
  expect(reads.filter((file) => file === lower)).toEqual([lower]);

  plugin(data, "override restored");
  const listed = named("explicit-plugin", JSON.stringify({ plugins: [lower] }));
  main.follow([origin, listed.origin]);
  const snap = main.snapshotOf(listed.origin);
  expect(snap?.plugins).toMatchObject([{ path: override }]);
  expect(snap?.chain[0]?.listed[lower]).toMatchObject({
    path: lower,
    definition: { kind: "text", text: expect.stringContaining("packaged") },
  });
});

test("the two renderers and an answer written through the host read each book revision once", () => {
  const state = project("book-state");
  const book = repoConfigsPath(state);
  const dir = project("repository");
  fs.writeFileSync(path.join(dir, ".cc-candybar.json5"), "{}");
  writeStatePlan(repoConfigs(state).plan(() => ({ [dir]: "declined" })));
  const { file } = named("base");
  const a = originOf(dir, dir, file);
  const b = originOf(dir, project("another-cwd"), file);
  const only = {
    ...a,
    target: requestedConfigTarget(file, undefined, "config-only"),
  };
  const reads: string[] = [];
  const opens: string[] = [];
  const service = physicalDiscovery(project("data"), reads, { opens, state });
  const main = service.forRenderer(MAIN_RENDERER);
  const worker = service.forRenderer(rendererNameOf("worktree"));
  main.follow([only]);
  expect(opens).not.toContain(book);
  main.follow([only, a]);
  worker.follow([b]);
  expect(reads.filter((path) => path === book)).toHaveLength(1);
  const beforeWrite = opens.length;
  const result = performChanges(
    [],
    {
      stateDir: state,
      answers: [
        {
          kind: "approve-repo",
          id: 1 as EffectId,
          session: sessionIdOf("worktree"),
          origin: b,
          dir,
          answer: "approved",
        },
      ],
      said: () => {},
    },
    worker,
  );
  expect(result).toEqual({ kind: "ok", files: [book] });
  // The same fresh observation supplies both the plan and the rollback bytes.
  expect(opens.slice(beforeWrite)).toEqual([book]);
  expect(reads.filter((path) => path === book)).toHaveLength(1);
  expect(worker.landed([book])).toEqual([b]);
  expect(worker.snapshotOf(b)?.repo?.standing).toBe("approved");
  expect(main.snapshotOf(a)?.repo?.standing).toBe("approved");
  expect(reads.filter((path) => path === book)).toHaveLength(2);
});

const changePadding = (text: string) =>
  text.replace("padding: 1", "padding: 2");
const paddingEdit = (origin: RenderOrigin, text: string): ConfigChange => ({
  kind: "change",
  id: 1 as EffectId,
  session: sessionIdOf("config-edit"),
  target: { kind: "layer", origin, role: "user" },
  changes: diffChanges(text, changePadding(text)),
});

test("an unrestored write reaches a directory alias but leaves a different hardlink entry alone", () => {
  const initial = "{ globals: { padding: 1 } }";
  const direct = named("direct-entry", initial);
  const alias = path.join(root, "directory-alias");
  fs.symlinkSync(path.dirname(direct.file), alias);
  const file = path.join(alias, "config.json5");
  const writerOrigin = originOf(alias, alias, file);
  const hardlink = path.join(path.dirname(direct.file), "hardlink.json5");
  fs.linkSync(direct.file, hardlink);
  const hardlinkOrigin = originOf(alias, alias, hardlink);
  const later = named("later-publication", initial);
  const {
    service,
    discovery: writer,
    delivered,
    logged,
  } = discoveryRig(diskFiles, heldClock(new Date()));
  const name = rendererNameOf("worktree");
  const observer = service.forRenderer(name);
  writer.follow([writerOrigin, later.origin]);
  observer.follow([direct.origin, hardlinkOrigin]);

  const outcome = performChanges(
    [paddingEdit(writerOrigin, initial), paddingEdit(later.origin, initial)],
    null,
    writer,
    (at, text) => {
      if (at === later.file) throw new Error("later publication refused");
      if (text === initial) throw new Error("restore refused");
      writeConfigFile(at, text);
    },
  );
  if (outcome.kind !== "incomplete") throw new Error(JSON.stringify(outcome));
  expect(writer.landed(outcome.files)).toEqual([writerOrigin]);
  expect(delivered).toEqual([[name, originKey(direct.origin)]]);
  expect(textOfLayer(writer, writerOrigin, file)).toBe(changePadding(initial));
  expect(textOfLayer(observer, direct.origin, direct.file)).toBe(
    changePadding(initial),
  );
  expect(textOfLayer(observer, hardlinkOrigin, hardlink)).toBe(initial);
  expect(fs.readFileSync(hardlink, "utf8")).toBe(initial);
  expect(logged.map(recordOf)).toContainEqual(
    expect.objectContaining({
      why: "landed",
      followed: "4",
      observed: "2",
      moved: "2",
    }),
  );
});

test("a batch composes disjoint edits addressed through two names of one directory entry", () => {
  const initial = '{ globals: { padding: 1, separator: " " } }';
  const direct = named("one-entry", initial);
  const alias = path.join(root, "alias-entry");
  fs.symlinkSync(path.dirname(direct.file), alias);
  const file = path.join(alias, "config.json5");
  const throughAlias = originOf(alias, alias, file);
  const clock = heldClock(new Date());
  const { discovery } = discoveryRig(diskFiles, clock);
  discovery.follow([throughAlias, direct.origin]);
  const separator = initial.replace('" "', '" | "');
  const published: string[] = [];
  const result = performChanges(
    [
      paddingEdit(throughAlias, initial),
      {
        ...paddingEdit(direct.origin, initial),
        changes: diffChanges(initial, separator),
      },
    ],
    null,
    discovery,
    (target, text) => {
      published.push(target);
      writeConfigFile(target, text);
    },
  );
  expect(fs.readFileSync(direct.file, "utf8")).toBe(changePadding(separator));
  expect(result).toEqual({ kind: "ok", files: [file] });
  expect(published).toEqual([file]);
});

test("a created config reaches an alias whose parent was missing when followed", () => {
  const physical = project("physical-root");
  const alias = path.join(root, "alias-root");
  fs.symlinkSync(physical, alias);
  const observed = path.join(alias, "future", "config.json5");
  const created = path.join(physical, "future", "config.json5");
  const origin = originOf(alias, alias, observed);
  const { service, discovery, delivered } = discoveryRig(
    diskFiles,
    heldClock(new Date()),
  );
  discovery.follow([origin]);
  const writer = service.forRenderer(rendererNameOf("writer"));
  writeConfigFile(created, "{}");
  expect(writer.landed([created])).toEqual([]);
  expect(delivered).toEqual([[MAIN_RENDERER, originKey(origin)]]);
  expect(textOfLayer(discovery, origin, observed)).toBe("{}");
});

test.each([
  { revision: "unchanged", edited: false, newReads: 0 },
  { revision: "externally edited", edited: true, newReads: 1 },
])(
  "a config write rechecks an $revision revision before both consumers reload",
  ({ edited, newReads }) => {
    const initial = '{ globals: { padding: 1, separator: " " } }';
    const { origin, file } = named("shared-write", initial);
    const reads: string[] = [];
    const opens: string[] = [];
    const service = physicalDiscovery(project("empty-data"), reads, { opens });
    const first = service.forRenderer(MAIN_RENDERER);
    const second = service.forRenderer(rendererNameOf("worktree"));
    first.follow([origin]);
    second.follow([origin]);
    expect(opens).toEqual([file]);
    expect(reads).toEqual([file]);

    const current = edited ? initial.replace('" "', '" | "') : initial;
    if (edited) fs.writeFileSync(file, current);
    const landed = performChanges([paddingEdit(origin, initial)], null, second);
    expect(landed).toEqual({ kind: "ok", files: [file] });
    expect(opens).toEqual([file, file]);
    expect(reads).toHaveLength(1 + newReads);
    if (landed.kind !== "ok") throw new Error(landed.reason);

    expect(second.landed(landed.files)).toEqual([origin]);
    expect(opens).toEqual([file, file, file]);
    expect(reads).toHaveLength(2 + newReads);
    for (const consumer of [first, second])
      expect(textOfLayer(consumer, origin, file)).toBe(changePadding(current));
  },
);

test("a dangling plugin definition stays quiet until its target appears", () => {
  const data = project("data");
  const plugin = path.join(
    project("data/cc-candybar/plugins/widget"),
    "plugin.json5",
  );
  const target = path.join(root, "definition.json5");
  fs.symlinkSync(target, plugin);
  const { file, origin: base } = named("session");
  const origin = {
    ...base,
    target: requestedConfigTarget(file, undefined, "config-only"),
  };
  const clock = heldClock(new Date());
  const opens: string[] = [];
  const service = physicalDiscovery(data, [], { clock, opens });
  const renderer = service.forRenderer(MAIN_RENDERER);
  renderer.follow([origin]);
  const definition = () =>
    renderer.snapshotOf(origin)?.plugins.find((p) => p.path === plugin)
      ?.definition;
  expect(definition()?.kind).toBe("unreadable");
  clock.advance(3 * POLL_MS + DEBOUNCE_MS);
  expect(opens.filter((at) => at === file)).toEqual([file]);
  fs.writeFileSync(target, "{}");
  clock.advance(POLL_MS + DEBOUNCE_MS);
  expect(definition()).toMatchObject({ kind: "text", text: "{}" });
});

test("a held layer replaced by a directory cannot be overwritten by an edit", () => {
  const initial = "{ globals: { padding: 1 } }";
  const { origin, file } = named("directory-after-discovery", initial);
  const reads: string[] = [];
  const service = physicalDiscovery(project("empty-data"), reads);
  const renderer = service.forRenderer(MAIN_RENDERER);
  renderer.follow([origin]);
  fs.unlinkSync(file);
  fs.mkdirSync(file);

  expect(
    performChanges([paddingEdit(origin, initial)], null, renderer),
  ).toEqual({
    kind: "failed",
    reason: `config read failed: ${file}: not a file`,
  });
  expect(reads).toEqual([file]);
  expect(fs.statSync(file).isDirectory()).toBe(true);
});

// [LAW:behavior-not-structure] Distinct origins open in separate turns. Count
// the real payload read, rather than its descriptor check or snapshot lookup.
test("physical config and plugin text are shared across separate renderer discoveries", () => {
  const left = project("left");
  const right = project("right");
  const installed = project("data/cc-candybar/plugins/shared");
  const plugin = path.join(installed, "plugin.json5");
  const leftPlugin = path.join(project("left/widget"), "plugin.json5");
  const rightPlugin = path.join(project("right/widget"), "plugin.json5");
  const relative = "widget/plugin.json5";
  const config = path.join(left, "bar.json5");
  const alias = path.join(right, "alias.json5");
  const hardlink = path.join(right, "hardlink.json5");
  const initial = JSON.stringify({ plugins: [relative] });
  fs.writeFileSync(config, initial);
  fs.symlinkSync(config, alias);
  fs.linkSync(config, hardlink);
  fs.writeFileSync(leftPlugin, "{ name: 'left' }");
  fs.writeFileSync(rightPlugin, "{ name: 'right' }");
  fs.writeFileSync(plugin, "{ name: 'first' }");

  const reads: string[] = [];
  const service = physicalDiscovery(path.join(root, "data"), reads);
  const first = service.forRenderer(MAIN_RENDERER);
  const next = service.forRenderer(rendererNameOf("other"));
  const a = originOf(left, left, config);
  const b = originOf(right, right, alias);
  const c = originOf(right, right, hardlink);
  first.follow([a]);
  next.follow([b]);
  next.follow([b, c]);
  expect(reads.filter((file) => file === config || file === hardlink)).toEqual([
    config,
  ]);
  expect(reads.filter((file) => file === plugin)).toHaveLength(1);
  expect(first.snapshotOf(a)?.chain[0]?.listed[relative]?.path).toBe(
    leftPlugin,
  );
  expect(next.snapshotOf(b)?.chain[0]?.listed[relative]?.path).toBe(
    rightPlugin,
  );
  expect(textOfLayer(next, b, alias)).toBe(initial);
  expect(textOfLayer(next, c, hardlink)).toBe(initial);

  // Both aliases see an in-place change to the same inode. The installed
  // plugin separately changes identity through an atomic publish.
  const changed = '{ plugins: ["widget/plugin.json5"], globals: {} }';
  fs.writeFileSync(config, changed);
  const replacement = path.join(installed, "replacement");
  fs.writeFileSync(replacement, "{ name: 'second' }");
  fs.renameSync(replacement, plugin);
  service.again("test write");
  expect(reads.filter((file) => file === config || file === hardlink)).toEqual([
    config,
    config,
  ]);
  expect(reads.filter((file) => file === plugin)).toHaveLength(2);
  expect(textOfLayer(first, a, config)).toBe(changed);
  expect(textOfLayer(next, b, alias)).toBe(changed);
  expect(textOfLayer(next, c, hardlink)).toBe(changed);
  expect(next.snapshotOf(b)?.plugins[0]?.definition).toMatchObject({
    kind: "text",
    text: "{ name: 'second' }",
  });

  fs.unlinkSync(config);
  fs.mkdirSync(config);
  service.again("test replacement with directory");
  expect(next.snapshotOf(b)?.chain[0]).toMatchObject({
    path: alias,
    content: { kind: "unreadable", error: "not a file" },
  });
  expect(textOfLayer(next, c, hardlink)).toBe(changed);
});

test("a project cannot inherit another origin's approval through the same physical config", () => {
  const approved = project("approved");
  const other = project("other");
  const config = path.join(approved, ".cc-candybar.json5");
  const same = path.join(other, ".cc-candybar.json5");
  fs.writeFileSync(config, "{}");
  fs.linkSync(config, same);
  writeStatePlan(
    repoConfigs(path.join(root, "state")).plan(() => ({
      [approved]: "approved",
    })),
  );
  const reads: string[] = [];
  const service = physicalDiscovery(project("empty-data"), reads);
  const first = service.forRenderer(MAIN_RENDERER);
  const second = service.forRenderer(rendererNameOf("other"));
  const a = originOf(approved, approved);
  const b = originOf(other, other);
  first.follow([a]);
  second.follow([b]);
  expect(textOfLayer(first, a, config)).toBe("{}");
  expect(second.snapshotOf(b)?.repo).toMatchObject({
    dir: other,
    standing: "awaiting",
  });
  expect(textOfLayer(second, b, same)).toBeNull();
  expect(reads.filter((file) => file === config || file === same)).toEqual([
    config,
  ]);
});

test("text exceeding the retention budget still reads but does not occupy the cache", () => {
  const file = path.join(root, "long.json5");
  const text = " ".repeat(2 * 1024 * 1024 + 1);
  fs.writeFileSync(file, text);
  const reads: string[] = [];
  const cached = new ConfigText(countingText(reads));
  expect(cached.read(file).text).toBe(text);
  expect(cached.read(file).text).toBe(text);
  expect(reads).toEqual([file, file]);
});

// [LAW:verifiable-goals] Delete between the real descriptor read and first
// follow. A stat at follow sees only absence; the snapshot saw text.
test("a deleted layer heard through its descriptor revision retires on the first poll", async () => {
  const { file, origin: input } = named(
    "removed-after-read",
    "{ globals: { padding: 9 } }",
  );
  const origin = {
    ...input,
    target: requestedConfigTarget(file, undefined, "config-only"),
  };
  const clock = heldClock(new Date());
  const watchers = new WatcherRegistry({
    failed: failTest,
    clock,
    logger: () => {},
  });
  const reads: string[] = [];
  const moved: RenderOrigin[] = [];
  const observe = countingText(reads);
  const service = new ConfigDiscovery({
    failed: failTest,
    locations: {
      ...locations(HOST),
      dataHome: project("empty-data"),
      dataDirs: [],
    },
    stateDir: stateDir(HOST),
    watchers,
    openText(at, use) {
      const result = observe(at, use);
      if (at === file) fs.unlinkSync(file);
      return result;
    },
    log: () => {},
    moved: (_renderer, origins) => moved.push(...origins),
  });
  cleanups.push(
    () => watchers.closeAll(),
    () => service.close(),
  );
  const renderer = service.forRenderer(MAIN_RENDERER);
  const content = () => renderer.snapshotOf(origin)?.chain[0]?.content.kind;
  renderer.follow([origin]);
  expect(content()).toBe("text");
  expect(fs.existsSync(file)).toBe(false);
  expect(moved).toEqual([]);

  await clock.settle(POLL_MS + DEBOUNCE_MS);
  expect(content()).toBe("absent");
  expect(moved).toEqual([origin]);
  expect(reads).toEqual([file]);
  await clock.settle(POLL_MS + DEBOUNCE_MS);
  expect(moved).toEqual([origin]);
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
  const { snapshot } = discover(
    { kind: "chain", cwd: root },
    readShared(world, files),
  );
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
