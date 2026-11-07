import { systemFilesystem } from "../src/disk/system-filesystem";
import { homeOf } from "../src/daemon/home";
import { FACTS_NOTHING } from "./helpers/facts";
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
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { TEST_LINKS } from "./helpers/link-signer";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { viewFacts } from "./helpers/view-facts";
import { fakeWatches } from "./helpers/fake-watches";
import { locations, stateDir } from "../src/daemon/paths";
import { bareGates } from "./helpers/gates";
import { systemTimekeeper, type Timekeeper } from "../src/time";
import { heldClock } from "./helpers/held-clock";
import { SourceRuns } from "../src/var-system/source-runs";

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
  const watchers = new WatcherRegistry({ filesystem: systemFilesystem, clock: systemTimekeeper,
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const cache = new RenderCache(
    {
      clock: opts.clock ?? systemTimekeeper,
      stateDir: stateDir(homeOf(host)),
      locations: locations(host, homeOf(host)),
      storage: NO_PLUGIN_STORAGE,
      links: TEST_LINKS,
      gates: bareGates(),
      sessionState: new SessionState(SINGLE_RUN),
      watchers,
      source: SOURCES_NOTHING,
      facts: FACTS_NOTHING,
      log: (_level, line) => lines.push(line),
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      maxEntries: opts.maxEntries,
      observers: {
        onReload: (entry, _s, cause, settled) => {
          loads.push(settled);
          causes.push(cause);
          reloaded.push(entry.projectDir);
          opts.onReload?.(entry.projectDir);
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
  // An entry of its own directory, its config written and loaded.
  const project = (name: string): string => {
    const at = path.join(dir, name);
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "config.json5"), CONFIG);
    cache.getOrCreate(at, at, path.join(at, "config.json5"));
    return at;
  };
  return {
    cache,
    lines,
    loads,
    causes,
    reloaded,
    write,
    entry,
    reload,
    reopened,
    open,
    project,
  };
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
  const clock = heldClock(new Date());
  const r = rig({ clock });
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
  clock.advance(0);
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

// [LAW:no-ambient-temporal-coupling] A catch-up reloads one entry per turn of
// the loop, so work waiting on the loop (a client's request) runs between
// entries instead of behind all of them.
describe("a catch-up walks the entries one per turn", () => {
  const since = Date.parse("2026-10-27T04:00:00.000Z");
  const resumed = { kind: "events-resumed", since } as const;
  const walked = (r: ReturnType<typeof rig>, from: number) =>
    r.reloaded.slice(from);

  test("nothing reloads in the turn that asks, and work deferred behind it runs between the first entry and the second", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    const r = rig({ clock });
    const a = r.project("a");
    const b = r.project("b");
    const from = r.reloaded.length;
    r.cache.reloadEvery(resumed);
    expect(walked(r, from)).toEqual([]);
    expect(r.cache.stats.due).toBe(2);
    let between: string[] | null = null;
    clock.defer(() => (between = walked(r, from)));
    clock.advance(0);
    expect(between).toEqual([a]);
    expect(walked(r, from)).toEqual([a, b]);
    expect(r.cache.stats.due).toBe(0);
  });

  test("an entry evicted before its turn is not reloaded, and leaves the count at once", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    const r = rig({ clock, maxEntries: 2 });
    r.project("a");
    const b = r.project("b");
    r.cache.reloadEvery(resumed);
    expect(r.cache.stats.due).toBe(2);
    r.project("c");
    expect(r.cache.stats.due).toBe(1);
    const from = r.reloaded.length;
    clock.advance(0);
    expect(walked(r, from)).toEqual([b]);
  });

  test("a close before the walk ends reloads nothing more", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    const r = rig({ clock });
    r.project("a");
    r.project("b");
    r.cache.reloadEvery(resumed);
    r.cache.close();
    const from = r.reloaded.length;
    clock.advance(0);
    expect(walked(r, from)).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("a second catch-up before the walk ends reloads each entry once, for the later cause", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    const r = rig({ clock });
    const a = r.project("a");
    const b = r.project("b");
    const from = r.reloaded.length;
    r.cache.reloadEvery(resumed);
    const answers = {
      kind: "answers-watch",
      heard: { kind: "unknown" },
    } as const;
    r.cache.reloadEvery(answers);
    clock.advance(0);
    expect(walked(r, from)).toEqual([a, b]);
    expect(r.causes.slice(from)).toEqual([answers, answers]);
  });

  test("an entry reloaded by an explicit reload before its turn is not reloaded again by the walk", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    const r = rig({ clock });
    r.write(CONFIG);
    r.entry();
    const b = r.project("b");
    r.cache.reloadEvery(resumed);
    const from = r.reloaded.length;
    expect(r.reload()).toBe("kept");
    expect(r.cache.stats.due).toBe(1);
    clock.advance(0);
    expect(walked(r, from)).toEqual([dir, b]);
  });

  test("a reload that throws ends only its own turn: the rest of the walk and a later catch-up still reload", () => {
    fakeWatches();
    const clock = heldClock(new Date());
    let failing: string | null = null;
    const r = rig({
      clock,
      onReload: (projectDir) => {
        if (projectDir === failing) throw new Error("observer failed");
      },
    });
    const a = r.project("a");
    const b = r.project("b");
    failing = a;
    const from = r.reloaded.length;
    r.cache.reloadEvery(resumed);
    expect(() => clock.advance(0)).toThrow("observer failed");
    clock.advance(0);
    expect(walked(r, from)).toEqual([a, b]);
    expect(r.cache.stats.due).toBe(0);
    failing = null;
    r.cache.reloadEvery(resumed);
    clock.advance(0);
    expect(walked(r, from)).toEqual([a, b, a, b]);
  });
});
