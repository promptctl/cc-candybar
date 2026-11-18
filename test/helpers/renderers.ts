// Renderers a test builds around its own answer to events: one that answers
// them itself, and one that hears each event on its way into a real
// renderer.

import type {
  Renderer,
  RendererInput,
  RendererOutput,
  TimedRenderer,
} from "../../src/renderer-interface/interface";
import { timed } from "../../src/renderer-interface/interface";
import type { OwnTurns } from "../../src/renderer/main";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { Collector } from "../../src/daemon/collector";
import { systemTimekeeper } from "../../src/time";

// `renderer` as the host holds it in process: each turn timed around its
// answer, on `monotonic` — a unit test's own clock, which reads no time.
export const hostHeld = (
  renderer: Renderer,
  monotonic: () => number = () => systemTimekeeper.monotonic(),
): TimedRenderer => timed(renderer, monotonic);

// A collector as a host's turns reach it, in a rig no feed follows a session
// in: the frames a turn drew go nowhere.
export const unfollowedCollector = (
  collector: Pick<Collector, "subscribed" | "holding" | "writableSettings">,
) => ({
  subscribed: collector.subscribed.bind(collector),
  holding: collector.holding.bind(collector),
  writableSettings: collector.writableSettings.bind(collector),
  frames: () => {},
  stored: () => {},
  recorded: () => {},
});

// A renderer whose events `answered` answers.
export function eventRenderer(
  answered: (input: RendererInput) => Promise<RendererOutput>,
): Renderer {
  return { answer: answered };
}

// The stored writes of a rig whose host holds no store: its renderer's turns
// tell it none.
export const NOTHING_STORED = (): readonly [] => [];

// The lines of a rig that reads none of what its renderer logged.
export const NOTHING_SAID = (): readonly [] => [];

// The renderer's own turns in a rig that hands it no inspect and no close:
// one would be the rig's bug, said.
const noTurn = (what: string) => (): never => {
  throw new Error(`this rig hands the renderer no ${what}`);
};
export const NO_OWN_TURNS: OwnTurns = {
  inspect: noTurn("inspect"),
  closing: noTurn("close"),
  close: noTurn("close"),
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
  landed: () => [],
  path: () => undefined,
  repoDir: () => undefined,
};

// The world of a rig whose renderer asks no act: one it is handed fails by
// name, its renderer names no origin, the daemon is not closing, and an act's
// failure no bar holds would be the rig's bug.
export const NO_ACTS: HostWorld = {
  perform: async (act) => ({
    kind: "failed",
    reason: `${act.kind}: this rig performs no act`,
  }),
  stateDir: "/nonexistent/this-rig-has-no-state-dir",
  configs: NO_CONFIGS,
  closing: () => false,
  unheard: (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
};

// `renderer`, with `heard` told each event before it answers.
export function hearingEvents(
  renderer: Renderer,
  heard: (input: RendererInput) => void,
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
  return {
    renderer: {
      answer: (input) => {
        const waiting = held;
        held = Promise.resolve();
        return waiting.then(() => renderer.answer(input));
      },
    },
    hold: () => {
      let open = (): void => {};
      held = new Promise<void>((resolve) => (open = resolve));
      return open;
    },
  };
}
