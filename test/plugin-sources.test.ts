// [LAW:behavior-not-structure] A plugin's `sources`, through what a session
// sees and what the daemon reports: the bar a session's view draws, the holds
// and watches the storage owner counts, the load events — never which internal
// function ran. Every view here is the daemon's own: a render cache over the
// payload providers, declared by `declareLanes`, drawn from `sessionSource`.

import { processLauncher } from "../src/proc/launch";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { TEST_SIGNER } from "./helpers/link-signer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPayloadProviders } from "../src/daemon/payload-providers";
import { FileEventDelivery } from "../src/daemon/cache/file-events";
import {
  WatcherRegistry,
  type WatcherCounters,
} from "../src/daemon/cache/watchers";
import {
  loadFromDisk,
  pluginLoadLine,
  RenderCache,
  type SessionView,
} from "../src/daemon/cache/render";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import {
  declareLanes,
  projectSources,
  renderOptionsOf,
  sourcesFactOf,
} from "../src/daemon/render-payload";
import {
  sessionSource,
  type SessionSource,
} from "../src/daemon/session-source";
import { SessionState } from "../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { drawDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { resolvePath, SourceRegistry } from "../src/var-system/sources";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { checkConfig, type CheckOutcome } from "../src/check";
import { instantOf } from "../src/utils/instant";
import { ABSENT, ok, PENDING } from "../src/utils/outcome";
import { settledLane } from "../src/utils/reading";
import { installFromRepo } from "../src/plugin-install";
import { REPO_PLUGIN_DIR } from "../src/config/loader/plugin-folders";
import { ansiOf } from "../src/render/frame";
import { stripAnsi } from "./helpers/daemon-e2e";
import { viewFacts } from "./helpers/view-facts";
import { ReloadSignal } from "./helpers/reload-signal";
import { until } from "./helpers/until";

const SOURCE = `{ scope: "session", refresh: { watch: true }, read: { file: { json: true } } }`;
const STATUS = "plugins.p.status";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-sources-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

function write(rel: string, contents: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

// The fixture plugin: one session source, a segment gated on it, one that
// reads it unguarded, and whatever else a test lays beside them.
function plugin(extra = "", folder = path.join(dir, "p")): string {
  const definition = path.join(folder, "plugin.json5");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    definition,
    `{
      sources: { status: ${SOURCE} },
      segments: {
        gated: { when: '{{ hasKey .plugins.p "status" }}', template: 'home={{ .plugins.p.status.home }}' },
        bare: { template: 'bare={{ .plugins.p.status.home }}' },
      },
      ${extra}
    }`,
  );
  return definition;
}

// A user config listing the fixture plugin and placing `placed`.
function config(placed: readonly string[], more = ""): string {
  plugin();
  return write(
    "config.json5",
    `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ${JSON.stringify(placed)} } ${more} }`,
  );
}

