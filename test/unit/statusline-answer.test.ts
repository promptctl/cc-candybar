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

import { TEST_ENV, TEST_ENVIRONMENT } from "../helpers/session-environment";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import {
  eventRenderer,
  hearingEvents,
  hostHeld,
  noActs,
  NO_CONFIGS,
} from "../helpers/renderers";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { renderFailedFrame, standIn } from "../../src/render/frame";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { HostPresentations } from "../../src/daemon/host-presentations";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { HeldSurface } from "../../src/renderer-interface/presentation";
import type { DaemonEvent } from "../../src/utils/event-hold";
import type { Instant } from "../../src/utils/instant";
import { rendererHost } from "../../src/daemon/renderer-host";
import { answerStatusline } from "../../src/daemon/statusline-answer";
import type { Moved } from "../../src/daemon/collector";
import type { Awaiting } from "../../src/facts/awaited";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { TEST_SIGNER } from "../helpers/link-signer";
import type { RequestFacts } from "../../src/daemon/foundations/request-event";
import { BadVerbArgs } from "../../src/daemon/foundations/verb-error";
import { failureOf } from "../../src/daemon/foundations/host-failure";
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
import type { Monotonic } from "../../src/time";
import { handClock } from "../helpers/hand-clock";
import { ABSENT } from "../../src/utils/outcome";

const SESSION = sessionIdOf("a-session");
const REQUEST = 3 as RequestId;
const FRAME = renderFailedFrame("the bar");
const CHECKED = checkRenderRequest(
  {
    v: PROTOCOL_VERSION,
    kind: "render",
    args: ["cc-candybar"],
    cwd: "/project",
    encoding: "frame",
    env: TEST_ENV,
    hookData: {
      hook_event_name: "Status",
      session_id: SESSION,
      transcript_path: "/project/transcript.jsonl",
      cwd: "/project",
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: "/project", project_dir: "/project" },
    },
  },
  { firstSightOfUnknownHookField: () => false },
  () => {},
  "/home/test",
);
if (!CHECKED.ok) throw new Error(CHECKED.problems.join("; "));
const REQ = CHECKED.req;
const LOCATION = { main: "", worktree: "", subpath: "", noRepo: true };
const locate = () => ABSENT;
const CONTEXT = { ...REQ, hookData: { ...REQ.hookData, location: LOCATION } };
// The world state the collector reads at the request's keys.
const WORLD = { session: SESSION, seq: 4 } as unknown as WorldState;
const NO_SUBSCRIPTIONS: Subscriptions = {
  sources: {},
  lanes: {},
  managedFolders: [],
  configSelections: [],
  configs: [],
};
// The request's deadline is a timer the case fires itself (`deadlines`).
const deadlines = new Set<() => void>();
const CLOCK = handClock({
  monotonic: () => 0 as Monotonic,
  now: () => 1_700_000_000_000,
  timer: (_ms, fire) => {
    deadlines.add(fire);
    return () => void deadlines.delete(fire);
  },
});
const NOT_CLOSING = new AbortController().signal;

const present = (id: number, request = REQUEST): Present => ({
  kind: "present",
  id: id as EffectId,
  session: SESSION,
  surface: "statusline",
  request,
  frame: FRAME,
  awaiting: { kind: "settled", seq: 1 },
});

// The request's present, owing what `awaiting` says its draw owes.
const owing = (id: number, awaiting: Awaiting): Present => ({
  ...present(id),
  awaiting,
});
const OWED: Awaiting = { kind: "owed", seq: 1, names: ["slow"] };

// A turn's output with no subscriptions.
const output = (
  effects: readonly Effect[],
  record: RendererOutput["record"] = [],
): RendererOutput => ({
  kind: "answered",
  stored: [],
  effects,
  subscriptions: NO_SUBSCRIPTIONS,
  wake: null,
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
  wake: null,
  record,
  frames: [],
});

// A renderer whose request turns answer `request` (each draw of a request its
// next, the last again), whose context turn answers `configured`, and which
// keeps every event it hears.
function scripted(
  request: RendererOutput | readonly RendererOutput[],
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
  const draws = "kind" in request ? [request] : request;
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
          return draws[Math.min(requests.length, draws.length) - 1]!;
        default:
          heard.push(event);
          return output([]);
      }
    }),
  };
}

