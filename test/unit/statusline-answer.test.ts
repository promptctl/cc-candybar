// A render request answered through its renderer (src/daemon/statusline-
// answer.ts): the host answers the client with the one frame presented for the
// request, a turn that presents none or throws is a failure naming the
// renderer, and every effect the turn returned is owed one `effect-done`. The
// session's config reaches the renderer ahead of the request, with the world
// state its collector read at the request's keys, and every output's
// subscriptions reach the host.
//
// [LAW:behavior-not-structure] Each case drives the host's driver over a fake
// renderer: a value whose turns are scripted, and nothing that records calls.

import { renderFailedFrame, standIn } from "../../src/render/frame";
import { sessionIdOf } from "../../src/daemon/session-id";
import { rendererHost } from "../../src/daemon/renderer-host";
import { answerStatusline } from "../../src/daemon/statusline-answer";
import type { RequestFacts } from "../../src/daemon/request-event";
import {
  TurnThrew,
  type Effect,
  type EffectId,
  type Event,
  type Renderer,
  type RendererOutput,
  type RequestId,
  type Subscriptions,
} from "../../src/renderer/interface";
import type { WorldState } from "../../src/facts/world-state";
import type { CheckedRenderRequest } from "../../src/renderer/request-context";
import { instantOf } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";

const SESSION = sessionIdOf("a-session");
const REQUEST = 3 as RequestId;
const AT = instantOf(new Date(1_700_000_000_000));
const FRAME = renderFailedFrame("the bar");
// What the host reads of a checked request: its session, its encoding, and a
// hook naming no directory, so no checkout is read for it.
const REQ = {
  encoding: "frame",
  hookData: { session_id: SESSION },
} as unknown as CheckedRenderRequest;
// The world state the collector reads at the request's keys.
const WORLD = { session: SESSION, seq: 4 } as unknown as WorldState;
const NO_SUBSCRIPTIONS: Subscriptions = { sources: new Map() };
const CLOCK = {
  monotonic: () => 0 as Monotonic,
  now: () => 1_700_000_000_000,
};

const present = (id: number, request = REQUEST): Effect => ({
  kind: "present",
  id: id as EffectId,
  session: SESSION,
  surface: "statusline",
  request,
  frame: FRAME,
});

// A turn's output with no subscriptions.
const output = (
  effects: readonly Effect[],
  record: RendererOutput["record"] = [],
): RendererOutput => ({ effects, subscriptions: NO_SUBSCRIPTIONS, record });

// A renderer whose request turn answers `output` (or throws it), whose config
// turn answers `configured`, and which keeps every event it hears.
function scripted(
  request: RendererOutput | TurnThrew,
  configured: RendererOutput = output([]),
): {
  readonly renderer: Renderer;
  readonly heard: Event[];
  readonly configs: Event[];
  readonly requests: Event[];
} {
  const heard: Event[] = [];
  const configs: Event[] = [];
  const requests: Event[] = [];
  return {
    heard,
    configs,
    requests,
    renderer: {
      answer: async ({ event }) => {
        switch (event.kind) {
          case "config":
            configs.push(event);
            return configured;
          case "request":
            requests.push(event);
            if (request instanceof TurnThrew) throw request;
            return request;
          default:
            heard.push(event);
            return output([]);
        }
      },
    },
  };
}

async function answer(
  renderer: Renderer,
  logged: string[] = [],
  subscribed: Subscriptions[] = [],
  holds: { count: number } = { count: 0 },
) {
  const facts: RequestFacts = [];
  const answered = await answerStatusline(
    rendererHost(
      "main",
      CLOCK,
      renderer,
      (_level, line) => logged.push(line),
      (subscriptions) => subscribed.push(subscriptions),
    ),
    {
      requested: () => WORLD,
      holding: () => {
        holds.count++;
        return () => holds.count--;
      },
    },
    CLOCK,
    REQ,
    REQUEST,
    AT,
    0,
    facts,
  );
  return { answered, facts: new Map(facts) };
}

// The deliveries a settle starts settle on microtasks alone: a fake renderer
// answers at once.
const drained = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("the request's present answers it, in the request's encoding, and its settle is its effect-done", async () => {
  const { renderer, heard } = scripted(output([present(1)], [["drew", "2ms"]]));
  const { answered, facts } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  expect(facts.get("renderer")).toBe("main");
  expect(facts.get("drew")).toBe("2ms");
  expect(facts.get("effects")).toBe("present:statusline");
  expect(facts.has("encoded")).toBe(true);
  answered.settled(true);
  await drained();
  expect(heard).toEqual([
    { kind: "effect-done", of: 1, outcome: { kind: "ok" } },
  ]);
});

test("the client's sighting is the presented frame's motion: a handoff line's, not the hidden bar's", async () => {
  const handoff = standIn({ ...FRAME, motion: "moves" }, FRAME.rows);
  const { renderer } = scripted(
    output([{ ...present(1), frame: handoff }], []),
  );
  const { answered } = await answer(renderer);
  expect(answered.seen).toBe("can-move");
});

