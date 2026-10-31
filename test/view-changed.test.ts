// brandon-unfiled-3248.8ro6 §4e: a session's view says when what it draws
// from moved, and a feed showing the session wakes on nothing else of its
// data. It says so as it opens, and when a source it reads publishes a value
// that differs from the one stored; a re-read that finds what is stored moves
// nothing, so a still source under a fast period wakes no feed.

import { processLauncher } from "../src/proc/launch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DECLARES_NOTHING,
  SOURCES_NOTHING,
  RenderCache,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { TEST_SIGNER } from "./helpers/link-signer";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { viewFacts } from "./helpers/view-facts";
import { writeAtomic } from "../src/utils/atomic-write";
import { until } from "./helpers/until";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-changed-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// A cache whose views report each change by session, over a config whose one
// segment reads a file source re-read every 50 ms.
function setUp() {
  const status = path.join(dir, "status.txt");
  fs.writeFileSync(status, "green");
  const configFile = path.join(dir, "bar.json5");
  // The config, its one segment drawn by `template`.
  const writeConfig = (template: string): void =>
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        variables: {
          status: {
            kind: "file",
            path: status,
            parse: { text: true },
            cache: { ttl: "50ms" },
            default: "?",
          },
        },
        segments: { status: { template } },
        root: { h: ["status"] },
      }),
    );
  writeConfig("{{ .status }}");
  const watchers = new WatcherRegistry({
    counters: {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const changed: string[] = [];
  // The sessions each reload said drew from its entry, in order.
  const reloads: Array<readonly string[]> = [];
  const cache = new RenderCache(
    {
      launcher: processLauncher,
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: DECLARES_NOTHING,
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      observers: {
        onViewChanged: (sid) => changed.push(sid),
        onReload: (_entry, sessions) => reloads.push(sessions),
      },
    },
  );
  cleanups.push(() => cache.close());
  const open = (sid: string) =>
    cache.holdSession(dir, dir, configFile, viewFacts(dir, sid));
  const reload = (): void =>
    cache.reload(dir, dir, configFile, { kind: "write" });
  return { status, changed, reloads, writeConfig, reload, open };
}

test("a view says so as it opens, once per session", () => {
  const { changed, open } = setUp();
  open("a")[Symbol.dispose]();
  open("a")[Symbol.dispose]();
  open("b")[Symbol.dispose]();
  expect(changed).toEqual(["a", "b"]);
});

test("a source re-read that finds what it stored wakes nothing; a new value wakes once", async () => {
  const { status, changed, open } = setUp();
  using held = open("s");
  await until(
    () => held.view.store.read("status") === "green",
    "the source's first read",
  );
  // Its first read is a change from the default the view opened with: the
  // directory's source, read through the view.
  const settled = changed.length;
  expect(changed).toEqual(["s", "s"]);
  // Twenty periods of re-reads of the same text.
  await sleep(1000);
  expect(changed).toHaveLength(settled);
  writeAtomic(status, "red");
  await until(() => held.view.store.read("status") === "red", "the new value");
  expect(changed).toHaveLength(settled + 1);
  await sleep(300);
  expect(changed).toHaveLength(settled + 1);
});

// A reload wakes the feeds of the sessions that drew from its entry: those
// whose views it reopened, and those whose config failed to load and whose
// strip now says so. An entry just created was drawn by no one.
test("a reload names the sessions that drew from its entry, whether or not it loaded", () => {
  const { reloads, writeConfig, reload, open } = setUp();
  open("a")[Symbol.dispose]();
  expect(reloads).toEqual([[]]);
  writeConfig("{{ .status }}!");
  reload();
  fs.writeFileSync(path.join(dir, "bar.json5"), "{ not json5");
  reload();
  expect(reloads).toEqual([[], ["a"], ["a"]]);
});

// A view a reload replaced is no session's bar, though the render that holds
// it still draws from it: what its retired sources publish wakes no feed.
test("a view a reload retired says nothing more while a render still holds it", async () => {
  const { status, changed, writeConfig, reload, open } = setUp();
  using old = open("s");
  await until(
    () => old.view.store.read("status") === "green",
    "the first read",
  );
  // An edit, and the save's reload of it. The config's watch hears the write
  // too, and its reload of the same bytes, which can land inside the window
  // counted below, keeps the state and opens no view.
  writeConfig("{{ .status }}!");
  reload();
  using now = open("s");
  expect(now.view).not.toBe(old.view);
  await until(
    () => now.view.store.read("status") === "green",
    "the successor's first read",
  );
  await sleep(200);
  const settled = changed.length;
  writeAtomic(status, "red");
  await until(
    () =>
      old.view.store.read("status") === "red" &&
      now.view.store.read("status") === "red",
    "both views' new value",
  );
  await sleep(200);
  expect(changed).toHaveLength(settled + 1);
});
