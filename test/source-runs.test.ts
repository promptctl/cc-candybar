import { SAMPLE_REGION } from "../scripts/lib/draw-fixtures/sample-region.js";
import { fixtureFakeLauncher } from "./helpers/scripted-launcher";
import { manualWatcherRegistry } from "../scripts/lib/draw-fixtures/directory-watches";
// A source's identity is a digest of what its run needs, two declarations
// with one digest share one run, and a key that moves is a new identity whose
// run lands over the old value (candybar-gather-renderer-76bb.6pj.5dx; spec
// docs/design/gather-and-renderer.md, section 19).

import { exits, hangs, runsFor, shell } from "../src/proc/spawner-fake";
import {
  turns,
} from "../scripts/lib/draw-fixtures/fake-launcher";
import { heldClock } from "./helpers/held-clock";
import {
  SourceRegistry,
  VariableStore,
  type SourceParse,
} from "../src/var-system";
import { SourceRuns } from "../src/daemon/source-runs";
import {
  collectedRuns,
  type CollectedRuns,
} from "../scripts/lib/draw-fixtures/held-runs";
import { runOf, type SourceIdentity } from "../src/facts/source-identity";
import { shellEnvOf } from "../src/config/shell-env";
import type { Environment } from "../src/daemon/foundations/session-env";
import { ok } from "../src/utils/outcome";

const TEXT: SourceParse = { kind: "text", default: undefined };
// The variables a shell source here runs in: the base set a declaration
// naming none gets.
const SHELL_ENV = shellEnvOf();
const digestOf = (identity: SourceIdentity): string => runOf(identity).digest;

interface Held {
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  // What holds the registry's runs; its close is a session letting go.
  readonly held: CollectedRuns;
}

// A rig: one owner over a scripted launcher on a held clock, and as many
// registries over it as the test opens, each holding its own runs, as the
// host holds a session view's.
function rig(inherited: NodeJS.ProcessEnv = {}) {
  const clock = heldClock(new Date(0));
  const { launcher, spawner, started } = fixtureFakeLauncher(clock, inherited);
  const runs = new SourceRuns({
    watchers: manualWatcherRegistry(clock),
    launcher,
    clock,
  });
  const opened: Held[] = [];
  // A session's registry, its programs run in `environment`.
  const registry = (environment: Environment = {}): Held => {
    const store = new VariableStore(clock);
    const r = new SourceRegistry(store, SAMPLE_REGION, "");
    const held = collectedRuns(runs, r, ok(environment));
    r.bindInputs({
      session: () => {
        throw new Error("no session is read");
      },
      read: () => ({ kind: "pending", why: "unread" }),
      ...held.readings,
      drawnAt: () => {
        throw new Error("no depth is read");
      },
    });
    const h = { store, registry: r, held };
    opened.push(h);
    return h;
  };
  const close = (): void => {
    for (const h of opened) {
      h.registry.dispose();
      h.held.close();
    }
    runs.close();
  };
  return { clock, spawner, started, runs, registry, close };
}

// The wait for every run out. A fake child's exit is a timer on the held
// clock, due at once, which only an advance fires; its stream events finish
// on the next-tick queue, which `turns` drains. The wait itself is bounded
// on the real clock, so a run that never lands fails naming its source.
async function settledAll(
  clock: ReturnType<typeof heldClock>,
  ...held: Held[]
): Promise<void> {
  clock.advance(0);
  await turns();
  for (const h of held)
    expect(await h.held.settled(AbortSignal.timeout(5000))).toEqual([]);
}

