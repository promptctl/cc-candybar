// Renderers a test builds around its own answer to events: one that answers
// events alone, and one that hears each event on its way into a real
// renderer. A push reaches neither test's answer.

import type {
  AdapterInput,
  AdapterOutput,
  EventInput,
  Renderer,
  RendererOutput,
} from "../../src/renderer-interface/interface";
import { rendererOf } from "../../src/renderer-interface/interface";
import type { HostWorld } from "../../src/daemon/renderer-host";

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