// The program's contract: the whole file, renamed into place.
function programWrites(storage: string, sid: string, doc: unknown): void {
  fs.mkdirSync(storage, { recursive: true });
  const tmp = path.join(storage, `.${sid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, path.join(storage, `${sid}.json`));
}

interface Rig {
  readonly cache: RenderCache<SessionSource>;
  readonly providers: ReturnType<typeof createPayloadProviders>;
  readonly counters: WatcherCounters;
  readonly sessionState: SessionState;
  readonly reloads: ReloadSignal;
  readonly lines: string[];
}

// The daemon's own composition of a render cache (src/daemon/daemon.ts).
function rig(): Rig {
  const counters: WatcherCounters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const lines: string[] = [];
  const log = (level: string, message: string): void => {
    lines.push(`${level} ${message}`);
  };
  const watchers = new WatcherRegistry({ counters, logger: log });
  const providers = createPayloadProviders({
    launcher: processLauncher,
    watchers,
    fileEvents: new FileEventDelivery({ watchers, logger: log }),
    logger: log,
    ledger: new RefreshLedger(log),
  });
  const sessionState = new SessionState();
  const reloads = new ReloadSignal();
  const cache = new RenderCache<SessionSource>(
    {
      launcher: processLauncher,
      sessionState,
      watchers,
      storage: providers.managedStorage,
      signer: TEST_SIGNER,
      fileEvents: NO_FILE_EVENTS,
      log,
      declare: (holds, facts, closure, sources) =>
        declareLanes(providers, holds, facts, closure, sources),
      source: sessionSource({
        providers,
        sessionState,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024, observers: reloads.observers },
  );
  cleanups.push(() => {
    cache.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.managedStorage.close();
    watchers.closeAll();
  });
  return { cache, providers, counters, sessionState, reloads, lines };
}

// One frame of the session's view, as the daemon draws one: its payload as
// the view derives it, this draw's own facts beside it.
function draw(view: SessionView<SessionSource>): {
  readonly text: string;
  readonly errors: readonly string[];
} {
  const effective = view.source.effective();
  const errors: string[] = [];
  const { frame } = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    { drawing: { by: "request" }, feeds: UNFOLLOWED_FEEDS, today: undefined },
    instantOf(new Date()),
    renderOptionsOf(effective, 200),
    { onSegmentError: (id, message) => errors.push(`${id}: ${message}`) },
    effective,
  );
  return { text: stripAnsi(ansiOf(frame)), errors };
}

// The view of session `sid`, held as a render holds it, released at cleanup.
function viewOf(
  r: Rig,
  configFile: string,
  sid = "s1",
): SessionView<SessionSource> {
  const held = r.cache.holdSession(dir, dir, configFile, viewFacts(dir, sid));
  cleanups.push(() => held[Symbol.dispose]());
  return held.view;
}

const storageOf = (folder = path.join(dir, "p")): string =>
  path.join(fs.realpathSync(folder), "session");

// The source's lane has answered its first read.
async function answered(
  view: SessionView<SessionSource>,
  name = STATUS,
): Promise<void> {
  await until(
    () => view.lanes().sources.get(name)?.current().kind !== "pending",
    `${name}'s first read`,
  );
}

// fs.watch goes live after it returns, with no ready signal: the program
// writes again (the same bytes, so the final state is one) until the bar shows
// what it wrote.
function writeUntilShown(
  write: () => void,
  shown: () => boolean,
  what: string,
): Promise<void> {
  return until(() => {
    if (shown()) return true;
    write();
    return false;
  }, `${what} showing`);
}

