// A source's identity is a digest of what its run needs, two declarations
// with one digest share one run, and a key that moves is a new identity whose
// run lands over the old value (candybar-gather-renderer-76bb.6pj.5dx; spec
// docs/design/gather-and-renderer.md, section 19).

import { exits, hangs, runsFor, shell } from "../src/proc/spawner-fake";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import { heldClock } from "./helpers/held-clock";
import {
  SourceRegistry,
  VariableStore,
  type SourceParse,
} from "../src/var-system";
import { SourceRuns } from "../src/daemon/source-runs";
import { CheckRuns } from "../src/check-runs";
import { runOf, type SourceIdentity } from "../src/facts/source-identity";
import { instantOf } from "../src/utils/instant";

const TEXT: SourceParse = { kind: "text", default: undefined };
const digestOf = (identity: SourceIdentity): string => runOf(identity).digest;

interface Held {
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  // What holds the registry's runs; its close is a session letting go.
  readonly held: CheckRuns;
}

// A rig: one owner over a scripted launcher on a held clock, and as many
// registries over it as the test opens, each holding its own runs, as the
// host holds a session view's.
function rig(maxUnheld?: number) {
  const clock = heldClock(new Date(0));
  const { launcher, spawner, started } = fakeLauncher(clock);
  const runs = new SourceRuns({ launcher, clock, maxUnheld });
  const opened: Held[] = [];
  const registry = (): Held => {
    const store = new VariableStore(clock);
    const r = new SourceRegistry(store, "");
    const held = new CheckRuns(runs, r, instantOf(new Date(0)));
    r.bindInputs({
      session: () => {
        throw new Error("no session is read");
      },
      read: () => ({ kind: "pending", why: "unread" }),
      run: (digest) => held.run(digest),
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
    read: { kind: "shell", command: "uptime", cwd: "/work" },
    parse: { kind: "text" },
    refresh: { kind: "never" },
  };

  it("is the same for one identity in any field order, and differs on every field", () => {
    const reordered = {
      refresh: { kind: "never" },
      parse: { kind: "text" },
      read: { cwd: "/work", command: "uptime", kind: "shell" },
    } as SourceIdentity;
    expect(digestOf(reordered)).toBe(digestOf(base));
    const others: SourceIdentity[] = [
      { ...base, read: { kind: "shell", command: "uptime", cwd: "/other" } },
      { ...base, read: { kind: "shell", command: "w", cwd: "/work" } },
      { ...base, parse: { kind: "json" } },
      { ...base, parse: { kind: "regex", source: "(.*)", flags: "" } },
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
        parse: { kind: "text", default: "a's default" },
        cache: { kind: "never" },
      });
      b.registry.declareShell("v", "exit 3", {
        cwd: "/work",
        parse: { kind: "text", default: "b's default" },
        cache: { kind: "never" },
      });
      c.registry.declareShell("v", "exit 3", {
        cwd: "/elsewhere",
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
      // The entry the key left is kept, unheld, for a return.
      expect(r.runs.stats().shell).toMatchObject({ entries: 2, held: 1 });

      r.clock.advance(500);
      await settledAll(r.clock, h);
      expect(store.read("branch")).toBe("feature");

      // Back to the first value: the kept entry answers at once, and a run
      // with no period is read again once on its hold's return.
      r.spawner.program(
        shell("git branch --show-current"),
        runsFor(500, exits(0, "main")),
      );
      store.setBox("head", "A");
      r.clock.advance(0);
      await turns();
      expect(store.read("branch")).toBe("main");
      expect(await h.held.settled(AbortSignal.abort())).toEqual([]);
      expect(r.started()).toHaveLength(3);
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

describe("SourceRuns — an entry is kept while held, and under the bound after", () => {
  it("one holder's release leaves the run to the other; the last release keeps its value and arms no period", async () => {
    const r = rig();
    try {
      r.spawner.program(shell("sleep 1"), runsFor(1000, exits(0, "done")));
      const a = r.registry();
      const b = r.registry();
      for (const { registry } of [a, b])
        registry.declareShell("slow", "sleep 1", {
          cwd: "/work",
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

      r.clock.advance(1000);
      await settledAll(r.clock, b);
      expect(b.store.read("slow")).toBe("done");

      // Nobody holds it now: it is kept, and its period spawns nothing.
      b.held.close();
      r.clock.advance(120_000);
      await turns();
      expect(r.started()).toHaveLength(1);
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 0 });

      // A hold that returns reads the kept value at once.
      const c = r.registry();
      c.registry.declareShell("slow", "sleep 1", {
        cwd: "/work",
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 60_000 },
      });
      expect(c.store.read("slow")).toBe("done");
      expect(await c.held.settled(AbortSignal.abort())).toEqual([]);
    } finally {
      r.close();
    }
  });

  it("past the bound, the least recently read unheld run is dropped", async () => {
    const r = rig(1);
    try {
      r.spawner.program(shell("echo one"), exits(0, "one"));
      r.spawner.program(shell("echo two"), exits(0, "two"));
      const a = r.registry();
      a.registry.declareShell("v", "echo one", {
        cwd: "/work",
        parse: TEXT,
        cache: { kind: "never" },
      });
      await settledAll(r.clock, a);
      a.held.close();
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 0 });
      const b = r.registry();
      b.registry.declareShell("v", "echo two", {
        cwd: "/work",
        parse: TEXT,
        cache: { kind: "never" },
      });
      await settledAll(r.clock, b);
      expect(r.runs.stats().shell).toMatchObject({ entries: 1, held: 1 });
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
        parse: TEXT,
        cache: { kind: "ttl", durationMs: 60_000 },
      });
      await turns();
      // The new state holds the entry before the old state is disposed, as
      // the render cache's dispose-after-swap does.
      const b = r.registry();
      b.registry.declareShell("v", "slow", {
        cwd: "/work",
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
