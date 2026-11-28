import {
  HostPresentations,
  type PresentationReader,
} from "../src/daemon/host-presentations";
import type {
  DrawSurface,
  ProposedPresentation,
} from "../src/renderer-interface/presentation";
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
const host = () => {
  const shared = new HostPresentations();
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
  return { shared, turn, inspect };
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
  const settle = firstTurn.drawn(first);
  expect(book.inspect()).toBeUndefined();
  settle(sent.id, true);
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
  expect(answer.proposal?.motion).toEqual({
    kind: "change",
    base: accepted.motion.order,
    change: {},
  });
  next.drawn(second)(answer.id, false);
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
  // A request's answer presents on the statusline; a feed draws its lane.
  const proposed = (
    by: DrawSurface | "request",
    proposal: ProposedPresentation,
    receipt: number,
  ): Pick<RendererOutput, "effects" | "frames"> => {
    const id = receipt as EffectId;
    return by === "request"
      ? { effects: [{ ...present, id, proposal }], frames: [] }
      : {
          effects: [],
          frames: [
            {
              session,
              lane: by,
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
  const stage = (by: DrawSurface | "request", receipt: number) => {
    const draw = book.turn(
      reader,
      by === "request" ? request : { kind: "due" },
    )!;
    const settle = draw.drawn({ ...output, ...proposed(by, whole, receipt) });
    return {
      order: draw.input.presentation!.order,
      accept: () => settle(receipt as EffectId, true),
    };
  };
  const requestA = stage("request", 1);
  const feed = stage("pane", 2);
  const requestB = stage("request", 3);
  requestB.accept();
  const expiry = book.turn(reader, { kind: "due" })!;
  const expired = { since: 45 as Tick, shown: false, timeoutS: 30 };
  expiry.drawn({
    ...output,
    frames: [],
    effects: [],
    idle: [{ session, value: expired }],
  });
  feed.accept();
  requestA.accept();
  expect(book.inspect()).toMatchObject({
    surfaces: {
      statusline: { order: requestB.order },
      pane: { order: feed.order },
    },
    motion: { order: requestB.order },
  });
  expect(book.inspect()!.idle).toEqual({
    order: expiry.input.presentation!.order,
    value: expired,
  });
  const unwatched = stage("pane", 4);
  book.shared.stopFeed(session, "pane");
  unwatched.accept();
  expect(book.inspect()!.surfaces.pane).toBeUndefined();
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: requestB.order }),
  );
  // The statusline lane's feed leaving stops its frames in flight, and the
  // statusline's image stands, since requests still draw it.
  const followed = stage("statusline", 5);
  book.shared.stopFeed(session, "statusline");
  followed.accept();
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: requestB.order }),
  );
  const answering = stage("request", 6);
  answering.accept();
  expect(book.inspect()!.surfaces.statusline).toEqual(
    expect.objectContaining({ order: answering.order }),
  );
  const retired = stage("request", 7);
  book.shared.retire(session);
  retired.accept();
  expect(book.inspect()).toBeUndefined();
});
