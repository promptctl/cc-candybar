import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DECLARES_NOTHING,
  RenderCache,
  type SessionView,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { renderDsl } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";
import { stripAnsi } from "./helpers/ansi";
import { viewFacts } from "./helpers/view-facts";

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

function makeCache(
  opts: { budgetBytes?: number; log?: (line: string) => void } = {},
) {
  const lines: string[] = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0 },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const cache = new RenderCache(
    {
      sessionState: new SessionState(),
      watchers,
      declare: DECLARES_NOTHING,
      log: (_level, line) => {
        opts.log?.(line);
        lines.push(line);
      },
    },
    { budgetBytes: () => opts.budgetBytes ?? 1024 * 1024 * 1024 },
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

const drawn = (
  view: SessionView,
  sid = view.sessionId,
  at = new Date(),
): string =>
  stripAnsi(
    renderDsl(
      view.state.config,
      view.state.compiled,
      view.store,
      view.registry,
      { session_id: sid, workspace: { project_dir: dir } },
      instantOf(at),
      { endcaps: "plain", colorCompatibility: "none", wrap: true, padding: 1, width: 300 },
    ),
  );

// One render of session `sid` from `cwd`, as the daemon draws one: through the
// session's view, held for the render, then every source it started settled.
async function render(
  cache: RenderCache,
  sid: string,
  cwd = dir,
  at = new Date(),
): Promise<{ text: string; view: SessionView }> {
  const { text, view } = (() => {
    using held = cache.holdSession(cwd, cwd, undefined, sid, viewFacts(cwd, sid));
    return { text: drawn(held.view, sid, at), view: held.view };
  })();
  // Both homes the render read: the view's sources, and the directory's.
  expect(await view.registry.settled(5000)).toEqual([]);
  expect(await view.state.registry.settled(5000)).toEqual([]);
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

test("a reload opens each of the entry's views anew on the new state, and retires the old", async () => {
  configure(dir);
  const { cache, lines } = makeCache();
  const before = await render(cache, "s-a");
  cache.reload(dir, dir, undefined);
  // The successor is open — declared, so the next frame draws a view that
  // holds what it reads — before any render (brandon-unfiled-3248.8ro6, 4a).
  expect(cache.stats.views).toBe(1);
  expect(cache.latestView()?.state).not.toBe(before.view.state);
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
  const held = cache.holdSession(dir, dir, undefined, "s-a", viewFacts(dir, "s-a"));
  cache.reload(dir, dir, undefined);
  expect(cache.stats).toMatchObject({ views: 1, retiredViews: 1 });
  // Retired, not disposed: the render still draws through it.
  expect(lines.some((l) => l.startsWith("session view closed"))).toBe(false);
  expect(drawn(held.view)).toContain("who=s-a");
  held[Symbol.dispose]();
  expect(cache.stats.retiredViews).toBe(0);
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=reload .* held=1 /),
  );
});

// [LAW:no-ambient-temporal-coupling] The instant is the draw's, and a
// directory is never drawn: a key over it could only be answered by whichever
// session's draw last touched the directory, so it is refused at load.
test("a source keyed on the instant is refused at load, naming the period that re-runs it", () => {
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({
      variables: {
        clocked: {
          kind: "shell",
          command: counted("clocked", "c"),
          cache: { key: '{{ now | date "15:04" }}' },
        },
      },
      segments: { s: { template: "{{ .clocked }}" } },
      root: { h: ["s"] },
    }),
  );
  const { cache } = makeCache();
  const entry = cache.getOrCreate(dir, dir, undefined);
  expect(entry.lastError).toContain('cache.key calls "now"');
  expect(entry.lastError).toContain('cache: { ttl: "<duration>" }');
});

// A key over the depth reads a session's setting, which only its view holds:
// each view runs its own, floored at the depth that view draws at.
test("a source keyed on the drawn depth is each view's own", async () => {
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({
      variables: {
        inked: {
          kind: "shell",
          command: counted("inked", "i"),
          cache: { key: '{{ readableOn "#777777" "#000000" 4.5 }}' },
        },
      },
      segments: { s: { template: "{{ .inked }}" } },
      root: { h: ["s"] },
    }),
  );
  const { cache } = makeCache();
  const a = await render(cache, "s-a");
  const afterA = runs("inked");
  const b = await render(cache, "s-b");
  expect(a.view.state.registry.variableStore.has("inked")).toBe(false);
  expect(drawn(a.view)).toContain(" i ");
  expect(drawn(b.view)).toContain(" i ");
  expect(runs("inked")).toBe(afterA + 1);
});

test("debug introspection samples the most recently rendered session's view", async () => {
  configure(dir);
  const { cache } = makeCache();
  await render(cache, "s-a");
  await render(cache, "s-b");
  await render(cache, "s-a");
  expect(cache.latestView()?.sessionId).toBe("s-a");
});

test("a view that fails to open releases the state hold it was opened under", () => {
  configure(dir);
  let boom = true;
  const { cache } = makeCache({
    log: (line) => {
      if (boom && line.startsWith("session view opened")) {
        boom = false;
        throw new Error("log boom");
      }
    },
  });
  expect(() => cache.holdSession(dir, dir, undefined, "s-a", viewFacts(dir, "s-a"))).toThrow(
    "log boom",
  );
  // Retired by the reload and held by nothing, the state is reclaimed now.
  cache.reload(dir, dir, undefined);
  expect(cache.stats.retired).toBe(0);
});

test("views the served entry alone carries past the budget are said, not hidden", async () => {
  configure(dir);
  const { cache, lines } = makeCache({ budgetBytes: 1 });
  await render(cache, "s-a");
  expect(lines).toContainEqual(
    expect.stringMatching(/^render-cache over budget entries=1 views=1 /),
  );
});

