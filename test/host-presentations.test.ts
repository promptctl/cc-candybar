import {
  HostPresentations,
  type LaneTurns,
  type PresentationReader,
} from "../src/daemon/host-presentations";
import type { ProposedPresentation } from "../src/renderer-interface/presentation";
import type { Lane } from "../src/config/lanes";
import type {
  EffectId,
  Event,
  EventInput,
  RendererOutput,
  RequestId,
} from "../src/renderer-interface/interface";
import {
  answered,
  contextOf,
  handIn,
  presentOf,
  READ,
  rendererOf,
  snapshotOf,
  worldStateOf,
} from "./helpers/main-renderer";
import type { Tick } from "../src/utils/instant";

const context = contextOf("held");
const session = context.hookData.session_id;
const request: Event = { kind: "request", context, id: 1 as RequestId };
const start: Event = {
  kind: "start",
  sessions: [{ context, worldState: worldStateOf(session) }],
  viewers: {},
  configs: [
    {
      origin: context.requested,
      config: snapshotOf(
        '{segments:{a:{template:"wide retained value"}},root:{h:["a"]}}',
      ),
    },
  ],
};
const input = (event: Event): EventInput => ({ kind: "event", event, ...READ });
// The subscriber book's turns for the one session here: a lane's first viewer
// arriving or its last leaving begins the lane's next turn.
const laneTurns = () => {
  let minted = 0;
  const turns = new Map<Lane, number>();
  const followed = new Set<Lane>();
  const lanes: LaneTurns = {
    turnOf: (_, lane) => turns.get(lane) ?? 0,
    current: (sid, lane, turn) => lanes.turnOf(sid, lane) === turn,
    follows: (_, lane) => followed.has(lane),
  };
  const follow = (lane: Lane, on: boolean) => {
    if (on) followed.add(lane);
    else followed.delete(lane);
    turns.set(lane, ++minted);
  };
  return { lanes, follow };
};
const host = () => {
  const { lanes, follow } = laneTurns();
  const shared = new HostPresentations(lanes);
  const turn = (
    reader: PresentationReader,
    event: Event,
    problem: string | null = null,
  ) =>
    shared.turn(
      input(event),
      reader,
      () => [session],
      () => problem,
      (sid) => sid === session,
    );
  const inspect = () =>
    turn(new WeakMap(), request)!.input.presentation!.sessions[0]?.resume;
  return { shared, turn, inspect, lanes, follow };
};

test("delivered frames become sparse bases, even if their renderer dies before receiving its receipt", async () => {
  const book = host();
  const main = rendererOf();
  const peer = rendererOf();
  const reader: PresentationReader = new WeakMap();
  answered(await handIn(main, start));
  const firstTurn = book.turn(reader, request)!;
  const first = answered(await main.answer(firstTurn.input));
  const sent = presentOf(first.effects);
  expect(sent.proposal?.surface.kind).toBe("whole");
  const take = firstTurn.drawn(first);
  expect(book.inspect()).toBeUndefined();
  const verdict = take(sent.id);
  if (verdict.presentation !== "presented") throw new Error("unpresented");
  verdict.settle();
  const accepted = book.inspect()!;
  expect(accepted.surfaces.statusline!.order).toBe(
    firstTurn.input.presentation!.order,
  );
  const fresh: PresentationReader = new WeakMap();
  const restoring = book.turn(fresh, start)!;
  answered(await peer.answer(JSON.parse(JSON.stringify(restoring.input))));
  restoring.received();
  const next = book.turn(fresh, request)!;
  expect(next.input.presentation!.sessions[0]?.resume).toBeUndefined();
  const second = answered(await peer.answer(next.input));
  const answer = presentOf(second.effects);
  expect(answer.frame).toEqual(sent.frame);
  expect(answer.proposal?.surface).toEqual({
    kind: "change",
    base: accepted.surfaces.statusline!.order,
    change: {},
  });
  // A failed write never asks the delivery's verdict.
  next.drawn(second);
  expect(book.inspect()).toBe(accepted);
});

