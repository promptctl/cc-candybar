// Renderers a test builds around its own answer to an input.

import type {
  EventInput,
  Renderer,
  RendererOutput,
  TimedRenderer,
} from "../../src/renderer-interface/interface";
import { timed } from "../../src/renderer-interface/interface";
import type { HostWorld } from "../../src/daemon/renderer-host";
import {
  HostPresentations,
  type LaneTurns,
} from "../../src/daemon/host-presentations";
import type { Collector } from "../../src/daemon/collector";
import { systemTimekeeper } from "../../scripts/lib/system-clock";
import { authorizeRun } from "../../src/daemon/foundations/run-authorization";
import { TEST_SIGNER } from "./link-signer";

export function unexpectedTimingProblem(message: string): never {
  throw new Error(message);
}

// `renderer` as the host holds it in process: each turn timed around its
// answer, on `monotonic` — a unit test's own clock, which reads no time.
export const hostHeld = (
  renderer: Renderer,
  monotonic: () => number = () => systemTimekeeper.monotonic(),
): TimedRenderer => timed(renderer, monotonic, unexpectedTimingProblem);

// A collector as a host's turns reach it, in a rig no feed follows a session
// in: the frames a turn drew go nowhere.
export const unfollowedCollector = (
  collector: Pick<Collector, "subscribed" | "holding">,
) => ({
  subscribed: collector.subscribed.bind(collector),
  holding: collector.holding.bind(collector),
  frames: () => {},
  prepare: () => () => {},
  recorded: () => {},
});

export function eventRenderer(
  answer: (input: EventInput) => Promise<RendererOutput>,
): Renderer {
  return { answer };
}

// The stores of a rig whose host holds none: its renderer's turns tell it
// nothing.
const noneStored = { heard: (): void => {}, drain: (): readonly [] => [] };
export const NOTHING_STORED = {
  navigation: noneStored,
  draft: noneStored,
  "session-state": noneStored,
  "settings-history": noneStored,
};

// The config discovery of a rig whose renderer names no origin: one it
// names would be the rig's bug, said.
export const NO_CONFIGS: HostWorld["configs"] = {
  follow: (origins) => {
    if (origins.length > 0)
      throw new Error(
        `this rig discovers no config, and its renderer named ${origins.length}`,
      );
  },
  snapshotOf: () => null,
  selected: () => {},
  retainedOf: () => undefined,
  handoffOf: () => undefined,
  received: () => {},
  landed: () => [],
  path: () => undefined,
  repoDir: () => undefined,
  readText: (file) => {
    throw new Error(`this rig reads no config (${file})`);
  },
};

// Lanes no subscriber ever followed: each is in its first turn.
const UNFOLLOWED: LaneTurns = {
  laneOf: () => ({ turn: 0, followed: false }),
};

// The world of a rig whose renderer asks no act: one it is handed fails by
// name, its renderer names no origin, the daemon is not closing, and an act's
// failure no bar holds would be the rig's bug.
// [LAW:no-shared-mutable-globals] A presentation authority of the rig's own,
// for a host no feed follows a session in: each draw presents as its renderer
// alone holds it, no session's export is refused, and the host owns every
// session.
export const presenting = (): HostWorld["presentationTurn"] => {
  const presentations = new HostPresentations(UNFOLLOWED);
  return (input, observed) =>
    presentations.turn(
      input,
      observed,
      () => [],
      () => null,
      () => true,
    );
};

// A host world with no act to perform, and a presentation authority of its
// own.
export const noActs = (): HostWorld => ({
  presentationTurn: presenting(),
  sessionWriter: (_session, land) => land(),
  authorizeRun: (request, captures) =>
    authorizeRun(TEST_SIGNER, request, captures),
  perform: async (act) => ({
    kind: "failed",
    reason: `${act.kind}: this rig performs no act`,
  }),
  stateDir: "/nonexistent/this-rig-has-no-state-dir",
  configs: NO_CONFIGS,
  closing: () => false,
  acknowledgeDisplayed: () => {},
  reported: () => {},
  unheard: (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
});

// `renderer`, with `heard` told each event before it answers.
export function hearingEvents(
  renderer: Renderer,
  heard: (input: EventInput) => void,
): Renderer {
  return {
    answer: (input) => {
      heard(input);
      return renderer.answer(input);
    },
  };
}

// `renderer`, with a turn a test holds: `hold` keeps the next input's turn
// from reaching it until `open`, so every input sent after that one waits
// behind it in the host's mailbox, in flight.
export function holdable(renderer: Renderer): {
  readonly renderer: Renderer;
  readonly hold: () => () => void;
} {
  let held: Promise<void> = Promise.resolve();
  const turn = <T>(answer: () => Promise<T>): Promise<T> => {
    const waiting = held;
    held = Promise.resolve();
    return waiting.then(answer);
  };
  return {
    renderer: {
      answer: (input) => turn(() => renderer.answer(input)),
    },
    hold: () => {
      let open = (): void => {};
      held = new Promise<void>((resolve) => (open = resolve));
      return open;
    },
  };
}
