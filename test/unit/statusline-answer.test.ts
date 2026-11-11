// A render request answered through its renderer (src/daemon/statusline-
// answer.ts): the host answers the client with the one frame presented for the
// request, a turn that presents none or throws is a failure naming the
// renderer, and every effect the turn returned is owed one `effect-done`.
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
} from "../../src/renderer/interface";
import type { CheckedRenderRequest } from "../../src/renderer/request-context";
import { instantOf } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";

const SESSION = sessionIdOf("a-session");
const REQUEST = 3 as RequestId;
const AT = instantOf(new Date(1_700_000_000_000));
const FRAME = renderFailedFrame("the bar");
// What the host reads of a checked request: its session and its encoding.
const REQ = {
  sessionId: SESSION,
  encoding: "frame",
} as unknown as CheckedRenderRequest;
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

// A renderer whose request turn answers `output` (or throws it), and which
// keeps every effect-done it hears.
function scripted(request: RendererOutput | TurnThrew): {
  readonly renderer: Renderer;
  readonly heard: Event[];
} {
  const heard: Event[] = [];
  return {
    heard,
    renderer: {
      answer: async ({ event }) => {
        if (event.kind === "request") {
          if (request instanceof TurnThrew) throw request;
          return request;
        }
        heard.push(event);
        return { effects: [], record: [] };
      },
    },
  };
}

async function answer(renderer: Renderer, logged: string[] = []) {
  const facts: RequestFacts = [];
  const answered = await answerStatusline(
    rendererHost("main", renderer, (_level, line) => logged.push(line)),
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
  const { renderer, heard } = scripted({
    effects: [present(1)],
    record: [["drew", "2ms"]],
  });
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
  const { renderer } = scripted({
    effects: [{ ...present(1), frame: handoff }],
    record: [],
  });
  const { answered } = await answer(renderer);
  expect(answered.seen).toBe("can-move");
});

test("a present its client never took settles failed", async () => {
  const { renderer, heard } = scripted({ effects: [present(1)], record: [] });
  const { answered } = await answer(renderer);
  answered.settled(false);
  await drained();
  expect(heard).toMatchObject([
    { kind: "effect-done", of: 1, outcome: { kind: "failed" } },
  ]);
});

test("a turn that presents no frame for the request is a failure naming the renderer", async () => {
  const { renderer, heard } = scripted({
    effects: [present(1, 9 as RequestId)],
    record: [],
  });
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
  const { renderer, heard } = scripted({
    effects: [present(1), present(2)],
    record: [],
  });
  const { answered } = await answer(renderer);
  expect(answered.resp).toEqual({ ok: true, frame: FRAME });
  await drained();
  expect(heard).toMatchObject([
    { kind: "effect-done", of: 2, outcome: { kind: "failed" } },
  ]);
});

test("a turn that throws is a failure naming the renderer, with what it learned on the request's event", async () => {
  const { renderer } = scripted(
    new TurnThrew([["lanes", "-"]], new Error("the draw broke")),
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

test("a failed effect-done turn is said on a turn line naming the renderer and the session", async () => {
  const logged: string[] = [];
  const renderer: Renderer = {
    answer: async ({ event }) => {
      if (event.kind === "request")
        return { effects: [present(1)], record: [] };
      throw new TurnThrew([], new Error("no such present"));
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
