// Renderers a test builds around its own answer to an input.

import type {
  EventInput,
  Renderer,
  RendererOutput,
  TimedRenderer,
} from "../../src/renderer-interface/interface";
import { timed } from "../../src/renderer-interface/interface";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { RendererConfigs } from "../../src/daemon/config-discovery/config-discovery";
import type { Collector } from "../../src/daemon/collector";
import { systemTimekeeper } from "../../src/time";
import { authorizeRun } from "../../src/daemon/foundations/run-authorization";
import { TEST_SIGNER } from "./link-signer";
import { rethrown } from "./work-threw";

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
  stored: () => {},
  recorded: () => {},
});

export function eventRenderer(
  answer: (input: EventInput) => Promise<RendererOutput>,
): Renderer {
  return { answer };
}

// The stored writes of a rig whose host holds no store: its renderer's turns
// tell it none.
const noneStored = (): readonly [] => [];
export const NOTHING_STORED = {
  "session-state": noneStored,
  "settings-history": noneStored,
};

// The config discovery of a rig whose renderer names no origin: one it
// names would be the rig's bug, said.
export const NO_CONFIGS: RendererConfigs = {
  follow: (origins) => {
    if (origins.length > 0)
      throw new Error(
        `this rig discovers no config, and its renderer named ${origins.length}`,
      );
  },
  snapshotOf: () => null,
  selected: () => {},
  retainedOf: () => undefined,
  landed: () => [],
  path: () => undefined,
  repoDir: () => undefined,
  readText: (file) => {
    throw new Error(`this rig reads no config (${file})`);
  },
};

// The world of a rig whose renderer asks no act: one it is handed fails by
// name, its renderer names no origin, the daemon is not closing, and an act's
// failure no bar holds would be the rig's bug.
export const NO_ACTS: HostWorld = {
  authorizeRun: (request, captures) =>
    authorizeRun(TEST_SIGNER, request, captures),
  perform: async (act) => ({
    kind: "failed",
    reason: `${act.kind}: this rig performs no act`,
  }),
  stateDir: "/nonexistent/this-rig-has-no-state-dir",
  configs: () => NO_CONFIGS,
  closing: () => false,
  acknowledgeDisplayed: () => {},
  threw: rethrown,
  unheard: (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
};

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
