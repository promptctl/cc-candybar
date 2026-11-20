import fs from "node:fs";
import { HOST, hostOf, worldOf } from "./helpers/host";
import type { Host, World } from "../src/host";
import os from "node:os";
import path from "node:path";
import {
  RenderCache,
  SOURCES_NOTHING,
  type LoadCause,
  type Settled,
} from "../src/renderer/render-cache";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/renderer/session-state";
import { viewFacts } from "./helpers/view-facts";
import { fakeWatches } from "./helpers/fake-watches";
import { locations, stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { configHost } from "./helpers/config-host";
import { systemTimekeeper, type Timekeeper } from "../src/time";
import { heldClock } from "./helpers/held-clock";
import { SourceRuns } from "../src/daemon/source-runs";

// [LAW:behavior-not-structure] A reload keeps the state it serves exactly when
// what it read from disk is what that state was built from, read through
// what the cache shows: the state an entry serves, the views it opens, the
// warning it carries, and what each load says it did.

let dir: string;
let host: Host;
let world: World;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-keep-")));
  // No installed plugin and no user config reaches a load but the test's own.
  host = hostOf({
    ...HOST.env,
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_DATA_DIRS: path.join(dir, "share"),
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
  });
  world = worldOf(host);
});

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(
  opts: {
    clock?: Timekeeper;
    maxEntries?: number;
    onReload?: (projectDir: string) => void;
  } = {},
) {
  const loads: Settled[] = [];
  const causes: LoadCause[] = [];
  // Which entry each reload was of, by its project directory, in order.
  const reloaded: string[] = [];
  const lines: string[] = [];
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const cache = new RenderCache(
    {
      clock: opts.clock ?? systemTimekeeper,
      locations: locations(host),
      gates: bareGates(),
      sessionState: new SessionState(),
      source: SOURCES_NOTHING,
      log: (_level, line) => lines.push(line),
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      maxEntries: opts.maxEntries,
      observers: {
        onReload: (entry, _s, cause, settled) => {
          loads.push(settled);
          causes.push(cause);
          reloaded.push(entry.origin.projectDir);
          opts.onReload?.(entry.origin.projectDir);
        },
      },
    },
  );
  const configs = configHost(cache, {
    locations: locations(host),
    stateDir: stateDir(host),
    watchers,
    log: (_level, line) => lines.push(line),
  });
  cleanups.push(() => configs.close());
  cleanups.push(() => cache.close());
  const file = path.join(dir, "config.json5");
  const write = (text: string): void => fs.writeFileSync(file, text);
  const entry = () => cache.getOrCreate(configs.at(dir, dir, file));
  // What discovering every origin again did to the entry: how its reload
  // settled, or `unmoved` for a snapshot that digests as before, which
  // reloads nothing.
  const reload = (): Settled | "unmoved" => {
    const before = loads.length;
    configs.again();
    return loads.length === before ? "unmoved" : loads.at(-1)!;
  };
  const reopened = () => lines.filter((l) => / by=reload /.test(l)).length;
  const open = (sid: string) =>
    cache
      .holdSession(configs.at(dir, dir, file), viewFacts(dir, sid))
      [Symbol.dispose]();
  return {
    cache,
    configs,
    lines,
    loads,
    causes,
    reloaded,
    write,
    entry,
    reload,
    reopened,
    open,
  };
}

const CONFIG = `{
  segments: { t: { template: "one" } },
  root: { h: ["t"] },
}
`;

test("a snapshot that digests as before reloads nothing and reopens no view", () => {
  const r = rig();
  r.write(CONFIG);
  r.open("s1");
  const state = r.entry().state;
  expect(r.reload()).toBe("unmoved");
  expect(r.entry().state).toBe(state);
  expect(r.reopened()).toBe(0);
});

test("a whitespace or comment edit is kept; an edit to a value builds, and its view reopens", () => {
  const r = rig();
  r.write(CONFIG);
  r.open("s1");
  const state = r.entry().state;
  r.write(`// the bar's one segment\n${CONFIG.replace("{", "{   ")}\n\n`);
  expect(r.reload()).toBe("kept");
  expect(r.entry().state).toBe(state);
  r.write(CONFIG.replace(`"one"`, `"two"`));
  expect(r.reload()).toBe("built");
  expect(r.entry().state).not.toBe(state);
  expect(r.reopened()).toBe(1);
});

