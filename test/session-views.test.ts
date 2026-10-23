import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RenderCache, type SessionView } from "../src/daemon/cache/render";
import { GitDataProvider } from "../src/daemon/cache/git";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { renderDsl } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";
import { stripAnsi } from "./helpers/ansi";

// brandon-unfiled-3248.8ro6, step 2: each value lives where its scope says. A
// directory's store holds the sources no session value reaches; each session
// draws through a view of its own over it. Before, one store per directory was
// switched to each rendering session's values in turn, so a source keyed on a
// session value re-ran on every alternation between two sessions, and each saw
// whichever ran last.

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-views-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

function makeCache() {
  const lines: string[] = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0 },
    logger: () => {},
  });
  const gitService = new GitDataProvider({ logger: () => {} });
  cleanups.push(() => watchers.closeAll(), () => gitService.close());
  const cache = new RenderCache(
    {
      gitService,
      sessionState: new SessionState(),
      watchers,
      log: (_level, line) => lines.push(line),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => cache.close());
  return { cache, lines };
}

// Each run of a shell appends a line naming it, so the file counts its runs.
const runs = (name: string): number => {
  const p = path.join(dir, `${name}.runs`);
  return fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length
    : 0;
};
const counted = (name: string, out: string): string =>
  `echo run >> ${JSON.stringify(path.join(dir, `${name}.runs`))}; echo ${out}`;

function configure(cwd: string): void {
  const config = {
    variables: {
      sid: { kind: "input", path: "session_id" },
      // Re-runs when the session it is keyed on changes.
      perSession: {
        kind: "shell",
        command: counted("perSession", "ps"),
        cache: { key: "{{ .sid }}" },
      },
      // Reads no session value: one per directory.
      perDirectory: {
        kind: "shell",
        command: counted("perDirectory", "pd"),
        cache: { ttl: "1h" },
      },
    },
    segments: {
      who: { template: "who={{ .sid }} {{ .perSession }} {{ .perDirectory }}" },
    },
    root: { h: ["who"] },
  };
  fs.writeFileSync(path.join(cwd, ".cc-candybar.json5"), JSON.stringify(config));
}

const drawn = (view: SessionView, sid = view.sessionId): string =>
  stripAnsi(
    renderDsl(
      view.state.config,
      view.state.compiled,
      view.store,
      view.registry,
      { session_id: sid, workspace: { project_dir: dir } },
      instantOf(new Date()),
      { endcaps: "plain", colorCompatibility: "none", wrap: true, padding: 1, width: 300 },
    ),
  );

// One render of session `sid` from `cwd`, as the daemon draws one: through the
// session's view, held for the render, then every source it started settled.
async function render(
  cache: RenderCache,
  sid: string,
  cwd = dir,
): Promise<{ text: string; view: SessionView }> {
  const { text, view } = (() => {
    using held = cache.holdSession(cwd, cwd, undefined, sid);
    return { text: drawn(held.view, sid), view: held.view };
  })();
  expect(await view.registry.settled(5000)).toEqual([]);
  return { text, view };
}

test("two sessions alternating on one directory each keep their own values", async () => {
  configure(dir);
  const { cache } = makeCache();
  const a = await render(cache, "s-a");
  const b = await render(cache, "s-b");
  expect(a.text).toContain("who=s-a");
  expect(b.text).toContain("who=s-b");
  // One view per session, over the one entry.
  expect(a.view).not.toBe(b.view);
  expect(a.view.state).toBe(b.view.state);
  expect(cache.stats).toMatchObject({ size: 1, views: 2 });
  const settledRuns = runs("perSession");

  for (let i = 0; i < 4; i++) {
    expect((await render(cache, "s-a")).text).toContain("who=s-a");
    expect((await render(cache, "s-b")).text).toContain("who=s-b");
  }
  // Alternating re-runs nothing: each session's key is its own, and never
  // moved by the other's render.
  expect(runs("perSession")).toBe(settledRuns);
  // The directory's source ran once, for every session rendering there.
  expect(runs("perDirectory")).toBe(1);
});

test("a session's render from another directory replaces its view", async () => {
  configure(dir);
  const other = path.join(dir, "sub");
  fs.mkdirSync(other);
  configure(other);
  const { cache, lines } = makeCache();
  const first = await render(cache, "s-a");
  const moved = await render(cache, "s-a", other);
  expect(moved.view).not.toBe(first.view);
  expect(cache.stats).toMatchObject({ size: 2, views: 1 });
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=moved /),
  );
  // The other session's view is untouched by the move.
  const b = await render(cache, "s-b");
  expect(cache.stats.views).toBe(2);
  expect(b.view.state).toBe(first.view.state);
});

test("a reload retires the entry's views; the next render opens one on the new state", async () => {
  configure(dir);
  const { cache, lines } = makeCache();
  const before = await render(cache, "s-a");
  cache.reload(dir, dir, undefined);
  expect(cache.stats.views).toBe(0);
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=reload /),
  );
  const after = await render(cache, "s-a");
  expect(after.view.state).not.toBe(before.view.state);
  expect(after.text).toContain("who=s-a");
});

test("a view no render reads across a whole sweep closes; one read stays", async () => {
  configure(dir);
  const { cache, lines } = makeCache();
  await render(cache, "s-a");
  await render(cache, "s-b");
  cache.releaseIdle();
  // Read since the sweep before: kept.
  expect(cache.stats.views).toBe(2);
  await render(cache, "s-b");
  cache.releaseIdle();
  expect(cache.stats.views).toBe(1);
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=idle /),
  );
  // The session's next render opens its view again.
  expect((await render(cache, "s-a")).text).toContain("who=s-a");
  expect(cache.stats.views).toBe(2);
});

test("a view held by a render in flight is disposed only when the render returns", () => {
  configure(dir);
  const { cache, lines } = makeCache();
  const held = cache.holdSession(dir, dir, undefined, "s-a");
  cache.reload(dir, dir, undefined);
  expect(cache.stats.views).toBe(0);
  // Retired, not disposed: the render still draws through it.
  expect(lines.some((l) => l.startsWith("session view closed"))).toBe(false);
  expect(drawn(held.view)).toContain("who=s-a");
  held[Symbol.dispose]();
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=reload .* held=1 /),
  );
});
