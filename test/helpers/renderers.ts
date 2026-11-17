// Renderers a test builds around its own answer to events: one that answers
// events alone, and one that hears each event on its way into a real
// renderer. A push reaches neither test's answer.

import type {
  AdapterInput,
  AdapterOutput,
  EventInput,
  Renderer,
  RendererOutput,
  Subscriptions,
  TimedRenderer,
} from "../../src/renderer-interface/interface";
import { rendererOf, timed } from "../../src/renderer-interface/interface";
import type { HostWorld, rendererHost } from "../../src/daemon/renderer-host";
import type { Collector } from "../../src/daemon/collector";

// A renderer whose events `answered` answers, and which no push reaches.
export function eventRenderer(
  answered: (input: EventInput) => Promise<RendererOutput>,
): Renderer {
  return rendererOf({
    event: answered,
    adapter: async (input) => {
      throw new Error(`this renderer takes no push (${input.push.kind})`);
    },
  });
}

// A renderer whose pushes `replied` answers, and which no event reaches.
export function pushRenderer(
  replied: (input: AdapterInput) => Promise<AdapterOutput>,
): Renderer {
  return rendererOf({
    event: async (input) => {
      throw new Error(`this renderer takes no event (${input.event.kind})`);
    },
    adapter: replied,
  });
}

// The pushes of a rig that hands its renderer none: one would be the rig's
// bug, said.
export const NO_PUSHES = (): never => {
  throw new Error("this rig hands the renderer no push");
};

// The world of a rig whose renderer asks no act: one it is handed fails by
// name, the daemon is not closing, and an act's failure no bar holds would be
// the rig's bug.
export const NO_ACTS: HostWorld = {
  perform: async (act) => ({
    kind: "failed",
    reason: `${act.kind}: this rig performs no act`,
  }),
  stateDir: "/nonexistent/this-rig-has-no-state-dir",
  closing: () => false,
  unheard: (text) => {
    throw new Error(`an act's failure no bar holds: ${text}`);
  },
};

// `renderer`, with `heard` told each event before it answers.
export function hearingEvents(
  renderer: Renderer,
  heard: (input: EventInput) => void,
): Renderer {
  return rendererOf({
    event: (input) => {
      heard(input);
      return renderer.answer(input);
    },
    adapter: (input) => renderer.answer(input),
  });
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
    renderer: rendererOf({
      event: (input) => turn(() => renderer.answer(input)),
      adapter: (input) => turn(() => renderer.answer(input)),
    }),
    hold: () => {
      let open = (): void => {};
      held = new Promise<void>((resolve) => (open = resolve));
      return open;
    },
  };
}

// `renderer`, its turns timed as a link times them
// (src/daemon/renderer-process.ts), on `monotonic`: by default a clock that
// stands still, so every turn takes 0ms and no test reads the real one.
export const timedOf = (
  renderer: Renderer,
  monotonic: () => number = () => 0,
): TimedRenderer => timed(renderer, monotonic);

// What a rig's host takes from each turn: the subscriptions to `subscribed`,
// and nothing of the wake or the frames, which a rig that wants them reads.
export function takenBy(
  collector: Pick<Collector, "holding" | "writableSettings"> & {
    readonly subscribed?: (subscriptions: Subscriptions) => void;
  },
): Parameters<typeof rendererHost>[4] {
  return {
    declared: ({ subscriptions }) => collector.subscribed?.(subscriptions),
    framed: () => {},
    holding: (session) => collector.holding(session),
    writableSettings: (session) => collector.writableSettings(session),
  };
}
