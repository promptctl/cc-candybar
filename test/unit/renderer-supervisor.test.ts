// The supervisor over renderers a test plays: each start is told every live
// session, a renderer that ended is started again on the next input, what it
// held goes once the next one has started, and its effects go with it.

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

function rig() {
  const played: Played[] = [];
  const said: string[] = [];
  const deferred: Array<() => void> = [];
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
    monotonic: () => 0,
    now: () => AT,
    defer: (run) => void deferred.push(run),
    log: (level, line) => said.push(`${level} ${line}`),
  });
  const event = (of: EffectId) =>
    supervisor.answer({
      kind: "event",
      at: AT,
      event: { kind: "effect-done", session: S, of, outcome: { kind: "ok" } },
    });
  const push = (kind: "pin" | "close-views") =>
    supervisor.answer({
      kind: "adapter",
      at: AT,
      push: kind === "pin" ? { kind, session: S } : { kind },
    } as never);
  return { played, said, deferred, supervisor, event, push };
}

// Every reaction already queued, a few promise turns deep.
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

test("the first input starts a renderer with every live session, which answers it", async () => {
  const r = rig();
  await r.push("pin");
  expect(r.played).toHaveLength(1);
  const [first] = r.played;
  const start = first!.heard[0] as StartInput;
  expect(start.kind).toBe("start");
  expect(start.start.cause).toEqual({ kind: "first" });
  // The pin that started it is the renderer's to hear, not the start's.
  expect(start.start.sessions.map((s) => s.pinned)).toEqual([false]);
  expect(first!.heard[1]).toMatchObject({ push: { kind: "pin" } });
});

test("after a renderer ends, the next input starts one that holds the pins, and the dead one's holds go once it has started", async () => {
  const r = rig();
  await r.push("pin");
  const first = r.played[0]!;
  first.host.watches.watch("1.1" as WatchId, "k", {} as never);
  first.host.storage.hold("1.1" as StorageHoldId, []);
  first.end("exited with code 1");
  await flush();
  expect(r.said).not.toContain("release k");

  await r.push("close-views");
  // A teardown step with no renderer running starts none.
  expect(r.played).toHaveLength(1);

  await r.event("1.1" as EffectId).catch(() => {});
  expect(r.played).toHaveLength(1);

  await r.push("pin");
  expect(r.played).toHaveLength(2);
  const second = r.played[1]!;
  const start = second.heard[0] as StartInput;
  expect(start.start.cause).toEqual({
    kind: "crashed",
    ended: "exited with code 1",
  });
  expect(start.start.sessions.map((s) => s.pinned)).toEqual([true]);
  expect(second.generation).toBe(2);
  expect(r.said).toEqual(expect.arrayContaining(["release k", "unhold 1.1"]));
});

test("an effect returned by a renderer that ended is refused, and none reaches its successor", async () => {
  const r = rig();
  await r.push("pin");
  r.played[0]!.end("killed by SIGKILL");
  await flush();
  await r.push("pin");
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
  await r.push("pin");
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

test("once closed it ends its renderer and starts no other", async () => {
  const r = rig();
  await r.push("pin");
  await r.supervisor.close();
  await flush();
  await expect(r.push("pin")).rejects.toThrow(
    "the renderer supervisor is closed",
  );
  expect(r.played).toHaveLength(1);
});
