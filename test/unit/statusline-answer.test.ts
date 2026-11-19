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

import { checkoutLocation } from "../../src/utils/git-root";
import { TEST_ENVIRONMENT } from "../helpers/session-environment";
import {
  eventRenderer,
  hearingEvents,
  hostHeld,
  NO_ACTS,
} from "../helpers/renderers";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { renderFailedFrame, standIn } from "../../src/render/frame";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { rendererHost } from "../../src/daemon/renderer-host";
import { answerStatusline } from "../../src/daemon/statusline-answer";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { TEST_SIGNER } from "../helpers/link-signer";
import type { RequestFacts } from "../../src/daemon/foundations/request-event";
import {
  BadVerbArgs,
  failureOf,
} from "../../src/daemon/foundations/verb-error";
import {
  type Effect,
  Present,
  type EffectId,
  type Event,
  type Renderer,
  type RendererOutput,
  type RequestId,
  type Subscriptions,
} from "../../src/renderer-interface/interface";
import type { WorldState } from "../../src/facts/world-state";
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import type { Monotonic } from "../../src/time";

const SESSION = sessionIdOf("a-session");
const REQUEST = 3 as RequestId;
const FRAME = renderFailedFrame("the bar");
// What the host reads of a checked request: its session, its encoding, and a
// hook naming no directory, so no checkout is read for it.
const REQ = {
  encoding: "frame",
  deadline: { kind: "unstated" },
  hookData: { session_id: SESSION },
} as unknown as CheckedRenderRequest;
// The world state the collector reads at the request's keys.
const WORLD = { session: SESSION, seq: 4 } as unknown as WorldState;
const NO_SUBSCRIPTIONS: Subscriptions = {
  sources: {},
  lanes: {},
  configs: [],
  wake: null,
};
// The request's deadline is a timer the case fires itself (`deadlines`).
const deadlines = new Set<() => void>();
const CLOCK = {
  monotonic: () => 0 as Monotonic,
  now: () => 1_700_000_000_000,
  after: (_ms: number, fire: () => void) => {
    deadlines.add(fire);
    return () => void deadlines.delete(fire);
  },
};
const NOT_CLOSING = new AbortController().signal;

const present = (id: number, request = REQUEST): Present => ({
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
): RendererOutput => ({
  kind: "answered",
  stored: [],
  effects,
  subscriptions: NO_SUBSCRIPTIONS,
  record,
  frames: [],
});

// A turn that threw `message`, having reached `record`.
const threwWith = (
  record: RendererOutput["record"],
  message: string,
  subscriptions: Subscriptions = NO_SUBSCRIPTIONS,
): RendererOutput => ({
  kind: "threw",
  stored: [],
  failure: failureOf(new Error(message)),
  effects: [],
  subscriptions,
  record,
  frames: [],
});

// A renderer whose request turn answers `request`, whose context
// turn answers `configured`, and which keeps every event it hears.
function scripted(
  request: RendererOutput,
  configured: RendererOutput = output([]),
): {
  readonly renderer: Renderer;
  readonly heard: Event[];
  readonly contexts: Event[];
  readonly requests: Event[];
} {
  const heard: Event[] = [];
  const contexts: Event[] = [];
  const requests: Event[] = [];
  return {
    heard,
    contexts,
    requests,
    renderer: eventRenderer(async ({ event }) => {
      switch (event.kind) {
        case "context":
          contexts.push(event);
          return configured;
        case "request":
          requests.push(event);
          return request;
        default:
          heard.push(event);
          return output([]);
      }
    }),
  };
}

// What a case's request meets in the host: its session's wait, how long it
// may take, and the daemon's close.
interface Meets {
  readonly settled?: (session: unknown, signal: AbortSignal) => Promise<void>;
  readonly waitEndsAt?: number;
  readonly closing?: AbortSignal;
}

async function answer(
  renderer: Renderer,
  logged: string[] = [],
  subscribed: Subscriptions[] = [],
  holds: { count: number; sessions: string[] } = { count: 0, sessions: [] },
  meets: Meets = {},
) {
  const facts: RequestFacts = [];
  const named = new Set<string>();
  // Mirrors the collector: only a session a request has named is held.
  const holding = (session: string) => {
    if (!named.has(session)) return () => {};
    holds.count++;
    holds.sessions.push(session);
    return () => void holds.count--;
  };
  const answered = await answerStatusline(
    rendererHost(
      MAIN_RENDERER,
      CLOCK,
      hostHeld(renderer, CLOCK.monotonic),
      (_level, line) => logged.push(line),
      {
        subscribed: (subscriptions) => void subscribed.push(subscriptions),
        frames: () => {},
        stored: () => {},
        recorded: () => {},
        holding,
      },
      NO_ACTS,
    ),
    publishingFrames(TEST_SIGNER),
    {
      requested: (req) => {
        named.add(req.hookData.session_id);
        return WORLD;
      },
      holding,
      // A warm session: nothing it reads is still unread.
      settled: meets.settled ?? (async () => {}),
    },
    CLOCK,
    meets.closing ?? NOT_CLOSING,
    (_level, line) => logged.push(line),
    checkoutLocation,
    REQ,
    TEST_ENVIRONMENT,
    REQUEST,
    meets.waitEndsAt ?? 0,
    facts,
  );
  return { answered, facts: new Map(facts) };
}

// The deliveries a settle starts settle on microtasks alone: a fake renderer
// answers at once.
const drained = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("the request's present answers it, in the request's encoding, with each turn's time, and its settle is its effect-done", async () => {
  const { renderer, heard } = scripted(output([present(1)]));
  const { answered, facts } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  expect(facts.get("renderer")).toBe("main");
  // How long the renderer's own config and draw turns took, timed where
  // they ran.
  expect(facts.get("configured")).toMatch(/^\d+ms$/);
  expect(facts.get("drew")).toMatch(/^\d+ms$/);
  expect(facts.get("effects")).toBe("present:statusline");
  expect(facts.has("encoded")).toBe(true);
  answered.settled(true);
  await drained();
  expect(heard).toEqual([
    { kind: "effect-done", session: SESSION, of: 1, outcome: { kind: "ok" } },
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
    {
      kind: "effect-done",
      session: SESSION,
      of: 1,
      outcome: { kind: "failed" },
    },
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
    {
      kind: "effect-done",
      session: SESSION,
      of: 1,
      outcome: { kind: "failed" },
    },
  ]);
});

test("a second frame for the request is refused, and the first answers it", async () => {
  const { renderer, heard } = scripted(output([present(1), present(2)], []));
  const { answered } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  await drained();
  expect(heard).toMatchObject([
    {
      kind: "effect-done",
      session: SESSION,
      of: 2,
      outcome: { kind: "failed" },
    },
  ]);
});

test("a context turn's effects are refused, each owed its effect-done, and the request's present still answers it", async () => {
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
      outcome: { kind: "failed", reason: "a context turn answers no request" },
    },
  ]);
});

