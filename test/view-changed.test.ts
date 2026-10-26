// brandon-unfiled-3248.8ro6 §4e: a session's view says when what it draws
// from moved, and a feed showing the session wakes on nothing else of its
// data. It says so as it opens, and when a source it reads publishes a value
// that differs from the one stored; a re-read that finds what is stored moves
// nothing, so a still source under a fast period wakes no feed.

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
import { viewFacts } from "./helpers/view-facts";
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
      segments: { status: { template: "{{ .status }}" } },
      root: { h: ["status"] },
    }),
  );
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0 },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const changed: string[] = [];
  const cache = new RenderCache(
    {
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: DECLARES_NOTHING,
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      observers: { onViewChanged: (sid) => changed.push(sid) },
    },
  );
  cleanups.push(() => cache.close());
  const open = (sid: string) =>
    cache.holdSession(dir, dir, configFile, sid, viewFacts(dir, sid));
  return { status, changed, open };
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
  fs.writeFileSync(status, "red");
  await until(() => held.view.store.read("status") === "red", "the new value");
  expect(changed).toHaveLength(settled + 1);
  await sleep(300);
  expect(changed).toHaveLength(settled + 1);
});
