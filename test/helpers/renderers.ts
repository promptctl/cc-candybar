// Renderers a test builds around its own answer to events: one that answers
// events alone, and one that hears each event on its way into a real
// renderer. A push reaches neither test's answer.

import type {
  AdapterInput,
  AdapterOutput,
  EventInput,
  Renderer,
  RendererInput,
  RendererOutput,
} from "../../src/renderer-interface/interface";
import { rendererOf } from "../../src/renderer-interface/interface";
import type { HostedRenderer } from "../../src/daemon/renderer-supervisor";

// A renderer whose events `answered` answers, and which no push reaches.
export function eventRenderer(
  answered: (input: EventInput) => Promise<RendererOutput>,
): Renderer {
  return rendererOf({
    start: NO_START,
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
    start: NO_START,
    event: async (input) => {
      throw new Error(`this renderer takes no event (${input.event.kind})`);
    },
    adapter: replied,
  });
}

// The start of a rig that starts its renderer by hand: one would be the
// rig's bug, said.
const NO_START = async (): Promise<never> => {
  throw new Error("this renderer is started by its test, not by a start");
};

// The pushes of a rig that hands its renderer none: one would be the rig's
// bug, said.
export const NO_PUSHES = (): never => {
  throw new Error("this rig hands the renderer no push");
};

// What a rig's renderer does at a start beside opening its sessions: the rig
// starts none.
export const NO_STARTED = (): never => {
  throw new Error("this rig starts its renderer by hand");
};

// A renderer the host reaches directly, with no crossing to cost.
export function hosted(renderer: Renderer): HostedRenderer {
  return {
    // [LAW:types-are-the-program] exception: each input's output is its own
    // kind's; one call cannot name it.
    answer: (async (input: RendererInput) => ({
      output: await (
        renderer.answer as (input: RendererInput) => Promise<unknown>
      )(input),
      hopMs: 0,
    })) as HostedRenderer["answer"],
  };
}

// `renderer`, with `heard` told each event before it answers.
export function hearingEvents(
  renderer: Renderer,
  heard: (input: EventInput) => void,
): Renderer {
  return rendererOf({
    start: (input) => renderer.answer(input),
    event: (input) => {
      heard(input);
      return renderer.answer(input);
    },
    adapter: (input) => renderer.answer(input),
  });
}