// What a case's request meets in the host: the wait for its session's next
// world state, how long it may take, and the daemon's close.
interface Meets {
  readonly moved?: (
    session: unknown,
    after: number,
    signal: AbortSignal,
  ) => Promise<Moved>;
  readonly waitEndsAt?: number;
  readonly closing?: AbortSignal;
  // Whether the client has hung up.
  readonly gone?: () => boolean;
  // The host's world, when the case reads what a delivery did to it.
  readonly world?: HostWorld;
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
        prepare: () => () => {},
        recorded: () => {},
        holding,
      },
      meets.world ?? noActs(),
    ),
    publishingFrames(TEST_SIGNER),
    {
      requested: (req) => {
        named.add(req.hookData.session_id);
        return WORLD;
      },
      holding,
      // A draw that owes nothing never waits.
      moved: meets.moved ?? (async () => ({ kind: "gone" })),
    },
    CLOCK,
    meets.closing ?? NOT_CLOSING,
    (_level, line) => logged.push(line),
    locate,
    REQ,
    TEST_ENVIRONMENT,
    REQUEST,
    { waitEndsAt: meets.waitEndsAt ?? 0, gone: meets.gone ?? (() => false) },
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
  // The scripted present proposes nothing, so it presents nowhere.
  expect(heard).toEqual([
    {
      kind: "effect-done",
      session: SESSION,
      of: 1,
      outcome: { kind: "ok", presentation: "unshown" },
    },
  ]);
});

// A daemon event shows only where the host presented the answer carrying it:
// one drawn while the statusline's feed draws in its place shows nothing.
test.each([
  [false, "presented"],
  [true, "turned"],
] as const)(
  "an answer drawn while the statusline lane is followed (%s) is %s, and acknowledges its events only if presented",
  async (followed, presentation) => {
    const acknowledged: DaemonEvent[] = [];
    const presentations = new HostPresentations({
      laneOf: () => ({ turn: 0, followed }),
    });
    const world: HostWorld = {
      ...noActs(),
      presentationTurn: (input, observed) =>
        presentations.turn(input, observed, () => [], () => null, () => true),
      acknowledgeDisplayed: (events) => void acknowledged.push(...events),
    };
    const shown: DaemonEvent = {
      kind: "act-failed",
      about: "act-failed",
      event: { text: "an act failed", at: 7 as Instant, answered: false },
    };
    const { renderer, heard } = scripted(
      output([
        {
          ...present(1),
          displayedEvents: [shown],
          // The host holds the surface whole, unread.
          proposal: {
            surface: { kind: "whole", value: {} as HeldSurface },
            menu: { shown: false, timeoutS: 30 },
          },
        },
      ]),
    );
    const { answered } = await answer(renderer, [], [], undefined, { world });
    answered.settled(true);
    await drained();
    expect(heard).toEqual([
      {
        kind: "effect-done",
        session: SESSION,
        of: 1,
        outcome: { kind: "ok", presentation },
      },
    ]);
    expect(acknowledged).toEqual(presentation === "presented" ? [shown] : []);
  },
);

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

test("a present for another session cannot publish its frame", async () => {
  const other = {
    ...present(1),
    session: sessionIdOf("other-session"),
  };
  const { renderer, heard } = scripted(output([other]));
  const { answered } = await answer(renderer);

  expect(answered.resp).toMatchObject({ ok: false, code: "RENDER_FAILED" });
  await drained();
  expect(heard).toContainEqual({
    kind: "effect-done",
    session: other.session,
    of: other.id,
    outcome: {
      kind: "failed",
      reason: `presents session "other-session", not this request's "${SESSION}"`,
    },
  });
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
    wake: null,
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
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS]);
});

test("a turn that throws still hands the host what its open views read", async () => {
  const left: Subscriptions = {
    sources: { [SESSION]: [] },
    lanes: {},
    managedFolders: [],
    configSelections: [],
    configs: [],
  };
  const subscribed: Subscriptions[] = [];
  const { renderer } = scripted(threwWith([], "the draw broke", left));
  await answer(renderer, [], subscribed);
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS, left]);
});

test("a config's managed folders can change while its session reads and lanes stay fixed", async () => {
  const folders = { ...NO_SUBSCRIPTIONS, managedFolders: ["/plugin/session"] };
  const subscribed: Subscriptions[] = [];
  const { renderer } = scripted({ ...output([]), subscriptions: folders });
  await answer(renderer, [], subscribed);
  expect(subscribed).toEqual([NO_SUBSCRIPTIONS, folders]);
});