test("a turn that throws is a failure naming the renderer, with what it learned on the request's event", async () => {
  const { renderer } = scripted(threwWith([["lanes", "-"]], "the draw broke"));
  const { answered, facts } = await answer(renderer);
  expect(answered.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: "renderer main: the draw broke",
  });
  expect(answered.outcome).toMatchObject({ kind: "threw" });
  expect(facts.get("lanes")).toBe("-");
});

test("a render turn that throws a bad argument is still the daemon's failure, as its reply says", async () => {
  const { renderer } = scripted({
    kind: "threw",
    stored: [],
    failure: failureOf(new BadVerbArgs("no such row")),
    effects: [],
    subscriptions: NO_SUBSCRIPTIONS,
    frames: [],
    record: [],
  });
  const { answered } = await answer(renderer);
  expect(answered.resp).toMatchObject({ code: "RENDER_FAILED" });
  expect(answered.outcome).toMatchObject({
    kind: "threw",
    message: "no such row",
  });
});

test("a renderer that rejects is the turn's failure, said on its line, and the subscriptions last taken stand", async () => {
  const logged: string[] = [];
  const subscribed: Subscriptions[] = [];
  const renderer = eventRenderer(async ({ event }) => {
    if (event.kind === "context") return output([]);
    if (event.kind === "request") return output([present(1)]);
    throw new Error("the renderer went away");
  });
  const { answered } = await answer(renderer, logged, subscribed);
  answered.settled(true);
  await drained();
  expect(logged).toEqual([
    expect.stringMatching(
      /^turn renderer=main input=effect-done sid=a-session effect=1 error=.*the renderer went away/,
    ),
  ]);
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS, NO_SUBSCRIPTIONS]);
});

test("a turn that throws still hands the host what its open views read", async () => {
  const left: Subscriptions = {
    sources: { [SESSION]: [] },
    lanes: {},
    configs: [],
    wake: null,
  };
  const subscribed: Subscriptions[] = [];
  const { renderer } = scripted(threwWith([], "the draw broke", left));
  await answer(renderer, [], subscribed);
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS, left]);
});

test("a failed effect-done turn is said on a turn line naming the renderer and the session", async () => {
  const logged: string[] = [];
  const renderer = eventRenderer(async ({ event }) => {
    if (event.kind === "context") return output([]);
    if (event.kind === "request") return output([present(1)]);
    return threwWith([], "no such present");
  });
  const { answered } = await answer(renderer, logged);
  answered.settled(true);
  await drained();
  expect(logged).toEqual([
    expect.stringMatching(
      /^turn renderer=main input=effect-done sid=a-session effect=1 took=\d+ms error=.*no such present/,
    ),
  ]);
});