describe("a source's declaration", () => {
  function clean(o: CheckOutcome): string {
    if (o.kind !== "clean")
      throw new Error(`expected clean, got ${JSON.stringify(o)}`);
    return stripAnsi(o.rendered);
  }
  function fatal(o: CheckOutcome): string {
    if (o.kind !== "fatal")
      throw new Error(`expected fatal, got ${JSON.stringify(o)}`);
    return [o.message, ...o.warnings].join("\n");
  }
  const listing = (sources: string, extra = ""): string => {
    write(
      "p/plugin.json5",
      `{ sources: ${sources}, segments: { s: { template: "s" } }, ${extra} }`,
    );
    return write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
  };

  test("the built arm loads, lowered to a session document in the plugin folder's managed storage", () => {
    const r = rig();
    const p = listing(`{ status: ${SOURCE} }`);
    const loaded = loadFromDisk(dir, dir, p, {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(loaded.error).toBeNull();
      expect(loaded.state!.config.variables[STATUS]).toEqual({
        kind: "source",
        storage: path.join(dir, "p", "session"),
      });
      expect([...loaded.state!.sources]).toEqual([
        [STATUS, { folder: path.join(dir, "p", "session"), generation: 0 }],
      ]);
      // The build created the folder, so the program has somewhere to write.
      expect(fs.statSync(path.join(dir, "p", "session")).isDirectory()).toBe(
        true,
      );
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test.each([
    [
      "another scope",
      `{ scope: "repo", refresh: { watch: true }, read: { file: { json: true } } }`,
      "sources.status.scope",
    ],
    [
      "another trigger",
      `{ scope: "session", refresh: { period: "10s" }, read: { file: { json: true } } }`,
      "sources.status.refresh.period",
    ],
    [
      "no trigger",
      `{ scope: "session", read: { file: { json: true } } }`,
      "sources.status.refresh",
    ],
    [
      "another reader",
      `{ scope: "session", refresh: { watch: true }, read: { module: "./read.mjs" } }`,
      "sources.status.read.module",
    ],
    [
      "a text read",
      `{ scope: "session", refresh: { watch: true }, read: { file: { text: true } } }`,
      "sources.status.read.file.text",
    ],
    [
      "a file path",
      `{ scope: "session", refresh: { watch: true }, read: { file: { json: true, path: "./x.json" } } }`,
      "sources.status.read.file.path",
    ],
    [
      "a field no source has",
      `{ scope: "session", refresh: { watch: true }, read: { file: { json: true } }, key: "x" }`,
      "sources.status.key",
    ],
  ])(
    "%s drops the plugin, naming the field and what is built",
    async (_what, source, field) => {
      const message = fatal(
        await checkConfig(listing(`{ status: ${source} }`), dir),
      );
      expect(message).toContain(
        `plugin ${path.join(dir, "p/plugin.json5")} was not loaded`,
      );
      expect(message).toContain(field);
      expect(message).toContain(
        `what is built is a source {"scope":"session","refresh":{"watch":true},"read":{"file":{"json":true}}}`,
      );
    },
  );

  test("a dropped plugin declares no sources: no folder made, no watch held", () => {
    const r = rig();
    write(
      "p/plugin.json5",
      `{ sources: { status: ${SOURCE} }, segments: { s: { template: "{{ " } } }`,
    );
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const loaded = loadFromDisk(dir, dir, p, {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(loaded.state!.plugins.dropped.map((d) => [d.scope, d.name])).toEqual([["plugins", "p"]]);
      expect(loaded.state!.sources.size).toBe(0);
      expect(fs.existsSync(path.join(dir, "p", "session"))).toBe(false);
      expect(r.providers.managedStorage.stats().folders).toBe(0);
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("a user config naming a dropped plugin's source still loads: its read draws the drop, and its run refreshes nothing of it", () => {
    const r = rig();
    write(
      "p/plugin.json5",
      `{ sources: { status: ${SOURCE} }, segments: { s: { template: "{{ " } } }`,
    );
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"],
         actions: { raise: { run: ["/bin/true"], refreshes: ["plugins.p.status"] } },
         segments: { mine: { template: "x{{ .plugins.p.status.home }}" } },
         root: { h: ["mine"] } }`,
    );
    const loaded = loadFromDisk(dir, dir, p, {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(loaded.error).toBeNull();
      const { config, plugins } = loaded.state!;
      expect(plugins.dropped.map((d) => [d.scope, d.name])).toEqual([["plugins", "p"]]);
      // The namespace is the drop, so every name under it reads it.
      expect(config.variables["plugins.p"]).toMatchObject({ kind: "dropped" });
      expect(config.actions.raise).toMatchObject({ refreshes: [] });
      expect([...plugins.reached]).toEqual([path.join(dir, "p", "plugin.json5")]);
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("a source's name is one identifier", async () => {
    const message = fatal(
      await checkConfig(listing(`{ "a.b": ${SOURCE} }`), dir),
    );
    expect(message).toContain(`source name "a.b" is not one identifier`);
  });

  test("a source and a variable of the same name is a load error naming both", async () => {
    const message = fatal(
      await checkConfig(
        listing(
          `{ status: ${SOURCE} }`,
          `variables: { status: { kind: "literal", value: 1 } }`,
        ),
        dir,
      ),
    );
    expect(message).toContain(
      `source "status" and variable "status" are one name`,
    );
  });

  // [LAW:one-source-of-truth] A session's file is one document: two sources
  // reading it would be two names for it.
  test("two sources reading the same session file drop the plugin, naming both and the file", async () => {
    const message = fatal(
      await checkConfig(
        listing(`{ status: ${SOURCE}, other: ${SOURCE} }`),
        dir,
      ),
    );
    expect(message).toContain(
      `plugin ${path.join(dir, "p/plugin.json5")} was not loaded`,
    );
    expect(message).toContain(
      `sources.status: sources .plugins.p.status and .plugins.p.other read the same file, ${path.join(dir, "p", "session", "<session id>.json")}: a session's file is one document, read by one source`,
    );
  });

  test("another plugin whose folder is the same real folder is dropped, naming both sources and the file", async () => {
    write(
      "p/plugin.json5",
      `{ sources: { status: ${SOURCE} }, segments: { s: { template: "s" } } }`,
    );
    fs.symlinkSync(path.join(dir, "p"), path.join(dir, "q"));
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5", "./q/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.p.s", "plugins.q.s"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain(
      `plugin ${path.join(dir, "q/plugin.json5")} was not loaded`,
    );
    expect(message).not.toContain(
      `plugin ${path.join(dir, "p/plugin.json5")} was not loaded`,
    );
    expect(message).toContain(
      `sources .plugins.p.status and .plugins.q.status read the same file, ${path.join(dir, "p", "session", "<session id>.json")}`,
    );
  });

  test("`variables:` cannot author a source", async () => {
    write(
      "p/plugin.json5",
      `{ variables: { status: { kind: "source", storage: "/tmp" } }, segments: { s: { template: "s" } } }`,
    );
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain(
      `plugin ${path.join(dir, "p/plugin.json5")} was not loaded`,
    );
    expect(message).toContain("variables.status.kind");
  });

  // [LAW:nothing-unseen] The config-load event counts the sources the loaded
  // plugins declared, and `pluginVariables=` counts only what `variables:`
  // declared, never a source's synthesized variable.
  test("the load event counts sources apart from plugin variables", () => {
    const r = rig();
    write("q/plugin.json5", `{ sources: { other: ${SOURCE} } }`);
    write(
      "p/plugin.json5",
      `{ sources: { status: ${SOURCE} }, variables: { v: { kind: "literal", value: 1 } } }`,
    );
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5", "./q/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const loaded = loadFromDisk(dir, dir, p, {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(pluginLoadLine(loaded.layers, loaded.state!, loaded.ms)).toContain(
        " plugins loaded=2 sources=2 pluginVariables=1 dropped=0 ",
      );
    } finally {
      loaded.state?.registry.dispose();
    }
  });
});

// `check` runs no plugin program and has no session: every declared source
// reads absent, as a session's does before its program first writes.
describe("`cc-candybar check` on a source", () => {
  test("a hasKey-gated segment exits clean, the segment hidden", async () => {
    const outcome = await checkConfig(config(["mine", "plugins.p.gated"]), dir);
    if (outcome.kind !== "clean") throw new Error(JSON.stringify(outcome));
    expect(outcome.warnings).toEqual([]);
    expect(stripAnsi(outcome.rendered)).toContain("mine");
    expect(stripAnsi(outcome.rendered)).not.toContain("home=");
  });

  test("the same read unguarded exits fatal, naming the missing field", async () => {
    const outcome = await checkConfig(config(["mine", "plugins.p.bare"]), dir);
    if (outcome.kind !== "fatal") throw new Error(JSON.stringify(outcome));
    expect(outcome.message).toContain('segment "plugins.p.bare"');
    expect(outcome.message).toContain(
      'field "plugins.p.status.home" not found on receiver',
    );
  });
});

describe("a session reads its source", () => {
  test("absent until the program writes: hasKey reads false and the gated segment hides; the write draws the field", async () => {
    const r = rig();
    const view = viewOf(r, config(["mine", "plugins.p.gated"]));
    await answered(view);
    expect(view.lanes().sources.get(STATUS)!.current()).toEqual(ABSENT);
    const before = draw(view);
    expect(before.errors).toEqual([]);
    expect(before.text).toContain("mine");
    expect(before.text).not.toContain("home=");
    await writeUntilShown(
      () => programWrites(storageOf(), "s1", { home: "/h/one" }),
      () => draw(view).text.includes("home=/h/one"),
      "the program's write",
    );
    expect(draw(view).errors).toEqual([]);
  });

  test("an unguarded read before the write is the missing-field error", async () => {
    const r = rig();
    const view = viewOf(r, config(["plugins.p.bare"]));
    await answered(view);
    const { errors } = draw(view);
    expect(errors).toEqual([expect.stringContaining("not found on receiver")]);
    expect(errors[0]).toContain("status");
  });

  test("another session's file is not this session's", async () => {
    const r = rig();
    const file = config(["plugins.p.gated"]);
    const a = viewOf(r, file, "s-a");
    const b = viewOf(r, file, "s-b");
    await answered(a);
    await answered(b);
    await writeUntilShown(
      () => programWrites(storageOf(), "s-a", { home: "/a" }),
      () => draw(a).text.includes("home=/a"),
      "session a's write",
    );
    expect(draw(b).text).not.toContain("home=");
  });

  test("a shell keyed on a source no segment reads runs with the source's value, and the view holds the source's key", async () => {
    const r = rig();
    const counter = path.join(dir, "runs");
    plugin(
      `variables: { runs: { kind: "shell", command: "echo x >> ${counter}; wc -l < ${counter} | tr -d ' '", cache: { key: '{{ .plugins.p.status.home }}' } } },`,
    );
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "runs={{ .plugins.p.runs }}" } }, root: { h: ["mine"] } }`,
    );
    const view = viewOf(r, p);
    await answered(view);
    expect(view.lanes().sources.has(STATUS)).toBe(true);
    expect(r.providers.managedStorage.stats().held).toBe(1);
    const runs = (): number =>
      Number(/runs=(\d+)/.exec(draw(view).text)?.[1] ?? 0);
    // Before the write the key has nothing to read, so the shell has not run.
    expect(runs()).toBe(0);
    await writeUntilShown(
      () => programWrites(storageOf(), "s1", { home: "/one" }),
      () => runs() > 0,
      "the shell's run under the first value",
    );
    const first = runs();
    await writeUntilShown(
      () => programWrites(storageOf(), "s1", { home: "/two" }),
      () => runs() > first,
      "the shell's run under the second value",
    );
  });
});

// The view derives a source's document from its payload, compared by content.
describe("a source's document", () => {
  function sourceDoc(payload: () => unknown) {
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store);
    registry.declareSourceDocument(STATUS);
    registry.bindInputs({
      read: (p) => resolvePath(payload(), p),
      drawnAt: () => {
        throw new Error("no depth is read");
      },
    });
    cleanups.push(() => registry.dispose());
    return () => store.readDocument(STATUS);
  }

  test("reads the payload's reading at its own name: pending, ok, absent, failed", () => {
    for (const reading of [
      PENDING,
      ok({ home: "/h" }),
      ABSENT,
      { kind: "failed", reason: "bad json" },
    ]) {
      expect(
        sourceDoc(() => ({ plugins: { p: { status: reading } } }))(),
      ).toEqual(reading);
    }
  });

  test("anything else at its name reads failed, never a throw", () => {
    for (const held of [null, 3, "x", { kind: "other" }]) {
      expect(sourceDoc(() => ({ plugins: { p: { status: held } } }))()).toEqual({
        kind: "failed",
        reason: `variable "${STATUS}": the view's payload holds no source reading at "${STATUS}"`,
      });
    }
  });

  test("a payload without it reads failed, naming the variable: the declaration did not take it", () => {
    expect(sourceDoc(() => ({ plugins: {} }))()).toEqual({
      kind: "failed",
      reason: `variable "${STATUS}": the view's payload has no "${STATUS}": its declaration did not take the source the preset reads`,
    });
  });
});