test("a kept state still carries the warning its build earned", () => {
  const r = rig();
  const text = `{ variables: { v: { kind: "template", template: "{{ if }}" } } }`;
  r.write(text);
  expect(r.entry().lastWarnings.join("\n")).toContain(`Variable "v"`);
  r.write(`// a comment\n${text}`);
  expect(r.reload()).toBe("kept");
  expect(r.entry().lastWarnings.join("\n")).toContain(`Variable "v"`);
});

test("a build that throws at its gates shows its own warning beside the error, and the old state stays", () => {
  const r = rig();
  r.write(CONFIG);
  const state = r.entry().state;
  r.write(`{
  variables: { v: { kind: "template", template: "{{ if }}" } },
  actions: { a: { set: "k", to: "x" }, b: { set: "k", int: true } },
}`);
  expect(r.reload()).toBe("failed");
  const entry = r.entry();
  expect(entry.lastError).toContain(`key "k"`);
  expect(entry.lastWarnings.join("\n")).toContain(`Variable "v"`);
  expect(entry.state).toBe(state);
});

test("a change only to a warning keeps the state and updates the warning", () => {
  const r = rig();
  r.write(CONFIG);
  const state = r.entry().state;
  expect(r.entry().lastWarnings).toEqual([]);
  // A duplicate key resolving to the value already there: JSON5 keeps the
  // last, so what loads is unchanged and only the advisory is new.
  r.write(
    CONFIG.replace(`template: "one"`, `template: "one", template: "one"`),
  );
  expect(r.reload()).toBe("kept");
  expect(r.entry().state).toBe(state);
  expect(r.entry().lastWarnings.join("\n")).toContain("template");
});

test("an installed plugin nothing places, added with the config unchanged, builds: its drop is logged and its definition watched", () => {
  const r = rig();
  r.write(CONFIG);
  const state = r.entry().state;
  const definition = path.join(
    dir,
    "share/cc-candybar/plugins/foo/plugin.json5",
  );
  fs.mkdirSync(path.dirname(definition), { recursive: true });
  fs.writeFileSync(
    definition,
    `{ data: "./d.json", segments: { s: { template: "{{ if }}" } } }`,
  );
  expect(r.reload()).toBe("built");
  expect(r.entry().state).not.toBe(state);
  expect(r.entry().state.plugins.unreached.map((d) => d.path)).toContain(
    definition,
  );
  expect(r.lines.filter((l) => l.startsWith("config load ")).at(-1)).toContain(
    ` ~${definition} (`,
  );
  expect(
    r.lines.some(
      (l) =>
        l.startsWith("config watch bound ") &&
        l.includes(path.dirname(definition)),
    ),
  ).toBe(true);
});

// File events resuming after a span discover every origin again: an edit
// made while the OS delivered nothing was never heard by the origin's own
// watch.
test("a catch-up reloads the entry edited while its watch heard nothing, and leaves the other as it was", () => {
  fakeWatches();
  const clock = heldClock(new Date());
  const r = rig({ clock });
  const other = path.join(dir, "other");
  fs.mkdirSync(other);
  const otherFile = path.join(other, "config.json5");
  fs.writeFileSync(otherFile, CONFIG);
  r.write(CONFIG);
  r.open("s1");
  r.cache
    .holdSession(r.configs.at(other, other, otherFile), viewFacts(other, "s2"))
    [Symbol.dispose]();
  const edited = r.entry().state;
  const kept = r.cache.getOrCreate(r.configs.at(other, other, otherFile)).state;
  r.write(CONFIG.replace(`"one"`, `"two"`));
  const before = r.loads.length;
  r.configs.again();
  expect(r.causes.slice(before)).toEqual([{ kind: "config" }]);
  expect(r.loads.slice(before)).toEqual(["built"]);
  expect(r.entry().state).not.toBe(edited);
  expect(JSON.stringify(r.entry().state.config)).toContain(`"two"`);
  expect(r.cache.getOrCreate(r.configs.at(other, other, otherFile)).state).toBe(
    kept,
  );
  expect(r.reopened()).toBe(1);
});