test("the session's context reaches the renderer first, with the world state read at the request's keys, and its subscriptions reach the host before the request does", async () => {
  const opened: Subscriptions = {
    sources: { [SESSION]: [] },
    lanes: {},
    configs: [],
    wake: null,
  };
  const drawn: Subscriptions = {
    sources: {},
    lanes: {},
    configs: [],
    wake: null,
  };
  const subscribed: Subscriptions[] = [];
  const { renderer, contexts, requests } = scripted(
    { ...output([present(1)]), subscriptions: drawn },
    { ...output([]), subscriptions: opened },
  );
  await answer(
    hearingEvents(renderer, (input) => {
      // What the host had subscribed when this input reached the renderer.
      if (input.event.kind === "request") expect(subscribed).toEqual([opened]);
    }),
    [],
    subscribed,
  );
  expect(contexts).toEqual([
    { kind: "context", context: REQ, worldState: WORLD },
  ]);
  expect(requests).toEqual([{ kind: "request", id: REQUEST, context: REQ }]);
  expect(subscribed).toEqual([opened, drawn]);
});

test("the request holds its session from its context to its answer, wait included, the host holds it through each turn, and every hold is let go once each answers or throws", async () => {
  const threw = () => threwWith([], "x");
  for (const [config, request] of [
    [output([]), output([present(1)])],
    [output([]), threw()],
    [threw(), output([])],
  ] as const) {
    const holds = { count: 0, sessions: [] as string[] };
    const heldDuring: string[] = [];
    const renderer = eventRenderer(async ({ event }) => {
      const turn = event.kind === "context" ? config : request;
      heldDuring.push(`${event.kind}:${holds.count}`);
      return turn;
    });
    await answer(renderer, [], [], holds);
    expect(heldDuring).toEqual(
      config.kind === "threw" ? ["context:2"] : ["context:2", "request:2"],
    );
    // Each turn's hold names the session the request's document was read for.
    expect(new Set(holds.sessions)).toEqual(new Set([REQ.hookData.session_id]));
    expect(holds.count).toBe(0);
  }
});

describe("the request's wait, between its context and its request", () => {
  // A wait the case ends: `end` settles the session's world state.
  const held = () => {
    let end = (): void => {};
    const settled = (_session: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        end = resolve;
        signal.addEventListener("abort", () => resolve());
      });
    return { settled, end: () => end() };
  };

  test("a warm session's request is delivered at once", async () => {
    const { renderer, requests } = scripted(output([present(1)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("answered");
  });

  test("a wait that outlasts the client's deadline ends there, and the request draws what is landed", async () => {
    const { renderer, requests } = scripted(output([present(1)]));
    const answering = answer(renderer, [], [], undefined, {
      settled: () => new Promise(() => {}),
      waitEndsAt: 5000,
    });
    await drained();
    for (const fire of deadlines) fire();
    const { answered, facts } = await answering;
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("deadline");
  });

  test("the daemon's close ends the wait, and the request draws nothing into the closing views", async () => {
    const closing = new AbortController();
    const { renderer, contexts, requests } = scripted(output([present(1)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      // The close begins while the request waits.
      settled: () => {
        closing.abort();
        return new Promise(() => {});
      },
      waitEndsAt: 5000,
      closing: closing.signal,
    });
    expect(facts.get("ended")).toBe("closed");
    expect(contexts).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
  });

  test("a request whose context turn comes up once the close has begun opens no view", async () => {
    const closing = new AbortController();
    closing.abort();
    const { renderer, contexts, requests } = scripted(output([present(1)]));
    const { answered } = await answer(renderer, [], [], undefined, {
      closing: closing.signal,
    });
    expect(contexts).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
  });

  test("holds no place in the mailbox: an input sent during the wait is answered before the request", async () => {
    const wait = held();
    const order: string[] = [];
    const host = rendererHost(
      MAIN_RENDERER,
      CLOCK,
      hostHeld(
        eventRenderer(async ({ event }) => {
          order.push(event.kind);
          return event.kind === "request" ? output([present(1)]) : output([]);
        }),
        CLOCK.monotonic,
      ),
      () => {},
      {
        subscribed: () => {},
        frames: () => {},
        stored: () => {},
        recorded: () => {},
        holding: () => () => {},
      },
      NO_ACTS,
    );
    const answering = answerStatusline(
      host,
      publishingFrames(TEST_SIGNER),
      {
        requested: () => WORLD,
        holding: () => () => {},
        settled: wait.settled,
      },
      CLOCK,
      NOT_CLOSING,
      () => {},
      checkoutLocation,
      REQ,
      TEST_ENVIRONMENT,
      REQUEST,
      5000,
      [],
    );
    await drained();
    await host.deliver(
      () => ({ kind: "event", event: { kind: "retire", session: SESSION } }),
      [],
    );
    wait.end();
    await answering;
    expect(order).toEqual(["context", "retire", "request"]);
  });
});