describe("runOf", () => {
  const base: SourceIdentity = {
    read: { kind: "shell", command: "uptime", cwd: "/work", env: ["PATH"] },
    parse: { kind: "text" },
    refresh: { kind: "never" },
  };

  it("is the same for one identity in any field order, and differs on every field", () => {
    const reordered = {
      refresh: { kind: "never" },
      parse: { kind: "text" },
      read: { env: ["PATH"], cwd: "/work", command: "uptime", kind: "shell" },
    } as SourceIdentity;
    expect(digestOf(reordered)).toBe(digestOf(base));
    const others: SourceIdentity[] = [
      {
        ...base,
        read: {
          kind: "shell",
          command: "uptime",
          cwd: "/other",
          env: ["PATH"],
        },
      },
      {
        ...base,
        read: { kind: "shell", command: "uptime", cwd: "/work", env: ["HOME"] },
      },
      {
        ...base,
        read: { kind: "shell", command: "w", cwd: "/work", env: ["PATH"] },
      },
      { ...base, parse: { kind: "json" } },
      { ...base, parse: { kind: "regex", pattern: "(.*)" } },
      { ...base, refresh: { kind: "ttl", durationMs: 1000 } },
      { ...base, refresh: { kind: "watch_file", path: "/work/f" } },
      { ...base, refresh: { kind: "key", hash: "abc" } },
      {
        ...base,
        read: { kind: "file", path: "/work/uptime", readMode: "whole" },
      },
    ];
    const digests = new Set(others.map(digestOf));
    expect(digests.size).toBe(others.length);
    expect(digests.has(digestOf(base))).toBe(false);
  });
});

describe("SourceRuns — one digest is one run", () => {
  it("two registries declaring one shell identity start one program, and both publish its output", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("uptime"), exits(0, "up 3 days\n"));
      const a = r.registry();
      const b = r.registry();
      for (const { registry } of [a, b])
        registry.declareShell("up", "uptime", {
          cwd: "/work",
          env: SHELL_ENV,
          parse: TEXT,
          cache: { kind: "never" },
        });
      await settledAll(r.clock, a, b);
      expect(r.started()).toHaveLength(1);
      expect(a.store.read("up")).toBe("up 3 days");
      expect(b.store.read("up")).toBe("up 3 days");
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });
    } finally {
      r.close();
    }
  });

  it("a declaration differing only in its default shares the run; one differing in cwd does not", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("exit 3"), exits(3));
      const a = r.registry();
      const b = r.registry();
      const c = r.registry();
      a.registry.declareShell("v", "exit 3", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: { kind: "text", default: "a's default" },
        cache: { kind: "never" },
      });
      b.registry.declareShell("v", "exit 3", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: { kind: "text", default: "b's default" },
        cache: { kind: "never" },
      });
      c.registry.declareShell("v", "exit 3", {
        cwd: "/elsewhere",
        env: SHELL_ENV,
        parse: { kind: "text", default: "c's default" },
        cache: { kind: "never" },
      });
      await settledAll(r.clock, a, b, c);
      expect(r.started().map((s) => s.options.cwd)).toEqual([
        "/work",
        "/elsewhere",
      ]);
      // One run, each declaration's own default standing in for its failure.
      expect(a.store.read("v")).toBe("a's default");
      expect(b.store.read("v")).toBe("b's default");
      expect(c.store.read("v")).toBe("c's default");
      expect(a.registry.getLastError("v")?.message).toBe(
        'shell "exit 3" exited with code 3 in /work',
      );
      expect(c.registry.getLastError("v")?.message).toBe(
        'shell "exit 3" exited with code 3 in /elsewhere',
      );
    } finally {
      r.close();
    }
  });

  it("two names in one registry with one identity share the run and one hold", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("date"), exits(0, "noon"));
      const h = r.registry();
      const { store, registry } = h;
      for (const name of ["first", "second"])
        registry.declareShell(name, "date", {
          cwd: "/work",
          env: SHELL_ENV,
          parse: TEXT,
          cache: { kind: "never" },
        });
      await settledAll(r.clock, h);
      expect(r.started()).toHaveLength(1);
      expect(store.read("first")).toBe("noon");
      expect(store.read("second")).toBe("noon");
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });
    } finally {
      r.close();
    }
  });
});

