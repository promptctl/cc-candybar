// The supervisor over renderers a test plays: arming starts one told every
// live session, one that ended is started again after a backoff that grows
// while renderers end young, what it held goes once the next one has started,
// and its effects go with it.

import type {
  AdapterToHost,
  StorageHoldId,
  WatchId,
} from "../../src/renderer-interface/adapter";
import type {
  EffectId,
  Generation,
  RendererInput,
  StartInput,
} from "../../src/renderer-interface/interface";
import {
  RESTART,
  restartDelayMs,
  superviseRenderer,
  type RendererLink,
  type SupervisorDeps,
} from "../../src/daemon/renderer-supervisor";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Instant } from "../../src/utils/instant";

const AT = 0 as unknown as Instant;
const S = "s" as SessionId;

// One renderer the test started: what it was handed, what it heard, and the
// hand that ends it.
interface Played {
  readonly host: AdapterToHost;
  readonly generation: Generation;
  readonly heard: RendererInput[];
  end(words: string): void;
}

// Every reaction already queued, a few promise turns deep.
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

function rig() {
  const played: Played[] = [];
  const said: string[] = [];
  const deferred: Array<() => void> = [];
  let now = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  const start: SupervisorDeps["start"] = (host, generation) => {
    let end!: (words: string) => void;
    const ended = new Promise<string>((resolve) => (end = resolve));
    const heard: RendererInput[] = [];
    played.push({ host, generation, heard, end });
    const link: RendererLink = {
      answer: async (input) => {
        heard.push(input);
        return {
          output:
            input.kind === "adapter"
              ? { kind: "replied", reply: { kind: input.push.kind } as never }
              : {
                  kind: "answered",
                  effects: [],
                  record: [],
                  subscriptions: { sources: {} },
                },
          tookMs: 0,
        };
      },
      ended,
      end: async () => {
        end("ended with its host");
        await ended;
      },
    };
    return link;
  };
  const supervisor = superviseRenderer({
    start,
    host: {} as never,
    watches: {
      acquire: (key) => {
        said.push(`acquire ${key}`);
        return { release: () => said.push(`release ${key}`), deaf: [] };
      },
    },
    storage: {
      hold: (id) => said.push(`hold ${id}`),
      release: (id) => said.push(`unhold ${id}`),
    },
    sessions: () => [
      {
        context: {} as never,
        worldState: { session: S } as never,
      },
    ],
    monotonic: () => now,
    now: () => AT,
    defer: (run) => void deferred.push(run),
    after: (ms, run) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => (timers = timers.filter((t) => t !== timer));
    },
    log: (level, line) => said.push(`${level} ${line}`),
  });
  // The clock moved on by `ms`, and every restart due by then started.
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.run();
    await flush();
  };
  const event = (of: EffectId) =>
    supervisor.answer({
      kind: "event",
      at: AT,
      event: { kind: "effect-done", session: S, of, outcome: { kind: "ok" } },
    });
  const push = (kind: "pin" | "unpin" | "close-views" | "reload-every") =>
    supervisor.answer({
      kind: "adapter",
      at: AT,
      push:
        kind === "pin" || kind === "unpin"
          ? { kind, session: S }
          : kind === "reload-every"
            ? { kind, since: AT }
            : { kind },
    } as never);
  const startOf = (p: Played): StartInput => p.heard[0] as StartInput;
  return {
    played,
    said,
    deferred,
    supervisor,
    event,
    push,
    advance,
    startOf,
  };
}

test("arming starts a renderer told every live session, and a pin before it is carried by the start", async () => {
  const r = rig();
  await r.push("pin");
  expect(r.played).toHaveLength(0);
  r.supervisor.arm();
  await flush();
  const [first] = r.played;
  const start = r.startOf(first!);
  expect(start.start.cause).toEqual({ kind: "first" });
  expect(start.start.sessions.map((s) => s.pinned)).toEqual([true]);
  expect(first!.heard).toHaveLength(1);
});

test("an unarmed supervisor starts its renderer on the first input that needs one", async () => {
  const r = rig();
  await r.push("reload-every");
  expect(r.played).toHaveLength(1);
  expect(r.played[0]!.heard.map((i) => i.kind)).toEqual(["start", "adapter"]);
});