describe("the view declares the sources its preset reads", () => {
  test("a preset reading a source holds its key; one not reading it holds nothing; a switch releases it", async () => {
    const r = rig();
    const file = config(
      ["plugins.p.gated"],
      `, presets: { bare: { root: { h: ["mine"] } } }`,
    );
    const view = viewOf(r, file);
    await answered(view);
    expect([...view.lanes().sources.keys()]).toEqual([STATUS]);
    expect(r.providers.managedStorage.stats().held).toBe(1);
    r.sessionState.set("s1", "preset", "bare");
    expect([...view.lanes().sources.keys()]).toEqual([]);
    expect(r.providers.managedStorage.stats().held).toBe(0);
    expect(draw(view).text).toContain("mine");
  });

  test("a config placing no segment that reads the source holds nothing", async () => {
    const r = rig();
    const view = viewOf(r, config(["mine"]));
    expect(view.lanes().sources.size).toBe(0);
    expect(r.providers.managedStorage.stats().held).toBe(0);
    // The state still holds its folder's watch: a source is the config's.
    expect(r.providers.managedStorage.stats().folders).toBe(1);
  });

  // [LAW:nothing-unseen] The render event's fields.
  test("the render event counts the declared sources and names the pending ones", () => {
    expect(sourcesFactOf(new Map())).toEqual({
      sources: "0",
      sourcesPending: "-",
    });
    const unread = {
      current: () => ({
        kind: "pending" as const,
        why: "unread" as const,
        landed: new Promise<void>(() => {}),
      }),
    };
    expect(
      sourcesFactOf(
        new Map([
          ["plugins.a.s", settledLane(ok({}))],
          ["plugins.b.s", unread],
          ["plugins.c.s", settledLane(ABSENT)],
          [
            "plugins.d.s",
            {
              current: () => ({
                kind: "pending" as const,
                why: "superseded" as const,
                landed: new Promise<void>(() => {}),
              }),
            },
          ],
        ]),
      ),
    ).toEqual({
      sources: "4",
      sourcesPending: "plugins.b.s:unread,plugins.d.s:superseded",
    });
    expect(PENDING.kind).toBe("pending");
  });
});