describe("SourceRuns — a shell runs in the variables it names, from its session", () => {
  const ENV = shellEnvOf(["API_HOST"]);
  const declare = (h: Held): void =>
    h.registry.declareShell("api", "echo $API_HOST", {
      cwd: "/work",
      env: ENV,
      parse: TEXT,
      cache: { kind: "never" },
    });

  it("two sessions in one directory with the same named values start one program", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("echo $API_HOST"), exits(0, "prod\n"));
      // They differ only in a variable neither names.
      const a = r.registry({ API_HOST: "prod", PATH: "/bin", TOKEN: "a" });
      const b = r.registry({ API_HOST: "prod", PATH: "/bin", TOKEN: "b" });
      declare(a);
      declare(b);
      await settledAll(r.clock, a, b);
      expect(r.started()).toHaveLength(1);
      expect(a.store.read("api")).toBe("prod");
      expect(b.store.read("api")).toBe("prod");
    } finally {
      r.close();
    }
  });

  it("a session whose named variable differs gets its own run", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("echo $API_HOST"), exits(0, "up\n"));
      const a = r.registry({ API_HOST: "prod" });
      const b = r.registry({ API_HOST: "staging" });
      declare(a);
      declare(b);
      await settledAll(r.clock, a, b);
      expect(r.started().map((s) => s.options.env?.API_HOST)).toEqual([
        "prod",
        "staging",
      ]);
    } finally {
      r.close();
    }
  });

  it("the program's environment is the named variables the session has set, and no others", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("echo $API_HOST"), exits(0, "prod\n"));
      const h = r.registry({ API_HOST: "prod", PATH: "/bin", TOKEN: "secret" });
      declare(h);
      await settledAll(r.clock, h);
      const [run] = r.started();
      expect(run!.options.env).toMatchObject({
        API_HOST: "prod",
        PATH: "/bin",
      });
      expect(run!.options.env).not.toHaveProperty("TOKEN");
    } finally {
      r.close();
    }
  });
});

describe("SourceRuns — a moved key is a new identity, the old value standing", () => {
  it("a key change starts a new run; the node keeps its value, awaited, until the run lands", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("git branch --show-current"), exits(0, "main"));
      const h = r.registry();
      const { store, registry } = h;
      store.defineBox("head", "string", "A");
      registry.declareShell("branch", "git branch --show-current", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: TEXT,
        cache: { kind: "key", template: "{{ .head }}" },
      });
      await settledAll(r.clock, h);
      expect(r.started()).toHaveLength(1);
      expect(store.read("branch")).toBe("main");
      expect(r.runs.stats().shell).toMatchObject({ entries: 1 });

      // The second run takes a while; meanwhile the old value stands and a
      // request's wait is for the new run.
      r.spawner.program(
        shell("git branch --show-current"),
        runsFor(500, exits(0, "feature")),
      );
      store.setBox("head", "B");
      r.clock.advance(0);
      await turns();
      expect(r.started()).toHaveLength(2);
      expect(store.read("branch")).toBe("main");
      expect(await h.held.settled(AbortSignal.abort())).toEqual(["branch"]);
      // The entry the key left is dropped with its last hold.
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });

      r.clock.advance(500);
      await settledAll(r.clock, h);
      expect(store.read("branch")).toBe("feature");

      // Back to the first value: its entry went with its hold, so it is a
      // new run like any other, awaited while the last value stands.
      r.spawner.program(
        shell("git branch --show-current"),
        runsFor(500, exits(0, "main")),
      );
      store.setBox("head", "A");
      r.clock.advance(0);
      await turns();
      expect(r.started()).toHaveLength(3);
      expect(store.read("branch")).toBe("feature");
      expect(await h.held.settled(AbortSignal.abort())).toEqual(["branch"]);
      r.clock.advance(500);
      await settledAll(r.clock, h);
      expect(store.read("branch")).toBe("main");
    } finally {
      r.close();
    }
  });

  it("a key change publishes no pending into a document node", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("cat state.json"), exits(0, '{"n":1}'));
      const h = r.registry();
      const { store, registry } = h;
      store.defineBox("head", "string", "A");
      registry.declareShell("doc", "cat state.json", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: { kind: "json", default: undefined },
        cache: { kind: "key", template: "{{ .head }}" },
      });
      await settledAll(r.clock, h);
      expect(store.readDocument("doc")).toEqual({
        kind: "ok",
        value: { n: 1 },
      });
      r.spawner.program(
        shell("cat state.json"),
        runsFor(100, exits(0, '{"n":2}')),
      );
      store.setBox("head", "B");
      r.clock.advance(0);
      await turns();
      expect(store.readDocument("doc")).toEqual({
        kind: "ok",
        value: { n: 1 },
      });
      r.clock.advance(100);
      await settledAll(r.clock, h);
      expect(store.readDocument("doc")).toEqual({
        kind: "ok",
        value: { n: 2 },
      });
    } finally {
      r.close();
    }
  });
});