test("a new session context retries its failed config with the same declaration, while due does not", async () => {
  const origin = CONTEXT.requested;
  const declaration = { ...NO_SUBSCRIPTIONS, configs: [origin] };
  const delivered: Event["kind"][] = [];
  const unheard: string[] = [];
  const follow = jest.fn(() => {
    if (follow.mock.calls.length === 1)
      throw new Error("discovery unavailable");
  });
  const host = rendererHost(
    MAIN_RENDERER,
    CLOCK,
    hostHeld(
      eventRenderer(async ({ event }) => {
        delivered.push(event.kind);
        return { ...output([]), subscriptions: declaration };
      }),
      CLOCK.monotonic,
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      prepare: () => () => {},
      recorded: () => {},
      holding: () => () => {},
    },
    {
      ...noActs(),
      unheard: (why) => void unheard.push(why),
      configs: {
        ...NO_CONFIGS,
        follow,
        snapshotOf: () => ({
          chain: [],
          repo: null,
          plugins: [],
          strays: [],
          notices: [],
          watch: null,
          checkout: { root: "/project", git: false },
        }),
      },
    },
  );
  const context = () =>
    host.answer(() => ({
      kind: "event",
      event: { kind: "context", context: CONTEXT, worldState: WORLD },
    }));
  expect(await context()).toMatchObject({
    configFailure: { message: "discovery unavailable" },
  });
  await host.answer(() => ({ kind: "event", event: { kind: "due" } }));
  expect(follow).toHaveBeenCalledTimes(1);
  expect(await context()).not.toHaveProperty("configFailure");
  expect(follow.mock.calls).toEqual([[[origin]], [[origin]]]);
  expect(delivered).toEqual(["context", "due", "context", "config"]);
  expect(unheard).toEqual([expect.stringContaining("discovery unavailable")]);
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
    managedFolders: [],
    configSelections: [],
    configs: [],
  };
  const drawn: Subscriptions = {
    sources: {},
    lanes: {},
    managedFolders: [],
    configSelections: [],
    configs: [],
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
    { kind: "context", context: CONTEXT, worldState: WORLD },
  ]);
  expect(requests).toEqual([
    { kind: "request", id: REQUEST, context: CONTEXT },
  ]);
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