describe("a storage folder's watch", () => {
  test("N sessions' views opening and closing on one plugin folder open exactly one watch", async () => {
    const r = rig();
    const file = config(["plugins.p.gated"]);
    viewOf(r, file, "s0");
    const opened = r.counters.watchersOpened;
    for (let i = 1; i <= 5; i++) {
      const held = r.cache.holdSession(dir, dir, file, viewFacts(dir, `s${i}`));
      await answered(held.view);
      held[Symbol.dispose]();
    }
    r.cache.releaseIdle();
    r.cache.releaseIdle();
    expect(r.counters.watchersOpened).toBe(opened);
    expect(r.providers.managedStorage.stats().folders).toBe(1);
  });

  test("a reload keeps it open", async () => {
    const r = rig();
    const file = config(["plugins.p.gated"]);
    const view = viewOf(r, file);
    await answered(view);
    const entry = r.cache.getOrCreate(dir, dir, file);
    const opened = r.counters.watchersOpened;
    const closed = r.counters.watchersClosed;
    // An edit that changes what the config loads, so the reload builds a
    // state: a reload of unchanged inputs keeps the one served.
    const edited = fs
      .readFileSync(file, "utf8")
      .replace(`template: "mine"`, `template: "mine, edited"`);
    expect(edited).toContain("mine, edited");
    const before = entry.state;
    await r.reloads.after(entry, () => fs.writeFileSync(file, edited));
    expect(entry.state).not.toBe(before);
    expect(r.counters.watchersOpened).toBe(opened);
    expect(r.counters.watchersClosed).toBe(closed);
    expect(r.providers.managedStorage.stats().folders).toBe(1);
  });

  test("removing the session folder, and nothing else, reloads the config, recreates the folder, and the next write shows", async () => {
    const r = rig();
    const file = config(["plugins.p.gated"]);
    const held = r.cache.holdSession(dir, dir, file, viewFacts(dir, "s1"));
    await answered(held.view);
    held[Symbol.dispose]();
    const entry = r.cache.getOrCreate(dir, dir, file);
    const storage = storageOf();
    const before = entry.state.sources.get(STATUS)!;
    await r.reloads.afterRemoving(entry, storage, () => fs.mkdirSync(storage));
    expect(fs.statSync(storage).isDirectory()).toBe(true);
    expect(entry.state.sources.get(STATUS)!.generation).toBeGreaterThan(
      before.generation,
    );
    const view = viewOf(r, file);
    await answered(view);
    await writeUntilShown(
      () => programWrites(storage, "s1", { home: "/after" }),
      () => draw(view).text.includes("home=/after"),
      "the write after the removal",
    );
  });

  test("a chmod, a utimes and an xattr on the folder leave its source reading normally and open no watch", async () => {
    const r = rig();
    const file = config(["plugins.p.gated"]);
    const view = viewOf(r, file);
    await answered(view);
    const storage = storageOf();
    await writeUntilShown(
      () => programWrites(storage, "s1", { home: "/first" }),
      () => draw(view).text.includes("home=/first"),
      "the first write",
    );
    const opened = r.counters.watchersOpened;
    const key = r.cache.getOrCreate(dir, dir, file).state.sources.get(STATUS);
    const touches: Array<() => void> = [
      () => fs.chmodSync(storage, 0o700),
      () => fs.utimesSync(storage, new Date(), new Date()),
      ...(process.platform === "darwin"
        ? [
            () =>
              void execFileSync("xattr", [
                "-w",
                "com.ccb.test",
                String(Date.now()),
                storage,
              ]),
          ]
        : []),
    ];
    for (const touch of touches) touch();
    // Whatever the folder's watch and its plugin folder's made of them has
    // run once the next write lands.
    await writeUntilShown(
      () => programWrites(storage, "s1", { home: "/second" }),
      () => draw(view).text.includes("home=/second"),
      "the write after the touches",
    );
    expect(r.counters.watchersOpened).toBe(opened);
    expect(
      r.cache.getOrCreate(dir, dir, file).state.sources.get(STATUS),
    ).toEqual(key);
    expect(r.providers.managedStorage.stats().lost).toBe(0);
    expect(draw(view).errors).toEqual([]);
  });
});