test("a renderer that lived ends, and another starts at once holding its pins; the dead one's holds go once it has started", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  await r.push("pin");
  const first = r.played[0]!;
  first.host.watches.watch("1.1" as WatchId, "k", {} as never);
  first.host.storage.hold("1.1" as StorageHoldId, []);
  await r.advance(RESTART.youngMs);
  first.end("exited with code 1");
  await flush();
  expect(r.said).not.toContain("release k");
  await r.advance(0);
  expect(r.played).toHaveLength(2);
  const second = r.played[1]!;
  expect(r.startOf(second).start).toMatchObject({
    cause: { kind: "crashed", ended: "exited with code 1" },
  });
  expect(r.startOf(second).start.sessions.map((s) => s.pinned)).toEqual([true]);
  expect(second.generation).toBe(2);
  expect(r.said).toEqual(expect.arrayContaining(["release k", "unhold 1.1"]));
});

test("renderers that end young wait a backoff that doubles, and meanwhile inputs fail with how the last ended and start none", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  r.played[0]!.end("exited with code 1");
  await flush();
  expect(r.said).toEqual(
    expect.arrayContaining([expect.stringContaining("restart=1000ms")]),
  );
  await expect(r.push("reload-every")).rejects.toThrow(
    "no renderer runs: its process exited with code 1",
  );
  // A pin and a teardown step need no renderer: the next start carries the
  // pin, and there is nothing to close.
  await r.push("pin");
  await r.push("close-views");
  expect(r.played).toHaveLength(1);
  await r.advance(restartDelayMs(1) - 1);
  expect(r.played).toHaveLength(1);
  await r.advance(1);
  expect(r.played).toHaveLength(2);
  expect(r.startOf(r.played[1]!).start.sessions.map((s) => s.pinned)).toEqual([
    true,
  ]);
  r.played[1]!.end("exited with code 1");
  await flush();
  await r.advance(restartDelayMs(2) - 1);
  expect(r.played).toHaveLength(2);
  await r.advance(1);
  expect(r.played).toHaveLength(3);
});

test("the backoff doubles to its cap", () => {
  expect([0, 1, 2, 3].map(restartDelayMs)).toEqual([0, 1000, 2000, 4000]);
  expect(restartDelayMs(30)).toBe(RESTART.maxBackoffMs);
});

test("an unpin that lands while no renderer runs is kept, so the next start does not pin the feed again", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  await r.push("pin");
  r.played[0]!.end("killed by SIGKILL");
  await flush();
  await r.push("unpin");
  await r.advance(restartDelayMs(1));
  expect(r.startOf(r.played[1]!).start.sessions.map((s) => s.pinned)).toEqual([
    false,
  ]);
});

test("an effect returned by a renderer that ended is refused, and none reaches its successor", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  r.played[0]!.end("killed by SIGKILL");
  await flush();
  await r.advance(restartDelayMs(1));
  await expect(r.event("1.3" as EffectId)).rejects.toThrow(
    "effect 1.3 was returned by a renderer that has ended",
  );
  await r.event("2.1" as EffectId);
  expect(r.played[1]!.heard.at(-1)).toMatchObject({
    event: { kind: "effect-done", of: "2.1" },
  });
});

test("a watch's pushes go to the renderer that holds it, and none once it ended", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  const first = r.played[0]!;
  first.host.watches.watch("1.1" as WatchId, "k", {} as never);
  for (const run of r.deferred.splice(0)) run();
  await flush();
  expect(first.heard.at(-1)).toMatchObject({
    push: { kind: "watch", id: "1.1", heard: null },
  });
  first.end("exited with code 1");
  await flush();
  const count = first.heard.length;
  first.host.watches.watch("1.2" as WatchId, "j", {} as never);
  for (const run of r.deferred.splice(0)) run();
  await flush();
  expect(first.heard).toHaveLength(count);
});

test("once closed it ends its renderer, releases what it held, and starts no other", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  r.played[0]!.host.watches.watch("1.1" as WatchId, "k", {} as never);
  await r.supervisor.close();
  await flush();
  expect(r.said).toContain("release k");
  await expect(r.push("reload-every")).rejects.toThrow(
    "the renderer supervisor is closed",
  );
  await r.advance(RESTART.maxBackoffMs);
  expect(r.played).toHaveLength(1);
});

test("a close while it waits to restart cancels the restart", async () => {
  const r = rig();
  r.supervisor.arm();
  await flush();
  r.played[0]!.end("exited with code 1");
  await flush();
  await r.supervisor.close();
  await r.advance(RESTART.maxBackoffMs);
  expect(r.played).toHaveLength(1);
});