// [LAW:no-ambient-temporal-coupling] An entry lives while something holds
// it: a run nobody reads spawns nothing, so the last release drops it, ending
// its read in flight, its period and its watch. A key that moves every tick
// would otherwise leave a child running per tick.
describe("SourceRuns — an entry is kept while held, and dropped with its last hold", () => {
  it("one holder's release leaves the run to the other; the last release ends its read and arms no period", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("sleep 1"), runsFor(1000, exits(0, "done")));
      const a = r.registry();
      const b = r.registry();
      for (const { registry } of [a, b])
        registry.declareShell("slow", "sleep 1", {
          cwd: "/work",
          env: SHELL_ENV,
          parse: TEXT,
          cache: { kind: "ttl", durationMs: 60_000 },
        });
      await turns();
      expect(r.started()).toHaveLength(1);
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });

      a.held.close();
      await turns();
      expect(r.started()[0]!.signals).toEqual([]);
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });

      // Nobody holds it now: its child is ended, and its period spawns
      // nothing.
      b.held.close();
      await turns();
      expect(r.started()[0]!.signals).not.toEqual([]);
      r.clock.advance(120_000);
      await turns();
      expect(r.started()).toHaveLength(1);
      expect(r.runs.stats().shell).toMatchObject({ entries: 0, held: 0 });
    } finally {
      r.close();
    }
  });

  it("a registry ended alone lets go of the runs held over it, and its period spawns nothing", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("sleep 1"), runsFor(1000, exits(0, "done")));
      const a = r.registry();
      a.registry.declareShell("slow", "sleep 1", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 60_000 },
      });
      await turns();
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });

      // The registry's own teardown, with no close of what holds its runs.
      a.registry.dispose();
      await turns();
      r.clock.advance(120_000);
      await turns();
      expect(r.started()).toHaveLength(1);
      expect(r.runs.stats().shell).toMatchObject({ held: 0 });
    } finally {
      r.close();
    }
  });

  it("a reload that re-declares a running identity joins it rather than spawning again", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("slow"), runsFor(1000, exits(0, "answer")));
      const a = r.registry();
      a.registry.declareShell("v", "slow", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 60_000 },
      });
      await turns();
      // The new state holds the entry before the old state is disposed, as
      // the render cache's dispose-after-swap does.
      const b = r.registry();
      b.registry.declareShell("v", "slow", {
        cwd: "/work",
        env: SHELL_ENV,
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 60_000 },
      });
      a.held.close();
      r.clock.advance(1000);
      await settledAll(r.clock, b);
      expect(r.started()).toHaveLength(1);
      expect(b.store.read("v")).toBe("answer");
    } finally {
      r.close();
    }
  });
});

test("a shell source matching zero session variables gets an empty environment even when the host has a PATH", async () => {
  const r = rig({ PATH: "/host-only" });
  try {
    r.spawner.program(shell("read source"), exits(0, "value"));
    const h = r.registry({ UNSELECTED: "private" });
    h.registry.declareShell("source", "read source", {
      cwd: "/work",
      env: SHELL_ENV,
      parse: TEXT,
      cache: { kind: "never" },
    });
    await settledAll(r.clock, h);
    expect(r.started().map(({ options }) => options.env)).toEqual([{}]);
    expect(h.store.read("source")).toBe("value");
  } finally {
    r.close();
  }
});