describe("an installed plugin's storage", () => {
  let savedDataHome: string | undefined;
  beforeEach(() => {
    savedDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, "data");
  });
  afterEach(() => {
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
  });
  const root = (): string => path.join(dir, "data", "cc-candybar", "plugins");
  const placing = (): string =>
    write(
      "config.json5",
      `{ segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.p.gated"] } }`,
    );

  test("uninstalling it closes its watch once its states are reclaimed, and does not recreate its folder", async () => {
    const r = rig();
    plugin("", path.join(root(), "p"));
    // Placing none of its segments: a config that placed one would fail to
    // load without it, and keep the state that holds the folder.
    const file = write(
      "config.json5",
      `{ segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const held = r.cache.holdSession(dir, dir, file, viewFacts(dir, "s1"));
    held[Symbol.dispose]();
    // The state holds the folder its config declares, read by a view or not.
    expect(r.providers.managedStorage.stats().folders).toBe(1);
    const entry = r.cache.getOrCreate(dir, dir, file);
    const folder = path.join(root(), "p");
    await r.reloads.afterRemoving(entry, folder, () => plugin("", folder));
    expect(
      Object.keys(entry.state.config.variables).filter((n) =>
        n.startsWith("plugins.p."),
      ),
    ).toEqual([]);
    expect(r.providers.managedStorage.stats().folders).toBe(0);
    expect(fs.existsSync(folder)).toBe(false);
  });

  test("replacing a linked plugin folder by install, then writing the new folder's session file, shows the write", async () => {
    const r = rig();
    const dev = path.join(dir, "dev", "p");
    plugin("", dev);
    fs.mkdirSync(root(), { recursive: true });
    fs.symlinkSync(dev, path.join(root(), "p"));
    const file = placing();
    const view0 = viewOf(r, file);
    await answered(view0);
    await writeUntilShown(
      () => programWrites(path.join(dev, "session"), "s1", { home: "/linked" }),
      () => draw(view0).text.includes("home=/linked"),
      "the linked folder's write",
    );
    // The repo the install copies from.
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, REPO_PLUGIN_DIR, "p"), { recursive: true });
    fs.copyFileSync(
      path.join(dev, "plugin.json5"),
      path.join(repo, REPO_PLUGIN_DIR, "p", "plugin.json5"),
    );
    const entry = r.cache.getOrCreate(dir, dir, file);
    const installed = path.join(fs.realpathSync(root()), "p", "session");
    expect(installFromRepo(repo, root(), "repo")).toEqual([
      { path: path.join(root(), "p", "plugin.json5"), placed: "replaced" },
    ]);
    await until(
      () => entry.state.sources.get(STATUS)?.folder === installed,
      "the reload onto the installed folder",
      10_000,
    );
    const view = viewOf(r, file);
    await answered(view);
    await writeUntilShown(
      () => programWrites(installed, "s1", { home: "/installed" }),
      () => draw(view).text.includes("home=/installed"),
      "the installed folder's write",
    );
  });
});

// A repo's plugin and an installed one of its name each read their own
// sources, at their own scope: `.repo.lit.<source>` beside `.plugins.lit.<source>`.
test("sources nest by scope, each plugin's at its own namespace", () => {
  const payload = projectSources(["plugins.lit.status", "repo.lit.status"], (name) => ({
    kind: "ok" as const,
    value: name,
  }));
  expect(payload).toEqual({
    plugins: { lit: { status: { kind: "ok", value: "plugins.lit.status" } } },
    repo: { lit: { status: { kind: "ok", value: "repo.lit.status" } } },
  });
  expect(projectSources([], () => ({ kind: "ok" as const, value: 0 }))).toEqual({ plugins: {}, repo: {} });
});
