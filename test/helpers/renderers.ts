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
  TimedOutput,
  TimedRenderer,
} from "../../src/renderer-interface/interface";
import { rendererOf } from "../../src/renderer-interface/interface";
import type { HostWorld } from "../../src/daemon/renderer-host";
import type { Collector } from "../../src/daemon/collector";
import type { SessionId } from "../../src/daemon/foundations/session-id";

// What a renderer that needs nothing declares: no source, no row, no lane
// and no next turn.
export const QUIET: Subscriptions = {
  sources: {},
  tmuxStatus: [],
  lanes: {},
  wake: null,
};

// A renderer whose events `answered` answers, as its transport times them,
// and which no push reaches.
export function eventRenderer(
  answered: (input: EventInput) => Promise<TimedOutput>,
): TimedRenderer {
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
): TimedRenderer {
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
export function hearingEvents<O extends RendererOutput>(
  renderer: Renderer<O>,
  heard: (input: EventInput) => void,
): Renderer<O> {
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
export function holdable<O extends RendererOutput>(
  renderer: Renderer<O>,
): {
  readonly renderer: Renderer<O>;
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

// What a host hands its turns over a daemon's collector, where no feed is
// open, so a pushed frame reaches nothing.
export const unframed = (
  collector: Pick<Collector, "subscribed" | "holding" | "writableSettings">,
) => ({
  subscribed: (subscriptions: Subscriptions) =>
    collector.subscribed(subscriptions),
  framed: () => {},
  holding: (session: SessionId) => collector.holding(session),
  writableSettings: (session: SessionId) => collector.writableSettings(session),
});