describe("the request's draws, and its wait for what a draw owes", () => {
  // A wait the case ends with `end`: a world state landing.
  const held = () => {
    let end = (_moved: Moved): void => {};
    const moved = (_session: unknown, _after: number, signal: AbortSignal) =>
      new Promise<Moved>((resolve) => {
        end = resolve;
        signal.addEventListener("abort", () => resolve({ kind: "gone" }));
      });
    return { moved, end: (m: Moved) => end(m) };
  };

  test("a draw that owes nothing answers at once, with no wait", async () => {
    const { renderer, requests } = scripted(output([present(1)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("settled");
    expect(facts.get("draws")).toBe("1");
    expect(facts.get("cause")).toBe("-");
  });

  test("a draw that owes waits for a later world state and draws again; the frame it replaces is refused, never shown", async () => {
    const waits: number[] = [];
    const { renderer, requests, heard } = scripted([
      output([owing(1, OWED)]),
      output([owing(2, { kind: "settled", seq: 2 })]),
    ]);
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: async (_session, after) => {
        waits.push(after);
        return { kind: "moved" };
      },
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(2);
    // It waited past the world state the draw read.
    expect(waits).toEqual([1]);
    expect(facts.get("draws")).toBe("2");
    expect(facts.get("ended")).toBe("settled");
    await drained();
    expect(heard).toMatchObject([
      { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
    ]);
  });

  test("a wait that outlasts the client's deadline ends there, and the request answers with the frame it drew, owing", async () => {
    const { renderer, requests } = scripted(output([owing(1, OWED)]));
    const answering = answer(renderer, [], [], undefined, {
      moved: held().moved,
      waitEndsAt: 5000,
    });
    // The deadline is armed once the first draw is back and the wait begins.
    while (deadlines.size === 0) await drained();
    for (const fire of deadlines) fire();
    const { answered, facts } = await answering;
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("deadline");
  });

  test("a draw owing with no time left answers at once, with no wait", async () => {
    const { renderer, requests } = scripted(output([owing(1, OWED)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: () => {
        throw new Error("waited with no time left");
      },
      waitEndsAt: 0,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("deadline");
  });

  test("a draw owing what cannot come ends the request at once, naming the cause", async () => {
    const { renderer, requests } = scripted(
      output([
        owing(1, {
          kind: "stalled",
          seq: 1,
          names: ["slow"],
          reason: "the owners could not be read",
        }),
      ]),
    );
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: () => {
        throw new Error("waited for what cannot come");
      },
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("stalled");
    expect(facts.get("cause")).toBe("the owners could not be read");
  });

  test("a redraw that reads no later world state than the draw before it ends the request, naming why, since what was stamped never reached the renderer", async () => {
    const { renderer, requests } = scripted([
      output([owing(1, OWED)]),
      output([owing(2, { kind: "owed", seq: 1, names: ["slow"] })]),
    ]);
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: async () => ({ kind: "moved" }),
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(requests).toHaveLength(2);
    expect(facts.get("ended")).toBe("stale");
    expect(facts.get("cause")).toMatch(/world state 1 again/);
    // What the first draw owed is what held the request.
    expect(facts.get("waitedFor")).toBe("slow");
  });

  test("a client gone before any draw is answered abandoned, and no draw is sent", async () => {
    const { renderer, requests } = scripted(output([present(1)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      gone: () => true,
      waitEndsAt: 5000,
    });
    expect(answered.outcome).toMatchObject({ kind: "abandoned" });
    expect(requests).toHaveLength(0);
    expect(facts.has("ended")).toBe(false);
  });

  test("a client that leaves while its draw waited is answered abandoned, the frame it drew refused and its draw named, not a throw", async () => {
    let left = false;
    const { renderer, requests, heard } = scripted(output([owing(1, OWED)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      gone: () => left,
      moved: async () => {
        left = true;
        return { kind: "moved" };
      },
      waitEndsAt: 5000,
    });
    expect(answered.outcome).toMatchObject({ kind: "abandoned" });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("abandoned");
    // The draw that ran is still on the record.
    expect(facts.get("drew")).not.toBe("-");
    await drained();
    expect(heard).toMatchObject([
      { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
    ]);
  });

  test("a client that leaves while its wait ends any other way is answered abandoned too, and the frame is refused", async () => {
    let left = false;
    const { renderer, heard } = scripted(output([owing(1, OWED)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      gone: () => left,
      moved: async () => {
        left = true;
        return { kind: "gone" };
      },
      waitEndsAt: 5000,
    });
    expect(answered.outcome).toMatchObject({ kind: "abandoned" });
    expect(facts.get("ended")).toBe("abandoned");
    await drained();
    expect(heard).toMatchObject([
      { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
    ]);
  });

  test("a session no longer read ends the request with the frame it drew", async () => {
    const { renderer } = scripted(output([owing(1, OWED)]));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: async () => ({ kind: "gone" }),
      waitEndsAt: 5000,
    });
    expect(answered.resp).toEqual({ ok: true, frame: FRAME });
    expect(facts.get("ended")).toBe("gone");
  });

  test("a draw that threw ends the request at once with its failure", async () => {
    const { renderer, requests } = scripted(threwWith([], "x"));
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      moved: () => {
        throw new Error("waited after a throw");
      },
      waitEndsAt: 5000,
    });
    expect(answered.resp).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
    expect(facts.get("ended")).toBe("threw");
  });

  test("a draw that throws while the close is under way is the renderer's failure, said as it threw", async () => {
    const closing = new AbortController();
    const renderer = eventRenderer(async ({ event }) => {
      if (event.kind !== "request") return output([]);
      closing.abort();
      return threwWith([], "template exploded");
    });
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      closing: closing.signal,
      waitEndsAt: 5000,
    });
    expect(facts.get("ended")).toBe("threw");
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("template exploded"),
    });
  });

  test("the daemon's close ends the wait, and the request draws nothing more into the closing views", async () => {
    const closing = new AbortController();
    const { renderer, contexts, requests, heard } = scripted(
      output([owing(1, OWED)]),
    );
    const { answered, facts } = await answer(renderer, [], [], undefined, {
      // The close begins while the request waits.
      moved: () => {
        closing.abort();
        return new Promise(() => {});
      },
      waitEndsAt: 5000,
      closing: closing.signal,
    });
    expect(facts.get("ended")).toBe("closed");
    expect(answered.outcome.kind).toBe("closing");
    expect(contexts).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
    // The frame it drew is refused: nothing showed it.
    await drained();
    expect(heard).toMatchObject([
      { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
    ]);
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

  test("holds no place in the mailbox: an input sent during the wait is answered before the next draw", async () => {
    const wait = held();
    const order: string[] = [];
    let draws = 0;
    const host = rendererHost(
      MAIN_RENDERER,
      CLOCK,
      hostHeld(
        eventRenderer(async ({ event }) => {
          order.push(event.kind);
          if (event.kind !== "request") return output([]);
          draws++;
          return output([
            draws === 1
              ? owing(1, OWED)
              : owing(2, { kind: "settled", seq: 2 }),
          ]);
        }),
        CLOCK.monotonic,
      ),
      () => {},
      {
        subscribed: () => {},
        frames: () => {},
        prepare: () => () => {},
        recorded: () => {},
        holding: () => () => {},
      },
      noActs(),
    );
    const answering = answerStatusline(
      host,
      publishingFrames(TEST_SIGNER),
      {
        requested: () => WORLD,
        holding: () => () => {},
        moved: wait.moved,
      },
      CLOCK,
      NOT_CLOSING,
      () => {},
      locate,
      REQ,
      TEST_ENVIRONMENT,
      REQUEST,
      { waitEndsAt: 5000, gone: () => false },
      [],
    );
    await drained();
    await host.deliver(
      () => ({ kind: "event", event: { kind: "retire", session: SESSION } }),
      [],
    );
    wait.end({ kind: "moved" });
    await answering;
    // The first draw's frame is replaced, so it is refused once the wait ends.
    expect(order).toEqual([
      "context",
      "request",
      "retire",
      "effect-done",
      "request",
    ]);
  });
});
