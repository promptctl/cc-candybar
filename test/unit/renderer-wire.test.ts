// The renderer interface over a pair of line channels, as a renderer's
// process carries it: inputs answered by their outputs, notices and calls
// reaching the host, and a host's failure kept whole across the crossing.

import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import {
  rendererOf,
  type RendererInput,
} from "../../src/renderer-interface/interface";
import {
  serveRenderer,
  wireRenderer,
  type LineChannel,
} from "../../src/renderer-interface/wire";
import {
  DaemonClosing,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import type { Instant } from "../../src/utils/instant";

const AT = 0 as unknown as Instant;

// Two ends of one channel: what one sends, the other hears, a turn later.
function linePair(): [LineChannel, LineChannel] {
  const hearers: Array<(line: string) => void> = [() => {}, () => {}];
  const end = (me: 0 | 1): LineChannel => ({
    send: (line) => {
      expect(line).not.toContain("\n");
      void Promise.resolve().then(() => hearers[1 - me]!(line));
    },
    hear: (heard) => {
      hearers[me] = heard;
    },
  });
  return [end(0), end(1)];
}

const answered = {
  kind: "answered",
  effects: [],
  record: [],
  subscriptions: { sources: {} },
} as const;

function wired(host: Partial<AdapterToHost>) {
  const [hostEnd, rendererEnd] = linePair();
  let reached!: AdapterToHost;
  serveRenderer(
    rendererEnd,
    (remote) => {
      reached = remote;
      return rendererOf({
        start: async () => answered,
        event: async () => answered,
        adapter: async (input) => ({
          kind: "replied",
          reply: { kind: input.push.kind } as never,
        }),
      });
    },
    () => 0,
  );
  const wire = wireRenderer(hostEnd, host as AdapterToHost);
  return { wire, reached: () => reached };
}

const START: RendererInput = {
  kind: "start",
  at: AT,
  start: { cause: { kind: "first" }, sessions: [] },
};

test("an input crosses and its output comes back with the renderer's span", async () => {
  const { wire } = wired({});
  await expect(wire.answer(START)).resolves.toEqual({
    output: answered,
    tookMs: 0,
  });
});

test("a notice reaches the host's part by its path, and a call is answered with what it returned", async () => {
  const woken: unknown[] = [];
  const { wire, reached } = wired({
    wake: (...args) => void woken.push(args),
    serving: async () => ({ held: 7 }) as never,
  });
  await wire.answer(START);
  reached().wake("s" as never, "a cause" as never);
  await expect(reached().serving()).resolves.toEqual({ held: 7 });
  expect(woken).toEqual([["s", "a cause"]]);
});

test("a call that throws on the host rejects in the renderer with its failure whole", async () => {
  const thrown = new Error("the forge is down");
  const { wire, reached } = wired({
    serving: async () => {
      throw thrown;
    },
  });
  await wire.answer(START);
  const failed = await reached()
    .serving()
    .then(
      () => null,
      (e: unknown) => failureOf(e),
    );
  expect(failed).toEqual(failureOf(thrown));
});

test("an input still out when the renderer's end is gone fails with why", async () => {
  const [hostEnd] = linePair();
  const wire = wireRenderer(hostEnd, {} as AdapterToHost);
  const out = wire.answer(START);
  wire.fail(new Error("the renderer's process exited with code 1"));
  await expect(out).rejects.toThrow("exited with code 1");
  await expect(wire.answer(START)).rejects.toThrow("exited with code 1");
});

test("the host performs the renderer's reaches in the order it made them, a call's body before the notice after it", async () => {
  const order: string[] = [];
  const { wire, reached } = wired({
    menuIdle: {
      confirmClose: async () => {
        order.push("confirmClose");
        return true;
      },
      clicked: () => void order.push("clicked"),
    } as never,
  });
  await wire.answer(START);
  const call = reached().menuIdle.confirmClose("s" as never, AT);
  reached().menuIdle.clicked("s" as never, AT);
  await call;
  expect(order).toEqual(["confirmClose", "clicked"]);
});

test("a failure the host classified keeps its kind across, so the renderer routes a closing daemon as closing", async () => {
  const { wire, reached } = wired({
    serving: async () => {
      throw new DaemonClosing("the daemon is closing");
    },
  });
  await wire.answer(START);
  const kind = await reached()
    .serving()
    .then(
      () => null,
      (e: unknown) => failureOf(e).kind,
    );
  expect(kind).toBe("closing");
});