test("a late delivery advances only its surface, and retired surfaces reject outstanding deliveries", async () => {
  const book = host();
  const reader: PresentationReader = new WeakMap();
  const main = rendererOf();
  answered(await handIn(main, start));
  const producing = book.turn(reader, request)!;
  const output = answered(await main.answer(producing.input));
  const present = presentOf(output.effects);
  const whole = present.proposal!;
  // A request's answer presents on the statusline; a feed draws its lane,
  // under the lane's turn as it draws. A client that shows no answer proposes
  // nothing.
  const proposed = (
    by: Lane | "request" | "unshown",
    proposal: ProposedPresentation,
    receipt: number,
  ): Pick<RendererOutput, "effects" | "frames"> => {
    const id = receipt as EffectId;
    return by === "request"
      ? { effects: [{ ...present, id, proposal }], frames: [] }
      : by === "unshown"
      ? { effects: [{ ...present, id, proposal: undefined }], frames: [] }
      : {
          effects: [],
          frames: [
            {
              session,
              lane: by,
              turn: book.lanes.turnOf(session, by),
              frame: {
                kind: "drawn",
                receipt: id,
                bar: present.frame,
                proposal,
              },
            },
          ],
        };
  };
  const stage = (by: Lane | "request" | "unshown", receipt: number) => {
    const draw = book.turn(
      reader,
      by === "request" || by === "unshown" ? request : { kind: "due" },
    )!;
    const take = draw.drawn({ ...output, ...proposed(by, whole, receipt) });
    return {
      order: draw.input.presentation!.order,
      accept: () => {
        const verdict = take(receipt as EffectId);
        if (verdict.presentation === "presented") verdict.settle();
        return verdict.presentation;
      },
    };
  };
  book.follow("pane", true);
  const requestA = stage("request", 1);
  const feed = stage("pane", 2);
  const requestB = stage("request", 3);
  expect(requestB.accept()).toBe("presented");
  const expiry = book.turn(reader, { kind: "due" })!;
  const expired = { since: 45 as Tick, shown: false, timeoutS: 30 };
  expiry.drawn({
    ...output,
    frames: [],
    effects: [],
    idle: [{ session, value: expired }],
  });
  expect(feed.accept()).toBe("presented");
  expect(requestA.accept()).toBe("superseded");
  expect(book.inspect()).toMatchObject({
    surfaces: {
      statusline: { order: requestB.order },
      pane: { order: feed.order },
    },
  });
  expect(book.inspect()!.idle).toEqual({
    order: expiry.input.presentation!.order,
    value: expired,
  });
  const unwatched = stage("pane", 4);
  book.follow("pane", false);
  expect(unwatched.accept()).toBe("turned");
  expect(book.inspect()!.surfaces.pane).toBeUndefined();
  // A lane left and rejoined before a frame's delivery is a later turn, so
  // the frame drawn for the earlier one presents nowhere.
  book.follow("pane", true);
  const rejoined = stage("pane", 12);
  book.follow("pane", false);
  book.follow("pane", true);
  expect(rejoined.accept()).toBe("turned");
  expect(book.inspect()!.surfaces.pane).toBeUndefined();
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: requestB.order }),
  );
  // An answer that proposes nothing presents nowhere.
  const discarded = stage("unshown", 5);
  expect(discarded.accept()).toBe("unshown");
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: requestB.order }),
  );
  // The statusline lane gaining a viewer hands Claude Code's statusline to
  // its feed: the requests' image retires, with the answers on their way.
  const superseded = stage("request", 6);
  book.follow("statusline", true);
  expect(superseded.accept()).toBe("turned");
  expect(book.inspect()!.surfaces.statusline).toBeUndefined();
  const fed = stage("statusline", 7);
  expect(fed.accept()).toBe("presented");
  const unshown = stage("request", 8);
  expect(unshown.accept()).toBe("unshown");
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: fed.order }),
  );
  // Its last viewer leaving hands the statusline back to requests.
  const inFlight = stage("statusline", 9);
  book.follow("statusline", false);
  expect(inFlight.accept()).toBe("turned");
  expect(book.inspect()!.surfaces.statusline).toBeUndefined();
  const answering = stage("request", 10);
  expect(answering.accept()).toBe("presented");
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: answering.order }),
  );
  const retired = stage("request", 11);
  book.shared.retire(session);
  expect(retired.accept()).toBe("retired");
  expect(book.inspect()).toBeUndefined();
});

test("a session whose image the book let go is offered none on its next draw, so no record outlives it", async () => {
  const { lanes } = laneTurns();
  const shared = new HostPresentations(lanes, 1);
  const reader: PresentationReader = new WeakMap();
  const turn = (event: Event) =>
    shared.turn(input(event), reader, () => [session], () => null, () => true);
  const main = rendererOf();
  answered(await handIn(main, start));
  const drawing = turn(request)!;
  const output = answered(await main.answer(drawing.input));
  const shown = drawing.drawn(output)(presentOf(output.effects).id);
  expect(shown.presentation).toBe("presented");
  turn({ kind: "request", context: contextOf("evicting"), id: 2 as RequestId });
  expect(turn(request)!.input.presentation!.sessions).toEqual([
    { session, revision: 0, bases: {} },
  ]);
});

test("a frames client's answer proposes no presentation, so it presents nowhere", async () => {
  const book = host();
  const main = rendererOf();
  answered(await handIn(main, start));
  // A `cc-candybar frames` client asks with the same request; only its hint
  // differs.
  const fromFrames: Event = {
    ...request,
    context: {
      ...context,
      hints: {
        ...context.hints,
        client: { kind: "frames", bundle: "/bundle", source: null },
      },
    },
  };
  const drawing = book.turn(new WeakMap(), fromFrames)!;
  const output = answered(await main.answer(drawing.input));
  const present = presentOf(output.effects);
  expect(present.proposal).toBeUndefined();
  expect(drawing.drawn(output)(present.id)).toEqual({
    presentation: "unshown",
  });
  expect(book.inspect()).toBeUndefined();
});
