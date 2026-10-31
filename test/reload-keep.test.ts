import { processLauncher } from "../src/proc/launch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DECLARES_NOTHING,
  RenderCache,
  SOURCES_NOTHING,
  type LoadCause,
  type Settled,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { TEST_SIGNER } from "./helpers/link-signer";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { viewFacts } from "./helpers/view-facts";
import { fakeWatches } from "./helpers/fake-watches";

// [LAW:behavior-not-structure] A reload keeps the state it serves exactly when
// what it read from disk is what that state was built from, read through
// what the cache shows: the state an entry serves, the views it opens, the
// warning it carries, and what each load says it did.

let dir: string;
let saved: { home?: string; dirs?: string; config?: string };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reload-keep-")));
  // No installed plugin and no user config reaches a load but the test's own.
  saved = {
    home: process.env.XDG_DATA_HOME,
    dirs: process.env.XDG_DATA_DIRS,
    config: process.env.XDG_CONFIG_HOME,
  };
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  process.env.XDG_DATA_DIRS = path.join(dir, "share");
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
});

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  jest.restoreAllMocks();
  process.env.XDG_DATA_HOME = saved.home;
  process.env.XDG_DATA_DIRS = saved.dirs;
  process.env.XDG_CONFIG_HOME = saved.config;
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const loads: Settled[] = [];
  const causes: LoadCause[] = [];
  const lines: string[] = [];
  const watchers = new WatcherRegistry({ logger: () => {} });
  cleanups.push(() => watchers.closeAll());
  const cache = new RenderCache(
    {
      launcher: processLauncher,
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: DECLARES_NOTHING,
      log: (_level, line) => lines.push(line),
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      observers: {
        onReload: (_e, _s, cause, settled) => {
          loads.push(settled);
          causes.push(cause);
        },
      },
    },
  );
  cleanups.push(() => cache.close());
  const file = path.join(dir, "config.json5");
  const write = (text: string): void => fs.writeFileSync(file, text);
  const entry = () => cache.getOrCreate(dir, dir, file);
  const reload = (): Settled => {
    cache.reload(dir, dir, file, { kind: "write" });
    return loads.at(-1)!;
  };
  const reopened = () => lines.filter((l) => / by=reload /.test(l)).length;
  const open = (sid: string) =>
    cache.holdSession(dir, dir, file, viewFacts(dir, sid))[Symbol.dispose]();
  return { cache, lines, loads, causes, write, entry, reload, reopened, open };
}

const CONFIG = `{
  segments: { t: { template: "one" } },
  root: { h: ["t"] },
}
`;

test("a reload of unchanged inputs keeps the state and reopens no view", () => {
  const r = rig();
  r.write(CONFIG);
  r.open("s1");
  const state = r.entry().state;
  expect(r.reload()).toBe("kept");
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
  r.write(`{ variables: { v: { kind: "template", template: "{{ if }}" } } }`);
  expect(r.entry().lastWarning).toContain(`Variable "v"`);
  expect(r.reload()).toBe("kept");
  expect(r.entry().lastWarning).toContain(`Variable "v"`);
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
  expect(entry.lastWarning).toContain(`Variable "v"`);
  expect(entry.state).toBe(state);
});

test("a change only to a warning keeps the state and updates the warning", () => {
  const r = rig();
  r.write(CONFIG);
  const state = r.entry().state;
  expect(r.entry().lastWarning).toBeNull();
  // A duplicate key resolving to the value already there: JSON5 keeps the
  // last, so what loads is unchanged and only the advisory is new.
  r.write(
    CONFIG.replace(`template: "one"`, `template: "one", template: "one"`),
  );
  expect(r.reload()).toBe("kept");
  expect(r.entry().state).toBe(state);
  expect(r.entry().lastWarning).toContain("template");
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

// File events resuming after a span re-read every entry: an edit made while
// the OS delivered nothing was never heard by the entry's own watch.
test("a catch-up reloads every entry under events-resumed: the one edited while its watch heard nothing builds the new config, the other keeps its view", () => {
  fakeWatches();
  const r = rig();
  const other = path.join(dir, "other");
  fs.mkdirSync(other);
  const otherFile = path.join(other, "config.json5");
  fs.writeFileSync(otherFile, CONFIG);
  r.write(CONFIG);
  r.open("s1");
  r.cache
    .holdSession(other, other, otherFile, viewFacts(other, "s2"))
    [Symbol.dispose]();
  const edited = r.entry().state;
  const kept = r.cache.getOrCreate(other, other, otherFile).state;
  r.write(CONFIG.replace(`"one"`, `"two"`));
  const since = Date.parse("2026-10-27T04:00:00.000Z");
  const before = r.loads.length;
  r.cache.reloadEvery({ kind: "events-resumed", since });
  expect(r.causes.slice(before)).toEqual([
    { kind: "events-resumed", since },
    { kind: "events-resumed", since },
  ]);
  expect(r.loads.slice(before).sort()).toEqual(["built", "kept"]);
  expect(r.entry().state).not.toBe(edited);
  expect(JSON.stringify(r.entry().state.config)).toContain(`"two"`);
  expect(r.cache.getOrCreate(other, other, otherFile).state).toBe(kept);
  expect(r.reopened()).toBe(1);
});
