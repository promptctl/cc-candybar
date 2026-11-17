// The host's one path for a push (src/daemon/renderer-host.ts): `ask` hands
// back the reply of the push's own kind or rejects, and `tell` says a failure
// on the log, since nothing awaits it; a push's subscriptions are taken as an
// event's are; and a start heads the mailbox.

import { rendererHost } from "../../src/daemon/renderer-host";
import { failureOf } from "../../src/daemon/foundations/verb-error";
import {
  rendererOf,
  type AdapterOutput,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import { instantOf, type Instant } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";
import { NO_ACTS, pushRenderer, QUIET } from "../helpers/renderers";

const AT = instantOf(new Date(0));

// A host over a renderer that answers every push with `output`; `said`
// settles with the first line it logs, and `subscribed` holds each set of
// subscriptions the host took.
function hostOver(output: AdapterOutput) {
  let say: (line: string) => void = () => {};
  const said = new Promise<string>((resolve) => (say = resolve));
  const subscribed: Subscriptions[] = [];
  const host = rendererHost(
    "main",
    { now: () => 0, monotonic: () => 0 as Monotonic },
    pushRenderer(async () => output),
    (level, line) => say(`${level} ${line}`),
    {
      subscribed: (subscriptions) => void subscribed.push(subscriptions),
      framed: () => {
        throw new Error("a push draws no frame");
      },
      writableSettings: () => {
        throw new Error("a push lands no change");
      },
      holding: () => {
        throw new Error("a push holds no session");
      },
    },
    NO_ACTS,
  );
  return { host, said, subscribed };
}

test("an ask is handed the reply of its push's own kind", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "reload-every" },
    subscriptions: QUIET,
  });
  expect(await host.ask({ kind: "reload-every", since: 0 })).toEqual({
    kind: "reload-every",
  });
});

test("a push's subscriptions are taken as its turn's, so what it moved (a reload owing a frame) is declared", async () => {
  const wake = (AT + 1) as Instant;
  const { host, subscribed } = hostOver({
    kind: "replied",
    reply: { kind: "reload-every" },
    subscriptions: { ...QUIET, wake },
  });
  await host.ask({ kind: "reload-every", since: 0 });
  expect(subscribed).toEqual([{ ...QUIET, wake }]);
});

test("an ask answered with another push's reply rejects, naming both", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "close-views" },
    subscriptions: QUIET,
  });
  await expect(host.ask({ kind: "reload-every", since: 0 })).rejects.toThrow(
    "renderer main answered push reload-every with a close-views reply",
  );
});

test("an ask whose push threw rejects with the renderer's failure", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("the view broke")),
  });
  await expect(host.ask({ kind: "stats" })).rejects.toThrow(
    /renderer main push stats threw: .*the view broke/,
  );
});

test("a tell that fails is said on the log, and nothing rejects", async () => {
  const { host, said } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("no such entry")),
  });
  expect(host.tell({ kind: "reload-every", since: 0 })).toBe(undefined);
  expect(await said).toMatch(
    /^error renderer main push reload-every threw: .*no such entry/,
  );
});

test("a start heads the mailbox, behind only the slot in progress", async () => {
  const heard: string[] = [];
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const host = rendererHost(
    "main",
    { now: () => 0, monotonic: () => 0 as Monotonic },
    rendererOf({
      event: async (input) => {
        heard.push(input.event.kind);
        return {
          kind: "answered",
          effects: [],
          subscriptions: QUIET,
          frames: [],
          record: [],
          turnMs: 0,
        };
      },
      adapter: async (input) => {
        heard.push(`push:${input.push.kind}`);
        await opened;
        return {
          kind: "replied",
          reply: { kind: "reload-every" },
          subscriptions: QUIET,
        };
      },
    }),
    () => {},
    {
      subscribed: () => {},
      framed: () => {},
      writableSettings: () => [],
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const held = host.ask({ kind: "reload-every", since: 0 });
  const waiting = host.deliver(
    () => ({
      kind: "event",
      at: AT,
      event: { kind: "retire", session: "s" as never },
    }),
    [],
  );
  const started = host.start(
    () => ({
      kind: "event",
      at: AT,
      event: { kind: "start", sessions: [], viewers: {} },
    }),
    [],
  );
  open();
  await Promise.all([held, waiting, started]);
  expect(heard).toEqual(["push:reload-every", "start", "retire"]);
});

test("an input is made at the instant its slot comes up, not when it was asked, so the renderer's time never runs back", async () => {
  let wall = 0;
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const made: number[] = [];
  const host = rendererHost(
    "main",
    { now: () => wall, monotonic: () => 0 as Monotonic },
    pushRenderer(async (input) => {
      made.push(input.at);
      if (made.length === 1) await opened;
      return {
        kind: "replied",
        reply: { kind: "reload-every" },
        subscriptions: QUIET,
      };
    }),
    () => {},
    {
      subscribed: () => {},
      framed: () => {},
      writableSettings: () => [],
      holding: () => () => {},
    },
    NO_ACTS,
  );
  const first = host.ask({ kind: "reload-every", since: 0 });
  const second = host.ask({ kind: "reload-every", since: 0 });
  wall = 5000;
  open();
  await Promise.all([first, second]);
  expect(made).toEqual([0, 5]);
});