test("a present its client never took settles failed", async () => {
  const { renderer, heard } = scripted(output([present(1)]));
  const { answered } = await answer(renderer);
  answered.settled(false);
  await drained();
  expect(heard).toMatchObject([
    { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
  ]);
});

test("a turn that presents no frame for the request is a failure naming the renderer", async () => {
  const { renderer, heard } = scripted(
    output([present(1, 9 as RequestId)], []),
  );
  const { answered } = await answer(renderer);
  expect(answered.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: `renderer main: presented no statusline frame for request ${REQUEST}`,
  });
  await drained();
  // The stray present is refused, not dropped.
  expect(heard).toMatchObject([
    { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
  ]);
});

test("a second frame for the request is refused, and the first answers it", async () => {
  const { renderer, heard } = scripted(output([present(1), present(2)], []));
  const { answered } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  await drained();
  expect(heard).toMatchObject([
    { kind: "effect-done", of: 2, outcome: { kind: "failed" } },
  ]);
});

test("a config turn's effects are refused, each owed its effect-done, and the request's present still answers it", async () => {
  const { renderer, heard } = scripted(
    output([present(1)]),
    output([present(2)]),
  );
  const { answered, facts } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  expect(facts.get("effects")).toBe("present:statusline");
  await drained();
  expect(heard).toMatchObject([
    {
      kind: "effect-done",
      of: 2,
      outcome: { kind: "failed", reason: "a config turn answers no request" },
    },
  ]);
});

test("a turn that throws is a failure naming the renderer, with what it learned on the request's event", async () => {
  const { renderer } = scripted(
    new TurnThrew(
      [["lanes", "-"]],
      new Error("the draw broke"),
      NO_SUBSCRIPTIONS,
    ),
  );
  const { answered, facts } = await answer(renderer);
  expect(answered.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: "renderer main: the draw broke",
  });
  expect(answered.outcome).toMatchObject({ kind: "threw" });
  expect(facts.get("lanes")).toBe("-");
});

test("a turn that throws still hands the host what its open views read", async () => {
  const left: Subscriptions = {
    sources: new Map([[SESSION, []]]),
  };
  const subscribed: Subscriptions[] = [];
  const { renderer } = scripted(
    new TurnThrew([], new Error("the draw broke"), left),
  );
  await answer(renderer, [], subscribed);
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS, left]);
});

test("a failed effect-done turn is said on a turn line naming the renderer and the session", async () => {
  const logged: string[] = [];
  const renderer: Renderer = {
    answer: async ({ event }) => {
      if (event.kind === "config") return output([]);
      if (event.kind === "request") return output([present(1)]);
      throw new TurnThrew([], new Error("no such present"), NO_SUBSCRIPTIONS);
    },
  };
  const { answered } = await answer(renderer, logged);
  answered.settled(true);
  await drained();
  expect(logged).toEqual([
    expect.stringMatching(
      /^turn renderer=main input=effect-done sid=a-session effect=1 error=.*no such present/,
    ),
  ]);
});

test("the session's config reaches the renderer first, with the world state read at the request's keys, and its subscriptions reach the host before the request does", async () => {
  const opened: Subscriptions = {
    sources: new Map([[SESSION, []]]),
  };
  const drawn: Subscriptions = { sources: new Map() };
  const subscribed: Subscriptions[] = [];
  const { renderer, configs, requests } = scripted(
    { ...output([present(1)]), subscriptions: drawn },
    { ...output([]), subscriptions: opened },
  );
  await answer(
    {
      answer: (input) => {
        // What the host had subscribed when this input reached the renderer.
        if (input.event.kind === "request")
          expect(subscribed).toEqual([opened]);
        return renderer.answer(input);
      },
    },
    [],
    subscribed,
  );
  expect(configs).toEqual([
    { kind: "config", context: REQ, worldState: WORLD },
  ]);
  expect(requests).toEqual([
    { kind: "request", id: REQUEST, context: REQ, waitEndsAt: 0 },
  ]);
  expect(subscribed).toEqual([opened, drawn]);
});

test("the session is held while its request turn is out, and let go once it answers or throws", async () => {
  for (const request of [
    output([present(1)]),
    new TurnThrew([], new Error("x"), NO_SUBSCRIPTIONS),
  ]) {
    const holds = { count: 0 };
    let heldDuringTurn = 0;
    const renderer: Renderer = {
      answer: async ({ event }) => {
        if (event.kind !== "request") return output([]);
        heldDuringTurn = holds.count;
        if (request instanceof TurnThrew) throw request;
        return request;
      },
    };
    await answer(renderer, [], [], holds);
    expect(heldDuringTurn).toBe(1);
    expect(holds.count).toBe(0);
  }
});
