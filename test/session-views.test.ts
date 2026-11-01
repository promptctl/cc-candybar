import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInAction } from "mobx";
import {
  DECLARES_NOTHING,
  SOURCES_NOTHING,
  RenderCache,
  type Declare,
  type SessionView,
} from "../src/daemon/cache/render";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import type { ViewFacts } from "../src/daemon/render-payload";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { SessionState } from "../src/daemon/session-state";
import { instantOf } from "../src/utils/instant";
import { ABSENT } from "../src/utils/outcome";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { createLauncher, type Launcher } from "../src/proc/launch";
import { answerRepo } from "./helpers/repo-approval";

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
  // The configs these sessions draw are the directory's own.
  answerRepo(dir);
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

function makeCache(
  opts: {
    budgetBytes?: number;
    log?: (line: string) => void;
    declare?: Declare;
  } = {},
  launcher: Launcher = processLauncher,
) {
  const lines: string[] = [];
  const watchers = new WatcherRegistry({
    counters: { watchersOpened: 0, watchersClosed: 0, watchRefusals: 0, watchErrors: 0, dirWatchesOpened: 0, dirWatchesClosed: 0 },
    logger: () => {},
  });
  cleanups.push(() => watchers.closeAll());
  const cache = new RenderCache(
    { launcher, storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
 fileEvents: NO_FILE_EVENTS,
      sessionState: new SessionState(),
      watchers,
      source: SOURCES_NOTHING,
      declare: opts.declare ?? DECLARES_NOTHING,
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

// `edition` moves a literal no template reads, so configuring again with a
// new one is an edit a reload builds a state for: a reload of unchanged
// inputs keeps the state it serves.
function configure(cwd: string, edition = 0): void {
  const config = {
    variables: {
      edition: { kind: "literal", value: String(edition) },
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
  answerRepo(cwd);
}

const drawn = (
  view: SessionView,
  sid: string = view.sessionId,
  at = new Date(),
): string =>
  textOf(
    drawPayload(
      view.state.config,
      view.state.compiled,
      view.store,
      view.registry,
      { session_id: sid, workspace: { project_dir: dir } },
      instantOf(at),
      { endcaps: "plain", colorCompatibility: "none", wrap: true, padding: 1, width: 300 },
    ).frame,
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
    using held = cache.holdSession(cwd, cwd, undefined, viewFacts(cwd, sid));
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

test("a move to another directory declares the new view before the old releases what it held", () => {
  configure(dir);
  const other = path.join(dir, "sub");
  fs.mkdirSync(other);
  configure(other);
  // One owner entry both views hold, as two directories of one repo do.
  let holders = 0;
  let dropsToZero = 0;
  const { cache } = makeCache({
    declare: (holds, facts, closure, sources) => {
      holds.take("repo", () => {
        holders++;
        return () => {
          holders--;
          if (holders === 0) dropsToZero++;
        };
      });
      return DECLARES_NOTHING(holds, facts, closure, sources);
    },
  });
  cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"))[Symbol.dispose]();
  cache.holdSession(other, other, undefined, viewFacts(other, "s-a"))[Symbol.dispose]();
  expect(cache.stats.views).toBe(1);
  expect(holders).toBe(1);
  expect(dropsToZero).toBe(0);
});

test("a reload opens each of the entry's views anew on the new state, and retires the old", async () => {
  configure(dir);
  const { cache, lines } = makeCache();
  const before = await render(cache, "s-a");
  configure(dir, 1);
  cache.reload(dir, dir, undefined, { kind: "write" });
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

test("a reload keeps whether the session's view was read: a view idle before it still closes at the next sweep", async () => {
  configure(dir);
  const { cache, lines } = makeCache();
  await render(cache, "s-a");
  // A sweep with no render since: the view is unread, and kept once more.
  cache.releaseIdle();
  expect(cache.stats.views).toBe(1);
  configure(dir, 1);
  cache.reload(dir, dir, undefined, { kind: "write" });
  cache.releaseIdle();
  expect(cache.stats.views).toBe(0);
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=idle /),
  );
});

// [LAW:no-ambient-temporal-coupling] MobX holds a reaction created inside a
// batch until the batch ends: a frame drawn from a feed's reaction, opening a
// view, must still draw it declared.
test("a view opened inside a MobX batch is declared before it is handed back", () => {
  configure(dir);
  const { cache } = makeCache();
  const answer = runInAction(() => {
    using held = cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"));
    return held.view.lanes().git.current();
  });
  // DECLARES_NOTHING's answer, not the view's want of one.
  expect(answer).toEqual(ABSENT);
});

test("a kept view is declared with each request holdSession is given, inside a batch too", () => {
  configure(dir);
  const declaredFor: ViewFacts[] = [];
  const { cache } = makeCache({
    declare: (holds, facts, closure, sources) => {
      declaredFor.push(facts);
      return DECLARES_NOTHING(holds, facts, closure, sources);
    },
  });
  const first = viewFacts(dir, "s-a");
  cache.holdSession(dir, dir, undefined, first)[Symbol.dispose]();
  const next = viewFacts(dir, "s-a");
  runInAction(() => {
    using held = cache.holdSession(dir, dir, undefined, next);
    // Declared before the batch ends: this request's lanes, not the last's.
    expect(declaredFor).toEqual([first, next]);
    // A frame's facts, the request already declared, declare nothing again.
    cache.holdSession(dir, dir, undefined, next)[Symbol.dispose]();
    expect(held.view).toBeDefined();
  });
  expect(declaredFor).toHaveLength(2);
});

test("a view whose declaration throws answers that failure on its lanes", () => {
  configure(dir);
  const { cache, lines } = makeCache({
    declare: () => {
      throw new Error("closure exploded");
    },
  });
  using held = cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"));
  expect(held.view.lanes().git.current()).toEqual({
    kind: "failed",
    reason: expect.stringContaining("closure exploded"),
  });
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view declaration threw sid="s-a": .*closure exploded/),
  );
});

test("a view held by a render in flight is disposed only when the render returns", () => {
  configure(dir);
  const { cache, lines } = makeCache();
  const held = cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"));
  configure(dir, 1);
  cache.reload(dir, dir, undefined, { kind: "write" });
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

test("a move whose new view fails to open still retires the view it replaces", () => {
  configure(dir);
  const other = path.join(dir, "sub");
  fs.mkdirSync(other);
  configure(other);
  let opens = 0;
  const { cache, lines } = makeCache({
    log: (line) => {
      if (line.startsWith("session view opened") && ++opens === 2)
        throw new Error("log boom");
    },
  });
  cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"))[Symbol.dispose]();
  expect(() =>
    cache.holdSession(other, other, undefined, viewFacts(other, "s-a")),
  ).toThrow("log boom");
  expect(lines).toContainEqual(
    expect.stringMatching(/^session view closed sid="s-a" reason=moved /),
  );
  expect(cache.stats.retiredViews).toBe(0);
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
  expect(() => cache.holdSession(dir, dir, undefined, viewFacts(dir, "s-a"))).toThrow(
    "log boom",
  );
  // Retired by the reload and held by nothing, the state is reclaimed now.
  configure(dir, 1);
  cache.reload(dir, dir, undefined, { kind: "write" });
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

// A config load declares the session values into a view no session draws, to
// find what cannot declare. Every source a view holds reads a session value,
// which that view never answers, so the load starts none of them: counted at
// the spawn, since the probe's teardown aborts a shell it started before the
// shell can leave a trace of its own.
test("a config load starts no view's source, and still names a session value that cannot declare", async () => {
  const shell = (name: string, cache: object) => ({
    kind: "shell",
    command: counted(name, name),
    cache,
  });
  fs.writeFileSync(
    path.join(dir, ".cc-candybar.json5"),
    JSON.stringify({
      variables: {
        sid: { kind: "input", path: "session_id" },
        mode: { kind: "state", key: "mode", default: "a" },
        byInput: shell("byInput", { key: "{{ .sid }}" }),
        byState: shell("byState", { key: "{{ .mode }}" }),
        afterState: shell("afterState", { depends_on: ["mode"] }),
        byDepth: shell("byDepth", {
          key: '{{ readableOn "#777777" "#000000" 4.5 }}',
        }),
        perDirectory: shell("perDirectory", { ttl: "1h" }),
        unclosed: { kind: "template", template: "{{ .sid " },
      },
      segments: {
        s: {
          template:
            "{{ .byInput }} {{ .byState }} {{ .afterState }} {{ .byDepth }} {{ .perDirectory }}",
        },
      },
      root: { h: ["s"] },
    }),
  );
  let shells = 0;
  const launcher = createLauncher({
    stats: {
      onStart: (c) => {
        if (c === "user-shell") shells++;
      },
      onEnd: () => {},
      onRefused: () => {},
    },
  });
  const { cache } = makeCache({}, launcher);

  const entry = cache.getOrCreate(dir, dir, undefined);
  expect(entry.lastError).toBeNull();
  expect(await entry.state!.registry.settled(5000)).toEqual([]);
  // The one value that cannot declare, and no view source faulted for want of
  // a session.
  expect(entry.lastWarning).toBe('Variable "unclosed": unclosed action');
  // The directory's one source, and nothing a session did not ask for.
  expect(shells).toBe(1);
  expect(runs("perDirectory")).toBe(1);

  // A session asks for each of them, and a render settles what it started.
  await render(cache, "s-a");
  for (const name of ["byInput", "byState", "afterState", "byDepth"]) {
    expect([name, runs(name)]).toEqual([name, 1]);
  }
  expect(shells).toBe(5);
});

test("a copy click reads the frame its own renderer last delivered, not another's", async () => {
  configure(dir);
  const { cache } = makeCache();
  await render(cache, "s-copy");
  // One key, two surfaces whose frames list it with different text: the
  // statusline's answer from before a fix, the feed's from after.
  cache.delivered("s-copy", "request", new Map([["7", "before the fix"]]));
  cache.delivered("s-copy", "feed", new Map([["7", "after the fix"]]));
  expect(cache.drawnCopy("s-copy", "request", "7")).toBe("before the fix");
  expect(cache.drawnCopy("s-copy", "feed", "7")).toBe("after the fix");
  expect(cache.drawnCopy("s-copy", "request", "8")).toBeUndefined();
  // A feed that stops drawing takes its list with it.
  cache.stopDrawing("s-copy", "feed");
  expect(cache.drawnCopy("s-copy", "feed", "7")).toBeUndefined();
  expect(cache.drawnCopy("s-copy", "request", "7")).toBe("before the fix");
});

test("a frame on screen stays copyable across a reload's successor view, and goes when the session closes", async () => {
  configure(dir);
  const { cache } = makeCache();
  await render(cache, "s-copy");
  cache.delivered("s-copy", "request", new Map([["7", "the message"]]));
  configure(dir, 1);
  cache.reload(dir, dir, undefined, { kind: "write" });
  expect(cache.drawnCopy("s-copy", "request", "7")).toBe("the message");
  // Unread across two sweeps, the session's view closes, and its frames.
  cache.releaseIdle();
  cache.releaseIdle();
  expect(cache.stats.views).toBe(0);
  expect(cache.drawnCopy("s-copy", "request", "7")).toBeUndefined();
  // A session with no view keeps nothing it delivers.
  cache.delivered("s-copy", "request", new Map([["7", "the message"]]));
  expect(cache.drawnCopy("s-copy", "request", "7")).toBeUndefined();
});
